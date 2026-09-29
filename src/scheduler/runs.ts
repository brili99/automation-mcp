import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

const runRowSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  trigger: z.enum(['scheduled', 'manual']),
  scheduled_for: z.string().datetime({ offset: true }).nullable(),
  status: runStatusSchema,
  cancel_requested: z.number().int().min(0).max(1),
  started_at: z.string().datetime({ offset: true }).nullable(),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  output: z.string(),
  error: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  created_at: z.string().datetime({ offset: true }),
});

export type Run = {
  id: string;
  jobId: string;
  trigger: 'scheduled' | 'manual';
  scheduledFor: string | null;
  status: RunStatus;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
  error: string | null;
  exitCode: number | null;
  createdAt: string;
};

export class RunRepository {
  public constructor(private readonly database: Database) {}

  public queueManual(jobId: string): Run {
    const validJobId = z.string().uuid().parse(jobId);
    const job = this.database
      .query('SELECT id FROM jobs WHERE id = $id AND enabled = 1')
      .get({ id: validJobId });
    if (job === null) {
      throw new Error(`Enabled job ${validJobId} was not found.`);
    }
    const id = crypto.randomUUID();
    this.database
      .query(
        `INSERT INTO runs (id, job_id, trigger, scheduled_for, status, created_at)
         VALUES ($id, $jobId, 'manual', NULL, 'queued', $now)`,
      )
      .run({ id, jobId: validJobId, now: new Date().toISOString() });
    return this.get(id);
  }

  public get(id: string): Run {
    const validId = z.string().uuid().parse(id);
    const row = this.database.query('SELECT * FROM runs WHERE id = $id').get({ id: validId });
    if (row === null) {
      throw new Error(`Run ${validId} was not found.`);
    }
    return parseRun(row);
  }

  public list(jobId?: string, limit = 100): Run[] {
    const boundedLimit = z.number().int().min(1).max(500).parse(limit);
    const rows =
      jobId === undefined
        ? this.database
            .query('SELECT * FROM runs ORDER BY created_at DESC LIMIT $limit')
            .all({ limit: boundedLimit })
        : this.database
            .query('SELECT * FROM runs WHERE job_id = $jobId ORDER BY created_at DESC LIMIT $limit')
            .all({ jobId: z.string().uuid().parse(jobId), limit: boundedLimit });
    return rows.map(parseRun);
  }

  public getActive(): Run | null {
    const row = this.database.query("SELECT * FROM runs WHERE status = 'running' LIMIT 1").get();
    return row === null ? null : parseRun(row);
  }

  public claimNext(workerId: string): Run | null {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const active = this.database
        .query("SELECT id FROM runs WHERE status = 'running' LIMIT 1")
        .get();
      if (active !== null) {
        this.database.exec('COMMIT');
        return null;
      }
      const queued = this.database
        .query(
          `SELECT runs.id FROM runs
           INNER JOIN jobs ON jobs.id = runs.job_id
           WHERE runs.status = 'queued' AND jobs.enabled = 1
           ORDER BY runs.created_at LIMIT 1`,
        )
        .get();
      if (queued === null) {
        this.database.exec('COMMIT');
        return null;
      }
      const queuedId = z.object({ id: z.string().uuid() }).parse(queued).id;
      const changed = this.database
        .query(
          "UPDATE runs SET status = 'running', started_at = $now WHERE id = $id AND status = 'queued'",
        )
        .run({ now, id: queuedId });
      if (changed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database
        .query(
          'UPDATE worker_state SET heartbeat_at = $now WHERE singleton = 1 AND worker_id = $workerId',
        )
        .run({ now, workerId });
      this.database.exec('COMMIT');
      return this.get(queuedId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public finish(
    id: string,
    result: {
      status: 'succeeded' | 'failed' | 'cancelled';
      output: string;
      error?: string;
      exitCode?: number | null;
    },
  ): Run {
    const validId = z.string().uuid().parse(id);
    const now = new Date().toISOString();
    const changed = this.database
      .query(
        `UPDATE runs SET status = $status, finished_at = $now, output = $output,
          error = $error, exit_code = $exitCode WHERE id = $id AND status = 'running'`,
      )
      .run({
        id: validId,
        status: result.status,
        now,
        output: result.output,
        error: result.error ?? null,
        exitCode: result.exitCode ?? null,
      });
    if (changed.changes !== 1) {
      throw new Error(`Run ${validId} is not active.`);
    }
    return this.get(validId);
  }

  public cancel(id: string): Run {
    const validId = z.string().uuid().parse(id);
    const now = new Date().toISOString();
    const result = this.database
      .query(
        `UPDATE runs
         SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           cancel_requested = CASE WHEN status = 'running' THEN 1 ELSE cancel_requested END,
           finished_at = CASE WHEN status = 'queued' THEN $now ELSE finished_at END
         WHERE id = $id AND status IN ('queued', 'running')`,
      )
      .run({ id: validId, now });
    if (result.changes === 0) {
      throw new Error(`Run ${validId} is not queued or running.`);
    }
    return this.get(validId);
  }

  public recoverInterrupted(): number {
    const now = new Date().toISOString();
    return this.database
      .query("UPDATE runs SET status = 'interrupted', finished_at = $now WHERE status = 'running'")
      .run({ now }).changes;
  }

  public queueScheduled(jobId: string, occurrence: Date): boolean {
    return this.recordScheduled(jobId, occurrence, true);
  }

  public recordScheduled(jobId: string, occurrence: Date, shouldQueue: boolean): boolean {
    const id = crypto.randomUUID();
    const result = this.database
      .query(
        `INSERT OR IGNORE INTO runs (id, job_id, trigger, scheduled_for, status, finished_at, created_at)
         VALUES ($id, $jobId, 'scheduled', $scheduledFor, $status, $finishedAt, $now)`,
      )
      .run({
        id,
        jobId: z.string().uuid().parse(jobId),
        scheduledFor: occurrence.toISOString(),
        status: shouldQueue ? 'queued' : 'cancelled',
        finishedAt: shouldQueue ? null : new Date().toISOString(),
        now: new Date().toISOString(),
      });
    return result.changes === 1;
  }
}

function parseRun(row: unknown): Run {
  const parsed = runRowSchema.parse(row);
  return {
    id: parsed.id,
    jobId: parsed.job_id,
    trigger: parsed.trigger,
    scheduledFor: parsed.scheduled_for,
    status: parsed.status,
    cancelRequested: parsed.cancel_requested === 1,
    startedAt: parsed.started_at,
    finishedAt: parsed.finished_at,
    output: parsed.output,
    error: parsed.error,
    exitCode: parsed.exit_code,
    createdAt: parsed.created_at,
  };
}
