/**
 * Database adapter interface — abstracts better-sqlite3 (Node.js) and sql.js (WebView/WASM).
 * All methods are synchronous to match the existing codebase's usage pattern.
 */
export interface PreparedStatement {
  all(...params: any[]): any[];
  get(...params: any[]): any;
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface DBAdapter {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  pragma(str: string): any;
  close(): void;
  /** sql.js only: export the database as a binary blob for persistence */
  export?(): Uint8Array;
}
