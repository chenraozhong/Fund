import express from 'express';
import cors from 'cors';
import fundsRouter from './routes/funds';
import transactionsRouter from './routes/transactions';
import statsRouter from './routes/stats';
import backupRouter from './routes/backup';
import aiRouter from './routes/ai';
import importRouter from './routes/import';
import tradesRouter from './routes/trades';
import { startAutoBackup } from './backup';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/funds', fundsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/backups', backupRouter);
app.use('/api/ai', aiRouter);
app.use('/api/import', importRouter);
app.use('/api/trades', tradesRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startAutoBackup();
});
