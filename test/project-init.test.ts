import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjectConfigPath, loadConfig } from '../src/config/config.js';
import { findProjectRoot, initializeProject } from '../src/config/project.js';
import { openDatabase } from '../src/db/database.js';

describe('project-local initialization', () => {
  let parent: string;
  let project: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'automation-project-init-'));
    project = join(parent, 'repository');
    await mkdir(project);
    const gitInit = Bun.spawnSync(['git', 'init', '-q', project], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(gitInit.exitCode).toBe(0);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  test('initializes at the repository root and discovers it from nested directories', async () => {
    const nested = join(project, 'src', 'feature');
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(project);

    const initialized = await initializeProject(findProjectRoot(nested));
    expect(initialized.projectRoot).toBe(project);
    expect(initialized.automationDirectory).toBe(join(project, '.automation'));
    expect(initialized.configCreated).toBe(true);
    expect(initialized.databaseCreated).toBe(true);
    expect(initialized.config.databasePath).toBe(join(project, '.automation', 'automation.sqlite'));
    expect(await discoverProjectConfigPath(nested)).toBe(
      join(project, '.automation', 'config.json'),
    );

    const discovered = await loadConfig(undefined, nested);
    expect(discovered.databasePath).toBe(initialized.config.databasePath);
    expect(discovered.workspaceRoots).toEqual([project]);
    expect((await stat(initialized.automationDirectory)).mode & 0o777).toBe(0o700);
  });

  test('the init command initializes the repository root and is repeatable', async () => {
    const nested = join(project, 'packages', 'service');
    await mkdir(nested, { recursive: true });
    const externalConfig = join(parent, 'explicit-config.json');
    await Bun.write(externalConfig, JSON.stringify({ databasePath: 'external.sqlite' }));
    const cliPath = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
    const first = Bun.spawnSync(['bun', cliPath, 'init'], {
      cwd: nested,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        AUTOMATION_MCP_CONFIG: externalConfig,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain(`Initialized automation for ${project}`);
    expect(await Bun.file(join(project, '.automation', 'automation.sqlite')).exists()).toBe(true);

    const second = Bun.spawnSync(['bun', cliPath, 'init'], {
      cwd: nested,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        AUTOMATION_MCP_CONFIG: externalConfig,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toContain('(preserved)');
  });

  test('repeat initialization preserves user config and database contents', async () => {
    const first = await initializeProject(project);
    const config = JSON.parse(await readFile(first.config.configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config['memoryTokenBudget'] = 777;
    await Bun.write(first.config.configPath, `${JSON.stringify(config, null, 2)}\n`);

    const database = await openDatabase(first.config.databasePath);
    database
      .query(
        "INSERT INTO todos (id, title, status, created_at, updated_at) VALUES ($id, 'keep', 'open', $now, $now)",
      )
      .run({ id: crypto.randomUUID(), now: new Date().toISOString() });
    database.close();

    const second = await initializeProject(project);
    expect(second.configCreated).toBe(false);
    expect(second.databaseCreated).toBe(false);
    expect(second.config.memoryTokenBudget).toBe(777);

    const reopened = await openDatabase(second.config.databasePath);
    expect(reopened.query('SELECT title FROM todos').get()).toEqual({ title: 'keep' });
    reopened.close();
  });

  test('uses an explicit config override ahead of project discovery', async () => {
    await initializeProject(project);
    const alternatePath = join(parent, 'override.json');
    await Bun.write(alternatePath, JSON.stringify({ databasePath: 'override.sqlite' }));
    expect((await loadConfig(alternatePath, project)).databasePath).toBe(
      join(parent, 'override.sqlite'),
    );
  });
});
