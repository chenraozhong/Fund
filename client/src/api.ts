const BASE = '/api';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Harmony WebView mode: set by the local-router init
let localDispatch: ((method: string, path: string, query?: Record<string, string>, body?: any) => Promise<{ status: number; data: any }>) | null = null;

/**
 * Initialize local mode for Harmony WebView.
 * When set, all API calls bypass fetch and use the local router directly.
 */
export function initLocalMode(dispatcher: typeof localDispatch) {
  localDispatch = dispatcher;
}

/** Check if running in Harmony WebView local mode */
export function isLocalMode(): boolean {
  return localDispatch !== null;
}

function parseUrlAndQuery(url: string): { path: string; query: Record<string, string> } {
  const [path, qs] = url.split('?');
  const query: Record<string, string> = {};
  if (qs) {
    for (const part of qs.split('&')) {
      const [k, v] = part.split('=');
      if (k) query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    }
  }
  return { path, query };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  // Local mode: dispatch directly to service functions (Harmony WebView)
  if (localDispatch) {
    const method = (options?.method || 'GET').toUpperCase();
    const body = options?.body ? JSON.parse(options.body as string) : undefined;
    const { path, query } = parseUrlAndQuery(url);
    const result = await localDispatch(method, '/api' + path, query, body);
    if (result.status >= 400) {
      throw new Error(result.data?.error || `Error ${result.status}`);
    }
    return result.data as T;
  }

  // Normal mode: HTTP fetch to Express server
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(BASE + url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    } catch (err: any) {
      lastError = err;
      // Only retry on network errors (server restarting), not on 4xx/5xx
      if (err.message && !err.message.includes('Failed to fetch') && !err.message.includes('fetch')) {
        throw err;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('请求失败');
}

export interface Fund {
  id: number;
  name: string;
  color: string;
  code: string;
  market_nav: number;
  stop_profit_pct: number;
  stop_loss_pct: number;
  base_position_pct: number;
  created_at: string;
  holding_shares: number;
  current_value: number;
  total_cost: number;
  gain: number;
  gain_pct: number;
}

export interface Transaction {
  id: number;
  fund_id: number;
  fund_name: string;
  fund_color: string;
  date: string;
  type: 'buy' | 'sell' | 'dividend';
  asset: string;
  shares: number;
  price: number;
  notes: string | null;
}

export interface Summary {
  total_value: number;
  total_cost: number;
  gain: number;
  gain_pct: number;
  fund_count: number;
  tx_count: number;
}

export interface Allocation {
  id: number;
  name: string;
  color: string;
  value: number;
  percentage: number;
}

export interface PerformanceData {
  funds: { id: number; name: string; color: string }[];
  data: Record<string, any>[];
}

export interface Position {
  asset: string;
  holding_shares: number;
  buy_shares: number;
  sell_shares: number;
  total_cost: number;
  sell_revenue: number;
  dividends: number;
  current_value: number;
  nav: number;
  avg_cost: number;
  gain: number;
  gain_pct: number;
  tx_count: number;
}

export interface ImportPreview {
  name: string;
  totalShares: number;
  avgNav: number;
  gain: number;
  baseShares: number;
  basePrice: number;
  baseAmount: number;
  recentTransactions: { date: string; type: string; shares: number; price: number }[];
  transactionCount: number;
}

export interface Trade {
  id: number;
  fund_id: number;
  asset: string;
  buy_date: string;
  buy_shares: number;
  buy_price: number;
  sell_date: string;
  sell_shares: number;
  sell_price: number;
  paired_shares: number;
  profit: number;
  notes: string | null;
  created_at: string;
}

export interface NavLatest {
  code: string;
  name: string;
  date: string;
  nav: number;
  estimated_nav: number | null;
  estimated_change: number | null;
  estimate_time: string | null;
}

export interface NavDate {
  date: string;
  nav: number;
  note?: string;
}

export interface NavHistory {
  total: number;
  list: { date: string; nav: number; cumulative_nav: number; change_pct: number | null }[];
}

export interface AiAdvice {
  advice: string;
  generated_at: string;
  fund_name: string;
  positions_count: number;
  total_cost: number;
  total_value: number;
}

export interface DailySnapshot {
  date: string;
  holding_shares: number;
  total_cost: number;
  market_value: number;
  cost_nav: number;
  market_nav: number;
  gain: number;
  gain_pct: number;
}

export interface BatchDecision {
  fundId: number;
  name: string;
  code: string;
  color: string;
  nav: number;
  action: 'buy' | 'sell' | 'hold';
  shares: number;
  amount: number;
  summary: string;
  confidence: number;
  compositeScore?: number;
  urgency?: 'high' | 'medium' | 'low';
  position?: {
    holdingShares: number;
    costNav: number;
    gainPct: number;
    baseShares: number;
    swingShares: number;
    marketValue: number;
  };
  masterSignals?: {
    fearGreed: number;
    cyclePhase: string;
    cycleLabel: string;
    baseFactor: number;
  };
  dimensions?: {
    technical: { score: number; trend: string; rsi: number };
    fundamental: { score: number; highlights: string[] };
    news: { score: number; sentiment: string };
  };
  capitalFlow?: {
    flowScore: number;
    flowLabel: string;
    sector: { name: string; mainNetInflow: number; mainPct: number } | null;
    latestMarket: { mainNetInflow: number } | null;
    latestNorthbound: { netBuy: number } | null;
  };
  reasoning?: string[];
}

export interface ForecastResult {
  fundName: string;
  currentNav: number;
  prediction: {
    direction: 'up' | 'down' | 'sideways';
    predictedNav: number;
    predictedChangePct: number;
    navRange: { high: number; low: number };
    confidence: number;
  };
  strategy: {
    action: 'buy' | 'sell' | 'hold';
    shares: number;
    amount: number;
    strategies: string[];
  };
  factors: Record<string, { value: number; label: string; [k: string]: any }>;
  position: { holdingShares: number; costNav: number; gainPct: number; baseShares: number; swingShares: number };
  stats: { recent20: { upDays: number; downDays: number; avgUp: number; avgDown: number }; volatility: number; atrPct: number };
  reasoning: string[];
  fundamentalHighlights: string[];
  timestamp: string;
  message?: string;
}

export interface BatchForecast {
  direction: 'up' | 'down' | 'sideways';
  predictedNav: number;
  predictedChangePct: number;
  confidence: number;
  navRange: { high: number; low: number };
  rsi: number;
  trend: string;
  volatility: number;
  flowScore?: number;
  flowLabel?: string;
}

export interface EstimateData {
  gsz: number;
  gszzl: number;
  gztime: string;
  dwjz: number;
  name: string;
  officialNav: number;
  officialDate: string;
  prevNav: number;
}

export interface ForecastReviewSummary {
  stats: {
    total: number;
    correct: number;
    accuracy: number;
    avgError: number;
    inRange: number;
    inRangePct: number;
  };
  byFund: {
    fund_id: number;
    name: string;
    code: string;
    color: string;
    total: number;
    correct: number;
    accuracy: number;
    avg_error: number;
    inRangePct: number;
  }[];
  factorAccuracy: {
    factor: string;
    label: string;
    total: number;
    correct: number;
    accuracy: number;
  }[];
  recent: {
    id: number;
    fund_id: number;
    fund_name: string;
    fund_code: string;
    fund_color: string;
    target_date: string;
    direction: string;
    predicted_nav: number;
    predicted_change_pct: number;
    confidence: number;
    actual_nav: number;
    actual_change_pct: number;
    direction_correct: number;
    error_pct: number;
    within_range: number;
    analysis: string;
    factorsParsed: Record<string, number>;
  }[];
  days: number;
}

export interface StrategySignal {
  source: string;
  type: 'buy' | 'sell' | 'hold';
  strength: number;
  reason: string;
}

export interface StrategyResult {
  fund: { id: number; name: string; code: string; market_nav: number };
  position: {
    holdingShares: number; costNav: number; totalCost: number;
    marketValue: number; gain: number; gainPct: number;
  };
  technical: {
    rsi14: number;
    macd: { dif: number; dea: number; histogram: number };
    bollingerBands: { upper: number; middle: number; lower: number; width: number; percentB: number };
    atr14: number;
    ma5: number; ma10: number; ma20: number; ma60: number;
    trend: string; trendScore: number;
    support: number; resistance: number;
    volumeMomentum: number;
  };
  risk: {
    maxDrawdown: number; maxDrawdownDays: number; currentDrawdown: number;
    volatility20d: number; sharpeRatio: number; var95: number;
    calmarRatio: number; winRate: number; profitLossRatio: number;
  };
  market: {
    sector: string; sectorIndex: string;
    marketIndices: { name: string; code: string; price: number; changePct: number; trend: string }[];
    marketRegime: 'bull' | 'bear' | 'shock';
    marketScore: number;
  };
  signals: StrategySignal[];
  compositeScore: number;
  advice: {
    kellyPct: number; suggestedAction: string; suggestedAmount: number;
    pyramidLevels: { nav: number; action: string; amount: number; reason: string }[];
    holdingDays: number; costEfficiency: number;
  };
  shortTermPlan: {
    triggers: { condition: string; action: string; amount: number; nav: number }[];
    stopLossNav: number; takeProfitNav: number; outlook: string;
  };
  longTermPlan: {
    monthlyBase: number;
    smartDCA: { condition: string; multiplier: number; amount: number }[];
    targetCostNav: number; targetGainPct: number; horizonMonths: number; outlook: string;
  };
  recoveryPlan: {
    isLosing: boolean; currentLoss: number; currentLossPct: number; breakevenNav: number;
    scenarios: { label: string; investAmount: number; newCostNav: number; newShares: number; breakevenChangePct: number; estimatedDays: number }[];
    recommendation: string;
  };
  summary: {
    verdict: string; verdictColor: string; oneLiner: string; keyPoints: string[];
  };
  navHistory: { date: string; nav: number; change?: number }[];
  timestamp: string;
}

export interface FundDetail {
  fund: { id: number; name: string; color: string; code: string; market_nav: number; stop_profit_pct: number; stop_loss_pct: number; base_position_pct: number; created_at: string };
  positions: Position[];
  transactions: Transaction[];
}

export const api = {
  getFunds: () => request<Fund[]>('/funds'),
  createFund: (data: { name: string; color: string; code?: string }) =>
    request<Fund>('/funds', { method: 'POST', body: JSON.stringify(data) }),
  updateFund: (id: number, data: { name?: string; color?: string; code?: string; market_nav?: number; stop_profit_pct?: number; stop_loss_pct?: number; base_position_pct?: number }) =>
    request<Fund>(`/funds/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFund: (id: number) =>
    request<void>(`/funds/${id}`, { method: 'DELETE' }),
  getTrashFunds: () =>
    request<(Fund & { tx_count: number; deleted_at: string })[]>('/funds/trash/list'),
  restoreFund: (id: number) =>
    request<{ success: boolean }>(`/funds/trash/${id}/restore`, { method: 'POST' }),
  permanentDeleteFund: (id: number) =>
    request<{ success: boolean }>(`/funds/trash/${id}/permanent`, { method: 'DELETE' }),

  getTransactions: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<Transaction[]>(`/transactions${qs}`);
  },
  createTransaction: (data: Partial<Transaction>) =>
    request<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(data) }),
  batchCreateTransactions: (transactions: Partial<Transaction>[]) =>
    request<{ success: boolean; created: number; errors: { index: number; error: string }[]; transactions: Transaction[] }>(
      '/transactions/batch', { method: 'POST', body: JSON.stringify({ transactions }) }),
  updateTransaction: (id: number, data: Partial<Transaction>) =>
    request<Transaction>(`/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTransaction: (id: number) =>
    request<void>(`/transactions/${id}`, { method: 'DELETE' }),
  mergeTransactions: (ids: number[]) =>
    request<Transaction>('/transactions/merge', { method: 'POST', body: JSON.stringify({ ids }) }),
  splitTransaction: (id: number, shares: number) =>
    request<{ original: Transaction; split: Transaction }>(`/transactions/${id}/split`, { method: 'POST', body: JSON.stringify({ shares }) }),
  analyzeTradesForDate: (date?: string) => {
    const qs = date ? `?date=${date}` : '';
    return request<{
      date: string;
      trades: {
        id: number; fundName: string; fundCode: string; color: string;
        type: string; shares: number; price: number; amount: number;
        score: number; grade: string; gradeLabel: string;
        analysis: string[];
        details: {
          bollinger: { percentB: number; position: string };
          rsi: number; trend: string; trendScore: number; vsMA20: number;
          forecast: { direction: string; changePct: number };
          costNav: number; gainPct: number; volatility: number;
          geoRisk: { score: number; level: string } | null;
        };
      }[];
      summary: { total: number; good: number; neutral: number; bad: number; avgScore: number; verdict: string };
    }>(`/strategy/trade-analysis${qs}`);
  },

  getTrades: (fundId: number) => request<Trade[]>(`/trades/funds/${fundId}`),
  createTrade: (buyTxIds: number[], sellTxIds: number[]) =>
    request<Trade>('/trades', { method: 'POST', body: JSON.stringify({ buyTxIds, sellTxIds }) }),
  deleteTrade: (id: number) =>
    request<void>(`/trades/${id}`, { method: 'DELETE' }),

  getFundDetail: (id: number) => request<FundDetail>(`/funds/${id}/positions`),
  adjustHolding: (id: number, target_shares: number, target_nav: number, mode?: 'transaction' | 'fix_base') =>
    request<{ success: boolean }>(`/funds/${id}/adjust`, { method: 'POST', body: JSON.stringify({ target_shares, target_nav, mode: mode || 'transaction' }) }),
  updateFundGain: (id: number, gain: number) =>
    request<{ success: boolean; gain: number; targetCost: number; targetNav: number }>(`/funds/${id}/gain`, { method: 'POST', body: JSON.stringify({ gain }) }),
  getFundAdvice: (id: number) => request<AiAdvice>(`/ai/funds/${id}/advice`),
  getFundResearch: (id: number) => request<{
    fundamental: {
      name: string; type: string; rate: string; manager: string; managerDays: string; managerReturn: string;
      performance: string; assetAlloc: string; topHoldings: string; holderStructure: string; scale: string;
    } | null;
    news: { title: string; date: string; source: string; url: string }[];
    sectorKeyword: string;
    position: { holdingShares: number; costNav: number; marketNav: number; gainPct: number };
    analysis: string | null;
    error?: string;
    generated_at?: string;
  }>(`/ai/funds/${id}/research`),
  getModels: (fundName?: string) => request<{ models: { id: string; label: string; description: string }[]; default: string }>(`/strategy/models${fundName ? `?fundName=${encodeURIComponent(fundName)}` : ''}`),
  getDecision: (id: number, nav: number, model?: string) => request<{
    nav: number; action: 'buy' | 'sell' | 'hold'; shares: number; amount: number;
    confidence: number; urgency: 'high' | 'medium' | 'low'; summary: string; compositeScore: number;
    position: { holdingShares: number; costNav: number; gainPct: number; baseShares: number; swingShares: number; marketValue: number };
    impact: { newShares: number; newCostNav: number; costChange: number };
    cycle: {
      step1: { action: string; nav: number; shares: number; amount: number };
      step2: { action: string; nav: number; shares: number; amount: number };
      cycleCostDrop: number; cycleProfit: number; newCostNavAfterCycle: number;
    } | null;
    dimensions: {
      technical: { score: number; trend: string; rsi: number; signals: string[] };
      fundamental: { score: number; highlights: string[] };
      news: { score: number; sentiment: string; bullish: string[]; bearish: string[] };
    };
    reasoning: string[];
    modelVersion: { forecast: string; decision: string; label: string };
    timestamp: string;
  }>(`/strategy/funds/${id}/decision?nav=${nav}${model ? `&model=${model}` : ''}`),
  getForecast: (id: number) => request<ForecastResult>(`/strategy/funds/${id}/forecast`),
  getFundStrategy: (id: number) => request<StrategyResult>(`/strategy/funds/${id}`),
  getQuickAdvice: (id: number, realtimeNav: number) => request<StrategyResult>(`/strategy/funds/${id}?nav=${realtimeNav}`),
  getSwingAdvice: (id: number, nav: number) => request<{
    nav: number; costNav: number; holdingShares: number;
    unpairedBuys: { id: number; date: string; shares: number; price: number; remainShares: number; profit: number; profitPct: number }[];
    suggestions: { txId: number; date: string; buyPrice: number; shares: number; sellShares: number; keepShares: number; profit: number; action: string; reason: string }[];
    impact: { totalProfit: number; totalSellShares: number; newHoldingShares: number; newCostNav: number; costReduction: number };
  }>(`/strategy/funds/${id}/swing?nav=${nav}`),

  getBandTrade: (id: number, nav: number) => request<any>(`/strategy/funds/${id}/band-trade?nav=${nav}`),
  getPortfolioAdvice: () => request<any>('/strategy/portfolio-advice'),

  importPreview: (text: string) =>
    request<{ funds: ImportPreview[] }>('/import/preview', { method: 'POST', body: JSON.stringify({ text }) }),
  importExecute: (text: string) =>
    request<{ success: boolean; imported: { name: string; fundId: number; transactionCount: number }[] }>('/import/execute', { method: 'POST', body: JSON.stringify({ text }) }),

  getBackups: () => request<{ filename: string; size: number; created_at: string }[]>('/backups'),
  createBackup: () => request<{ filename: string; size: number }>('/backups', { method: 'POST' }),
  restoreBackup: (filename: string) =>
    request<{ success: boolean; message: string }>('/backups/restore', { method: 'POST', body: JSON.stringify({ filename }) }),
  deleteBackup: (filename: string) =>
    request<void>(`/backups/${filename}`, { method: 'DELETE' }),

  getSummary: () => request<Summary>('/stats/summary'),
  getPerformance: () => request<PerformanceData>('/stats/performance'),
  getAllocation: () => request<Allocation[]>('/stats/allocation'),
  recordSnapshot: () => request<{ success: boolean; count: number }>('/stats/snapshot', { method: 'POST' }),
  getSnapshots: (fundId: number, days?: number) =>
    request<DailySnapshot[]>(`/stats/snapshots/${fundId}${days ? `?days=${days}` : ''}`),
  getCostNavChanges: () =>
    request<{ fund_id: number; costNav: number; prevCostNav: number; costNavChange: number; costNavChangePct: number; date: string }[]>('/stats/cost-nav-changes'),

  getEstimateAll: () => request<Record<number, { gsz: number; gszzl: number; gztime: string; dwjz: number; name: string }>>('/nav/estimate/all'),
  getLatestNav: (code: string) => request<NavLatest>(`/nav/${code}/latest`),
  getNavByDate: (code: string, date: string) => request<NavDate>(`/nav/${code}/date/${date}`),
  refreshAllNav: () => request<{ updated: number; total: number; results: { id: number; name: string; code: string; nav: number | null; error?: string }[] }>('/nav/refresh-all', { method: 'POST' }),
  getNavHistory: (code: string, params?: { start?: string; end?: string; pageSize?: string }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    return request<NavHistory>(`/nav/${code}/history${qs}`);
  },
  getBatchDecisions: (estimates: Record<number, number>) =>
    request<BatchDecision[]>(`/strategy/decisions/all?estimates=${encodeURIComponent(JSON.stringify(estimates))}`),
  getBatchForecasts: () =>
    request<Record<number, BatchForecast>>('/strategy/forecasts/all'),
  getForecastReviewSummary: (days?: number) =>
    request<ForecastReviewSummary>(`/strategy/forecast-reviews/summary${days ? `?days=${days}` : ''}`),
  runForecastReview: () =>
    request<{ success: boolean; reviewed: number }>('/strategy/forecast-reviews/run', { method: 'POST' }),
  getFundForecastHistory: (fundId: number, limit?: number) =>
    request<any[]>(`/strategy/forecasts/fund/${fundId}${limit ? `?limit=${limit}` : ''}`),

  // --- Data Sync ---
  syncExport: () => request<{ version: number; exportedAt: string; data: Record<string, any[]> }>('/sync/export'),
  syncImport: (syncData: { version: number; data: Record<string, any[]> }) =>
    request<{ success: boolean; imported: Record<string, number> }>('/sync/import', { method: 'POST', body: JSON.stringify(syncData) }),
  // Pull from remote PC server (routed through local-router in harmony mode)
  syncPullFromPC: (pcUrl: string) =>
    request<{ version: number; exportedAt: string; data: Record<string, any[]> }>('/sync/pull', { method: 'POST', body: JSON.stringify({ pcUrl }) }),
  // Push to remote PC server (routed through local-router in harmony mode)
  syncPushToPC: (pcUrl: string, syncData: any) =>
    request<{ success: boolean; imported: Record<string, number> }>('/sync/push', { method: 'POST', body: JSON.stringify({ pcUrl, data: syncData }) }),
};
