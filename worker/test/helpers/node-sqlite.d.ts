declare module "node:sqlite" {
  export class StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
}

declare module "node:module" {
  export function createRequire(filename: string | URL): (id: string) => any;
}

interface ImportMeta {
  readonly url: string;
}
