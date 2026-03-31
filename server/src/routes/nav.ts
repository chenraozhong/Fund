import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

// 批量刷新所有有基金代码的基金的最新净值，更新 market_nav
router.post('/refresh-all', async (_req: Request, res: Response) => {
  try {
    const funds = db.prepare("SELECT id, name, code FROM funds WHERE code != '' AND code IS NOT NULL").all() as any[];
    const results: { id: number; name: string; code: string; nav: number | null; error?: string }[] = [];

    for (const f of funds) {
      try {
        const gzRes = await fetch(`https://fundgz.1234567.com.cn/js/${f.code}.js?rt=${Date.now()}`);
        if (gzRes.ok) {
          const text = await gzRes.text();
          const json = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
          const data = JSON.parse(json);
          const nav = parseFloat(data.dwjz);
          if (nav > 0) {
            // 同时更新净值和基金名称（API返回的name是官方名称）
            if (data.name) {
              db.prepare('UPDATE funds SET market_nav = ?, name = ? WHERE id = ?').run(nav, data.name, f.id);
            } else {
              db.prepare('UPDATE funds SET market_nav = ? WHERE id = ?').run(nav, f.id);
            }
            results.push({ id: f.id, name: data.name || f.name, code: f.code, nav });
            continue;
          }
        }
        results.push({ id: f.id, name: f.name, code: f.code, nav: null, error: '未获取到净值' });
      } catch (err: any) {
        results.push({ id: f.id, name: f.name, code: f.code, nav: null, error: err.message });
      }
    }

    res.json({ updated: results.filter(r => r.nav !== null).length, total: funds.length, results });
  } catch (err: any) {
    res.status(500).json({ error: '批量刷新失败: ' + err.message });
  }
});

// 获取最新净值（含实时估值）
router.get('/:code/latest', async (req: Request, res: Response) => {
  const { code } = req.params;
  try {
    // 先尝试实时估值接口
    const gzRes = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`);
    if (gzRes.ok) {
      const text = await gzRes.text();
      const json = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
      const data = JSON.parse(json);
      res.json({
        code: data.fundcode,
        name: data.name,
        date: data.jzrq,
        nav: parseFloat(data.dwjz),
        estimated_nav: data.gsz ? parseFloat(data.gsz) : null,
        estimated_change: data.gszzl ? parseFloat(data.gszzl) : null,
        estimate_time: data.gztime || null,
      });
      return;
    }
    res.status(404).json({ error: '未找到该基金' });
  } catch (err: any) {
    res.status(500).json({ error: '获取净值失败: ' + err.message });
  }
});

// 获取指定日期净值
router.get('/:code/date/:date', async (req: Request, res: Response) => {
  const { code, date } = req.params;
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=5&startDate=${date}&endDate=${date}`;
    const apiRes = await fetch(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    const data = await apiRes.json() as any;

    if (data.Data?.LSJZList?.length > 0) {
      const item = data.Data.LSJZList[0];
      res.json({ date: item.FSRQ, nav: parseFloat(item.DWJZ) });
      return;
    }

    // 如果精确日期没找到，取最近的前一个交易日
    const fallbackUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=3&startDate=&endDate=${date}`;
    const fallbackRes = await fetch(fallbackUrl, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    const fallbackData = await fallbackRes.json() as any;

    if (fallbackData.Data?.LSJZList?.length > 0) {
      const item = fallbackData.Data.LSJZList[0];
      res.json({ date: item.FSRQ, nav: parseFloat(item.DWJZ), note: '非交易日，返回最近交易日净值' });
      return;
    }

    res.status(404).json({ error: '未找到该日期净值' });
  } catch (err: any) {
    res.status(500).json({ error: '获取净值失败: ' + err.message });
  }
});

// 获取历史净值列表
router.get('/:code/history', async (req: Request, res: Response) => {
  const { code } = req.params;
  const { start, end, pageSize } = req.query;
  try {
    const size = pageSize || '30';
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${size}&startDate=${start || ''}&endDate=${end || ''}`;
    const apiRes = await fetch(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    const data = await apiRes.json() as any;

    if (data.Data?.LSJZList) {
      const list = data.Data.LSJZList.map((item: any) => ({
        date: item.FSRQ,
        nav: parseFloat(item.DWJZ),
        cumulative_nav: parseFloat(item.LJJZ),
        change_pct: item.JZZZL ? parseFloat(item.JZZZL) : null,
      }));
      res.json({ total: data.Data.TotalCount, list });
      return;
    }

    res.json({ total: 0, list: [] });
  } catch (err: any) {
    res.status(500).json({ error: '获取历史净值失败: ' + err.message });
  }
});

export default router;
