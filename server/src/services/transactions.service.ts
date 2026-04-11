import db from '../db';
import { recordDailySnapshots } from './stats.service';

function getChinaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export function listTransactions(query: { fundId?: string; type?: string; from?: string; to?: string }) {
  let sql = `
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t
    JOIN funds f ON f.id = t.fund_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (query.fundId) { sql += ' AND t.fund_id = ?'; params.push(query.fundId); }
  if (query.type) { sql += ' AND t.type = ?'; params.push(query.type); }
  if (query.from) { sql += ' AND t.date >= ?'; params.push(query.from); }
  if (query.to) { sql += ' AND t.date <= ?'; params.push(query.to); }

  sql += ' ORDER BY t.date DESC, t.created_at DESC';
  return db.prepare(sql).all(...params);
}

function adjustBaseForHistorical(fund_id: number | string, type: string, shares: number, price: number) {
  const base = db.prepare(
    "SELECT * FROM transactions WHERE fund_id = ? AND notes LIKE '%历史持仓%' AND type = 'buy' ORDER BY id LIMIT 1"
  ).get(fund_id) as any;

  if (!base) return;

  const baseShares = base.shares as number;
  const baseCost = base.shares * base.price;
  let newBaseShares = baseShares;
  let newBaseCost = baseCost;

  if (type === 'buy') {
    newBaseShares = baseShares - (shares || 0);
    newBaseCost = baseCost - (shares || 0) * (price || 0);
  } else if (type === 'sell') {
    newBaseShares = baseShares + (shares || 0);
    newBaseCost = baseCost + (shares || 0) * (price || 0);
  } else if (type === 'dividend') {
    newBaseCost = baseCost - (price || 0);
  }

  if (newBaseShares > 0.0001) {
    db.prepare('UPDATE transactions SET shares = ?, price = ? WHERE id = ?')
      .run(Math.round(newBaseShares * 10000) / 10000, Math.round((newBaseCost / newBaseShares) * 10000) / 10000, base.id);
  } else {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(base.id);
  }
}

export function createTransaction(data: {
  fund_id: number; date: string; type: string; asset?: string; shares?: number; price?: number; notes?: string;
  affect_gain?: boolean;
}) {
  let { fund_id, date, type, asset, shares, price, notes } = data;
  const affectGain = data.affect_gain !== false; // 默认true: 影响收益计算
  if (!fund_id || !date || !type) throw { status: 400, error: 'fund_id, date, type are required' };

  if (!asset) {
    const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(fund_id) as any;
    if (!fundRow) throw { status: 400, error: '基金不存在' };
    asset = fundRow.name;
  }

  const today = getChinaToday();
  const isHistorical = date < today;

  const result = db.transaction(() => {
    const ins = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(fund_id, date, type, asset, shares || 0, price || 0, notes || null);

    if (isHistorical && !affectGain) {
      adjustBaseForHistorical(fund_id, type, shares || 0, price || 0);
    }

    return ins.lastInsertRowid;
  })();

  const tx = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t JOIN funds f ON f.id = t.fund_id
    WHERE t.id = ?
  `).get(result);
  try { recordDailySnapshots(); } catch { /* ignore */ }
  return tx;
}

export function batchCreateTransactions(transactions: any[]) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw { status: 400, error: '请提供交易列表' };
  }

  const today = getChinaToday();
  const results: any[] = [];
  const errors: { index: number; error: string }[] = [];

  const batchInsert = db.transaction(() => {
    for (let i = 0; i < transactions.length; i++) {
      const { fund_id, date, type, shares, price, notes } = transactions[i];
      let { asset } = transactions[i];

      if (!fund_id || !date || !type) {
        errors.push({ index: i, error: `第${i + 1}条：缺少基金/日期/类型` });
        continue;
      }

      if (!asset) {
        const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(fund_id) as any;
        if (!fundRow) { errors.push({ index: i, error: `第${i + 1}条：基金不存在` }); continue; }
        asset = fundRow.name;
      }

      const ins = db.prepare(
        'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(fund_id, date, type, asset, shares || 0, price || 0, notes || null);

      if (date < today) {
        adjustBaseForHistorical(fund_id, type, shares || 0, price || 0);
      }

      results.push(ins.lastInsertRowid);
    }
  });

  batchInsert();
  const created = results.map(id =>
    db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(id)
  );
  return { success: true, created: created.length, errors, transactions: created };
}

export function updateTransaction(id: number | string, data: {
  fund_id?: number; date?: string; type?: string; asset?: string; shares?: number; price?: number; notes?: string;
  affect_gain?: boolean;
}) {
  const { fund_id, date, type, asset, shares, price, notes } = data;
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
  if (!tx) throw { status: 404, error: 'Transaction not found' };
  try { recordDailySnapshots(); } catch { /* ignore */ }
  return tx;
}

export function deleteTransaction(id: number | string) {
  const result = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  if (result.changes === 0) throw { status: 404, error: 'Transaction not found' };
  try { recordDailySnapshots(); } catch { /* ignore */ }
  return { success: true };
}

export function splitTransaction(id: number | string, splitShares: number) {
  if (!splitShares || splitShares <= 0) throw { status: 400, error: '拆分份额必须大于 0' };

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
  if (!tx) throw { status: 404, error: 'Transaction not found' };

  if (tx.type === 'dividend') {
    if (splitShares >= tx.price) throw { status: 400, error: `拆分金额必须小于原金额 ${tx.price}` };
    const remaining = Math.round((tx.price - splitShares) * 10000) / 10000;

    return db.transaction(() => {
      db.prepare('UPDATE transactions SET price = ? WHERE id = ?').run(remaining, id);
      const ins = db.prepare(
        'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(tx.fund_id, tx.date, tx.type, tx.asset, 0, splitShares, `从交易#${id}拆分`);
      return {
        original: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(id),
        split: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(ins.lastInsertRowid),
      };
    })();
  }

  if (splitShares >= tx.shares) throw { status: 400, error: `拆分份额必须小于原份额 ${tx.shares}` };
  const remainingShares = Math.round((tx.shares - splitShares) * 10000) / 10000;

  return db.transaction(() => {
    db.prepare('UPDATE transactions SET shares = ? WHERE id = ?').run(remainingShares, id);
    const ins = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tx.fund_id, tx.date, tx.type, tx.asset, splitShares, tx.price, `从交易#${id}拆分`);
    return {
      original: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(id),
      split: db.prepare('SELECT t.*, f.name as fund_name, f.color as fund_color FROM transactions t JOIN funds f ON f.id = t.fund_id WHERE t.id = ?').get(ins.lastInsertRowid),
    };
  })();
}

export function mergeTransactions(ids: number[]) {
  if (!ids || ids.length < 2) throw { status: 400, error: 'At least 2 transaction IDs are required' };

  const placeholders = ids.map(() => '?').join(',');
  const txs = db.prepare(`SELECT * FROM transactions WHERE id IN (${placeholders})`).all(...ids) as any[];

  if (txs.length !== ids.length) throw { status: 404, error: 'Some transactions not found' };

  const fundIds = new Set(txs.map(t => t.fund_id));
  const assets = new Set(txs.map(t => t.asset));
  const types = new Set(txs.map(t => t.type));

  if (fundIds.size > 1) throw { status: 400, error: 'All transactions must belong to the same fund' };
  // 同基金内asset名称可能不一致(简称vs全称), 不再校验asset, 统一用基金名称
  if (types.size > 1) throw { status: 400, error: 'All transactions must be the same type' };

  const type = txs[0].type;
  const fund_id = txs[0].fund_id;
  // 统一用基金名称作为asset
  const fundRow = db.prepare('SELECT name FROM funds WHERE id = ?').get(fund_id) as any;
  const asset = fundRow?.name || txs[0].asset;

  let totalShares = 0, totalCost = 0, latestDate = txs[0].date;
  for (const tx of txs) {
    if (type === 'dividend') { totalCost += tx.price; }
    else { totalShares += tx.shares; totalCost += tx.shares * tx.price; }
    if (tx.date > latestDate) latestDate = tx.date;
  }

  const avgPrice = type === 'dividend' ? totalCost : (totalShares > 0 ? totalCost / totalShares : 0);

  return db.transaction(() => {
    db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...ids);
    const result = db.prepare(
      'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(fund_id, latestDate, type, asset, totalShares, avgPrice, `Merged from ${txs.length} transactions`);
    return db.prepare(`
      SELECT t.*, f.name as fund_name, f.color as fund_color
      FROM transactions t JOIN funds f ON f.id = t.fund_id
      WHERE t.id = ?
    `).get(result.lastInsertRowid);
  })();
}
