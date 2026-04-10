/**
 * sql.js (WASM SQLite) adapter — for use in WebView / browser environments.
 * Implements the same interface as better-sqlite3 so all existing queries work unchanged.
 */
import type { DBAdapter, PreparedStatement } from './db-interface';

// sql.js types (minimal)
interface SqlJsDatabase {
  run(sql: string, params?: any[]): void;
  exec(sql: string): { columns: string[]; values: any[][] }[];
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  bind(params?: any[]): boolean;
  step(): boolean;
  getAsObject(opts?: { useBigInt?: boolean }): Record<string, any>;
  get(params?: any[]): any[];
  free(): void;
  reset(): void;
  getColumnNames(): string[];
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

// Persistence callback — called after each write operation (debounced)
let persistCallback: ((data: Uint8Array) => void) | null = null;
let persistTimer: any = null;
const PERSIST_DEBOUNCE = 500; // ms

function schedulePersist(sqlDb: SqlJsDatabase) {
  if (!persistCallback) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistCallback) {
      persistCallback(sqlDb.export());
    }
  }, PERSIST_DEBOUNCE);
}

/**
 * Wrap a sql.js Database as a DBAdapter (compatible with better-sqlite3 API).
 */
function wrapSqlJs(sqlDb: SqlJsDatabase): DBAdapter {
  const adapter: DBAdapter = {
    prepare(sql: string): PreparedStatement {
      return {
        all(...params: any[]): any[] {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length > 0) stmt.bind(params);
            const results: any[] = [];
            const columns = stmt.getColumnNames();
            while (stmt.step()) {
              const row: any = {};
              const values = stmt.get();
              for (let i = 0; i < columns.length; i++) {
                row[columns[i]] = values[i];
              }
              results.push(row);
            }
            return results;
          } finally {
            stmt.free();
          }
        },

        get(...params: any[]): any {
          const stmt = sqlDb.prepare(sql);
          try {
            if (params.length > 0) stmt.bind(params);
            if (stmt.step()) {
              const columns = stmt.getColumnNames();
              const values = stmt.get();
              const row: any = {};
              for (let i = 0; i < columns.length; i++) {
                row[columns[i]] = values[i];
              }
              return row;
            }
            return undefined;
          } finally {
            stmt.free();
          }
        },

        run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
          sqlDb.run(sql, params);
          // sql.js doesn't directly return changes/lastInsertRowid from run()
          // Use pragma to get them
          const changesResult = sqlDb.exec('SELECT changes() as c');
          const changes = changesResult.length > 0 ? changesResult[0].values[0][0] as number : 0;
          const rowidResult = sqlDb.exec('SELECT last_insert_rowid() as r');
          const lastInsertRowid = rowidResult.length > 0 ? rowidResult[0].values[0][0] as number : 0;
          schedulePersist(sqlDb);
          return { changes, lastInsertRowid };
        },
      };
    },

    exec(sql: string): void {
      sqlDb.exec(sql);
      schedulePersist(sqlDb);
    },

    transaction<T>(fn: () => T): () => T {
      return () => {
        sqlDb.run('BEGIN TRANSACTION', []);
        try {
          const result = fn();
          sqlDb.run('COMMIT', []);
          schedulePersist(sqlDb);
          return result;
        } catch (err) {
          sqlDb.run('ROLLBACK', []);
          throw err;
        }
      };
    },

    pragma(str: string): any {
      const result = sqlDb.exec(`PRAGMA ${str}`);
      return result.length > 0 ? result[0].values[0]?.[0] : undefined;
    },

    close(): void {
      sqlDb.close();
    },

    export(): Uint8Array {
      return sqlDb.export();
    },
  };

  return adapter;
}

/**
 * Initialize sql.js database.
 * @param initSqlJs - The initSqlJs function from the sql.js library
 * @param existingData - Optional existing database binary (for restore from persistence)
 * @param onPersist - Callback to save database binary (called after each write, debounced)
 */
export async function createSqlJsDb(
  initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>,
  existingData?: Uint8Array | null,
  onPersist?: (data: Uint8Array) => void,
): Promise<DBAdapter> {
  const SQL = await initSqlJs();
  const sqlDb = existingData ? new SQL.Database(existingData) : new SQL.Database();

  if (onPersist) {
    persistCallback = onPersist;
  }

  const adapter = wrapSqlJs(sqlDb);

  // Apply the same schema and migrations as db.ts
  adapter.pragma('journal_mode = WAL');
  adapter.pragma('foreign_keys = ON');

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS funds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#378ADD',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('buy','sell','dividend')),
      asset TEXT NOT NULL,
      shares REAL DEFAULT 0,
      price REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      asset TEXT NOT NULL,
      buy_date TEXT NOT NULL,
      buy_shares REAL NOT NULL,
      buy_price REAL NOT NULL,
      sell_date TEXT NOT NULL,
      sell_shares REAL NOT NULL,
      sell_price REAL NOT NULL,
      paired_shares REAL NOT NULL,
      profit REAL NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      holding_shares REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      market_value REAL NOT NULL DEFAULT 0,
      cost_nav REAL NOT NULL DEFAULT 0,
      market_nav REAL NOT NULL DEFAULT 0,
      gain REAL NOT NULL DEFAULT 0,
      gain_pct REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(fund_id, date)
    );
  `);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,
      direction TEXT NOT NULL,
      predicted_nav REAL NOT NULL,
      predicted_change_pct REAL NOT NULL,
      confidence INTEGER NOT NULL,
      nav_range_high REAL,
      nav_range_low REAL,
      factors TEXT,
      base_nav REAL NOT NULL DEFAULT 0,
      rsi REAL,
      trend TEXT,
      volatility REAL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(fund_id, target_date)
    );
    CREATE TABLE IF NOT EXISTS forecast_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forecast_id INTEGER NOT NULL REFERENCES forecasts(id) ON DELETE CASCADE,
      fund_id INTEGER NOT NULL,
      target_date TEXT NOT NULL,
      actual_nav REAL NOT NULL,
      actual_change_pct REAL NOT NULL,
      direction_correct INTEGER NOT NULL DEFAULT 0,
      error_pct REAL NOT NULL DEFAULT 0,
      within_range INTEGER NOT NULL DEFAULT 0,
      analysis TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(fund_id, target_date)
    );
  `);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      nav REAL NOT NULL,
      action TEXT NOT NULL,
      shares REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      confidence INTEGER NOT NULL DEFAULT 0,
      urgency TEXT,
      composite_score INTEGER NOT NULL DEFAULT 0,
      cycle_phase TEXT,
      fear_greed INTEGER,
      reasoning TEXT,
      forecast_direction TEXT,
      forecast_change_pct REAL,
      model_version TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(fund_id, date, model_version)
    );
  `);

  // Migrations
  const migrations = [
    'ALTER TABLE funds ADD COLUMN market_nav REAL DEFAULT 0',
    'ALTER TABLE funds ADD COLUMN stop_profit_pct REAL DEFAULT 20',
    'ALTER TABLE funds ADD COLUMN stop_loss_pct REAL DEFAULT 15',
    "ALTER TABLE funds ADD COLUMN code TEXT DEFAULT ''",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_funds_code ON funds(code) WHERE code != ''",
    "ALTER TABLE funds ADD COLUMN deleted_at TEXT DEFAULT NULL",
    "ALTER TABLE funds ADD COLUMN base_position_pct REAL DEFAULT 30",
    "UPDATE funds SET stop_profit_pct = 20 WHERE stop_profit_pct = 5",
    "UPDATE funds SET stop_loss_pct = 15 WHERE stop_loss_pct = 5",
    "ALTER TABLE forecasts ADD COLUMN model_version TEXT DEFAULT 'v5'",
    "ALTER TABLE trades ADD COLUMN nav_diff REAL DEFAULT 0",
    "ALTER TABLE trades ADD COLUMN profit_pct REAL DEFAULT 0",
    "UPDATE trades SET nav_diff = ROUND((sell_price - buy_price) * 10000) / 10000, profit_pct = CASE WHEN buy_price > 0 THEN ROUND(((sell_price - buy_price) / buy_price) * 10000) / 100 ELSE 0 END WHERE nav_diff = 0",
    "ALTER TABLE transactions ADD COLUMN paired_shares REAL DEFAULT 0",
    "ALTER TABLE funds ADD COLUMN cumulative_gain REAL DEFAULT 0",
    "ALTER TABLE daily_snapshots ADD COLUMN daily_gain REAL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { adapter.exec(sql); } catch (_) { /* column/index already exists */ }
  }

  return adapter;
}
