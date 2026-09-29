import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDatabase } from '../src/db/database.js';
import {
  createDashboardHandler,
  readDashboardSnapshot,
  startDashboard,
} from '../src/ui/dashboard.js';

describe('read-only dashboard', () => {
  let database: Database;

  beforeEach(() => {
    database = openMemoryDatabase();
  });

  afterEach(() => database.close());

  test('reports worker absence and empty jobs/runs', () => {
    const snapshot = readDashboardSnapshot(database);
    expect(snapshot.worker.healthy).toBe(false);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.recentRuns).toEqual([]);
  });

  test('never exposes persisted agent output in the status snapshot', () => {
    const jobId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO jobs (id, name, prompt, workspace, cron_expression, timezone, adapter,
        adapter_config, enabled, max_runtime_ms, output_limit_bytes, created_at, updated_at)
       VALUES ($id, 'redacted', 'prompt', '/tmp', '0 0 * * *', 'UTC', 'opencode', '{}', 1, 1000, 1024, $now, $now)`,
      )
      .run({ id: jobId, now });
    database
      .query(
        `INSERT INTO runs (id, job_id, trigger, status, output, created_at)
       VALUES ($id, $jobId, 'manual', 'succeeded', 'sensitive output must not appear', $now)`,
      )
      .run({ id: runId, jobId, now });

    const snapshot = readDashboardSnapshot(database);
    expect(JSON.stringify(snapshot)).not.toContain('sensitive output');
  });

  test('serves status over GET and rejects mutation methods', async () => {
    const handler = createDashboardHandler(database);
    const get = handler(
      new Request('http://127.0.0.1/api/status', { headers: { host: '127.0.0.1' } }),
    );
    expect(get.status).toBe(200);
    expect((await get.json()).worker.healthy).toBe(false);
    expect(
      handler(
        new Request('http://127.0.0.1/api/status', {
          method: 'POST',
          headers: { host: '127.0.0.1' },
        }),
      ).status,
    ).toBe(405);
  });

  test('binds only to IPv4 localhost', () => {
    expect(() => startDashboard(database, { hostname: '0.0.0.0' })).toThrow();
  });
});
