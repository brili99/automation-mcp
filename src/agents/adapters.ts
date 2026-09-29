import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Job } from '../scheduler/jobs.js';
import type { AgentInvocation } from './contract.js';
import { UnsupportedAgentModeError } from './contract.js';
import { ProcessAgentAdapter } from './process.js';

const environmentSchema = z
  .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
  .max(50)
  .default([]);
const firstPartyConfigSchema = z
  .object({
    executable: z.string().min(1).optional(),
    environmentVariables: environmentSchema,
  })
  .strict();
const genericConfigSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string().max(2000)).max(128),
    environmentVariables: environmentSchema,
    sandboxValidated: z.literal(true),
    preflightArgs: z.array(z.string().max(2000)).max(32),
    requiredHelpFragments: z.array(z.string().min(1).max(200)).min(2).max(16),
  })
  .strict();

export class OpenCodeAdapter extends ProcessAgentAdapter {
  public readonly kind = 'opencode' as const;

  protected createInvocation(job: Job, prompt: string): AgentInvocation {
    const config = firstPartyConfigSchema.parse(job.adapterConfig);
    return {
      executable: config.executable ?? 'opencode',
      args: ['run', '--auto', prompt],
      environmentVariables: config.environmentVariables,
      environmentOverrides: {
        OPENCODE_PERMISSION: JSON.stringify({
          '*': 'deny',
          read: 'allow',
          glob: 'allow',
          grep: 'allow',
          edit: 'allow',
          bash: 'deny',
          task: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          external_directory: 'deny',
          doom_loop: 'deny',
        }),
      },
    };
  }

  protected helpArguments(_job: Job): string[] {
    return ['run', '--help'];
  }

  protected requiredHelpFragments(_job: Job): readonly string[] {
    return ['--auto'];
  }
}

export class CodexAdapter extends ProcessAgentAdapter {
  public readonly kind = 'codex' as const;

  protected createInvocation(job: Job, prompt: string): AgentInvocation {
    const config = firstPartyConfigSchema.parse(job.adapterConfig);
    return {
      executable: config.executable ?? 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', prompt],
      environmentVariables: config.environmentVariables,
    };
  }

  protected helpArguments(_job: Job): string[] {
    return ['exec', '--help'];
  }

  protected requiredHelpFragments(_job: Job): readonly string[] {
    return ['--sandbox', 'workspace-write', '--ask-for-approval'];
  }
}

export class AntigravityAdapter extends ProcessAgentAdapter {
  public readonly kind = 'antigravity' as const;

  protected createInvocation(job: Job, prompt: string): AgentInvocation {
    const config = firstPartyConfigSchema.parse(job.adapterConfig);
    return {
      executable: config.executable ?? 'agy',
      args: ['-p', '--sandbox', prompt],
      environmentVariables: config.environmentVariables,
    };
  }

  protected helpArguments(_job: Job): string[] {
    return ['--help'];
  }

  protected requiredHelpFragments(_job: Job): readonly string[] {
    return ['-p'];
  }

  public override async preflight(job: Job): Promise<void> {
    await super.preflight(job);
    const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let rawSettings: unknown;
    try {
      rawSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown;
    } catch {
      throw new UnsupportedAgentModeError(
        `Antigravity sandbox configuration must be set up before unattended runs: ${settingsPath}`,
      );
    }
    const settings = z
      .object({
        enableTerminalSandbox: z.literal(true),
        toolPermission: z.literal('proceed-in-sandbox'),
        allowNonWorkspaceAccess: z.literal(false).optional(),
        permissions: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .passthrough()
      .safeParse(rawSettings);
    const allowedRules = settings.success ? (settings.data.permissions?.allow ?? []) : [];
    if (
      !settings.success ||
      allowedRules.some(
        (rule) => rule.startsWith('unsandboxed(') || rule.startsWith('write_file(/'),
      )
    ) {
      throw new UnsupportedAgentModeError(
        'Antigravity requires sandboxed approvals, workspace-only access, and no unsandboxed/out-of-workspace allow rules.',
      );
    }
  }
}

export class GenericAdapter extends ProcessAgentAdapter {
  public readonly kind = 'generic' as const;

  protected createInvocation(job: Job, prompt: string): AgentInvocation {
    const config = genericConfigSchema.safeParse(job.adapterConfig);
    if (!config.success) {
      throw new UnsupportedAgentModeError(
        'Generic profiles require executable, argv, environmentVariables, sandboxValidated, preflightArgs, and requiredHelpFragments.',
      );
    }
    if (!config.data.args.some((argument) => argument.includes('{prompt}'))) {
      throw new UnsupportedAgentModeError(
        'Generic CLI argument arrays must include a {prompt} placeholder.',
      );
    }
    if (!config.data.args.includes('--sandbox') || !config.data.args.includes('workspace-write')) {
      throw new UnsupportedAgentModeError(
        'Generic CLI argv must explicitly include --sandbox workspace-write.',
      );
    }
    return {
      executable: config.data.executable,
      args: config.data.args.map((argument) => argument.replaceAll('{prompt}', prompt)),
      environmentVariables: config.data.environmentVariables,
    };
  }

  protected helpArguments(job: Job): string[] {
    return genericConfigSchema.parse(job.adapterConfig).preflightArgs;
  }

  protected requiredHelpFragments(job: Job): readonly string[] {
    return genericConfigSchema.parse(job.adapterConfig).requiredHelpFragments;
  }

  public override async preflight(job: Job): Promise<void> {
    const config = genericConfigSchema.parse(job.adapterConfig);
    if (
      !config.requiredHelpFragments.includes('--sandbox') ||
      !config.requiredHelpFragments.includes('workspace-write')
    ) {
      throw new UnsupportedAgentModeError(
        'Generic CLI requiredHelpFragments must explicitly include --sandbox and workspace-write.',
      );
    }
    await super.preflight(job);
  }
}

export function adapterFor(kind: Job['adapter']): ProcessAgentAdapter {
  switch (kind) {
    case 'opencode':
      return new OpenCodeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'antigravity':
      return new AntigravityAdapter();
    case 'generic':
      return new GenericAdapter();
  }
}
