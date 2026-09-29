import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { assertNoSecrets } from '../security/secrets.js';

export const todoStatusSchema = z.enum(['open', 'completed', 'cancelled']);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

const todoRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  status: todoStatusSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
});

export type Todo = {
  id: string;
  title: string;
  description: string | null;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateTodoInput = {
  title: string;
  description?: string | null;
};

export type UpdateTodoInput = {
  id: string;
  title?: string;
  description?: string | null;
};

export class TodoRepository {
  public constructor(private readonly database: Database) {}

  public create(input: CreateTodoInput): Todo {
    const title = z.string().trim().min(1).max(500).parse(input.title);
    const description =
      input.description === undefined
        ? null
        : z.string().max(10_000).nullable().parse(input.description);
    assertNoSecrets({ title, description }, 'TODO');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.database
      .query(
        `INSERT INTO todos (id, title, description, status, created_at, updated_at, completed_at)
         VALUES ($id, $title, $description, 'open', $now, $now, NULL)`,
      )
      .run({ id, title, description, now });
    return this.get(id);
  }

  public list(filter: { status?: TodoStatus; limit?: number } = {}): Todo[] {
    const limit = z.number().int().min(1).max(500).default(100).parse(filter.limit);
    const rows =
      filter.status === undefined
        ? this.database
            .query('SELECT * FROM todos ORDER BY created_at DESC LIMIT $limit')
            .all({ limit })
        : this.database
            .query(
              'SELECT * FROM todos WHERE status = $status ORDER BY created_at DESC LIMIT $limit',
            )
            .all({ status: todoStatusSchema.parse(filter.status), limit });
    return rows.map(parseTodo);
  }

  public get(id: string): Todo {
    const validId = z.string().uuid().parse(id);
    const row = this.database.query('SELECT * FROM todos WHERE id = $id').get({ id: validId });
    if (row === null) {
      throw new Error(`TODO ${validId} was not found.`);
    }
    return parseTodo(row);
  }

  public update(input: UpdateTodoInput): Todo {
    const validId = z.string().uuid().parse(input.id);
    const updates: string[] = [];
    const bindings: Array<string | null> = [];

    if (input.title !== undefined) {
      updates.push('title = ?');
      const title = z.string().trim().min(1).max(500).parse(input.title);
      assertNoSecrets({ title }, 'TODO');
      bindings.push(title);
    }
    if (Object.hasOwn(input, 'description')) {
      updates.push('description = ?');
      const description = z.string().max(10_000).nullable().parse(input.description);
      assertNoSecrets({ description }, 'TODO');
      bindings.push(description);
    }
    if (updates.length === 0) {
      return this.get(validId);
    }

    updates.push('updated_at = ?');
    bindings.push(new Date().toISOString());
    bindings.push(validId);
    const result = this.database
      .query(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`)
      .run(...bindings);
    if (result.changes === 0) {
      throw new Error(`TODO ${validId} was not found.`);
    }
    return this.get(validId);
  }

  public complete(id: string): Todo {
    return this.setStatus(id, 'completed');
  }

  public cancel(id: string): Todo {
    return this.setStatus(id, 'cancelled');
  }

  public delete(id: string): void {
    const validId = z.string().uuid().parse(id);
    const result = this.database.query('DELETE FROM todos WHERE id = $id').run({ id: validId });
    if (result.changes === 0) {
      throw new Error(`TODO ${validId} was not found.`);
    }
  }

  private setStatus(id: string, status: Exclude<TodoStatus, 'open'>): Todo {
    const validId = z.string().uuid().parse(id);
    const now = new Date().toISOString();
    const result = this.database
      .query(
        `UPDATE todos
         SET status = $status, updated_at = $now,
             completed_at = CASE WHEN $status = 'completed' THEN COALESCE(completed_at, $now) ELSE NULL END
         WHERE id = $id`,
      )
      .run({ status, now, id: validId });
    if (result.changes === 0) {
      throw new Error(`TODO ${validId} was not found.`);
    }
    return this.get(validId);
  }
}

function parseTodo(row: unknown): Todo {
  const parsed = todoRowSchema.parse(row);
  return {
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    status: parsed.status,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    completedAt: parsed.completed_at,
  };
}
