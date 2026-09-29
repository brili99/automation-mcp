import type { Database } from 'bun:sqlite';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { adapterFor } from '../agents/adapters.js';
import type { AppConfig } from '../config/config.js';
import { MemoryRepository } from '../memory/memory.js';
import { agentKindSchema, JobRepository } from '../scheduler/jobs.js';
import { RunRepository } from '../scheduler/runs.js';
import { TodoRepository, todoStatusSchema } from '../todos/repository.js';

export function createMcpServer(database: Database, config: AppConfig): McpServer {
  const server = new McpServer({ name: 'local-agent-automation', version: '0.1.0' });
  const todos = new TodoRepository(database);
  const jobs = new JobRepository(database, config.workspaceRoots);
  const runs = new RunRepository(database);
  const memories = new MemoryRepository(database, config.memoryTokenBudget);
  const textResult = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    'todo_add',
    {
      title: 'Add TODO',
      description: 'Create a TODO independent of scheduled jobs.',
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        description: z.string().max(10_000).optional(),
      },
    },
    async ({ title, description }) =>
      textResult(todos.create({ title, ...(description === undefined ? {} : { description }) })),
  );

  server.registerTool(
    'todo_list',
    {
      title: 'List TODOs',
      description: 'List TODOs, optionally filtered by status.',
      inputSchema: {
        status: todoStatusSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ status, limit }) =>
      textResult(
        todos.list({
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
  );

  server.registerTool(
    'todo_update',
    {
      title: 'Update TODO',
      description: 'Update a TODO title and/or description.',
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(10_000).nullable().optional(),
      },
    },
    async ({ id, title, description }) =>
      textResult(
        todos.update({
          id,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
        }),
      ),
  );

  server.registerTool(
    'todo_complete',
    {
      title: 'Complete TODO',
      description: 'Mark a TODO complete.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => textResult(todos.complete(id)),
  );

  server.registerTool(
    'todo_cancel',
    {
      title: 'Cancel TODO',
      description: 'Cancel a TODO without deleting it.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => textResult(todos.cancel(id)),
  );

  server.registerTool(
    'todo_delete',
    {
      title: 'Delete TODO',
      description: 'Permanently delete a TODO.',
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      todos.delete(id);
      return textResult({ id, deleted: true });
    },
  );

  server.registerTool(
    'job_create',
    {
      title: 'Create scheduled job',
      description:
        'Create a scheduled agent job. Supply the exact cron expression and IANA time zone; neither is generated or modified.',
      inputSchema: {
        name: z.string().trim().min(1).max(200),
        prompt: z.string().trim().min(1).max(20_000),
        workspace: z.string().min(1),
        cronExpression: z.string().min(1).max(200),
        timezone: z.string().min(1).max(100),
        adapter: agentKindSchema,
        adapterConfig: z.record(z.string(), z.unknown()).optional(),
        maxRuntimeMs: z.number().int().min(1000).max(86_400_000).optional(),
        outputLimitBytes: z.number().int().min(1024).max(10_485_760).optional(),
      },
    },
    async ({
      name,
      prompt,
      workspace,
      cronExpression,
      timezone,
      adapter,
      adapterConfig,
      maxRuntimeMs,
      outputLimitBytes,
    }) => {
      const job = await jobs.create({
        name,
        prompt,
        workspace,
        cronExpression,
        timezone,
        adapter,
        ...(adapterConfig === undefined ? {} : { adapterConfig }),
        maxRuntimeMs: maxRuntimeMs ?? config.maxRunDurationMs,
        outputLimitBytes: outputLimitBytes ?? config.maxOutputBytes,
      });
      try {
        await adapterFor(job.adapter).preflight(job);
        return textResult(jobs.setEnabled(job.id, true));
      } catch (error) {
        throw new Error(
          `Job ${job.id} is saved paused because adapter preflight failed: ${errorMessage(error)}`,
        );
      }
    },
  );

  server.registerTool(
    'job_list',
    {
      title: 'List scheduled jobs',
      description: 'List configured jobs and their enabled state.',
      inputSchema: {},
    },
    async () => textResult(jobs.list()),
  );

  server.registerTool(
    'job_update',
    {
      title: 'Update scheduled job',
      description:
        'Update a job. Cron expression and IANA time zone are required and are saved exactly as supplied.',
      inputSchema: {
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200).optional(),
        prompt: z.string().trim().min(1).max(20_000).optional(),
        workspace: z.string().min(1).optional(),
        cronExpression: z.string().min(1).max(200),
        timezone: z.string().min(1).max(100),
        adapter: agentKindSchema.optional(),
        adapterConfig: z.record(z.string(), z.unknown()).optional(),
        maxRuntimeMs: z.number().int().min(1000).max(86_400_000).optional(),
        outputLimitBytes: z.number().int().min(1024).max(10_485_760).optional(),
      },
    },
    async ({
      id,
      name,
      prompt,
      workspace,
      cronExpression,
      timezone,
      adapter,
      adapterConfig,
      maxRuntimeMs,
      outputLimitBytes,
    }) => {
      const wasEnabled = jobs.get(id).enabled;
      const job = await jobs.update({
        id,
        cronExpression,
        timezone,
        ...(name === undefined ? {} : { name }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(adapter === undefined ? {} : { adapter }),
        ...(adapterConfig === undefined ? {} : { adapterConfig }),
        ...(maxRuntimeMs === undefined ? {} : { maxRuntimeMs }),
        ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
      });
      try {
        await adapterFor(job.adapter).preflight(job);
        return textResult(wasEnabled ? jobs.setEnabled(job.id, true) : job);
      } catch (error) {
        throw new Error(
          `Job ${job.id} is saved paused because adapter preflight failed: ${errorMessage(error)}`,
        );
      }
    },
  );

  server.registerTool(
    'job_set_enabled',
    {
      title: 'Enable or pause job',
      description: 'Enable or pause a scheduled job without changing its saved schedule.',
      inputSchema: { id: z.string().uuid(), enabled: z.boolean() },
    },
    async ({ id, enabled }) => {
      if (enabled) {
        const job = jobs.get(id);
        await adapterFor(job.adapter).preflight(job);
      }
      return textResult(jobs.setEnabled(id, enabled));
    },
  );

  server.registerTool(
    'job_run_now',
    {
      title: 'Queue immediate job run',
      description: 'Queue a manual run and return its execution ID for polling.',
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => textResult(runs.queueManual(jobId)),
  );

  server.registerTool(
    'run_status',
    {
      title: 'Read run status',
      description: 'Read the status of an execution.',
      inputSchema: { runId: z.string().uuid() },
    },
    async ({ runId }) => textResult(runs.get(runId)),
  );

  server.registerTool(
    'run_history',
    {
      title: 'Read run history',
      description: 'Read recent execution history, optionally filtered to one job.',
      inputSchema: {
        jobId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ jobId, limit }) => textResult(runs.list(jobId, limit ?? 100)),
  );

  server.registerTool(
    'run_cancel',
    {
      title: 'Cancel execution',
      description: 'Cancel a queued run or request cancellation of an active run.',
      inputSchema: { runId: z.string().uuid() },
    },
    async ({ runId }) => textResult(runs.cancel(runId)),
  );

  server.registerTool(
    'job_memory_get',
    {
      title: 'Read job memory',
      description: 'Inspect the persistent note for one job.',
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => textResult(memories.get(jobId)),
  );

  server.registerTool(
    'job_memory_set',
    {
      title: 'Edit job memory',
      description:
        'Replace a job memory note. Credentials/secrets are rejected and the note must fit its token budget.',
      inputSchema: {
        jobId: z.string().uuid(),
        note: z
          .object({
            decisions: z.array(z.string().trim().min(1).max(2000)).max(50),
            currentState: z.array(z.string().trim().min(1).max(2000)).max(50),
            constraints: z.array(z.string().trim().min(1).max(2000)).max(50),
            nextSteps: z.array(z.string().trim().min(1).max(2000)).max(50),
          })
          .strict(),
        tokenBudget: z.number().int().min(128).max(8192).optional(),
      },
    },
    async ({ jobId, note, tokenBudget }) =>
      textResult(memories.set(jobId, note, tokenBudget ?? config.memoryTokenBudget)),
  );

  server.registerTool(
    'job_memory_clear',
    {
      title: 'Clear job memory',
      description: 'Clear a job memory note without changing run history.',
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => textResult({ jobId, cleared: memories.clear(jobId) }),
  );

  return server;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
