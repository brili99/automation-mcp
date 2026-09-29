import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openMemoryDatabase } from '../src/db/database.js';
import { JobRepository } from '../src/scheduler/jobs.js';

describe('MCP tool registration', () => {
  let database: Database;
  let temporaryDirectory: string;

  beforeEach(async () => {
    database = openMemoryDatabase();
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'automation-mcp-tests-'));
  });

  afterEach(async () => {
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('registers the focused TODO/job/run/memory tool surface over stdio', async () => {
    const response = await listToolsOverStdio();
    const names = response.tools.map((tool) => tool.name);
    expect(names).toContain('todo_add');
    expect(names).toContain('job_create');
    expect(names).toContain('job_set_enabled');
    expect(names).toContain('run_status');
    expect(names).toContain('job_memory_clear');
  });

  test('requires explicit cron expression and timezone in the advertised schema', async () => {
    const response = await listToolsOverStdio();
    const update = response.tools.find((tool) => tool.name === 'job_update');
    const schema = z
      .object({ type: z.literal('object'), required: z.array(z.string()) })
      .parse(update?.inputSchema);
    expect(schema.required).toContain('cronExpression');
    expect(schema.required).toContain('timezone');
  });

  test('new jobs remain paused until adapter preflight', async () => {
    const workspace = join(temporaryDirectory, 'workspace');
    await mkdir(workspace);
    const job = await new JobRepository(database, [workspace]).create({
      name: 'Paused until verified',
      prompt: 'Test preflight gating',
      workspace,
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      adapter: 'opencode',
    });
    expect(job.enabled).toBe(false);
    expect(job.maxRuntimeMs).toBe(3_600_000);
    expect(job.outputLimitBytes).toBe(1_048_576);
  });

  async function listToolsOverStdio(): Promise<{
    tools: Array<{ name: string; inputSchema: unknown }>;
  }> {
    const configPath = join(temporaryDirectory, 'config.json');
    await Bun.write(
      configPath,
      JSON.stringify({ workspaceRoots: [temporaryDirectory], databasePath: 'mcp.sqlite' }),
    );
    const scriptPath = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
    const child = Bun.spawn(['bun', scriptPath, 'mcp'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, AUTOMATION_MCP_CONFIG: configPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const response = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .map((message) =>
        z.object({ id: z.number().optional(), result: z.unknown().optional() }).parse(message),
      )
      .find((message) => message.id === 2);
    return z
      .object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })) })
      .parse(response?.result);
  }
});
