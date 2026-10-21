// @types/node 20 predates node:sqlite. Only the surface the test harness uses is declared;
// the module ships with the Node 22 runtime that runs the tests and never reaches the Worker.
declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    get(...parameters: SQLInputValue[]): unknown;
    all(...parameters: SQLInputValue[]): unknown[];
    run(...parameters: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
