import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config/config.js';
import { openDatabase } from '../db/database.js';
import { createMcpServer } from './server.js';

export async function startMcpServer(): Promise<void> {
  const config = await loadConfig();
  const database = await openDatabase(config.databasePath);
  const handle = serveStdio(() => createMcpServer(database, config), {
    onerror: (error) => process.stderr.write(`MCP server error: ${error.message}\n`),
  });

  process.stdin.once('end', () => {
    void handle.close().finally(() => database.close());
  });
}
