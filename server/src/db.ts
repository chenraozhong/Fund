import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '..', 'portfolio.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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

db.exec(`
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

// Migrations
const migrations = [
  'ALTER TABLE funds ADD COLUMN market_nav REAL DEFAULT 0',
  'ALTER TABLE funds ADD COLUMN stop_profit_pct REAL DEFAULT 5',
  'ALTER TABLE funds ADD COLUMN stop_loss_pct REAL DEFAULT 5',
  "ALTER TABLE funds ADD COLUMN code TEXT DEFAULT ''",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_funds_code ON funds(code) WHERE code != ''",
  "ALTER TABLE funds ADD COLUMN deleted_at TEXT DEFAULT NULL",
  "ALTER TABLE funds ADD COLUMN base_position_pct REAL DEFAULT 30",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column/index already exists */ }
}

export default db;
