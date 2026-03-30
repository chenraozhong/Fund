import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

// List trades for a fund
router.get('/funds/:fundId', (req: Request, res: Response) => {
  const trades = db.prepare(`
    SELECT * FROM trades WHERE fund_id = ? ORDER BY created_at DESC
  `).all(req.params.fundId);
  res.json(trades);
});

// Create a trade by pairing buy txs + sell txs (supports multi-to-multi)
router.post('/', (req: Request, res: Response) => {
  const { buyTxIds, sellTxIds } = req.body as { buyTxIds: number[]; sellTxIds: number[] };

  // Backward compat: single pair
  const buyIds = buyTxIds || (req.body.buyTxId ? [req.body.buyTxId] : []);
  const sellIds = sellTxIds || (req.body.sellTxId ? [req.body.sellTxId] : []);

  if (buyIds.length === 0 || sellIds.length === 0) {
    res.status(400).json({ error: '至少需要一笔买入和一笔卖出' });
    return;
  }

  const buyTxs = buyIds.map((id: number) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
    if (!tx) throw new Error(`交易#${id}不存在`);
    if (tx.type !== 'buy') throw new Error(`交易#${id}不是买入类型`);
    return tx;
  });

  const sellTxs = sellIds.map((id: number) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
    if (!tx) throw new Error(`交易#${id}不存在`);
    if (tx.type !== 'sell') throw new Error(`交易#${id}不是卖出类型`);
    return tx;
  });

  // All must be same fund
  const fundIds = new Set([...buyTxs, ...sellTxs].map(t => t.fund_id));
  if (fundIds.size > 1) {
    res.status(400).json({ error: '所有交易必须属于同一基金' });
    return;
  }

  // Aggregate buys
  let totalBuyShares = 0, totalBuyCost = 0;
  let earliestBuyDate = buyTxs[0].date;
  for (const tx of buyTxs) {
    totalBuyShares += tx.shares;
    totalBuyCost += tx.shares * tx.price;
    if (tx.date < earliestBuyDate) earliestBuyDate = tx.date;
  }
  const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;

  // Aggregate sells
  let totalSellShares = 0, totalSellRevenue = 0;
  let latestSellDate = sellTxs[0].date;
  for (const tx of sellTxs) {
    totalSellShares += tx.shares;
    totalSellRevenue += tx.shares * tx.price;
    if (tx.date > latestSellDate) latestSellDate = tx.date;
  }
  const avgSellPrice = totalSellShares > 0 ? totalSellRevenue / totalSellShares : 0;

  const pairedShares = Math.min(totalBuyShares, totalSellShares);
  const profit = (avgSellPrice - avgBuyPrice) * pairedShares;
  const buyRemainder = Math.round((totalBuyShares - pairedShares) * 10000) / 10000;
  const sellRemainder = Math.round((totalSellShares - pairedShares) * 10000) / 10000;

  try {
    const result = db.transaction(() => {
      // Create the trade
      const tradeResult = db.prepare(`
        INSERT INTO trades (fund_id, asset, buy_date, buy_shares, buy_price, sell_date, sell_shares, sell_price, paired_shares, profit, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        buyTxs[0].fund_id, buyTxs[0].asset,
        earliestBuyDate, totalBuyShares, Math.round(avgBuyPrice * 10000) / 10000,
        latestSellDate, totalSellShares, Math.round(avgSellPrice * 10000) / 10000,
        pairedShares, Math.round(profit * 100) / 100,
        `${buyIds.length}买+${sellIds.length}卖配对`
      );

      // Consume all buy txs
      for (const tx of buyTxs) {
        db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
      }
      // If buy remainder, create a leftover tx
      if (buyRemainder > 0.0001) {
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(buyTxs[0].fund_id, buyTxs[buyTxs.length - 1].date, 'buy', buyTxs[0].asset, buyRemainder, avgBuyPrice, '配对剩余');
      }

      // Consume all sell txs
      for (const tx of sellTxs) {
        db.prepare('DELETE FROM transactions WHERE id = ?').run(tx.id);
      }
      // If sell remainder, create a leftover tx
      if (sellRemainder > 0.0001) {
        db.prepare(
          'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(sellTxs[0].fund_id, sellTxs[sellTxs.length - 1].date, 'sell', sellTxs[0].asset, sellRemainder, avgSellPrice, '配对剩余');
      }

      return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeResult.lastInsertRowid);
    })();

    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete a trade → restore transactions
router.delete('/:id', (req: Request, res: Response) => {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id) as any;
  if (!trade) {
    res.status(404).json({ error: '配对记录不存在' });
    return;
  }

  db.transaction(() => {
    // Restore buy transaction
    db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(trade.fund_id, trade.buy_date, 'buy', trade.asset, trade.paired_shares, trade.buy_price, `从配对#${trade.id}还原`);

    // Restore sell transaction
    db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(trade.fund_id, trade.sell_date, 'sell', trade.asset, trade.paired_shares, trade.sell_price, `从配对#${trade.id}还原`);

    // Delete the trade
    db.prepare('DELETE FROM trades WHERE id = ?').run(trade.id);
  })();

  res.json({ success: true });
});

export default router;
