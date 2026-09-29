import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openMemoryDatabase } from '../src/db/database.js';
import { TodoRepository } from '../src/todos/repository.js';

describe('TodoRepository', () => {
  let database: Database;
  let todos: TodoRepository;

  beforeEach(() => {
    database = openMemoryDatabase();
    todos = new TodoRepository(database);
  });

  afterEach(() => database.close());

  test('creates, filters, updates, completes, cancels, and deletes TODOs', () => {
    const first = todos.create({
      title: '  Review scheduler  ',
      description: 'Check atomic claims',
    });
    const second = todos.create({ title: 'Write docs' });

    expect(first.title).toBe('Review scheduler');
    expect(todos.list({ status: 'open' })).toHaveLength(2);
    expect(todos.update({ id: second.id, description: null }).description).toBeNull();
    expect(todos.complete(first.id).completedAt).not.toBeNull();
    expect(todos.cancel(second.id).status).toBe('cancelled');
    todos.delete(second.id);
    expect(todos.list()).toHaveLength(1);
  });

  test('rejects invalid titles and missing IDs', () => {
    expect(() => todos.create({ title: '  ' })).toThrow();
    expect(() => todos.get('not-a-uuid')).toThrow();
    expect(() =>
      todos.create({ title: 'private note', description: 'api_key=example-secret' }),
    ).toThrow('credential or secret');
  });
});
