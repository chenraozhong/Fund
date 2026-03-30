import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const funds = db.prepare(`
    SELECT f.*,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0) as total_cost,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares * t.price ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares * t.price ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN t.type = 'dividend' THEN t.price ELSE 0 END), 0) as current_value
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    GROUP BY f.id
    ORDER BY f.created_at DESC
  `).all();

  const result = (funds as any[]).map(f => ({
    ...f,
    gain: f.current_value - f.total_cost,
    gain_pct: f.total_cost > 0 ? ((f.current_value - f.total_cost) / f.total_cost) * 100 : 0,
  }));

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
  const { name, color } = req.body;
  const { id } = req.params;
  db.prepare('UPDATE funds SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?').run(name, color, id);
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id);
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  res.json(fund);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM funds WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }
  res.json({ success: true });
});

export default router;
