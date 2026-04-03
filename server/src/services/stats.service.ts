import db from '../db';

export function getSummary() {
  const funds = db.prepare(`
    SELECT f.id, f.market_nav,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy,
      COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0) as total_sell,
      COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as total_dividend
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    GROUP BY f.id
  `).all() as any[];

  let totalValue = 0, totalCost = 0;
  for (const f of funds) {
    const costBasis = f.total_buy - f.total_sell + f.total_dividend;
    const marketValue = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav : costBasis;
    totalValue += marketValue;
    totalCost += costBasis;
  }

  const txCount = (db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any).count;
  const gain = totalValue - totalCost;

  return {
    total_value: Math.round(totalValue * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    gain: Math.round(gain * 100) / 100,
    gain_pct: totalCost > 0 ? Math.round((gain / totalCost) * 10000) / 100 : 0,
    fund_count: funds.length,
    tx_count: txCount,
  };
}

export function getPerformance() {
  const funds = db.prepare('SELECT id, name, color FROM funds').all() as any[];
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }

  const result = months.map(month => {
    const endOfMonth = month + '-31';
    const entry: any = { month };
    for (const fund of funds) {
      const row = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as value
        FROM transactions WHERE fund_id = ? AND date <= ?
      `).get(fund.id, endOfMonth) as any;
      entry[fund.name] = Math.round(row.value * 100) / 100;
    }
    return entry;
  });

  return { funds, data: result };
}

export function getAllocation() {
  const funds = db.prepare(`
    SELECT f.id, f.name, f.color, f.market_nav,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy,
      COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0) as total_sell,
      COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as total_dividend
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    GROUP BY f.id
  `).all() as any[];

  const computed = funds.map(f => {
    const costBasis = f.total_buy - f.total_sell + f.total_dividend;
    const value = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav : costBasis;
    return { id: f.id, name: f.name, color: f.color, value };
  });

  const total = computed.reduce((s, f) => s + f.value, 0);

  return computed.map(f => ({
    id: f.id, name: f.name, color: f.color,
    value: Math.round(f.value * 100) / 100,
    percentage: total > 0 ? Math.round((f.value / total) * 10000) / 100 : 0,
  }));
}

export function recordDailySnapshots() {
  const today = new Date().toISOString().slice(0, 10);
  const funds = db.prepare(`
    SELECT f.id, f.market_nav,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy,
      COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0) as total_sell,
      COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as total_dividend
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL
    GROUP BY f.id
  `).all() as any[];

  const insert = db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (fund_id, date, holding_shares, total_cost, market_value, cost_nav, market_nav, gain, gain_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const f of funds) {
      const holdingShares = f.holding_shares;
      const totalCost = f.total_buy - f.total_sell + f.total_dividend;
      const mNav = f.market_nav || 0;
      const marketValue = mNav > 0 && holdingShares > 0 ? holdingShares * mNav : totalCost;
      const costNav = holdingShares > 0 && totalCost > 0 ? totalCost / holdingShares : 0;
      const gain = marketValue - totalCost;
      const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
      insert.run(f.id, today, holdingShares, Math.round(totalCost * 100) / 100, Math.round(marketValue * 100) / 100, Math.round(costNav * 10000) / 10000, mNav, Math.round(gain * 100) / 100, Math.round(gainPct * 100) / 100);
    }
  })();
  return funds.length;
}

export function getSnapshots(fundId: number | string, days?: number) {
  const limit = days || 90;
  const rows = db.prepare(`
    SELECT date, holding_shares, total_cost, market_value, cost_nav, market_nav, gain, gain_pct
    FROM daily_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT ?
  `).all(fundId, limit);
  return (rows as any[]).reverse();
}

export function getAllSnapshots() {
  return db.prepare(`
    SELECT s.fund_id, s.date, s.gain, s.gain_pct, s.cost_nav, s.market_nav
    FROM daily_snapshots s
    INNER JOIN (
      SELECT fund_id, MAX(date) as max_date FROM daily_snapshots GROUP BY fund_id
    ) latest ON s.fund_id = latest.fund_id AND s.date = latest.max_date
  `).all();
}

/** Get cost NAV change summary for all funds (latest vs previous snapshot) */
export function getCostNavChanges() {
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT fund_id, date, cost_nav, market_nav, gain_pct,
        ROW_NUMBER() OVER (PARTITION BY fund_id ORDER BY date DESC) as rn
      FROM daily_snapshots
    )
    SELECT
      r1.fund_id,
      r1.cost_nav as current_cost_nav,
      r1.date as current_date,
      r2.cost_nav as prev_cost_nav,
      r2.date as prev_date
    FROM ranked r1
    LEFT JOIN ranked r2 ON r1.fund_id = r2.fund_id AND r2.rn = 2
    WHERE r1.rn = 1
  `).all() as any[];

  return rows.map(r => ({
    fund_id: r.fund_id,
    costNav: r.current_cost_nav || 0,
    prevCostNav: r.prev_cost_nav || 0,
    costNavChange: r.prev_cost_nav ? r.current_cost_nav - r.prev_cost_nav : 0,
    costNavChangePct: r.prev_cost_nav ? ((r.current_cost_nav - r.prev_cost_nav) / r.prev_cost_nav) * 100 : 0,
    date: r.current_date,
  }));
}
