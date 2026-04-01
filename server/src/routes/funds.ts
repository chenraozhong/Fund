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
    WHERE f.deleted_at IS NULL
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
  const { name, color, code } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }

  // 如果有基金代码，检查是否已存在同代码基金 → 更新名称
  if (code) {
    const existing = db.prepare('SELECT * FROM funds WHERE code = ?').get(code) as any;
    if (existing) {
      db.prepare('UPDATE funds SET name = ?, color = COALESCE(?, color) WHERE id = ?')
        .run(name, color || null, existing.id);
      const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(existing.id);
      res.json(fund);
      return;
    }
  }

  const result = db.prepare('INSERT INTO funds (name, color, code) VALUES (?, ?, ?)').run(name, color || '#378ADD', code || '');
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(fund);
});

// 回收站列表
router.get('/trash/list', (_req: Request, res: Response) => {
  const funds = db.prepare(`
    SELECT f.*, COUNT(t.id) as tx_count
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NOT NULL
    GROUP BY f.id
    ORDER BY f.deleted_at DESC
  `).all();
  res.json(funds);
});

// 恢复基金
router.post('/trash/:id/restore', (req: Request, res: Response) => {
  const result = db.prepare('UPDATE funds SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: '未找到该回收站基金' });
    return;
  }
  res.json({ success: true });
});

// 永久删除
router.delete('/trash/:id/permanent', (req: Request, res: Response) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!fund) {
    res.status(404).json({ error: '只能永久删除回收站中的基金' });
    return;
  }
  db.prepare('DELETE FROM funds WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.put('/:id', (req: Request, res: Response) => {
  const { name, color, code, market_nav, stop_profit_pct, stop_loss_pct, base_position_pct } = req.body;
  const { id } = req.params;
  db.prepare(`UPDATE funds SET
    name = COALESCE(?, name),
    color = COALESCE(?, color),
    code = COALESCE(?, code),
    market_nav = COALESCE(?, market_nav),
    stop_profit_pct = COALESCE(?, stop_profit_pct),
    stop_loss_pct = COALESCE(?, stop_loss_pct),
    base_position_pct = COALESCE(?, base_position_pct)
    WHERE id = ?`
  ).run(name, color, code ?? null, market_nav ?? null, stop_profit_pct ?? null, stop_loss_pct ?? null, base_position_pct ?? null, id);
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id);
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  res.json(fund);
});

// Adjust holding: set target shares and cost NAV
// mode = 'transaction' (default): generate adjustment transactions to reach target
// mode = 'fix_base': directly modify the base/historical transaction
router.post('/:id/adjust', (req: Request, res: Response) => {
  const { id } = req.params;
  const { target_shares, target_nav, mode } = req.body;

  if (target_shares == null || target_nav == null) {
    res.status(400).json({ error: '需要 target_shares 和 target_nav' });
    return;
  }

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }

  // 模式二：修正历史持仓
  if (mode === 'fix_base') {
    const base = db.prepare(
      "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
    ).get(id) as any;

    if (!base) {
      res.status(400).json({ error: '未找到历史持仓记录，无法使用此模式' });
      return;
    }

    // 计算除了底仓以外的其他交易产生的净份额和净成本
    const others = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as net_shares,
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
        COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as net_cost
      FROM transactions WHERE fund_id = ? AND id != ?
    `).get(id, base.id) as any;

    // 底仓 = 目标 - 其他交易的贡献
    const newBaseShares = target_shares - others.net_shares;
    const newBaseCost = target_shares * target_nav - others.net_cost;

    if (newBaseShares <= 0) {
      res.status(400).json({ error: `修正后底仓份额为 ${newBaseShares.toFixed(2)}，不合理。请检查目标值。` });
      return;
    }

    const newBasePrice = Math.round((newBaseCost / newBaseShares) * 10000) / 10000;

    db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
      .run(Math.round(newBaseShares * 10000) / 10000, newBasePrice, base.id);

    res.json({ success: true, mode: 'fix_base', baseShares: newBaseShares, basePrice: newBasePrice });
    return;
  }

  // 模式一（默认）：生成调整交易
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
        const price = costDiff / sharesDiff;
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, today, 'buy', asset, Math.round(sharesDiff * 10000) / 10000, Math.round(price * 10000) / 10000, '持仓调整');
      } else if (sharesDiff < 0) {
        const price = Math.abs(costDiff / sharesDiff);
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, today, 'sell', asset, Math.round(Math.abs(sharesDiff) * 10000) / 10000, Math.round(price * 10000) / 10000, '持仓调整');
      } else {
        if (costDiff > 0) {
          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(id, today, 'dividend', asset, 0, Math.round(costDiff * 100) / 100, '净值调整');
        } else {
          const fakeShares = 0.0001;
          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(id, today, 'sell', asset, fakeShares, Math.round(Math.abs(costDiff) / fakeShares * 10000) / 10000, '净值调整');
        }
      }
    }
  })();

  res.json({ success: true, mode: 'transaction' });
});

// 修改当前盈亏：根据盈亏自动反推持仓成本，调整底仓
router.post('/:id/gain', (req: Request, res: Response) => {
  const { id } = req.params;
  const { gain } = req.body;

  if (gain == null) {
    res.status(400).json({ error: '需要 gain（盈亏金额）' });
    return;
  }

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }

  if (!fund.market_nav || fund.market_nav <= 0) {
    res.status(400).json({ error: '请先设置当前市场净值（market_nav），才能根据盈亏计算成本' });
    return;
  }

  // 计算当前持仓份额
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares
    FROM transactions WHERE fund_id = ?
  `).get(id) as any;

  const holdingShares = row.holding_shares;
  if (holdingShares <= 0) {
    res.status(400).json({ error: '当前无持仓份额，无法调整盈亏' });
    return;
  }

  // 目标成本 = 市值 - 盈亏
  const marketValue = holdingShares * fund.market_nav;
  const targetCost = marketValue - gain;
  const targetNav = targetCost / holdingShares;

  // 查找历史持仓底仓记录
  const base = db.prepare(
    "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
  ).get(id) as any;

  if (!base) {
    res.status(400).json({ error: '未找到历史持仓记录，无法自动调整。请使用持仓调整功能。' });
    return;
  }

  // 计算除底仓外的其他交易贡献
  const others = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as net_shares,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as net_cost
    FROM transactions WHERE fund_id = ? AND id != ?
  `).get(id, base.id) as any;

  const newBaseShares = holdingShares - others.net_shares;
  const newBaseCost = targetCost - others.net_cost;

  if (newBaseShares <= 0) {
    res.status(400).json({ error: `修正后底仓份额为 ${newBaseShares.toFixed(2)}，不合理。` });
    return;
  }

  const newBasePrice = Math.round((newBaseCost / newBaseShares) * 10000) / 10000;

  db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
    .run(Math.round(newBaseShares * 10000) / 10000, newBasePrice, base.id);

  res.json({
    success: true,
    gain,
    targetCost: Math.round(targetCost * 100) / 100,
    targetNav: Math.round(targetNav * 10000) / 10000,
    baseShares: Math.round(newBaseShares * 10000) / 10000,
    basePrice: newBasePrice,
  });
});

// 软删除（移入回收站）
router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare("UPDATE funds SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(req.params.id);
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
