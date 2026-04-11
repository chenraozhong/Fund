import Database from 'better-sqlite3';
import path from 'path';
import type { DBAdapter } from './db-interface';

const dbPath = path.join(__dirname, '..', 'portfolio.db');
const rawDb = new Database(dbPath);

rawDb.pragma('journal_mode = WAL');
rawDb.pragma('foreign_keys = ON');

rawDb.exec(`
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

rawDb.exec(`
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

rawDb.exec(`
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
rawDb.exec(`
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

// 决策记录表
rawDb.exec(`
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

// Add nav_diff and profit_pct columns to trades
rawDb.exec(`
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
    nav_diff REAL DEFAULT 0,
    profit_pct REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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
  // v6: 版本号
  "ALTER TABLE forecasts ADD COLUMN model_version TEXT DEFAULT 'v5'",
  // trades: nav diff & profit pct
  "ALTER TABLE trades ADD COLUMN nav_diff REAL DEFAULT 0",
  "ALTER TABLE trades ADD COLUMN profit_pct REAL DEFAULT 0",
  // backfill existing trades
  "UPDATE trades SET nav_diff = ROUND((sell_price - buy_price) * 10000) / 10000, profit_pct = CASE WHEN buy_price > 0 THEN ROUND(((sell_price - buy_price) / buy_price) * 10000) / 100 ELSE 0 END WHERE nav_diff = 0",
  // transactions: paired tracking (不再删除原始交易)
  "ALTER TABLE transactions ADD COLUMN paired_shares REAL DEFAULT 0",
  // funds: 累计收益(每日累加方式)
  "ALTER TABLE funds ADD COLUMN cumulative_gain REAL DEFAULT 0",
  // daily_snapshots: 当日收益
  "ALTER TABLE daily_snapshots ADD COLUMN daily_gain REAL DEFAULT 0",
  // funds: 官方前日净值(用于当日收益计算, 与前端API一致)
  "ALTER TABLE funds ADD COLUMN prev_nav REAL DEFAULT 0",
  // funds: 最新NAV对应的日期(用于判断是否为交易日)
  "ALTER TABLE funds ADD COLUMN nav_date TEXT DEFAULT ''",
  // daily_snapshots: 存储当日使用的prev_nav(历史记录)
  "ALTER TABLE daily_snapshots ADD COLUMN prev_nav REAL DEFAULT 0",
];
for (const sql of migrations) {
  try { rawDb.exec(sql); } catch (_) { /* column/index already exists */ }
}

// Wrap as DBAdapter for type compatibility
// better-sqlite3 already matches the interface naturally
const db = rawDb as unknown as DBAdapter;

export default db;
