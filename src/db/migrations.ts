import type { Database } from 'bun:sqlite';
import { z } from 'zod';

const userVersionSchema = z.object({ user_version: z.number().int().nonnegative() });

const migrations: readonly string[] = [
  `
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
    CREATE INDEX todos_status_created_idx ON todos(status, created_at DESC);

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
      workspace TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      adapter TEXT NOT NULL CHECK (adapter IN ('opencode', 'codex', 'antigravity', 'generic')),
      adapter_config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      max_runtime_ms INTEGER NOT NULL,
      output_limit_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX jobs_enabled_idx ON jobs(enabled, updated_at);

    CREATE TABLE job_schedule_state (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      last_evaluated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE job_memory (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      token_budget INTEGER NOT NULL CHECK (token_budget BETWEEN 128 AND 8192),
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      started_at TEXT,
      finished_at TEXT,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      exit_code INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, scheduled_for)
    ) STRICT;
    CREATE INDEX runs_job_created_idx ON runs(job_id, created_at DESC);
    CREATE INDEX runs_status_created_idx ON runs(status, created_at);
    CREATE UNIQUE INDEX runs_one_global_active_idx ON runs((1)) WHERE status = 'running';

    CREATE TABLE worker_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      worker_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    ) STRICT;
  `,
];

export function applyMigrations(database: Database): void {
  const rawVersion = database.query('PRAGMA user_version').get();
  const version = userVersionSchema.parse(rawVersion).user_version;
  if (version > migrations.length) {
    throw new Error(`Database schema version ${version} is newer than this application supports.`);
  }

  for (let index = version; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined) {
      throw new Error(`Missing database migration ${index + 1}.`);
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
