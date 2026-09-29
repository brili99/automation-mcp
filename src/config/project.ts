import { spawnSync } from 'node:child_process';
import { access, chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/database.js';
import { type AppConfig, loadConfig } from './config.js';

export type ProjectInitialization = {
  projectRoot: string;
  automationDirectory: string;
  config: AppConfig;
  configCreated: boolean;
  databaseCreated: boolean;
};

export function findProjectRoot(directory = process.cwd()): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    return resolve(result.stdout.trim());
  }
  return resolve(directory);
}

export async function initializeProject(directory = process.cwd()): Promise<ProjectInitialization> {
  const projectRoot = await realpath(resolve(directory));
  const automationDirectory = join(projectRoot, '.automation');
  await ensureAutomationDirectory(automationDirectory);

  const configPath = join(automationDirectory, 'config.json');
  const configCreated = await createConfigIfMissing(configPath, projectRoot);
  const config = await loadConfig(configPath);
  const databaseCreated = !(await pathExists(config.databasePath));
  const database = await openDatabase(config.databasePath);
  database.close();

  return { projectRoot, automationDirectory, config, configCreated, databaseCreated };
}

async function ensureAutomationDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to initialize a non-directory or symlink at ${path}.`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

async function createConfigIfMissing(path: string, projectRoot: string): Promise<boolean> {
  const config = {
    databasePath: 'automation.sqlite',
    workspaceRoots: [projectRoot],
    memoryTokenBudget: 1200,
    maxRunDurationMs: 3_600_000,
    maxOutputBytes: 1_048_576,
    runHistoryLimit: 500,
  };
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
