#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { openDatabase } from '../db/database.js';
import { startMcpServer } from '../mcp/stdio.js';
import { startWorker } from '../scheduler/worker.js';
import { startDashboard } from '../ui/dashboard.js';

const args = Bun.argv.slice(2);

async function main(): Promise<void> {
  const [command, ...commandArgs] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'mcp':
      await startMcpServer();
      return;
    case 'worker':
      await startWorker();
      return;
    case 'ui':
      await runUi(commandArgs);
      return;
    case 'service':
      await runService(commandArgs);
      return;
    case 'version':
      process.stdout.write('0.1.0\n');
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runUi(commandArgs: string[]): Promise<void> {
  const config = await loadConfig();
  const database = await openDatabase(config.databasePath);
  const hostIndex = commandArgs.indexOf('--host');
  const portIndex = commandArgs.indexOf('--port');
  const hostname = hostIndex === -1 ? '127.0.0.1' : commandArgs[hostIndex + 1];
  if (hostname !== '127.0.0.1') {
    database.close();
    throw new Error('The status dashboard is limited to 127.0.0.1.');
  }
  const portValue = portIndex === -1 ? undefined : Number(commandArgs[portIndex + 1]);
  const server = startDashboard(database, {
    hostname,
    ...(portValue === undefined ? {} : { port: portValue }),
  });
  process.stderr.write(`Status dashboard listening at http://${server.hostname}:${server.port}\n`);
  await new Promise<void>((resolve) => {
    const close = (): void => {
      server.stop(true);
      database.close();
      resolve();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function runService(commandArgs: string[]): Promise<void> {
  const [action] = commandArgs;
  if (action === 'install') {
    await installService();
    return;
  }
  if (!['start', 'stop', 'status', 'logs', 'enable-lingering'].includes(action ?? '')) {
    throw new Error(
      'Usage: automation-mcp service <install|start|stop|status|logs|enable-lingering>',
    );
  }
  if (process.platform !== 'linux') {
    throw new Error('The systemd user service is supported on Linux only.');
  }
  if (action === 'enable-lingering') {
    process.stderr.write(
      'Run `loginctl enable-linger "$USER"` to enable lingering for this account.\n',
    );
    return;
  }

  const argsByAction: Record<string, string[]> = {
    start: ['--user', 'start', 'automation-worker.service'],
    stop: ['--user', 'stop', 'automation-worker.service'],
    status: ['--user', 'status', 'automation-worker.service', '--no-pager'],
    logs: ['--user', '-u', 'automation-worker.service', '-n', '100', '--no-pager'],
  };
  const program = action === 'logs' ? 'journalctl' : 'systemctl';
  const result = spawnSync(program, argsByAction[action ?? ''], { stdio: 'inherit', shell: false });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${program} ${action} failed with status ${result.status ?? 'unknown'}.`);
  }
}

async function installService(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('The systemd user service is supported on Linux only.');
  }
  const config = await loadConfig();
  const unitDirectory = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDirectory, 'automation-worker.service');
  const bunPath = Bun.which('bun');
  if (bunPath === null) {
    throw new Error(
      'Cannot locate Bun in PATH. Install Bun and retry `automation-mcp service install`.',
    );
  }
  await Bun.$`mkdir -p ${unitDirectory}`;
  const templateUrl = new URL('../../deploy/automation-worker.service', import.meta.url);
  const template = await readFile(templateUrl, 'utf8');
  const substitutions: Record<string, string> = {
    '@BUN_PATH@': systemdQuote(bunPath),
    '@CLI_PATH@': systemdQuote(resolve(process.argv[1] ?? '')),
    '@USER_PATH@': systemdQuote(process.env['PATH'] ?? ''),
    '@CONFIG_PATH@': systemdQuote(config.configPath),
  };
  const unit = Object.entries(substitutions).reduce(
    (contents, [placeholder, value]) => contents.replaceAll(placeholder, value),
    template,
  );
  await Bun.write(unitPath, unit);
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], {
    stdio: 'inherit',
    shell: false,
  });
  if (reload.status !== 0) {
    throw new Error(
      'systemctl --user daemon-reload failed. Check that a user systemd session is available.',
    );
  }
  process.stdout.write(`Installed user service at ${unitPath}\n`);
  process.stdout.write('Start it with: automation-mcp service start\n');
}

function systemdQuote(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${escaped}"`;
}

function printHelp(): void {
  process.stdout.write('automation-mcp: local TODO and scheduled agent automation\n');
  process.stdout.write('\nCommands:\n');
  process.stdout.write('  mcp                     Start the MCP stdio server\n');
  process.stdout.write('  worker                  Run the schedule worker\n');
  process.stdout.write('  ui [--port PORT]        Start the read-only localhost dashboard\n');
  process.stdout.write('  service install         Install the Linux systemd user unit\n');
  process.stdout.write('  service start|stop|status|logs|enable-lingering\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `automation-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
