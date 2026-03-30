import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/summary', (_req: Request, res: Response) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as total_value,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_cost,
      COUNT(DISTINCT t.id) as tx_count
    FROM transactions t
  `).get() as any;

  const fundCount = (db.prepare('SELECT COUNT(*) as count FROM funds').get() as any).count;

  res.json({
    total_value: row.total_value,
    total_cost: row.total_cost,
    gain: row.total_value - row.total_cost,
    gain_pct: row.total_cost > 0 ? ((row.total_value - row.total_cost) / row.total_cost) * 100 : 0,
    fund_count: fundCount,
    tx_count: row.tx_count,
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
    SELECT f.id, f.name, f.color,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as value
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    GROUP BY f.id
  `).all() as any[];

  const total = funds.reduce((s, f) => s + f.value, 0);

  const result = funds.map(f => ({
    id: f.id,
    name: f.name,
    color: f.color,
    value: Math.round(f.value * 100) / 100,
    percentage: total > 0 ? Math.round((f.value / total) * 10000) / 100 : 0,
  }));

  res.json(result);
});

export default router;
