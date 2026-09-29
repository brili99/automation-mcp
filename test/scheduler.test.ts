import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, OpenCodeAdapter } from '../src/agents/adapters.js';
import { runBoundedProcess } from '../src/agents/process.js';
import { openMemoryDatabase } from '../src/db/database.js';
import { JobRepository } from '../src/scheduler/jobs.js';
import { RunRepository } from '../src/scheduler/runs.js';
import { nextOccurrence, validateSchedule } from '../src/scheduler/schedule.js';
import { pollSchedules } from '../src/scheduler/worker.js';

describe('scheduler and process execution', () => {
  let database: Database;
  let workspaceRoot: string;
  let workspace: string;

  beforeEach(async () => {
    database = openMemoryDatabase();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'automation-workspaces-'));
    workspace = join(workspaceRoot, 'project');
    await mkdir(workspace);
  });

  afterEach(async () => {
    database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test('preserves explicit cron and IANA time zone and calculates next occurrence', () => {
    const schedule = validateSchedule('*/5 * * * *', 'America/New_York');
    expect(schedule.cronExpression).toBe('*/5 * * * *');
    expect(schedule.timezone).toBe('America/New_York');
    expect(nextOccurrence(schedule, new Date('2026-01-15T14:02:00.000Z')).toISOString()).toBe(
      '2026-01-15T14:05:00.000Z',
    );
    expect(() => validateSchedule('bad schedule', 'Mars/Olympus')).toThrow();
  });

  test('queues recent occurrences once and skips old downtime occurrences', async () => {
    const job = await createJob({ cronExpression: '* * * * *', timezone: 'UTC' });
    const now = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
    const createdAt = new Date(now.getTime() - 60_000).toISOString();
    database
      .query('UPDATE job_schedule_state SET last_evaluated_at = $createdAt WHERE job_id = $jobId')
      .run({ createdAt, jobId: job.id });

    pollSchedules(database, now, 65_000);
    const firstCount = new RunRepository(database).list(job.id, 100).length;
    pollSchedules(database, now, 65_000);
    expect(new RunRepository(database).list(job.id, 100)).toHaveLength(firstCount);

    const oldCursor = new Date(now.getTime() - 3_600_000).toISOString();
    database
      .query('UPDATE job_schedule_state SET last_evaluated_at = $oldCursor WHERE job_id = $jobId')
      .run({ oldCursor, jobId: job.id });
    const skippedPollNow = new Date(now.getTime() + 20_000);
    pollSchedules(database, skippedPollNow, 1000);
    const state = database
      .query('SELECT last_evaluated_at FROM job_schedule_state WHERE job_id = $jobId')
      .get({ jobId: job.id });
    expect(state).toEqual({ last_evaluated_at: skippedPollNow.toISOString() });
  });

  test('prevents duplicate scheduled occurrence and only one active claim', async () => {
    const job = await createJob({ cronExpression: '0 0 * * *', timezone: 'UTC' });
    new JobRepository(database, [workspaceRoot]).setEnabled(job.id, true);
    const runs = new RunRepository(database);
    const occurrence = new Date('2026-01-01T00:00:00.000Z');
    expect(runs.queueScheduled(job.id, occurrence)).toBe(true);
    expect(runs.queueScheduled(job.id, occurrence)).toBe(false);
    const first = runs.claimNext('test-worker');
    expect(first?.status).toBe('running');
    expect(runs.claimNext('test-worker')).toBeNull();
    expect(runs.cancel(first?.id ?? '')).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
    expect(runs.finish(first?.id ?? '', { status: 'cancelled', output: '' }).status).toBe(
      'cancelled',
    );
  });

  test('uses fixed argv and workspace-only policies for first-party agents', async () => {
    const job = await createJob({ cronExpression: '0 0 * * *', timezone: 'UTC' });
    const openCode = new OpenCodeAdapter().buildInvocation(
      job,
      'task; touch /tmp/not-shell-expanded',
    );
    expect(openCode.args).toContain('task; touch /tmp/not-shell-expanded');
    expect(openCode.environmentOverrides?.['OPENCODE_PERMISSION']).toContain('external_directory');
    expect(new CodexAdapter().buildInvocation({ ...job, adapter: 'codex' }, 'task').args).toContain(
      'workspace-write',
    );
  });

  test('runs fake process with bounded output and honors cancellation', async () => {
    const output = await runBoundedProcess(
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        environmentVariables: [],
      },
      workspace,
      2000,
      4096,
      new AbortController().signal,
    );
    expect(output.output).toBe(workspace);
    expect(output.exitCode).toBe(0);

    await expect(
      runBoundedProcess(
        {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('x'.repeat(10000))"],
          environmentVariables: [],
        },
        workspace,
        2000,
        1024,
        new AbortController().signal,
      ),
    ).rejects.toThrow('output exceeded');

    const abort = new AbortController();
    const processResult = runBoundedProcess(
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        environmentVariables: [],
      },
      workspace,
      5000,
      1024,
      abort.signal,
    );
    abort.abort();
    await expect(processResult).rejects.toThrow('cancelled');
  });

  test('schedule updates and pausing cancel stale queued occurrences', async () => {
    const jobs = new JobRepository(database, [workspaceRoot]);
    const job = await createJob({ cronExpression: '0 0 * * *', timezone: 'UTC' });
    const runs = new RunRepository(database);
    const queued = runs.queueScheduled(job.id, new Date('2026-01-01T00:00:00.000Z'));
    expect(queued).toBe(true);
    const updatedJob = await jobs.update({
      id: job.id,
      cronExpression: '0 1 * * *',
      timezone: 'UTC',
    });
    expect(updatedJob.enabled).toBe(false);
    expect(runs.list(job.id)[0]?.status).toBe('cancelled');
    jobs.setEnabled(job.id, true);
    const manual = runs.queueManual(job.id);
    expect(jobs.setEnabled(job.id, false).enabled).toBe(false);
    expect(runs.get(manual.id).status).toBe('cancelled');
  });

  async function createJob(schedule: { cronExpression: string; timezone: string }) {
    const job = await new JobRepository(database, [workspaceRoot]).create({
      name: 'Test job',
      prompt: 'Run deterministic fake tests',
      workspace,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      adapter: 'opencode',
    });
    return new JobRepository(database, [workspaceRoot]).setEnabled(job.id, true);
  }
});
