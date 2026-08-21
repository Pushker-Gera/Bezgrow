declare module "node:sqlite" {
  export type DatabaseSyncOptions = { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean }

  export class StatementSync {
    all(...anonymousParameters: unknown[]): Array<Record<string, unknown>>
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined
    run(...anonymousParameters: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions)
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
