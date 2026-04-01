import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/summary', (_req: Request, res: Response) => {
  // 按基金逐个计算，与 funds GET / 逻辑一致
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

  let totalValue = 0;
  let totalCost = 0;
  for (const f of funds) {
    const costBasis = f.total_buy - f.total_sell + f.total_dividend;
    const marketValue = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav
      : costBasis;
    totalValue += marketValue;
    totalCost += costBasis;
  }

  const txCount = (db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any).count;
  const gain = totalValue - totalCost;

  res.json({
    total_value: Math.round(totalValue * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    gain: Math.round(gain * 100) / 100,
    gain_pct: totalCost > 0 ? Math.round((gain / totalCost) * 10000) / 100 : 0,
    fund_count: funds.length,
    tx_count: txCount,
  });
});

router.get('/performance', (_req: Request, res: Response) => {
  const funds = db.prepare('SELECT id, name, color FROM funds').all() as any[];

  // Generate last 12 months
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7)); // YYYY-MM
  }

  const result = months.map(month => {
    const endOfMonth = month + '-31'; // Works for comparison since dates are strings
    const entry: any = { month };

    for (const fund of funds) {
      const row = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as value
        FROM transactions
        WHERE fund_id = ? AND date <= ?
      `).get(fund.id, endOfMonth) as any;

      entry[fund.name] = Math.round(row.value * 100) / 100;
    }

    return entry;
  });

  res.json({ funds, data: result });
});

router.get('/allocation', (_req: Request, res: Response) => {
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
      ? f.holding_shares * f.market_nav
      : costBasis;
    return { id: f.id, name: f.name, color: f.color, value };
  });

  const total = computed.reduce((s, f) => s + f.value, 0);

  const result = computed.map(f => ({
    id: f.id,
    name: f.name,
    color: f.color,
    value: Math.round(f.value * 100) / 100,
    percentage: total > 0 ? Math.round((f.value / total) * 10000) / 100 : 0,
  }));

  res.json(result);
});

// 记录每日快照（幂等，同一天同一基金只存一条）
function recordDailySnapshots() {
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

  const tx = db.transaction(() => {
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
  });
  tx();
  return funds.length;
}

// 手动触发快照
router.post('/snapshot', (_req: Request, res: Response) => {
  const count = recordDailySnapshots();
  res.json({ success: true, count });
});

// 获取基金快照历史
router.get('/snapshots/:fundId', (req: Request, res: Response) => {
  const { fundId } = req.params;
  const { days } = req.query;
  const limit = days ? parseInt(days as string) : 90;
  const rows = db.prepare(`
    SELECT date, holding_shares, total_cost, market_value, cost_nav, market_nav, gain, gain_pct
    FROM daily_snapshots
    WHERE fund_id = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(fundId, limit);
  res.json((rows as any[]).reverse());
});

// 获取所有基金的最新快照（用于总览）
router.get('/snapshots-all', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT s.fund_id, s.date, s.gain, s.gain_pct, s.cost_nav, s.market_nav
    FROM daily_snapshots s
    INNER JOIN (
      SELECT fund_id, MAX(date) as max_date FROM daily_snapshots GROUP BY fund_id
    ) latest ON s.fund_id = latest.fund_id AND s.date = latest.max_date
  `).all();
  res.json(rows);
});

export { recordDailySnapshots };
export default router;
