import { Router, Request, Response } from 'express';
import * as svc from '../services/nav.service';

const router = Router();

function handleServiceError(res: Response, err: any) {
  const status = err?.status || 500;
  const error = err?.error || err?.message || 'Internal error';
  res.status(status).json({ error });
}

router.post('/refresh-all', async (_req: Request, res: Response) => {
  try {
    res.json(await svc.refreshAllNav());
  } catch (err: any) {
    res.status(500).json({ error: '批量刷新失败: ' + (err.message || err) });
  }
});

router.get('/:code/latest', async (req: Request, res: Response) => {
  try {
    res.json(await svc.getLatestNav(req.params.code as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.get('/estimate/all', async (_req: Request, res: Response) => {
  try {
    res.json(await svc.getEstimateAll());
  } catch (err: any) {
    res.status(500).json({ error: '批量估值失败: ' + (err.message || err) });
  }
});

router.get('/:code/date/:date', async (req: Request, res: Response) => {
  try {
    res.json(await svc.getNavByDate(req.params.code as string, req.params.date as string));
  } catch (err: any) {
    handleServiceError(res, err);
  }
});

router.get('/:code/history', async (req: Request, res: Response) => {
  try {
    res.json(await svc.getNavHistory(req.params.code as string, req.query as any));
  } catch (err: any) {
    res.status(500).json({ error: '获取历史净值失败: ' + (err.message || err) });
  }
});

export default router;
