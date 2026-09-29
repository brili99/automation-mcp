import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDatabase } from '../src/db/database.js';
import { extractMemoryUpdate, MemoryRepository, memoryContext } from '../src/memory/memory.js';
import { JobRepository } from '../src/scheduler/jobs.js';

describe('per-job persistent memory', () => {
  let database: Database;
  let workspaceRoot: string;
  let workspace: string;
  let memories: MemoryRepository;

  beforeEach(async () => {
    database = openMemoryDatabase();
    workspaceRoot = await mkdtemp(join(tmpdir(), 'automation-memory-'));
    workspace = join(workspaceRoot, 'project');
    await mkdir(workspace);
    memories = new MemoryRepository(database, 512);
  });

  afterEach(async () => {
    database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test('persists notes independently for each job and can clear one', async () => {
    const jobs = new JobRepository(database, [workspaceRoot]);
    const first = await createJob(jobs, 'First');
    const second = await createJob(jobs, 'Second');
    memories.set(first.id, {
      decisions: ['use UTC'],
      currentState: [],
      constraints: [],
      nextSteps: [],
    });
    memories.set(second.id, {
      decisions: [],
      currentState: ['separate state'],
      constraints: [],
      nextSteps: [],
    });

    expect(memories.get(first.id)?.note.decisions).toEqual(['use UTC']);
    expect(memories.get(second.id)?.note.currentState).toEqual(['separate state']);
    expect(memoryContext(memories.get(first.id))).toContain('untrusted task context');
    expect(memories.clear(first.id)).toBe(true);
    expect(memories.get(first.id)).toBeNull();
    expect(memories.get(second.id)).not.toBeNull();
  });

  test('rejects memory over budget and preserves the previous valid value', async () => {
    const job = await createJob(new JobRepository(database, [workspaceRoot]), 'Budget');
    const original = memories.set(
      job.id,
      {
        decisions: ['stable decision'],
        currentState: ['stable state'],
        constraints: [],
        nextSteps: [],
      },
      128,
    );

    const tooLarge = {
      decisions: ['x'.repeat(900)],
      currentState: [],
      constraints: [],
      nextSteps: [],
    };
    expect(() => memories.applyUpdate(job.id, tooLarge)).toThrow('cannot be compacted');
    expect(memories.get(job.id)).toEqual(original);
  });

  test('compacts old detail when the budget allows and rejects credential-shaped content', async () => {
    const job = await createJob(new JobRepository(database, [workspaceRoot]), 'Compact');
    memories.set(
      job.id,
      {
        decisions: ['d'.repeat(100), 'new decision'],
        currentState: ['s'.repeat(100), 'current state'],
        constraints: ['keep this constraint'],
        nextSteps: ['n'.repeat(100), 'new step'],
      },
      180,
    );
    const updated = memories.applyUpdate(job.id, {
      decisions: [],
      currentState: [],
      constraints: [],
      nextSteps: Array.from({ length: 10 }, (_, index) => `step ${index} ${'z'.repeat(60)}`),
    });
    expect(updated.compacted).toBe(true);
    expect(updated.memory.tokenEstimate).toBeLessThanOrEqual(180);
    expect(() =>
      memories.set(job.id, {
        decisions: ['api_key=should-not-persist'],
        currentState: [],
        constraints: [],
        nextSteps: [],
      }),
    ).toThrow('credential or secret');
  });

  test('validates structured memory updates from untrusted output', () => {
    const note = {
      decisions: ['retain transaction boundary'],
      currentState: [],
      constraints: [],
      nextSteps: [],
    };
    expect(
      extractMemoryUpdate(
        `Agent summary\nAUTOMATION_MEMORY_UPDATE_BEGIN\n${JSON.stringify(note)}\nAUTOMATION_MEMORY_UPDATE_END`,
      ),
    ).toEqual(note);
    expect(
      extractMemoryUpdate(
        'AUTOMATION_MEMORY_UPDATE_BEGIN\n{"decisions":["password=bad"],"currentState":[],"constraints":[],"nextSteps":[]}\nAUTOMATION_MEMORY_UPDATE_END',
      ),
    ).toBeNull();
    expect(extractMemoryUpdate('unstructured output')).toBeNull();
  });

  async function createJob(repository: JobRepository, name: string) {
    return repository.create({
      name,
      prompt: 'Maintain the job memory note',
      workspace,
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      adapter: 'opencode',
    });
  }
});
