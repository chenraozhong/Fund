import db from '../db';

export function listTrades(fundId: number | string) {
  return db.prepare('SELECT * FROM trades WHERE fund_id = ? ORDER BY created_at DESC').all(fundId);
}

export function createTrade(data: { buyTxIds?: number[]; sellTxIds?: number[]; buyTxId?: number; sellTxId?: number }) {
  const buyIds = data.buyTxIds || (data.buyTxId ? [data.buyTxId] : []);
  const sellIds = data.sellTxIds || (data.sellTxId ? [data.sellTxId] : []);

  if (buyIds.length === 0 || sellIds.length === 0) {
    throw { status: 400, error: '至少需要一笔买入和一笔卖出' };
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

  const fundIdSet = new Set([...buyTxs, ...sellTxs].map(t => t.fund_id));
  if (fundIdSet.size > 1) throw { status: 400, error: '所有交易必须属于同一基金' };

  // 计算可配对份额: 买入可用 = shares - paired_shares, 卖出同理
  let totalBuyAvail = 0, totalBuyCost = 0, earliestBuyDate = buyTxs[0].date;
  for (const tx of buyTxs) {
    const avail = tx.shares - (tx.paired_shares || 0);
    if (avail <= 0.0001) throw new Error(`交易#${tx.id}已全部配对`);
    totalBuyAvail += avail;
    totalBuyCost += avail * tx.price;
    if (tx.date < earliestBuyDate) earliestBuyDate = tx.date;
  }
  const avgBuyPrice = totalBuyAvail > 0 ? totalBuyCost / totalBuyAvail : 0;

  let totalSellAvail = 0, totalSellRevenue = 0, latestSellDate = sellTxs[0].date;
  for (const tx of sellTxs) {
    const avail = tx.shares - (tx.paired_shares || 0);
    if (avail <= 0.0001) throw new Error(`交易#${tx.id}已全部配对`);
    totalSellAvail += avail;
    totalSellRevenue += avail * tx.price;
    if (tx.date > latestSellDate) latestSellDate = tx.date;
  }
  const avgSellPrice = totalSellAvail > 0 ? totalSellRevenue / totalSellAvail : 0;

  const pairedShares = Math.min(totalBuyAvail, totalSellAvail);
  const profit = (avgSellPrice - avgBuyPrice) * pairedShares;
  const navDiff = Math.round((avgSellPrice - avgBuyPrice) * 10000) / 10000;
  const profitPct = avgBuyPrice > 0 ? Math.round(((avgSellPrice - avgBuyPrice) / avgBuyPrice) * 10000) / 100 : 0;

  const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(buyTxs[0].fund_id) as any;
  const asset = fundRow?.name || buyTxs[0].asset;

  return db.transaction(() => {
    const tradeResult = db.prepare(`
      INSERT INTO trades (fund_id, asset, buy_date, buy_shares, buy_price, sell_date, sell_shares, sell_price, paired_shares, profit, nav_diff, profit_pct, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      buyTxs[0].fund_id, asset,
      earliestBuyDate, totalBuyAvail, Math.round(avgBuyPrice * 10000) / 10000,
      latestSellDate, totalSellAvail, Math.round(avgSellPrice * 10000) / 10000,
      pairedShares, Math.round(profit * 100) / 100,
      navDiff, profitPct,
      `${buyIds.length}买+${sellIds.length}卖配对`
    );

    // 标记配对份额(按比例分配到各笔交易)
    let remainPair = pairedShares;
    for (const tx of buyTxs) {
      const avail = tx.shares - (tx.paired_shares || 0);
      const used = Math.min(avail, remainPair);
      db.prepare('UPDATE transactions SET paired_shares = ROUND(paired_shares + ?, 4) WHERE id = ?').run(used, tx.id);
      remainPair -= used;
      if (remainPair <= 0.0001) break;
    }
    remainPair = pairedShares;
    for (const tx of sellTxs) {
      const avail = tx.shares - (tx.paired_shares || 0);
      const used = Math.min(avail, remainPair);
      db.prepare('UPDATE transactions SET paired_shares = ROUND(paired_shares + ?, 4) WHERE id = ?').run(used, tx.id);
      remainPair -= used;
      if (remainPair <= 0.0001) break;
    }

    return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeResult.lastInsertRowid);
  })();
}

export function deleteTrade(id: number | string) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as any;
  if (!trade) throw { status: 404, error: '配对记录不存在' };

  const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(trade.fund_id) as any;
  const asset = fundRow?.name || trade.asset;

  db.transaction(() => {
    // 尝试还原: 减少原始交易的paired_shares(新逻辑创建的配对)
    let remainBuy = trade.paired_shares;
    const buyTxs = db.prepare(
      "SELECT id, shares, paired_shares FROM transactions WHERE fund_id = ? AND type = 'buy' AND date = ? AND paired_shares > 0 ORDER BY id"
    ).all(trade.fund_id, trade.buy_date) as any[];
    for (const tx of buyTxs) {
      const restore = Math.min(tx.paired_shares, remainBuy);
      db.prepare('UPDATE transactions SET paired_shares = ROUND(paired_shares - ?, 4) WHERE id = ?').run(restore, tx.id);
      remainBuy -= restore;
      if (remainBuy <= 0.0001) break;
    }
    // 找不到原始TX(旧逻辑已删除) → 合并到同日同类型已有TX, 没有则新建
    if (remainBuy > 0.0001) {
      const existBuy = db.prepare(
        "SELECT id, shares, price FROM transactions WHERE fund_id = ? AND type = 'buy' AND date = ? ORDER BY id LIMIT 1"
      ).get(trade.fund_id, trade.buy_date) as any;
      if (existBuy) {
        // 加权合并: 新均价 = (旧成本 + 还原成本) / (旧份额 + 还原份额)
        const newShares = existBuy.shares + remainBuy;
        const newPrice = (existBuy.shares * existBuy.price + remainBuy * trade.buy_price) / newShares;
        db.prepare('UPDATE transactions SET shares = ROUND(?, 4), price = ROUND(?, 6) WHERE id = ?')
          .run(newShares, newPrice, existBuy.id);
      } else {
        db.prepare('INSERT INTO transactions (fund_id, date, type, asset, shares, price, paired_shares, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(trade.fund_id, trade.buy_date, 'buy', asset, Math.round(remainBuy * 10000) / 10000, trade.buy_price, 0, `从配对#${trade.id}还原`);
      }
    }

    let remainSell = trade.paired_shares;
    const sellTxs = db.prepare(
      "SELECT id, shares, paired_shares FROM transactions WHERE fund_id = ? AND type = 'sell' AND date = ? AND paired_shares > 0 ORDER BY id"
    ).all(trade.fund_id, trade.sell_date) as any[];
    for (const tx of sellTxs) {
      const restore = Math.min(tx.paired_shares, remainSell);
      db.prepare('UPDATE transactions SET paired_shares = ROUND(paired_shares - ?, 4) WHERE id = ?').run(restore, tx.id);
      remainSell -= restore;
      if (remainSell <= 0.0001) break;
    }
    if (remainSell > 0.0001) {
      const existSell = db.prepare(
        "SELECT id, shares, price FROM transactions WHERE fund_id = ? AND type = 'sell' AND date = ? ORDER BY id LIMIT 1"
      ).get(trade.fund_id, trade.sell_date) as any;
      if (existSell) {
        const newShares = existSell.shares + remainSell;
        const newPrice = (existSell.shares * existSell.price + remainSell * trade.sell_price) / newShares;
        db.prepare('UPDATE transactions SET shares = ROUND(?, 4), price = ROUND(?, 6) WHERE id = ?')
          .run(newShares, newPrice, existSell.id);
      } else {
        db.prepare('INSERT INTO transactions (fund_id, date, type, asset, shares, price, paired_shares, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(trade.fund_id, trade.sell_date, 'sell', asset, Math.round(remainSell * 10000) / 10000, trade.sell_price, 0, `从配对#${trade.id}还原`);
      }
    }

    db.prepare('DELETE FROM trades WHERE id = ?').run(trade.id);
  })();

  return { success: true };
}
