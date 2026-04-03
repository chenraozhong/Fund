/**
 * Local router for Harmony WebView — maps API paths to service functions.
 * Replaces Express when running in a browser/WebView environment.
 */
import * as funds from './services/funds.service';
import * as transactions from './services/transactions.service';
import * as stats from './services/stats.service';
import * as trades from './services/trades.service';
import * as nav from './services/nav.service';

type Handler = (params: Record<string, string>, query: Record<string, string>, body?: any) => any | Promise<any>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

function register(method: string, path: string, handler: Handler) {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_match, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  });
}

// --- Funds ---
register('GET', '/funds', () => funds.listFunds());
register('POST', '/funds', (_p, _q, body) => funds.createFund(body));
register('GET', '/funds/trash/list', () => funds.listTrashFunds());
register('POST', '/funds/trash/:id/restore', (p) => funds.restoreTrashFund(p.id));
register('DELETE', '/funds/trash/:id/permanent', (p) => funds.permanentDeleteFund(p.id));
register('PUT', '/funds/:id', (p, _q, body) => funds.updateFund(p.id, body));
register('POST', '/funds/:id/adjust', (p, _q, body) => funds.adjustHolding(p.id, body));
register('POST', '/funds/:id/gain', (p, _q, body) => funds.updateFundGain(p.id, body.gain));
register('DELETE', '/funds/:id', (p) => funds.deleteFund(p.id));
register('GET', '/funds/:id/positions', (p) => funds.getFundPositions(p.id));

// --- Transactions ---
register('GET', '/transactions', (_p, q) => transactions.listTransactions(q));
register('POST', '/transactions', (_p, _q, body) => transactions.createTransaction(body));
register('POST', '/transactions/batch', (_p, _q, body) => transactions.batchCreateTransactions(body.transactions));
register('PUT', '/transactions/:id', (p, _q, body) => transactions.updateTransaction(p.id, body));
register('DELETE', '/transactions/:id', (p) => transactions.deleteTransaction(p.id));
register('POST', '/transactions/:id/split', (p, _q, body) => transactions.splitTransaction(p.id, body.shares));
register('POST', '/transactions/merge', (_p, _q, body) => transactions.mergeTransactions(body.ids));

// --- Stats ---
register('GET', '/stats/summary', () => stats.getSummary());
register('GET', '/stats/performance', () => stats.getPerformance());
register('GET', '/stats/allocation', () => stats.getAllocation());
register('POST', '/stats/snapshot', () => ({ success: true, count: stats.recordDailySnapshots() }));
register('GET', '/stats/snapshots/:fundId', (p, q) => stats.getSnapshots(p.fundId, q.days ? parseInt(q.days) : undefined));
register('GET', '/stats/snapshots-all', () => stats.getAllSnapshots());

// --- Trades ---
register('GET', '/trades/funds/:fundId', (p) => trades.listTrades(p.fundId));
register('POST', '/trades', (_p, _q, body) => trades.createTrade(body));
register('DELETE', '/trades/:id', (p) => trades.deleteTrade(p.id));

// --- Backups (WebView: export/import sql.js database via IndexedDB) ---
import db from './db';

const BACKUP_DB_NAME = 'fund-tracker-backups';
const BACKUP_STORE = 'backups';

function openBackupIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BACKUP_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BACKUP_STORE)) {
        req.result.createObjectStore(BACKUP_STORE, { keyPath: 'filename' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

register('GET', '/backups', async () => {
  const idb = await openBackupIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(BACKUP_STORE, 'readonly');
    const req = tx.objectStore(BACKUP_STORE).getAll();
    req.onsuccess = () => {
      idb.close();
      resolve((req.result || []).map((b: { filename: string; size: number; created_at: string }) => ({
        filename: b.filename,
        size: b.size,
        created_at: b.created_at,
      })));
    };
    req.onerror = () => { idb.close(); reject(req.error); };
  });
});

register('POST', '/backups', async () => {
  if (!db.export) throw { status: 500, error: '数据库不支持导出' };
  const data = db.export();
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const filename = `backup_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;

  const idb = await openBackupIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(BACKUP_STORE, 'readwrite');
    tx.objectStore(BACKUP_STORE).put({
      filename,
      data: data,
      size: data.byteLength,
      created_at: now.toISOString(),
    });
    tx.oncomplete = () => { idb.close(); resolve({ filename, size: data.byteLength }); };
    tx.onerror = () => { idb.close(); reject(tx.error); };
  });
});

register('POST', '/backups/restore', async (_p, _q, body) => {
  const filename = body?.filename;
  if (!filename) throw { status: 400, error: '请指定备份文件名' };

  const idb = await openBackupIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(BACKUP_STORE, 'readonly');
    const req = tx.objectStore(BACKUP_STORE).get(filename);
    req.onsuccess = () => {
      idb.close();
      if (!req.result || !req.result.data) {
        reject({ status: 404, error: '备份不存在' });
        return;
      }
      // Reload page to reinitialize with backup data
      // Store the backup data in the main database store
      const mainDB = indexedDB.open('fund-tracker', 1);
      mainDB.onupgradeneeded = () => {
        if (!mainDB.result.objectStoreNames.contains('database')) {
          mainDB.result.createObjectStore('database');
        }
      };
      mainDB.onsuccess = () => {
        const restoreTx = mainDB.result.transaction('database', 'readwrite');
        restoreTx.objectStore('database').put(new Uint8Array(req.result.data), 'main');
        restoreTx.oncomplete = () => {
          mainDB.result.close();
          resolve({ success: true, message: '恢复成功，请刷新页面重新加载数据' });
        };
        restoreTx.onerror = () => {
          mainDB.result.close();
          reject({ status: 500, error: '恢复失败' });
        };
      };
      mainDB.onerror = () => reject({ status: 500, error: '无法打开数据库' });
    };
    req.onerror = () => { idb.close(); reject(req.error); };
  });
});

register('DELETE', '/backups/:filename', async (p) => {
  const idb = await openBackupIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(BACKUP_STORE, 'readwrite');
    tx.objectStore(BACKUP_STORE).delete(p.filename);
    tx.oncomplete = () => { idb.close(); resolve({ success: true }); };
    tx.onerror = () => { idb.close(); reject(tx.error); };
  });
});

// --- NAV ---
register('POST', '/nav/refresh-all', () => nav.refreshAllNav());
register('GET', '/nav/estimate/all', () => nav.getEstimateAll());
register('GET', '/nav/:code/latest', (p) => nav.getLatestNav(p.code));
register('GET', '/nav/:code/date/:date', (p) => nav.getNavByDate(p.code, p.date));
register('GET', '/nav/:code/history', (p, q) => nav.getNavHistory(p.code, q));

// --- Strategy (shares same logic as PC — any fix auto-syncs) ---
import {
  getAvailableModels, DEFAULT_MODEL, computeDecision, logDecision,
  getFullStrategy, getBatchDecisions, getBatchForecasts,
  getForecastReviewSummary, getDecisionLogs, getForecastHistory,
  autoReviewForecasts, FORECAST_MODEL_VERSION, DECISION_MODEL_VERSION,
  getSingleForecast,
} from './routes/strategy';

register('GET', '/strategy/models', () => ({ models: getAvailableModels(), default: DEFAULT_MODEL }));
register('GET', '/strategy/funds/:id', (p, q) => getFullStrategy(Number(p.id), q.nav ? parseFloat(q.nav) : undefined));
register('GET', '/strategy/funds/:id/decision', async (p, q) => {
  const result = await computeDecision(Number(p.id), q.nav ? parseFloat(q.nav) : 0, q.model || undefined);
  logDecision(Number(p.id), result);
  return result;
});
register('GET', '/strategy/decisions/all', (_, q) => {
  let estimates: Record<number, number> = {};
  if (q.estimates) { try { estimates = JSON.parse(q.estimates); } catch {} }
  return getBatchDecisions(estimates, q.model || undefined);
});
register('GET', '/strategy/forecasts/all', () => getBatchForecasts());
register('GET', '/strategy/forecast-reviews/summary', (_, q) => getForecastReviewSummary(q.days ? Number(q.days) : 30));
register('POST', '/strategy/forecast-reviews/run', () => ({ success: true, reviewed: autoReviewForecasts() }));
register('GET', '/strategy/decision-logs', (_, q) => getDecisionLogs(q.fundId ? Number(q.fundId) : undefined, q.days ? Number(q.days) : 30));
register('GET', '/strategy/model-versions', () => ({
  forecast: FORECAST_MODEL_VERSION, decision: DECISION_MODEL_VERSION,
  description: {
    forecast: '12因子+地缘风险+回归抑制+ATR2.5x+Wilder RSI+假日历',
    decision: '五维防御优先(技术20%+基本面20%+市场30%+消息10%+资金20%)+预测整合+地缘风险',
  },
}));
register('GET', '/strategy/funds/:id/forecast', (p, q) => getSingleForecast(Number(p.id), q.estimate ? parseFloat(q.estimate) : undefined));
register('GET', '/strategy/funds/:id/swing', async (p, q) => {
  const fundId = Number(p.id);
  const realtimeNav = q.nav ? parseFloat(q.nav) : 0;
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
  if (!fund) throw { status: 404, error: '基金不存在' };
  const nav = realtimeNav > 0 ? realtimeNav : (fund.market_nav || 0);
  if (nav <= 0) throw { status: 400, error: '需要提供净值' };

  // Calculate position
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='buy' THEN shares ELSE 0 END),0)-COALESCE(SUM(CASE WHEN type='sell' THEN shares ELSE 0 END),0) as holding_shares, COALESCE(SUM(CASE WHEN type='buy' THEN shares*price ELSE 0 END),0)-COALESCE(SUM(CASE WHEN type='sell' THEN shares*price ELSE 0 END),0)+COALESCE(SUM(CASE WHEN type='dividend' THEN price ELSE 0 END),0) as cost_basis FROM transactions WHERE fund_id=?`).get(fundId) as any;
  const holdingShares = row.holding_shares;
  const totalCost = row.cost_basis;
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0;
  const basePositionPct = fund.base_position_pct ?? 30;
  const baseShares = Math.round(holdingShares * basePositionPct / 100 * 10000) / 10000;
  const swingShares = Math.round((holdingShares - baseShares) * 10000) / 10000;

  return {
    nav,
    costNav: Math.round(costNav * 10000) / 10000,
    holdingShares: Math.round(holdingShares * 10000) / 10000,
    basePosition: { pct: basePositionPct, shares: baseShares, maxSellable: swingShares, baseCostNav: costNav, newBaseCostNav: costNav, baseCostDrop: 0 },
    unpairedBuys: [],
    unpairedSells: [],
    suggestions: [],
    dipStrategy: { enabled: false, currentLossPct: 0, dropFromCost: 0, levels: [], totalPlan: { totalAmount: 0, newCostNav: 0, totalCostReduction: 0 }, outlook: '' },
    impact: { totalProfit: 0, sellProfit: 0, buyProfit: 0, totalSellShares: 0, totalBuyShares: 0, newHoldingShares: holdingShares, newCostNav: costNav, costReduction: 0 },
  };
});
register('GET', '/strategy/trade-analysis', async (_, q) => {
  // Simplified: return empty if no date trades
  return { date: q.date || new Date().toISOString().slice(0, 10), trades: [], summary: { total: 0, good: 0, neutral: 0, bad: 0, avgScore: 0, verdict: '暂无交易数据' } };
});
register('GET', '/strategy/forecasts/fund/:id', (p, q) => getForecastHistory(Number(p.id), q.limit ? Number(q.limit) : 30));

// --- Import ---
import { importPreview, importExecute } from './routes/import';

register('POST', '/import/preview', (_, _q, body) => importPreview(body?.text));
register('POST', '/import/execute', (_, _q, body) => importExecute(body?.text));

// --- AI (requires external API — graceful fallback if unavailable) ---
register('GET', '/ai/funds/:id/advice', () => { throw { status: 503, error: '手机端暂不支持AI建议，请在PC端使用' }; });
register('GET', '/ai/funds/:id/research', () => { throw { status: 503, error: '手机端暂不支持AI研报，请在PC端使用' }; });

// --- Data Sync (PC ↔ Mobile via local network) ---
register('GET', '/sync/export', () => {
  // Export all tables as JSON for sync
  const tables = ['funds', 'transactions', 'trades', 'daily_snapshots', 'forecasts', 'forecast_reviews', 'decision_logs'];
  const data: Record<string, any[]> = {};
  for (const table of tables) {
    try { data[table] = db.prepare(`SELECT * FROM ${table}`).all(); } catch { data[table] = []; }
  }
  return { version: 1, exportedAt: new Date().toISOString(), data };
});

register('POST', '/sync/import', (_, _q, body) => {
  if (!body?.data) throw { status: 400, error: '无效的同步数据' };
  const importData = body.data as Record<string, any[]>;
  const importOrder = ['funds', 'transactions', 'trades', 'daily_snapshots', 'forecasts', 'forecast_reviews', 'decision_logs'];
  const stats: Record<string, number> = {};

  const doImport = db.transaction(() => {
    for (const table of importOrder) {
      const rows = importData[table];
      if (!rows || !Array.isArray(rows) || rows.length === 0) { stats[table] = 0; continue; }
      // Clear existing data
      db.exec(`DELETE FROM ${table}`);
      // Insert rows
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
      for (const row of rows) {
        stmt.run(...cols.map(c => row[c] ?? null));
      }
      stats[table] = rows.length;
    }
  });
  doImport();
  return { success: true, imported: stats };
});

// Proxy endpoints: fetch from/to PC server via native HTTP (bypasses mixed content)
register('POST', '/sync/pull', async (_, _q, body) => {
  const pcUrl = (body?.pcUrl || '').replace(/\/+$/, '');
  if (!pcUrl) throw { status: 400, error: '请提供PC服务器地址' };
  const res = await fetch(`${pcUrl}/api/sync/export`);
  if (!res.ok) throw { status: res.status, error: `PC连接失败: ${res.status} ${res.statusText}` };
  return res.json();
});

register('POST', '/sync/push', async (_, _q, body) => {
  const pcUrl = (body?.pcUrl || '').replace(/\/+$/, '');
  const syncData = body?.data;
  if (!pcUrl) throw { status: 400, error: '请提供PC服务器地址' };
  if (!syncData) throw { status: 400, error: '无同步数据' };
  const res = await fetch(`${pcUrl}/api/sync/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncData),
  });
  if (!res.ok) throw { status: res.status, error: `推送到PC失败: ${res.status}` };
  return res.json();
});

/**
 * Dispatch a request to the appropriate handler.
 * Returns { status, data } matching the Express response pattern.
 */
export async function dispatch(
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: any,
): Promise<{ status: number; data: any }> {
  // Strip /api prefix if present
  const cleanPath = path.startsWith('/api') ? path.slice(4) : path;

  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const match = cleanPath.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    try {
      const result = await route.handler(params, query || {}, body);
      return { status: 200, data: result };
    } catch (err: any) {
      const status = err?.status || 500;
      const error = err?.error || err?.message || 'Internal error';
      return { status, data: { error } };
    }
  }

  return { status: 404, data: { error: `Route not found: ${method} ${path}` } };
}
