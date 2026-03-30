const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export interface Fund {
  id: number;
  name: string;
  color: string;
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

export const api = {
  getFunds: () => request<Fund[]>('/funds'),
  createFund: (data: { name: string; color: string }) =>
    request<Fund>('/funds', { method: 'POST', body: JSON.stringify(data) }),
  updateFund: (id: number, data: { name?: string; color?: string }) =>
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

  getSummary: () => request<Summary>('/stats/summary'),
  getPerformance: () => request<PerformanceData>('/stats/performance'),
  getAllocation: () => request<Allocation[]>('/stats/allocation'),
};
