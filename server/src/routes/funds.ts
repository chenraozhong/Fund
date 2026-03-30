import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const funds = db.prepare(`
    SELECT f.*,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy,
      COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0) as total_sell,
      COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as total_dividend
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    GROUP BY f.id
    ORDER BY f.created_at DESC
  `).all();

  const result = (funds as any[]).map(f => {
    const costBasis = f.total_buy - f.total_sell + f.total_dividend; // 持仓成本
    // 如果设置了当前市场净值，用它算市值和盈亏；否则用持仓成本
    const marketValue = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav
      : costBasis;
    const gain = marketValue - costBasis;

    return {
      ...f,
      current_value: marketValue,
      total_cost: costBasis,
      gain,
      gain_pct: costBasis > 0 ? (gain / costBasis) * 100 : 0,
    };
  });

  res.json(result);
});

router.post('/', (req: Request, res: Response) => {
  const { name, color } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  const result = db.prepare('INSERT INTO funds (name, color) VALUES (?, ?)').run(name, color || '#378ADD');
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(fund);
});

router.put('/:id', (req: Request, res: Response) => {
  const { name, color, market_nav, stop_profit_pct, stop_loss_pct } = req.body;
  const { id } = req.params;
  db.prepare(`UPDATE funds SET
    name = COALESCE(?, name),
    color = COALESCE(?, color),
    market_nav = COALESCE(?, market_nav),
    stop_profit_pct = COALESCE(?, stop_profit_pct),
    stop_loss_pct = COALESCE(?, stop_loss_pct)
    WHERE id = ?`
  ).run(name, color, market_nav ?? null, stop_profit_pct ?? null, stop_loss_pct ?? null, id);
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id);
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  res.json(fund);
});

// Adjust holding: set target shares and cost NAV by creating/updating an adjustment transaction
router.post('/:id/adjust', (req: Request, res: Response) => {
  const { id } = req.params;
  const { target_shares, target_nav } = req.body;

  if (target_shares == null || target_nav == null) {
    res.status(400).json({ error: '需要 target_shares 和 target_nav' });
    return;
  }

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }

  // Get current position from transactions
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
    FROM transactions WHERE fund_id = ?
  `).get(id) as any;

  const currentShares = row.holding_shares;
  const currentCost = row.cost_basis;
  const targetCost = target_shares * target_nav;

  const sharesDiff = target_shares - currentShares;
  const costDiff = targetCost - currentCost;

  db.transaction(() => {
    const today = new Date().toISOString().slice(0, 10);
    const asset = fund.name;

    if (Math.abs(sharesDiff) > 0.0001 || Math.abs(costDiff) > 0.01) {
      if (sharesDiff > 0) {
        // Need more shares → insert a buy adjustment
        const price = costDiff / sharesDiff;
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, today, 'buy', asset, Math.round(sharesDiff * 10000) / 10000, Math.round(price * 10000) / 10000, '持仓调整');
      } else if (sharesDiff < 0) {
        // Need fewer shares → insert a sell adjustment
        const price = Math.abs(costDiff / sharesDiff);
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, today, 'sell', asset, Math.round(Math.abs(sharesDiff) * 10000) / 10000, Math.round(price * 10000) / 10000, '持仓调整');
      } else {
        // Same shares, different cost → adjust via a tiny buy/sell pair
        // Add a buy at the target nav, and sell the same at old nav
        // Simpler: just add a dividend adjustment for the cost difference
        if (costDiff > 0) {
          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(id, today, 'dividend', asset, 0, Math.round(costDiff * 100) / 100, '净值调整');
        } else {
          // Negative adjustment: add a sell of 0 shares... not valid.
          // Use a buy with 0 shares at negative? No. Just do a tiny buy+sell.
          // Actually: add a buy at higher price then sell at lower to reduce cost basis
          // Simplest: just create a correction buy with negative-ish math
          // Let's use: buy 0.0001 shares at costDiff/0.0001 price
          const fakeShares = 0.0001;
          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(id, today, 'sell', asset, fakeShares, Math.round(Math.abs(costDiff) / fakeShares * 10000) / 10000, '净值调整');
        }
      }
    }
  })();

  res.json({ success: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM funds WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  res.json({ success: true });
});

// Get fund detail with positions grouped by asset
router.get('/:id/positions', (req: Request, res: Response) => {
  const { id } = req.params;
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }

  // Get all transactions for this fund, grouped by asset
  const assets = db.prepare(`
    SELECT
      asset,
      SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END) as buy_shares,
      SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END) as sell_shares,
      SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END) as buy_cost,
      SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END) as sell_revenue,
      SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END) as dividends,
      COUNT(*) as tx_count
    FROM transactions
    WHERE fund_id = ?
    GROUP BY asset
    ORDER BY buy_cost DESC
  `).all(id) as any[];

  const positions = assets.map(a => {
    const holdingShares = a.buy_shares - a.sell_shares;
    const costBasis = a.buy_cost - a.sell_revenue + a.dividends; // 持仓成本
    const nav = holdingShares > 0 ? costBasis / holdingShares : 0; // 持仓均价
    // 如果有市场净值，用市价算盈亏
    const marketValue = (fund as any).market_nav > 0 && holdingShares > 0
      ? holdingShares * (fund as any).market_nav
      : costBasis;
    const gain = marketValue - costBasis;

    return {
      asset: a.asset,
      holding_shares: holdingShares,
      buy_shares: a.buy_shares,
      sell_shares: a.sell_shares,
      total_cost: costBasis,
      sell_revenue: a.sell_revenue,
      dividends: a.dividends,
      current_value: marketValue,
      nav: Math.round(nav * 10000) / 10000,
      avg_cost: Math.round(nav * 10000) / 10000,
      gain,
      gain_pct: costBasis > 0 ? (gain / costBasis) * 100 : 0,
      tx_count: a.tx_count,
    };
  });

  // Get all transactions for this fund
  const transactions = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t
    JOIN funds f ON f.id = t.fund_id
    WHERE t.fund_id = ?
    ORDER BY t.date DESC, t.created_at DESC
  `).all(id);

  res.json({ fund, positions, transactions });
});

export default router;
