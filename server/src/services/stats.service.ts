import db from '../db';

export function getSummary() {
  const funds = db.prepare(`
    SELECT f.id, f.market_nav, f.cumulative_gain,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL
    GROUP BY f.id
  `).all() as any[];

  let totalValue = 0, totalGain = 0;
  for (const f of funds) {
    const marketValue = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav : 0;
    totalValue += marketValue;
    totalGain += (f.cumulative_gain || 0);
  }

  const txCount = (db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any).count;

  return {
    total_value: Math.round(totalValue * 100) / 100,
    total_cost: Math.round((totalValue - totalGain) * 100) / 100,
    gain: Math.round(totalGain * 100) / 100,
    gain_pct: totalValue > totalGain && totalGain !== 0
      ? Math.round((totalGain / (totalValue - totalGain)) * 10000) / 100 : 0,
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

  // 1. 获取所有基金数据(含官方prev_nav)
  const funds = db.prepare(`
    SELECT f.id, f.market_nav, f.prev_nav, f.cumulative_gain,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0) as total_buy_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL
    GROUP BY f.id
  `).all() as any[];

  // 2. 今日交易(用于反推日初份额)
  const todayTxs = db.prepare(`
    SELECT fund_id,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) as today_bought,
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as today_sold
    FROM transactions WHERE date = ? GROUP BY fund_id
  `).all(today) as any[];
  const todayMap = new Map<number, { bought: number; sold: number }>();
  for (const t of todayTxs) todayMap.set(t.fund_id, { bought: t.today_bought, sold: t.today_sold });

  // 3. fallback: 每只基金各自的最近快照NAV(当funds.prev_nav为0时使用)
  const prevSnaps = db.prepare(`
    SELECT ds.fund_id, ds.market_nav FROM daily_snapshots ds
    WHERE ds.date = (SELECT MAX(date) FROM daily_snapshots WHERE fund_id = ds.fund_id AND date < ?)
  `).all(today) as any[];
  const prevSnapNavMap = new Map<number, number>();
  for (const s of prevSnaps) prevSnapNavMap.set(s.fund_id, s.market_nav);

  // 4. 今日已有快照的daily_gain(幂等: 先减旧值再加新值)
  const existingSnaps = db.prepare(`
    SELECT fund_id, daily_gain FROM daily_snapshots WHERE date = ?
  `).all(today) as any[];
  const existingGainMap = new Map<number, number>();
  for (const s of existingSnaps) existingGainMap.set(s.fund_id, s.daily_gain || 0);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (fund_id, date, holding_shares, total_cost, market_value, cost_nav, market_nav, gain, gain_pct, daily_gain, prev_nav)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateFundGain = db.prepare(`UPDATE funds SET cumulative_gain = ? WHERE id = ?`);
  const updatePrevSnapshot = db.prepare(`
    UPDATE daily_snapshots SET holding_shares = ?
    WHERE fund_id = ? AND date = (SELECT MAX(date) FROM daily_snapshots WHERE fund_id = ? AND date < ?)
  `);

  db.transaction(() => {
    for (const f of funds) {
      const holdingShares = f.holding_shares;
      const mNav = f.market_nav || 0;
      const marketValue = mNav > 0 && holdingShares > 0 ? holdingShares * mNav : 0;
      const avgBuyPrice = f.total_buy_shares > 0 ? f.total_buy / f.total_buy_shares : 0;
      const holdingCost = holdingShares > 0 ? holdingShares * avgBuyPrice : 0;
      const costNav = holdingCost > 0 ? holdingCost / holdingShares : 0;

      // 日初份额 = 当前持仓 - 今日买入 + 今日卖出
      const todayTx = todayMap.get(f.id);
      const startOfDayShares = holdingShares - (todayTx?.bought || 0) + (todayTx?.sold || 0);

      // prevNav: 优先用官方API的prev_nav, fallback到快照
      const prevNav = (f.prev_nav && f.prev_nav > 0) ? f.prev_nav : (prevSnapNavMap.get(f.id) || 0);

      let dailyGain = 0;
      if (startOfDayShares > 0 && mNav > 0 && prevNav > 0) {
        dailyGain = Math.round(startOfDayShares * (mNav - prevNav) * 100) / 100;
      }

      // 幂等累计收益: 减旧daily_gain + 加新daily_gain
      const oldDailyGain = existingGainMap.get(f.id) ?? 0;
      const cumulativeGain = Math.round(((f.cumulative_gain || 0) - oldDailyGain + dailyGain) * 100) / 100;
      updateFundGain.run(cumulativeGain, f.id);

      const gainPct = holdingCost > 0 ? ((marketValue - holdingCost) / holdingCost) * 100 : 0;

      insert.run(f.id, today, holdingShares, Math.round(holdingCost * 100) / 100,
        Math.round(marketValue * 100) / 100, Math.round(costNav * 10000) / 10000,
        mNav, Math.round(cumulativeGain * 100) / 100, Math.round(gainPct * 100) / 100,
        dailyGain, prevNav);

      // 同步更新昨日快照的holding_shares(反映补录交易)
      updatePrevSnapshot.run(startOfDayShares, f.id, f.id, today);
    }
  })();
  return funds.length;
}

export function getSnapshots(fundId: number | string, days?: number) {
  const limit = days || 90;
  const rows = db.prepare(`
    SELECT date, holding_shares, total_cost, market_value, cost_nav, market_nav, gain, gain_pct, daily_gain
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

/** 短线收益汇总（所有配对交易） */
export function getShortTermProfit() {
  const trades = db.prepare('SELECT * FROM trades ORDER BY sell_date DESC').all() as any[];

  let totalProfit = 0, totalBuyCost = 0, winCount = 0, lossCount = 0;
  const byFund: Record<number, { fund_id: number; asset: string; profit: number; count: number; buyCost: number }> = {};

  for (const t of trades) {
    const buyCost = t.paired_shares * t.buy_price;
    totalProfit += t.profit;
    totalBuyCost += buyCost;
    if (t.profit >= 0) winCount++; else lossCount++;

    if (!byFund[t.fund_id]) {
      byFund[t.fund_id] = { fund_id: t.fund_id, asset: t.asset, profit: 0, count: 0, buyCost: 0 };
    }
    byFund[t.fund_id].profit += t.profit;
    byFund[t.fund_id].count += 1;
    byFund[t.fund_id].buyCost += buyCost;
  }

  const fundBreakdown = Object.values(byFund)
    .map(f => ({
      ...f,
      profit: Math.round(f.profit * 100) / 100,
      profitPct: f.buyCost > 0 ? Math.round((f.profit / f.buyCost) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.profit - a.profit);

  // 按月统计
  const byMonth: Record<string, { month: string; profit: number; buyCost: number; count: number; winCount: number; lossCount: number }> = {};
  for (const t of trades) {
    const month = (t.sell_date || t.buy_date).slice(0, 7); // YYYY-MM
    if (!byMonth[month]) {
      byMonth[month] = { month, profit: 0, buyCost: 0, count: 0, winCount: 0, lossCount: 0 };
    }
    const buyCost = t.paired_shares * t.buy_price;
    byMonth[month].profit += t.profit;
    byMonth[month].buyCost += buyCost;
    byMonth[month].count += 1;
    if (t.profit >= 0) byMonth[month].winCount++; else byMonth[month].lossCount++;
  }
  const monthlyBreakdown = Object.values(byMonth)
    .map(m => ({
      ...m,
      profit: Math.round(m.profit * 100) / 100,
      profitPct: m.buyCost > 0 ? Math.round((m.profit / m.buyCost) * 10000) / 100 : 0,
      buyCost: Math.round(m.buyCost * 100) / 100,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return {
    totalProfit: Math.round(totalProfit * 100) / 100,
    totalProfitPct: totalBuyCost > 0 ? Math.round((totalProfit / totalBuyCost) * 10000) / 100 : 0,
    totalBuyCost: Math.round(totalBuyCost * 100) / 100,
    tradeCount: trades.length,
    winCount,
    lossCount,
    winRate: trades.length > 0 ? Math.round((winCount / trades.length) * 10000) / 100 : 0,
    fundBreakdown,
    monthlyBreakdown,
    recentTrades: trades.slice(0, 10).map(t => ({
      id: t.id,
      fund_id: t.fund_id,
      asset: t.asset,
      buy_date: t.buy_date,
      sell_date: t.sell_date,
      paired_shares: t.paired_shares,
      buy_price: t.buy_price,
      sell_price: t.sell_price,
      profit: t.profit,
      navDiff: Math.round((t.sell_price - t.buy_price) * 10000) / 10000,
      profitPct: t.buy_price > 0 ? Math.round(((t.sell_price - t.buy_price) / t.buy_price) * 10000) / 100 : 0,
    })),
  };
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
