import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase } from "../persistence/d1-perform-repository";

/**
 * Real SQLite behind the D1 surface the repositories use, so tests exercise actual migrations,
 * STRICT tables, CHECK constraints, foreign keys and triggers instead of recorded statements.
 */
class SqliteStatement {
  private values: SQLInputValue[] = [];
  constructor(private readonly db: DatabaseSync, readonly query: string) {}

  bind(...values: SQLInputValue[]) {
    this.values = values;
    return this;
  }

  async first<Row>() {
    return (this.db.prepare(this.query).get(...this.values) as Row | undefined) ?? null;
  }

  async run() {
    const outcome = this.db.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(outcome.changes) } };
  }

  async all<Row>() {
    return { success: true, results: this.db.prepare(this.query).all(...this.values) as Row[] };
  }
}

export function createMigratedDatabase(): { sqlite: DatabaseSync; db: SqlDatabase } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  const db = {
    prepare: (query: string) => new SqliteStatement(sqlite, query),
    async batch(statements: readonly SqliteStatement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SqlDatabase;
  return { sqlite, db };
}
