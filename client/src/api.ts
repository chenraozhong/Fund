const BASE = '/api';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
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
  market_nav: number;
  stop_profit_pct: number;
  stop_loss_pct: number;
  created_at: string;
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

export interface AiAdvice {
  advice: string;
  generated_at: string;
  fund_name: string;
  positions_count: number;
  total_cost: number;
  total_value: number;
}

export interface FundDetail {
  fund: { id: number; name: string; color: string; market_nav: number; stop_profit_pct: number; stop_loss_pct: number; created_at: string };
  positions: Position[];
  transactions: Transaction[];
}

export const api = {
  getFunds: () => request<Fund[]>('/funds'),
  createFund: (data: { name: string; color: string }) =>
    request<Fund>('/funds', { method: 'POST', body: JSON.stringify(data) }),
  updateFund: (id: number, data: { name?: string; color?: string; market_nav?: number }) =>
    request<Fund>(`/funds/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFund: (id: number) =>
    request<void>(`/funds/${id}`, { method: 'DELETE' }),

  getTransactions: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<Transaction[]>(`/transactions${qs}`);
  },
  createTransaction: (data: Partial<Transaction>) =>
    request<Transaction>('/transactions', { method: 'POST', body: JSON.stringify(data) }),
  updateTransaction: (id: number, data: Partial<Transaction>) =>
    request<Transaction>(`/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTransaction: (id: number) =>
    request<void>(`/transactions/${id}`, { method: 'DELETE' }),
  mergeTransactions: (ids: number[]) =>
    request<Transaction>('/transactions/merge', { method: 'POST', body: JSON.stringify({ ids }) }),
  splitTransaction: (id: number, shares: number) =>
    request<{ original: Transaction; split: Transaction }>(`/transactions/${id}/split`, { method: 'POST', body: JSON.stringify({ shares }) }),

  getTrades: (fundId: number) => request<Trade[]>(`/trades/funds/${fundId}`),
  createTrade: (buyTxIds: number[], sellTxIds: number[]) =>
    request<Trade>('/trades', { method: 'POST', body: JSON.stringify({ buyTxIds, sellTxIds }) }),
  deleteTrade: (id: number) =>
    request<void>(`/trades/${id}`, { method: 'DELETE' }),

  getFundDetail: (id: number) => request<FundDetail>(`/funds/${id}/positions`),
  adjustHolding: (id: number, target_shares: number, target_nav: number) =>
    request<{ success: boolean }>(`/funds/${id}/adjust`, { method: 'POST', body: JSON.stringify({ target_shares, target_nav }) }),
  getFundAdvice: (id: number) => request<AiAdvice>(`/ai/funds/${id}/advice`),

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
};
