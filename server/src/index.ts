import express from 'express';
import cors from 'cors';
import fundsRouter from './routes/funds';
import transactionsRouter from './routes/transactions';
import statsRouter from './routes/stats';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/funds', fundsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/stats', statsRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
