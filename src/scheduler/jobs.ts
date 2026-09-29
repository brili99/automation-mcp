import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { resolveApprovedWorkspace } from '../config/workspaces.js';
import { assertNoSecrets } from '../security/secrets.js';
import { validateSchedule } from './schedule.js';

export const agentKindSchema = z.enum(['opencode', 'codex', 'antigravity', 'generic']);
export type AgentKind = z.infer<typeof agentKindSchema>;

const jobRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prompt: z.string(),
  workspace: z.string(),
  cron_expression: z.string(),
  timezone: z.string(),
  adapter: agentKindSchema,
  adapter_config: z.string(),
  enabled: z.number().int().min(0).max(1),
  max_runtime_ms: z.number().int(),
  output_limit_bytes: z.number().int(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export type Job = {
  id: string;
  name: string;
  prompt: string;
  workspace: string;
  cronExpression: string;
  timezone: string;
  adapter: AgentKind;
  adapterConfig: Record<string, unknown>;
  enabled: boolean;
  maxRuntimeMs: number;
  outputLimitBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateJobInput = {
  name: string;
  prompt: string;
  workspace: string;
  cronExpression: string;
  timezone: string;
  adapter: AgentKind;
  adapterConfig?: Record<string, unknown>;
  maxRuntimeMs?: number;
  outputLimitBytes?: number;
};

export type UpdateJobInput = {
  id: string;
  name?: string;
  prompt?: string;
  workspace?: string;
  cronExpression: string;
  timezone: string;
  adapter?: AgentKind;
  adapterConfig?: Record<string, unknown>;
  maxRuntimeMs?: number;
  outputLimitBytes?: number;
};

export class JobRepository {
  public constructor(
    private readonly database: Database,
    private readonly approvedWorkspaceRoots: readonly string[],
  ) {}

  public async create(input: CreateJobInput): Promise<Job> {
    const fields = await validateJobInput(input, this.approvedWorkspaceRoots);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .query(
          `INSERT INTO jobs (
            id, name, prompt, workspace, cron_expression, timezone, adapter, adapter_config,
            enabled, max_runtime_ms, output_limit_bytes, created_at, updated_at
          ) VALUES ($id, $name, $prompt, $workspace, $cron, $timezone, $adapter, $config, 0, $runtime, $outputLimit, $now, $now)`,
        )
        .run({
          id,
          name: fields.name,
          prompt: fields.prompt,
          workspace: fields.workspace,
          cron: fields.cronExpression,
          timezone: fields.timezone,
          adapter: fields.adapter,
          config: JSON.stringify(fields.adapterConfig),
          runtime: fields.maxRuntimeMs,
          outputLimit: fields.outputLimitBytes,
          now,
        });
      this.database
        .query('INSERT INTO job_schedule_state (job_id, last_evaluated_at) VALUES ($id, $now)')
        .run({ id, now });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  public async update(input: UpdateJobInput): Promise<Job> {
    const id = z.string().uuid().parse(input.id);
    const current = this.get(id);
    const merged: CreateJobInput = {
      name: input.name ?? current.name,
      prompt: input.prompt ?? current.prompt,
      workspace: input.workspace ?? current.workspace,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      adapter: input.adapter ?? current.adapter,
      adapterConfig: input.adapterConfig ?? current.adapterConfig,
      maxRuntimeMs: input.maxRuntimeMs ?? current.maxRuntimeMs,
      outputLimitBytes: input.outputLimitBytes ?? current.outputLimitBytes,
    };
    const fields = await validateJobInput(merged, this.approvedWorkspaceRoots);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .query(
          `UPDATE jobs SET name = $name, prompt = $prompt, workspace = $workspace,
          cron_expression = $cron, timezone = $timezone, adapter = $adapter,
          adapter_config = $config, max_runtime_ms = $runtime,
          output_limit_bytes = $outputLimit, enabled = 0, updated_at = $now WHERE id = $id`,
        )
        .run({
          id,
          name: fields.name,
          prompt: fields.prompt,
          workspace: fields.workspace,
          cron: fields.cronExpression,
          timezone: fields.timezone,
          adapter: fields.adapter,
          config: JSON.stringify(fields.adapterConfig),
          runtime: fields.maxRuntimeMs,
          outputLimit: fields.outputLimitBytes,
          now,
        });
      this.database
        .query('UPDATE job_schedule_state SET last_evaluated_at = $now WHERE job_id = $id')
        .run({ id, now });
      this.database
        .query(
          `UPDATE runs SET status = 'cancelled', finished_at = $now
           WHERE job_id = $id AND trigger = 'scheduled' AND status = 'queued'`,
        )
        .run({ id, now });
      this.database
        .query(
          `UPDATE runs SET status = 'cancelled', finished_at = $now
           WHERE job_id = $id AND trigger = 'scheduled' AND status = 'queued'`,
        )
        .run({ id, now });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  public get(id: string): Job {
    const validId = z.string().uuid().parse(id);
    const row = this.database.query('SELECT * FROM jobs WHERE id = $id').get({ id: validId });
    if (row === null) {
      throw new Error(`Job ${validId} was not found.`);
    }
    return parseJob(row);
  }

  public list(): Job[] {
    return this.database.query('SELECT * FROM jobs ORDER BY created_at DESC').all().map(parseJob);
  }

  public setEnabled(id: string, enabled: boolean): Job {
    const validId = z.string().uuid().parse(id);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    let changes: number;
    try {
      changes = this.database
        .query('UPDATE jobs SET enabled = $enabled, updated_at = $now WHERE id = $id')
        .run({ id: validId, enabled: enabled ? 1 : 0, now }).changes;
      this.database
        .query('UPDATE job_schedule_state SET last_evaluated_at = $now WHERE job_id = $id')
        .run({ id: validId, now });
      if (!enabled) {
        this.database
          .query(
            `UPDATE runs SET status = 'cancelled', finished_at = $now
             WHERE job_id = $id AND status = 'queued'`,
          )
          .run({ id: validId, now });
      }
      if (!enabled) {
        this.database
          .query(
            `UPDATE runs SET status = 'cancelled', finished_at = $now
             WHERE job_id = $id AND status = 'queued'`,
          )
          .run({ id: validId, now });
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    if (changes === 0) {
      throw new Error(`Job ${validId} was not found.`);
    }
    return this.get(validId);
  }
}

async function validateJobInput(
  input: CreateJobInput,
  approvedWorkspaceRoots: readonly string[],
): Promise<
  CreateJobInput & {
    workspace: string;
    cronExpression: string;
    timezone: string;
    adapterConfig: Record<string, unknown>;
    maxRuntimeMs: number;
    outputLimitBytes: number;
  }
> {
  const name = z.string().trim().min(1).max(200).parse(input.name);
  const prompt = z.string().trim().min(1).max(20_000).parse(input.prompt);
  assertNoSecrets(prompt, 'Job prompt');
  assertNoSecrets(input.adapterConfig ?? {}, 'Adapter configuration');
  const workspace = await resolveApprovedWorkspace(input.workspace, approvedWorkspaceRoots);
  const schedule = validateSchedule(input.cronExpression, input.timezone);
  const adapter = agentKindSchema.parse(input.adapter);
  const adapterConfig = z
    .record(z.string(), z.unknown())
    .default({})
    .parse(input.adapterConfig ?? {});
  const maxRuntimeMs = z
    .number()
    .int()
    .min(1000)
    .max(86_400_000)
    .default(3_600_000)
    .parse(input.maxRuntimeMs);
  const outputLimitBytes = z
    .number()
    .int()
    .min(1024)
    .max(10_485_760)
    .default(1_048_576)
    .parse(input.outputLimitBytes);

  return {
    name,
    prompt,
    workspace,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    adapter,
    adapterConfig,
    maxRuntimeMs,
    outputLimitBytes,
  };
}

function parseJob(row: unknown): Job {
  const parsed = jobRowSchema.parse(row);
  let config: unknown;
  try {
    config = JSON.parse(parsed.adapter_config) as unknown;
  } catch {
    throw new Error(`Job ${parsed.id} contains invalid adapter configuration JSON.`);
  }
  const adapterConfig = z.record(z.string(), z.unknown()).parse(config);
  return {
    id: parsed.id,
    name: parsed.name,
    prompt: parsed.prompt,
    workspace: parsed.workspace,
    cronExpression: parsed.cron_expression,
    timezone: parsed.timezone,
    adapter: parsed.adapter,
    adapterConfig,
    enabled: parsed.enabled === 1,
    maxRuntimeMs: parsed.max_runtime_ms,
    outputLimitBytes: parsed.output_limit_bytes,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}
