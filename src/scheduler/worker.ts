import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { adapterFor } from '../agents/adapters.js';
import type { ProcessAgentAdapter } from '../agents/process.js';
import { type AppConfig, loadConfig } from '../config/config.js';
import { openDatabase } from '../db/database.js';
import { extractMemoryUpdate, MemoryRepository, memoryContext } from '../memory/memory.js';
import { redactSecrets } from '../security/secrets.js';
import { type Job, JobRepository } from './jobs.js';
import { type Run, RunRepository } from './runs.js';
import { occurrencesBetween, validateSchedule } from './schedule.js';

const scheduleStateSchema = z.object({
  job_id: z.string().uuid(),
  last_evaluated_at: z.string().datetime({ offset: true }),
});

export type WorkerOptions = {
  config?: AppConfig;
  database?: Database;
  pollIntervalMs?: number;
  now?: () => Date;
  adapters?: Partial<Record<Job['adapter'], ProcessAgentAdapter>>;
};

export function pollSchedules(
  database: Database,
  now = new Date(),
  recentOccurrenceMs = 5000,
): number {
  const jobIds = database.query('SELECT id FROM jobs WHERE enabled = 1 ORDER BY id').all();
  let queued = 0;
  for (const rawJobId of jobIds) {
    const jobId = z.object({ id: z.string().uuid() }).parse(rawJobId).id;
    database.exec('BEGIN IMMEDIATE');
    try {
      const enabledJob = database
        .query('SELECT id FROM jobs WHERE id = $jobId AND enabled = 1')
        .get({ jobId });
      if (enabledJob === null) {
        database.exec('COMMIT');
        continue;
      }
      const job = new JobRepository(database, []).get(jobId);
      const rawState = database
        .query('SELECT job_id, last_evaluated_at FROM job_schedule_state WHERE job_id = $jobId')
        .get({ jobId });
      const state = scheduleStateSchema.parse(rawState);
      const evaluatedAt = new Date(state.last_evaluated_at);
      const cutoff = new Date(now.getTime() - recentOccurrenceMs);
      const scanFrom = evaluatedAt.getTime() > cutoff.getTime() ? evaluatedAt : cutoff;
      const recentDue = occurrencesBetween(
        validateSchedule(job.cronExpression, job.timezone),
        scanFrom,
        now,
        100,
      );
      const pending = database
        .query(
          "SELECT id FROM runs WHERE job_id = $jobId AND status IN ('queued', 'running') LIMIT 1",
        )
        .get({ jobId });
      const latestOccurrence = recentDue.at(-1);
      for (const occurrence of recentDue) {
        const shouldQueue = pending === null && occurrence === latestOccurrence;
        if (new RunRepository(database).recordScheduled(jobId, occurrence, shouldQueue)) {
          queued += Number(shouldQueue);
        }
      }
      database
        .query('UPDATE job_schedule_state SET last_evaluated_at = $time WHERE job_id = $jobId')
        .run({ time: now.toISOString(), jobId });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return queued;
}

export async function startWorker(options: WorkerOptions = {}): Promise<void> {
  const config = options.config ?? (await loadConfig());
  const database = options.database ?? (await openDatabase(config.databasePath));
  const ownsDatabase = options.database === undefined;
  const pollIntervalMs = z
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(2000)
    .parse(options.pollIntervalMs);
  const now = options.now ?? (() => new Date());
  const workerId = crypto.randomUUID();
  const startedAt = now().toISOString();
  const jobs = new JobRepository(database, config.workspaceRoots);
  const runs = new RunRepository(database);
  const memory = new MemoryRepository(database, config.memoryTokenBudget);
  const active = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  const controller = new AbortController();
  let polling = false;

  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    acquireWorkerLease(database, workerId, startedAt, runs);

    const poll = async (): Promise<void> => {
      if (polling || controller.signal.aborted) {
        return;
      }
      polling = true;
      try {
        await pollSchedules(database, now());
        database
          .query(
            'UPDATE worker_state SET heartbeat_at = $now WHERE singleton = 1 AND worker_id = $workerId',
          )
          .run({ now: now().toISOString(), workerId });

        const activeRun = runs.getActive();
        if (activeRun?.cancelRequested === true) {
          active.get(activeRun.id)?.controller.abort();
        }

        const claimed = runs.claimNext(workerId);
        if (claimed !== null) {
          const runController = new AbortController();
          const completion = executeRun(
            claimed,
            database,
            jobs,
            runs,
            memory,
            config,
            active,
            options.adapters,
            runController,
          );
          active.set(claimed.id, { controller: runController, completion });
        }
      } catch (error) {
        process.stderr.write(`Worker poll failed: ${errorMessage(error)}\n`);
      } finally {
        polling = false;
      }
    };

    await poll();
    while (!controller.signal.aborted) {
      await wait(pollIntervalMs, controller.signal);
      await poll();
    }
    for (const [runId, state] of active) {
      try {
        runs.cancel(runId);
      } catch {
        // The run may have finished between the active-map snapshot and cancellation.
      }
      state.controller.abort();
    }
    await Promise.all([...active.values()].map(({ completion }) => completion));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    database
      .query('DELETE FROM worker_state WHERE singleton = 1 AND worker_id = $workerId')
      .run({ workerId });
    if (ownsDatabase) {
      database.close();
    }
  }
}

async function executeRun(
  run: Run,
  database: Database,
  jobs: JobRepository,
  runs: RunRepository,
  memory: MemoryRepository,
  config: AppConfig,
  active: Map<string, { controller: AbortController; completion: Promise<void> }>,
  configuredAdapters: WorkerOptions['adapters'],
  runController: AbortController,
): Promise<void> {
  const heartbeat = setInterval(() => {
    database
      .query('UPDATE worker_state SET heartbeat_at = $now WHERE singleton = 1')
      .run({ now: new Date().toISOString() });
    const current = runs.get(run.id);
    if (current.cancelRequested) {
      runController.abort();
    }
  }, 1000);

  let output = '';
  let finalStatus: 'succeeded' | 'failed' | 'cancelled' = 'failed';
  let errorText: string | undefined;
  let exitCode: number | null = null;
  try {
    const job = jobs.get(run.jobId);
    const adapter = configuredAdapters?.[job.adapter] ?? adapterFor(job.adapter);
    await adapter.preflight(job);
    const currentMemory = memory.get(job.id);
    const result = await adapter.run({
      job,
      prompt: job.prompt,
      memoryContext: memoryContext(currentMemory),
      signal: runController.signal,
    });
    output = redactSecrets(result.output);
    exitCode = result.exitCode;
    finalStatus = result.exitCode === 0 ? 'succeeded' : 'failed';

    const update = extractMemoryUpdate(result.output);
    if (update !== null) {
      try {
        memory.applyUpdate(job.id, update);
      } catch (memoryError) {
        errorText = `Run completed, but memory was unchanged: ${errorMessage(memoryError)}`;
      }
    }
  } catch (error) {
    errorText = errorMessage(error);
    const current = runs.get(run.id);
    finalStatus = current.cancelRequested ? 'cancelled' : 'failed';
  } finally {
    clearInterval(heartbeat);
    active.delete(run.id);
    try {
      runs.finish(run.id, {
        status: finalStatus,
        output,
        ...(errorText === undefined ? {} : { error: redactSecrets(errorText) }),
        exitCode,
      });
      pruneHistory(database, config.runHistoryLimit);
    } catch (error) {
      process.stderr.write(`Could not persist run ${run.id} outcome: ${errorMessage(error)}\n`);
    }
  }
}

function isProcessLookupError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

export function acquireWorkerLease(
  database: Database,
  workerId: string,
  startedAt: string,
  runs: RunRepository,
): number {
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database
      .query('SELECT worker_id, pid FROM worker_state WHERE singleton = 1')
      .get();
    if (existing !== null) {
      const workerState = z
        .object({ worker_id: z.string(), pid: z.number().int() })
        .parse(existing);
      try {
        process.kill(workerState.pid, 0);
        throw new Error(
          `Worker ${workerState.worker_id} is already running with PID ${workerState.pid}.`,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Worker ')) {
          throw error;
        }
        if (!isProcessLookupError(error)) {
          throw error;
        }
      }
    }
    database
      .query(
        `INSERT INTO worker_state (singleton, worker_id, pid, started_at, heartbeat_at)
         VALUES (1, $workerId, $pid, $now, $now)
         ON CONFLICT(singleton) DO UPDATE SET worker_id = excluded.worker_id,
           pid = excluded.pid, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
      )
      .run({ workerId, pid: process.pid, now: startedAt });
    const recovered = runs.recoverInterrupted();
    database.exec('COMMIT');
    return recovered;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function pruneHistory(database: Database, limit: number): void {
  database
    .query(
      `DELETE FROM runs WHERE id IN (
        SELECT id FROM runs WHERE status != 'running'
        ORDER BY created_at DESC LIMIT -1 OFFSET $keep
      )`,
    )
    .run({ keep: limit });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
