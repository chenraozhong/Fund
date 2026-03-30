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
  const { fund_id, date, type, asset, shares, price, notes } = req.body;
  if (!fund_id || !date || !type || !asset) {
    res.status(400).json({ error: 'fund_id, date, type, and asset are required' });
    return;
  }
  const result = db.prepare(
    'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(fund_id, date, type, asset, shares || 0, price || 0, notes || null);

  const tx = db.prepare(`
    SELECT t.*, f.name as fund_name, f.color as fund_color
    FROM transactions t JOIN funds f ON f.id = t.fund_id
    WHERE t.id = ?
  `).get(result.lastInsertRowid);
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

export default router;
