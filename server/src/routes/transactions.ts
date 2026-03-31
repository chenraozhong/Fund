import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  let query = `
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t
    JOIN funds f ON f.id = t.fund_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (req.query.fundId) {
    query += ' AND t.fund_id = ?';
    params.push(req.query.fundId);
  }
  if (req.query.type) {
    query += ' AND t.type = ?';
    params.push(req.query.type);
  }
  if (req.query.from) {
    query += ' AND t.date >= ?';
    params.push(req.query.from);
  }
  if (req.query.to) {
    query += ' AND t.date <= ?';
    params.push(req.query.to);
  }

  query += ' ORDER BY t.date DESC, t.created_at DESC';

  const transactions = db.prepare(query).all(...params);
  res.json(transactions);
});

router.post('/', (req: Request, res: Response) => {
  const { fund_id, date, type, shares, price, notes } = req.body;
  let { asset } = req.body;
  if (!fund_id || !date || !type) {
    res.status(400).json({ error: 'fund_id, date, type are required' });
    return;
  }

  // asset 为空时自动使用基金名称
  if (!asset) {
    const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(fund_id) as any;
    if (!fundRow) {
      res.status(400).json({ error: '基金不存在' });
      return;
    }
    asset = fundRow.name;
  }

  const today = new Date().toISOString().slice(0, 10);
  const isHistorical = date < today;

  const result = db.transaction(() => {
    const ins = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(fund_id, date, type, asset, shares || 0, price || 0, notes || null);

    // 历史交易：调整底仓使当前持仓不变
    if (isHistorical) {
      const base = db.prepare(
        "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
      ).get(fund_id) as any;

      if (base) {
        const baseShares = base.shares as number;
        const baseCost = base.shares * base.price;
        let newBaseShares = baseShares;
        let newBaseCost = baseCost;

        if (type === 'buy') {
          // 新增历史买入 → 底仓减少对应份额和成本
          newBaseShares = baseShares - (shares || 0);
          newBaseCost = baseCost - (shares || 0) * (price || 0);
        } else if (type === 'sell') {
          // 新增历史卖出 → 底仓增加份额，成本增加卖出金额
          newBaseShares = baseShares + (shares || 0);
          newBaseCost = baseCost + (shares || 0) * (price || 0);
        } else if (type === 'dividend') {
          // 新增历史分红 → 底仓成本减少分红金额
          newBaseCost = baseCost - (price || 0);
        }

        if (newBaseShares > 0.0001) {
          const newBasePrice = Math.round((newBaseCost / newBaseShares) * 10000) / 10000;
          db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
            .run(Math.round(newBaseShares * 10000) / 10000, newBasePrice, base.id);
        } else if (newBaseShares <= 0.0001) {
          // 底仓已耗尽，删除底仓记录
          db.prepare('DELETE FROM transactions WHERE id = ?').run(base.id);
        }
      }
    }

    return ins.lastInsertRowid;
  })();

  const tx = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t JOIN funds f ON f.id = t.fund_id
    WHERE t.id = ?
  `).get(result);
  res.status(201).json(tx);
});

router.put('/:id', (req: Request, res: Response) => {
  const { fund_id, date, type, asset, shares, price, notes } = req.body;
  const { id } = req.params;
  db.prepare(`
    UPDATE transactions SET
      fund_id = COALESCE(?, fund_id),
      date = COALESCE(?, date),
      type = COALESCE(?, type),
      asset = COALESCE(?, asset),
      shares = COALESCE(?, shares),
      price = COALESCE(?, price),
      notes = ?
    WHERE id = ?
  `).run(fund_id, date, type, asset, shares, price, notes ?? null, id);

  const tx = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t JOIN funds f ON f.id = t.fund_id
    WHERE t.id = ?
  `).get(id);
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  res.json(tx);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  res.json({ success: true });
});

// Split a transaction into two
router.post('/:id/split', (req: Request, res: Response) => {
  const { id } = req.params;
  const { shares: splitShares } = req.body as { shares: number };

  if (!splitShares || splitShares <= 0) {
    res.status(400).json({ error: '拆分份额必须大于 0' });
    return;
  }

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }

  if (tx.type === 'dividend') {
    // For dividends, split by amount (price field stores the amount)
    if (splitShares >= tx.price) {
      res.status(400).json({ error: `拆分金额必须小于原金额 ${tx.price}` });
      return;
    }
    const remaining = Math.round((tx.price - splitShares) * 10000) / 10000;

    const result = db.transaction(() => {
      // Update original: reduce amount
      db.prepare('UPDATE transactions SET price = ? WHERE id = ?').run(remaining, id);

      // Create new transaction with split amount
      const ins = db.prepare(
        'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(tx.fund_id, tx.date, tx.type, tx.asset, 0, splitShares, `从交易#${id}拆分`);

      return {
        original: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(id),
        split: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(ins.lastInsertRowid),
      };
    })();

    res.json(result);
    return;
  }

  // For buy/sell, split by shares
  if (splitShares >= tx.shares) {
    res.status(400).json({ error: `拆分份额必须小于原份额 ${tx.shares}` });
    return;
  }

  const remainingShares = Math.round((tx.shares - splitShares) * 10000) / 10000;

  const result = db.transaction(() => {
    // Update original: reduce shares
    db.prepare('UPDATE transactions SET shares = ? WHERE id = ?').run(remainingShares, id);

    // Create new transaction with split shares, same price
    const ins = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tx.fund_id, tx.date, tx.type, tx.asset, splitShares, tx.price, `从交易#${id}拆分`);

    return {
      original: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(id),
      split: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(ins.lastInsertRowid),
    };
  })();

  res.json(result);
});

// Merge multiple transactions of the same asset into one
router.post('/merge', (req: Request, res: Response) => {
  const { ids } = req.body as { ids: number[] };
  if (!ids || ids.length < 2) {
    res.status(400).json({ error: 'At least 2 transaction IDs are required' });
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  const txs = db.prepare(`
    SELECT * FROM transactions WHERE id IN (${placeholders})
  `).all(...ids) as any[];

  if (txs.length !== ids.length) {
    res.status(404).json({ error: 'Some transactions not found' });
    return;
  }

  // All must belong to the same fund and same asset and same type
  const fundIds = new Set(txs.map(t => t.fund_id));
  const assets = new Set(txs.map(t => t.asset));
  const types = new Set(txs.map(t => t.type));

  if (fundIds.size > 1) {
    res.status(400).json({ error: 'All transactions must belong to the same fund' });
    return;
  }
  if (assets.size > 1) {
    res.status(400).json({ error: 'All transactions must be for the same asset' });
    return;
  }
  if (types.size > 1) {
    res.status(400).json({ error: 'All transactions must be the same type' });
    return;
  }

  const type = txs[0].type;
  const fund_id = txs[0].fund_id;
  const asset = txs[0].asset;

  let totalShares = 0;
  let totalCost = 0;
  let latestDate = txs[0].date;

  for (const tx of txs) {
    if (type === 'dividend') {
      totalCost += tx.price;
    } else {
      totalShares += tx.shares;
      totalCost += tx.shares * tx.price;
    }
    if (tx.date > latestDate) latestDate = tx.date;
  }

  // Weighted average price
  const avgPrice = type === 'dividend' ? totalCost : (totalShares > 0 ? totalCost / totalShares : 0);

  const mergeNotes = `Merged from ${txs.length} transactions`;

  const merge = db.transaction(() => {
    // Delete old transactions
    db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...ids);

    // Insert merged transaction
    const result = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(fund_id, latestDate, type, asset, totalShares, avgPrice, mergeNotes);

    return db.prepare(`
      SELECT t.*, f.name as fund_name, f.color as fund_color
      FROM transactions t JOIN funds f ON f.id = t.fund_id
      WHERE t.id = ?
    `).get(result.lastInsertRowid);
  });

  const merged = merge();
  res.json(merged);
});

export default router;
