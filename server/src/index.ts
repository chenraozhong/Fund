import express from 'express';
import cors from 'cors';
import fundsRouter from './routes/funds';
import transactionsRouter from './routes/transactions';
import statsRouter from './routes/stats';
import backupRouter from './routes/backup';
import aiRouter from './routes/ai';
import importRouter from './routes/import';
import tradesRouter from './routes/trades';
import navRouter from './routes/nav';
import strategyRouter from './routes/strategy';
import { startAutoBackup } from './backup';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api/funds', fundsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/backups', backupRouter);
app.use('/api/ai', aiRouter);
app.use('/api/import', importRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/nav', navRouter);
app.use('/api/strategy', strategyRouter);

// --- Data Sync endpoints (PC ↔ Mobile) ---
import db from './db';

app.get('/api/sync/export', (_req, res) => {
  try {
    const tables = ['funds', 'transactions', 'trades', 'daily_snapshots', 'forecasts', 'forecast_reviews', 'decision_logs'];
    const data: Record<string, any[]> = {};
    for (const table of tables) {
      try { data[table] = (db.prepare(`SELECT * FROM ${table}`).all() as any[]); } catch { data[table] = []; }
    }
    res.json({ version: 1, exportedAt: new Date().toISOString(), data });
  } catch (err: any) {
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

app.post('/api/sync/import', (req, res) => {
  try {
    const importData = req.body?.data as Record<string, any[]>;
    if (!importData) { res.status(400).json({ error: '无效的同步数据' }); return; }
    const importOrder = ['funds', 'transactions', 'trades', 'daily_snapshots', 'forecasts', 'forecast_reviews', 'decision_logs'];
    const stats: Record<string, number> = {};
    const doImport = db.transaction(() => {
      for (const table of importOrder) {
        const rows = importData[table];
        if (!rows || !Array.isArray(rows) || rows.length === 0) { stats[table] = 0; continue; }
        db.exec(`DELETE FROM ${table}`);
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(',');
        const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
        for (const row of rows) {
          stmt.run(...cols.map((c: string) => row[c] ?? null));
        }
        stats[table] = rows.length;
      }
    });
    doImport();
    res.json({ success: true, imported: stats });
  } catch (err: any) {
    res.status(500).json({ error: '导入失败: ' + err.message });
  }
});

// Sync proxy: pull/push via another server (for PC-to-PC or when accessed from browser)
app.post('/api/sync/pull', async (req, res) => {
  try {
    const pcUrl = (req.body?.pcUrl || '').replace(/\/+$/, '');
    if (!pcUrl) { res.status(400).json({ error: '请提供服务器地址' }); return; }
    const resp = await fetch(`${pcUrl}/api/sync/export`);
    if (!resp.ok) { res.status(resp.status).json({ error: `连接失败: ${resp.status}` }); return; }
    res.json(await resp.json());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/sync/push', async (req, res) => {
  try {
    const pcUrl = (req.body?.pcUrl || '').replace(/\/+$/, '');
    if (!pcUrl) { res.status(400).json({ error: '请提供服务器地址' }); return; }
    const resp = await fetch(`${pcUrl}/api/sync/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body.data),
    });
    if (!resp.ok) { res.status(resp.status).json({ error: `推送失败: ${resp.status}` }); return; }
    res.json(await resp.json());
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startAutoBackup();
});
