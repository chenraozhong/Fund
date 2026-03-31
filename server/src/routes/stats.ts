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

export default router;
