import { Router, Request, Response } from 'express';
import * as svc from '../services/trades.service';

const router = Router();

function handleServiceError(res: Response, err: any) {
  const status = err?.status || 500;
  const error = err?.error || err?.message || 'Internal error';
  res.status(status).json({ error });
}

router.get('/funds/:fundId', (req: Request, res: Response) => {
  res.json(svc.listTrades(req.params.fundId as string));
});

router.post('/', (req: Request, res: Response) => {
  try {
    const result = svc.createTrade(req.body);
    res.status(201).json(result);
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    res.json(svc.deleteTrade(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

export default router;
