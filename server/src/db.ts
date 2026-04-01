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

db.exec(`
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

// 预测持久化 + 自动复盘
db.exec(`
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
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column/index already exists */ }
}

export default db;
