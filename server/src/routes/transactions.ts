import { Router, Request, Response } from 'express';
import * as svc from '../services/transactions.service';

const router = Router();

function handleServiceError(res: Response, err: any) {
  const status = err?.status || 500;
  const error = err?.error || err?.message || 'Internal error';
  res.status(status).json({ error });
}

router.get('/', (req: Request, res: Response) => {
  res.json(svc.listTransactions(req.query as any));
});

router.post('/', (req: Request, res: Response) => {
  try {
    const tx = svc.createTransaction(req.body);
    res.status(201).json(tx);
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.post('/batch', (req: Request, res: Response) => {
  try {
    const result = svc.batchCreateTransactions(req.body.transactions);
    res.status(201).json(result);
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    res.json(svc.updateTransaction(req.params.id as string, req.body));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    res.json(svc.deleteTransaction(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.post('/:id/split', (req: Request, res: Response) => {
  try {
    res.json(svc.splitTransaction(req.params.id as string, req.body.shares));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.post('/merge', (req: Request, res: Response) => {
  try {
    res.json(svc.mergeTransactions(req.body.ids));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

export default router;
