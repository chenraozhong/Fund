import { Router, Request, Response } from 'express';
import * as svc from '../services/funds.service';

const router = Router();

function handleServiceError(res: Response, err: any) {
  const status = err?.status || 500;
  const error = err?.error || err?.message || 'Internal error';
  res.status(status).json({ error });
}

router.get('/', (_req: Request, res: Response) => {
  res.json(svc.listFunds());
});

router.post('/', (req: Request, res: Response) => {
  try {
    const fund = svc.createFund(req.body);
    res.status(201).json(fund);
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.get('/trash/list', (_req: Request, res: Response) => {
  res.json(svc.listTrashFunds());
});

router.post('/trash/:id/restore', (req: Request, res: Response) => {
  try {
    res.json(svc.restoreTrashFund(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.delete('/trash/:id/permanent', (req: Request, res: Response) => {
  try {
    res.json(svc.permanentDeleteFund(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    res.json(svc.updateFund(req.params.id as string, req.body));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.post('/:id/adjust', (req: Request, res: Response) => {
  try {
    res.json(svc.adjustHolding(req.params.id as string, req.body));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.post('/:id/gain', (req: Request, res: Response) => {
  try {
    res.json(svc.updateFundGain(req.params.id as string, req.body.gain));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    res.json(svc.deleteFund(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.get('/:id/positions', (req: Request, res: Response) => {
  try {
    res.json(svc.getFundPositions(req.params.id as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

export default router;
