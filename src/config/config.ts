import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const configSchema = z
  .object({
    databasePath: z.string().min(1).optional(),
    workspaceRoots: z
      .array(z.string().refine(isAbsolute, 'Workspace roots must be absolute paths.'))
      .default([]),
    memoryTokenBudget: z.number().int().min(128).max(8192).default(1200),
    maxRunDurationMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    maxOutputBytes: z.number().int().min(1024).max(10_485_760).default(1_048_576),
    runHistoryLimit: z.number().int().min(1).max(10_000).default(500),
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema> & {
  configPath: string;
  databasePath: string;
  dataDirectory: string;
};

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'automation-mcp', 'config.json');
}

export async function loadConfig(
  configPath = process.env['AUTOMATION_MCP_CONFIG'] ?? defaultConfigPath(),
): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  const dataDirectory = join(homedir(), '.local', 'share', 'automation-mcp');
  await mkdir(dirname(absoluteConfigPath), { recursive: true, mode: 0o700 });

  let rawConfig: unknown = {};
  try {
    rawConfig = JSON.parse(await readFile(absoluteConfigPath, 'utf8')) as unknown;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw new Error(
        `Unable to read configuration at ${absoluteConfigPath}: ${errorMessage(error)}`,
      );
    }
  }

  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(`Invalid configuration at ${absoluteConfigPath}: ${parsed.error.message}`);
  }

  const databasePath = parsed.data.databasePath
    ? resolve(
        isAbsolute(parsed.data.databasePath)
          ? parsed.data.databasePath
          : join(dirname(absoluteConfigPath), parsed.data.databasePath),
      )
    : join(dataDirectory, 'automation.sqlite');

  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await writeConfigIfMissing(absoluteConfigPath, parsed.data);

  return {
    ...parsed.data,
    configPath: absoluteConfigPath,
    databasePath,
    dataDirectory,
  };
}

async function writeConfigIfMissing(
  path: string,
  config: z.input<typeof configSchema>,
): Promise<void> {
  const initial = `${JSON.stringify(configSchema.parse(config), null, 2)}\n`;
  try {
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(initial);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
