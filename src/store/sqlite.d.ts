declare module "node:sqlite" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
