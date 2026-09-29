import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type { Job } from '../scheduler/jobs.js';
import type { AgentAdapter, AgentInvocation, AgentRunRequest, AgentRunResult } from './contract.js';
import { UnsupportedAgentModeError } from './contract.js';

const baseEnvironmentNames = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];
const forbiddenEnvironmentNames = new Set([
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
]);

export abstract class ProcessAgentAdapter implements AgentAdapter {
  public abstract readonly kind: Job['adapter'];

  protected abstract createInvocation(job: Job, prompt: string): AgentInvocation;
  protected abstract helpArguments(job: Job): string[];
  protected abstract requiredHelpFragments(job: Job): readonly string[];

  public buildInvocation(job: Job, prompt: string): AgentInvocation {
    const invocation = this.createInvocation(job, prompt);
    return {
      executable: z.string().min(1).parse(invocation.executable),
      args: z.array(z.string()).parse(invocation.args),
      environmentVariables: validateEnvironmentNames(invocation.environmentVariables),
      ...(invocation.environmentOverrides === undefined
        ? {}
        : { environmentOverrides: validateEnvironmentOverrides(invocation.environmentOverrides) }),
    };
  }

  public async preflight(job: Job): Promise<void> {
    const invocation = this.buildInvocation(job, 'preflight');
    const environment = buildEnvironment(
      invocation.environmentVariables,
      invocation.environmentOverrides,
    );
    const help = await captureHelp(invocation.executable, this.helpArguments(job), environment);
    const version = await captureHelp(invocation.executable, ['--version'], environment);
    if (!/\d+\.\d+(?:\.\d+)?/.test(version)) {
      throw new UnsupportedAgentModeError(
        `${this.kind} CLI did not report a recognizable version.`,
      );
    }
    const missing = this.requiredHelpFragments(job).filter((fragment) => !help.includes(fragment));
    if (missing.length > 0) {
      throw new UnsupportedAgentModeError(
        `${this.kind} CLI does not advertise the required non-interactive sandbox options: ${missing.join(', ')}.`,
      );
    }
  }

  public run(request: AgentRunRequest): Promise<AgentRunResult> {
    const prompt = [
      request.prompt,
      request.memoryContext,
      'At the end of your response, emit a memory update using this exact envelope with valid JSON. Do not include secrets:',
      'AUTOMATION_MEMORY_UPDATE_BEGIN',
      '{"decisions":[],"currentState":[],"constraints":[],"nextSteps":[]}',
      'AUTOMATION_MEMORY_UPDATE_END',
    ].join('\n\n');
    const invocation = this.buildInvocation(request.job, prompt);
    return runBoundedProcess(
      invocation,
      request.job.workspace,
      request.job.maxRuntimeMs,
      request.job.outputLimitBytes,
      request.signal,
    );
  }
}

export async function runBoundedProcess(
  invocation: AgentInvocation,
  cwd: string,
  maxRuntimeMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  const executable = z.string().min(1).parse(invocation.executable);
  const args = z.array(z.string()).parse(invocation.args);
  const directory = z.string().min(1).parse(cwd);
  const environment = buildEnvironment(
    invocation.environmentVariables,
    invocation.environmentOverrides,
  );
  const startedAt = Date.now();
  const child = spawn(executable, args, {
    cwd: directory,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  let terminationError: Error | null = null;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: Error): void => {
    terminationError ??= error;
    child.kill('SIGTERM');
    forceKill ??= setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  const collect = (chunk: Uint8Array): void => {
    const remaining = maxOutputBytes - outputBytes;
    if (remaining <= 0) {
      stop(new Error(`Agent output exceeded ${maxOutputBytes} bytes.`));
      return;
    }
    const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(bounded);
    outputBytes += bounded.byteLength;
    if (chunk.byteLength > remaining) {
      stop(new Error(`Agent output exceeded ${maxOutputBytes} bytes.`));
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const onAbort = (): void => stop(new Error('Agent run was cancelled.'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  const timeout = setTimeout(
    () => stop(new Error(`Agent exceeded the ${maxRuntimeMs} ms runtime limit.`)),
    maxRuntimeMs,
  );

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, terminationSignal) => {
        if (code === null) {
          reject(
            terminationError ??
              new Error(`Agent process stopped by ${terminationSignal ?? 'an unknown signal'}.`),
          );
        } else if (terminationError !== null) {
          reject(terminationError);
        } else {
          resolve(code);
        }
      });
    });
    const output = new TextDecoder().decode(Buffer.concat(chunks));
    return { output, exitCode, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
    if (forceKill !== undefined) {
      clearTimeout(forceKill);
    }
    signal.removeEventListener('abort', onAbort);
  }
}

function buildEnvironment(
  requestedNames: string[],
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const names = new Set([...baseEnvironmentNames, ...requestedNames]);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  Object.assign(environment, overrides);
  return environment;
}

function validateEnvironmentOverrides(overrides: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(overrides)) {
    const validName = z.enum(['OPENCODE_PERMISSION']).parse(name);
    validated[validName] = z.string().max(16_384).parse(value);
  }
  return validated;
}

function validateEnvironmentNames(names: string[]): string[] {
  return z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
    .max(50)
    .parse(names)
    .filter((name) => !forbiddenEnvironmentNames.has(name));
}

function captureHelp(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const collect = (chunk: Uint8Array): void => {
      bytes += chunk.byteLength;
      if (bytes <= 64 * 1024) {
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Unable to inspect ${executable}: ${error.message}`));
    });
    child.once('close', () => {
      clearTimeout(timeout);
      if (bytes > 64 * 1024) {
        reject(new Error(`${executable} help output exceeded the 64 KiB preflight limit.`));
        return;
      }
      resolve(new TextDecoder().decode(Buffer.concat(chunks)));
    });
  });
}
