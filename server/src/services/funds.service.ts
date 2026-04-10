import db from '../db';

export function listFunds() {
  const funds = db.prepare(`
    SELECT f.*,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0) as total_buy_shares,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_buy
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL
    GROUP BY f.id
    ORDER BY f.created_at DESC
  `).all();

  return (funds as any[]).map(f => {
    const marketValue = f.market_nav > 0 && f.holding_shares > 0
      ? f.holding_shares * f.market_nav : 0;
    // 累计收益: 直接读funds.cumulative_gain(由每日收益累加)
    const gain = f.cumulative_gain || 0;
    // 持仓成本 = 持有份额 × 平均买入价(均价法)
    const avgBuyPrice = f.total_buy_shares > 0 ? f.total_buy / f.total_buy_shares : 0;
    const holdingCost = f.holding_shares > 0 ? f.holding_shares * avgBuyPrice : 0;
    // 持仓收益率 = (市值 - 持仓成本) / 持仓成本
    const holdingGainPct = holdingCost > 0 ? ((marketValue - holdingCost) / holdingCost) * 100 : 0;
    return {
      ...f,
      current_value: marketValue,
      holding_cost: Math.round(holdingCost * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      gain_pct: holdingGainPct,
    };
  });
}

export function createFund(data: { name: string; color?: string; code?: string }) {
  const { name, color, code } = data;
  if (!name) throw { status: 400, error: 'Name is required' };

  if (code) {
    const existing = db.prepare('SELECT * FROM funds WHERE code = ?').get(code) as any;
    if (existing) {
      db.prepare('UPDATE funds SET name = ?, color = COALESCE(?, color) WHERE id = ?')
        .run(name, color || null, existing.id);
      return db.prepare('SELECT * FROM funds WHERE id = ?').get(existing.id);
    }
  }

  const result = db.prepare('INSERT INTO funds (name, color, code) VALUES (?, ?, ?)').run(name, color || '#378ADD', code || '');
  return db.prepare('SELECT * FROM funds WHERE id = ?').get(result.lastInsertRowid);
}

export function listTrashFunds() {
  return db.prepare(`
    SELECT f.*, COUNT(t.id) as tx_count
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NOT NULL
    GROUP BY f.id
    ORDER BY f.deleted_at DESC
  `).all();
}

export function restoreTrashFund(id: number | string) {
  const result = db.prepare('UPDATE funds SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id);
  if (result.changes === 0) throw { status: 404, error: '未找到该回收站基金' };
  return { success: true };
}

export function permanentDeleteFund(id: number | string) {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ? AND deleted_at IS NOT NULL').get(id);
  if (!fund) throw { status: 404, error: '只能永久删除回收站中的基金' };
  db.prepare('DELETE FROM funds WHERE id = ?').run(id);
  return { success: true };
}

export function updateFund(id: number | string, data: {
  name?: string; color?: string; code?: string; market_nav?: number;
  stop_profit_pct?: number; stop_loss_pct?: number; base_position_pct?: number;
  cumulative_gain?: number;
}) {
  const { name, color, code, market_nav, stop_profit_pct, stop_loss_pct, base_position_pct, cumulative_gain } = data;
  db.prepare(`UPDATE funds SET
    name = COALESCE(?, name),
    color = COALESCE(?, color),
    code = COALESCE(?, code),
    market_nav = COALESCE(?, market_nav),
    stop_profit_pct = COALESCE(?, stop_profit_pct),
    stop_loss_pct = COALESCE(?, stop_loss_pct),
    base_position_pct = COALESCE(?, base_position_pct),
    cumulative_gain = COALESCE(?, cumulative_gain)
    WHERE id = ?`
  ).run(name ?? null, color ?? null, code ?? null, market_nav ?? null, stop_profit_pct ?? null, stop_loss_pct ?? null, base_position_pct ?? null, cumulative_gain ?? null, id);
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id);
  if (!fund) throw { status: 404, error: 'Fund not found' };
  return fund;
}

export function adjustHolding(id: number | string, data: { target_shares: number; target_nav: number; mode?: string }) {
  const { target_shares, target_nav, mode } = data;

  if (target_shares == null || target_nav == null) {
    throw { status: 400, error: '需要 target_shares 和 target_nav' };
  }

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) throw { status: 404, error: 'Fund not found' };

  if (mode === 'fix_base') {
    const base = db.prepare(
      "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
    ).get(id) as any;

    if (!base) throw { status: 400, error: '未找到历史持仓记录，无法使用此模式' };

    const others = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as net_shares,
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
        COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as net_cost
      FROM transactions WHERE fund_id = ? AND id != ?
    `).get(id, base.id) as any;

    const newBaseShares = target_shares - others.net_shares;
    const newBaseCost = target_shares * target_nav - others.net_cost;

    if (newBaseShares <= 0) {
      throw { status: 400, error: `修正后底仓份额为 ${newBaseShares.toFixed(2)}，不合理。请检查目标值。` };
    }

    const newBasePrice = Math.round((newBaseCost / newBaseShares) * 10000) / 10000;
    db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
      .run(Math.round(newBaseShares * 10000) / 10000, newBasePrice, base.id);

    return { success: true, mode: 'fix_base', baseShares: newBaseShares, basePrice: newBasePrice };
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

  return { success: true, mode: 'transaction' };
}

export function updateFundGain(id: number | string, gain: number) {
  if (gain == null) throw { status: 400, error: '需要 gain（盈亏金额）' };

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) throw { status: 404, error: 'Fund not found' };
  if (!fund.market_nav || fund.market_nav <= 0) {
    throw { status: 400, error: '请先设置当前市场净值（market_nav），才能根据盈亏计算成本' };
  }

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares
    FROM transactions WHERE fund_id = ?
  `).get(id) as any;

  const holdingShares = row.holding_shares;
  if (holdingShares <= 0) throw { status: 400, error: '当前无持仓份额，无法调整盈亏' };

  const marketValue = holdingShares * fund.market_nav;
  const targetCost = marketValue - gain;
  const targetNav = targetCost / holdingShares;

  const base = db.prepare(
    "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
  ).get(id) as any;

  if (!base) throw { status: 400, error: '未找到历史持仓记录，无法自动调整。请使用持仓调整功能。' };

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

  if (newBaseShares <= 0) throw { status: 400, error: `修正后底仓份额为 ${newBaseShares.toFixed(2)}，不合理。` };

  const newBasePrice = Math.round((newBaseCost / newBaseShares) * 10000) / 10000;
  db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
    .run(Math.round(newBaseShares * 10000) / 10000, newBasePrice, base.id);

  // 同步更新cumulative_gain
  db.prepare('UPDATE funds SET cumulative_gain = ? WHERE id = ?')
    .run(Math.round(gain * 100) / 100, id);

  return {
    success: true,
    gain,
    targetCost: Math.round(targetCost * 100) / 100,
    targetNav: Math.round(targetNav * 10000) / 10000,
    baseShares: Math.round(newBaseShares * 10000) / 10000,
    basePrice: newBasePrice,
  };
}

export function deleteFund(id: number | string) {
  const result = db.prepare("UPDATE funds SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(id);
  if (result.changes === 0) throw { status: 404, error: 'Fund not found' };
  return { success: true };
}

export function getFundPositions(id: number | string) {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) throw { status: 404, error: 'Fund not found' };

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
    const costBasis = a.buy_cost - a.sell_revenue + a.dividends;
    const nav = holdingShares > 0 ? costBasis / holdingShares : 0;
    const marketValue = fund.market_nav > 0 && holdingShares > 0
      ? holdingShares * fund.market_nav
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

  const transactions = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t
    JOIN funds f ON f.id = t.fund_id
    WHERE t.fund_id = ?
    ORDER BY t.date DESC, t.created_at DESC
  `).all(id);

  return { fund, positions, transactions };
}
