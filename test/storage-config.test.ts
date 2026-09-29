import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { resolveApprovedWorkspace } from '../src/config/workspaces.js';
import { openDatabase, openMemoryDatabase } from '../src/db/database.js';
import { JobRepository } from '../src/scheduler/jobs.js';
import { RunRepository } from '../src/scheduler/runs.js';
import { acquireWorkerLease, startWorker } from '../src/scheduler/worker.js';

describe('shared storage and configuration', () => {
  let database: Database;
  let temporaryDirectory: string;
  let workspace: string;

  beforeEach(async () => {
    database = openMemoryDatabase();
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'automation-storage-'));
    workspace = join(temporaryDirectory, 'workspace');
    await mkdir(workspace);
  });

  afterEach(async () => {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('uses a strict versioned schema, foreign keys, WAL, and private DB mode', async () => {
    const path = join(temporaryDirectory, 'state', 'automation.sqlite');
    const persistent = await openDatabase(path);
    try {
      expect(persistent.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(persistent.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(persistent.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      persistent.close();
    }
  });

  test('validates config, preserves an existing config, and rejects unknown fields', async () => {
    const configPath = join(temporaryDirectory, 'config.json');
    const config = await loadConfig(configPath);
    expect(config.databasePath).toBe(
      join(homedir(), '.local', 'share', 'automation-mcp', 'automation.sqlite'),
    );
    const original = await readFile(configPath, 'utf8');
    await loadConfig(configPath);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await Bun.write(configPath, '{"unexpected":true}');
    await expect(loadConfig(configPath)).rejects.toThrow('Invalid configuration');
  });

  test('allows only canonical descendants of approved workspace roots', async () => {
    expect(await resolveApprovedWorkspace(workspace, [temporaryDirectory])).toBe(workspace);
    await expect(resolveApprovedWorkspace(tmpdir(), [workspace])).rejects.toThrow(
      'outside configured approved roots',
    );
    await expect(resolveApprovedWorkspace(workspace, [])).rejects.toThrow(
      'No approved workspace roots',
    );
  });

  test('persists the exact user schedule and rejects workspace escapes on update', async () => {
    const jobs = new JobRepository(database, [temporaryDirectory]);
    const job = await jobs.create({
      name: 'Schedule exactness',
      prompt: 'Inspect status only',
      workspace,
      cronExpression: '  */15 8-17 * * 1-5  ',
      timezone: 'America/Los_Angeles',
      adapter: 'opencode',
    });
    expect(job.cronExpression).toBe('  */15 8-17 * * 1-5  ');
    expect(job.timezone).toBe('America/Los_Angeles');
    await expect(
      jobs.update({
        id: job.id,
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
        workspace: tmpdir(),
      }),
    ).rejects.toThrow('outside configured approved roots');
    expect(jobs.get(job.id).cronExpression).toBe('  */15 8-17 * * 1-5  ');
  });

  test('rejects credential-named adapter configuration fields', async () => {
    const jobs = new JobRepository(database, [temporaryDirectory]);
    await expect(
      jobs.create({
        name: 'Secret config',
        prompt: 'Run in the approved project',
        workspace,
        cronExpression: '0 0 * * *',
        timezone: 'UTC',
        adapter: 'generic',
        adapterConfig: { nested: { apiKey: 'must-not-persist' } },
      }),
    ).rejects.toThrow('credential-named field');
  });

  test('acquires a worker lease and recovers abandoned active runs', async () => {
    const jobs = new JobRepository(database, [temporaryDirectory]);
    const createdJob = await jobs.create({
      name: 'Recovery',
      prompt: 'No-op',
      workspace,
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      adapter: 'opencode',
    });
    const job = jobs.setEnabled(createdJob.id, true);
    const runs = new RunRepository(database);
    const queued = runs.queueManual(job.id);
    runs.claimNext('old-worker');
    const deadPid = process.pid + 1_000_000;
    database
      .query(
        `INSERT INTO worker_state (singleton, worker_id, pid, started_at, heartbeat_at)
       VALUES (1, 'abandoned', $pid, $now, $now)`,
      )
      .run({ pid: deadPid, now: new Date().toISOString() });
    expect(acquireWorkerLease(database, 'new-worker', new Date().toISOString(), runs)).toBe(1);
    expect(runs.get(queued.id).status).toBe('interrupted');
  });

  test('worker starts with a persisted heartbeat and releases its lease on stop', async () => {
    const config = {
      configPath: join(temporaryDirectory, 'config.json'),
      databasePath: ':memory:',
      dataDirectory: temporaryDirectory,
      workspaceRoots: [temporaryDirectory],
      memoryTokenBudget: 512,
      maxRunDurationMs: 1000,
      maxOutputBytes: 1024,
      runHistoryLimit: 10,
    };
    const worker = startWorker({ config, database, pollIntervalMs: 250 });
    const started = await waitFor(
      () => database.query('SELECT * FROM worker_state').get() !== null,
    );
    expect(started).toBe(true);
    process.emit('SIGTERM');
    await worker;
    expect(database.query('SELECT * FROM worker_state').get()).toBeNull();
  });
});

async function waitFor(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return true;
    }
    await Bun.sleep(5);
  }
  return false;
}
