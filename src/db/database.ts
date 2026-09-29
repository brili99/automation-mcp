import { Database } from 'bun:sqlite';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyMigrations } from './migrations.js';

export async function openDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'a', 0o600);
  await file.close();
  await chmod(path, 0o600);
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA journal_mode = WAL');
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openMemoryDatabase(): Database {
  const database = new Database(':memory:', { create: true, strict: true });
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  applyMigrations(database);
  return database;
}
