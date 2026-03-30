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

// Create a trade by pairing a buy tx + sell tx
router.post('/', (req: Request, res: Response) => {
  const { buyTxId, sellTxId } = req.body;
  if (!buyTxId || !sellTxId) {
    res.status(400).json({ error: '需要选择一笔买入和一笔卖出' });
    return;
  }

  const buyTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(buyTxId) as any;
  const sellTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(sellTxId) as any;

  if (!buyTx || !sellTx) {
    res.status(404).json({ error: '交易记录不存在' });
    return;
  }
  if (buyTx.type !== 'buy') {
    res.status(400).json({ error: `交易#${buyTxId}不是买入类型` });
    return;
  }
  if (sellTx.type !== 'sell') {
    res.status(400).json({ error: `交易#${sellTxId}不是卖出类型` });
    return;
  }
  if (buyTx.fund_id !== sellTx.fund_id) {
    res.status(400).json({ error: '买卖交易必须属于同一基金' });
    return;
  }

  const pairedShares = Math.min(buyTx.shares, sellTx.shares);
  const profit = (sellTx.price - buyTx.price) * pairedShares;
  const buyRemainder = Math.round((buyTx.shares - pairedShares) * 10000) / 10000;
  const sellRemainder = Math.round((sellTx.shares - pairedShares) * 10000) / 10000;

  const result = db.transaction(() => {
    // Create the trade
    const tradeResult = db.prepare(`
      INSERT INTO trades (fund_id, asset, buy_date, buy_shares, buy_price, sell_date, sell_shares, sell_price, paired_shares, profit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      buyTx.fund_id, buyTx.asset,
      buyTx.date, buyTx.shares, buyTx.price,
      sellTx.date, sellTx.shares, sellTx.price,
      pairedShares, Math.round(profit * 100) / 100
    );

    // Consume or reduce buy tx
    if (buyRemainder <= 0.0001) {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(buyTxId);
    } else {
      db.prepare('UPDATE transactions SET shares = ? WHERE id = ?').run(buyRemainder, buyTxId);
    }

    // Consume or reduce sell tx
    if (sellRemainder <= 0.0001) {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(sellTxId);
    } else {
      db.prepare('UPDATE transactions SET shares = ? WHERE id = ?').run(sellRemainder, sellTxId);
    }

    return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeResult.lastInsertRowid);
  })();

  res.status(201).json(result);
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
