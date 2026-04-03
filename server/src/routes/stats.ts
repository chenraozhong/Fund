import { Router, Request, Response } from 'express';
import * as svc from '../services/stats.service';

const router = Router();

router.get('/summary', (_req: Request, res: Response) => {
  res.json(svc.getSummary());
});

router.get('/performance', (_req: Request, res: Response) => {
  res.json(svc.getPerformance());
});

router.get('/allocation', (_req: Request, res: Response) => {
  res.json(svc.getAllocation());
});

router.post('/snapshot', (_req: Request, res: Response) => {
  const count = svc.recordDailySnapshots();
  res.json({ success: true, count });
});

router.get('/snapshots/:fundId', (req: Request, res: Response) => {
  const days = req.query.days ? parseInt(req.query.days as string) : undefined;
  res.json(svc.getSnapshots(req.params.fundId as string, days));
});

router.get('/snapshots-all', (_req: Request, res: Response) => {
  res.json(svc.getAllSnapshots());
});

router.get('/cost-nav-changes', (_req: Request, res: Response) => {
  res.json(svc.getCostNavChanges());
});

// Re-export for backward compatibility (used by nav.ts)
export { recordDailySnapshots } from '../services/stats.service';
export default router;
