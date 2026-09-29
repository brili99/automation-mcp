import type { Job } from '../scheduler/jobs.js';

export type AgentInvocation = {
  executable: string;
  args: string[];
  environmentVariables: string[];
  environmentOverrides?: Record<string, string>;
};

export type AgentRunRequest = {
  job: Job;
  prompt: string;
  memoryContext: string;
  signal: AbortSignal;
};

export type AgentRunResult = {
  output: string;
  exitCode: number;
  durationMs: number;
};

export interface AgentAdapter {
  readonly kind: Job['adapter'];
  preflight(job: Job): Promise<void>;
  buildInvocation(job: Job, prompt: string): AgentInvocation;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class UnsupportedAgentModeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAgentModeError';
  }
}
