import { Router, Request, Response } from 'express';
import db from '../db';
import { recordDailySnapshots } from './stats';
import { autoReviewForecasts } from './strategy';

const router = Router();

// 从东方财富历史净值API获取最近2条官方净值（今日+昨日）
async function fetchOfficialNav(code: string): Promise<{ date: string; nav: number; prevDate: string; prevNav: number } | null> {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
    const res = await fetch(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    const data = await res.json() as any;
    const list = data.Data?.LSJZList;
    if (list?.length >= 2) {
      return {
        date: list[0].FSRQ,
        nav: parseFloat(list[0].DWJZ),
        prevDate: list[1].FSRQ,
        prevNav: parseFloat(list[1].DWJZ),
      };
    }
    if (list?.length === 1) {
      return { date: list[0].FSRQ, nav: parseFloat(list[0].DWJZ), prevDate: '', prevNav: 0 };
    }
  } catch { /* fallback */ }
  return null;
}

// 批量刷新所有有基金代码的基金的最新净值，更新 market_nav
router.post('/refresh-all', async (_req: Request, res: Response) => {
  try {
    const funds = db.prepare("SELECT id, name, code FROM funds WHERE code != '' AND code IS NOT NULL").all() as any[];
    const results: { id: number; name: string; code: string; nav: number | null; date?: string; source?: string; error?: string }[] = [];

    for (const f of funds) {
      try {
        // 1. 优先从官方历史净值API获取（当日净值18:00-21:00后可用）
        const official = await fetchOfficialNav(f.code);
        if (official && official.nav > 0) {
          db.prepare('UPDATE funds SET market_nav = ? WHERE id = ?').run(official.nav, f.id);
          results.push({ id: f.id, name: f.name, code: f.code, nav: official.nav, date: official.date, source: 'official' });
          continue;
        }

        // 2. 回退到估值接口的dwjz（上一交易日净值）
        const gzRes = await fetch(`https://fundgz.1234567.com.cn/js/${f.code}.js?rt=${Date.now()}`);
        if (gzRes.ok) {
          const text = await gzRes.text();
          const json = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
          const data = JSON.parse(json);
          const nav = parseFloat(data.dwjz);
          if (nav > 0) {
            if (data.name) {
              db.prepare('UPDATE funds SET market_nav = ?, name = ? WHERE id = ?').run(nav, data.name, f.id);
            } else {
              db.prepare('UPDATE funds SET market_nav = ? WHERE id = ?').run(nav, f.id);
            }
            results.push({ id: f.id, name: data.name || f.name, code: f.code, nav, date: data.jzrq, source: 'estimate_dwjz' });
            continue;
          }
        }
        results.push({ id: f.id, name: f.name, code: f.code, nav: null, error: '未获取到净值' });
      } catch (err: any) {
        results.push({ id: f.id, name: f.name, code: f.code, nav: null, error: err.message });
      }
    }

    // 刷新净值后自动记录每日快照 + 自动复盘预测
    try { recordDailySnapshots(); } catch { /* ignore snapshot errors */ }
    try { autoReviewForecasts(); } catch { /* ignore review errors */ }

    res.json({ updated: results.filter(r => r.nav !== null).length, total: funds.length, results });
  } catch (err: any) {
    res.status(500).json({ error: '批量刷新失败: ' + err.message });
  }
});

// 获取最新净值（含实时估值）
router.get('/:code/latest', async (req: Request, res: Response) => {
  const code = req.params.code as string;
  try {
    // 并行获取：官方净值 + 实时估值
    const [official, gzRes] = await Promise.all([
      fetchOfficialNav(code),
      fetch(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`).catch(() => null),
    ]);

    let estimated_nav: number | null = null;
    let estimated_change: number | null = null;
    let estimate_time: string | null = null;
    let gzName = '';
    let gzDate = '';
    let gzDwjz = 0;

    if (gzRes && gzRes.ok) {
      try {
        const text = await gzRes.text();
        if (text.includes('jsonpgz')) {
          const json = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
          const data = JSON.parse(json);
          estimated_nav = data.gsz ? parseFloat(data.gsz) : null;
          estimated_change = data.gszzl ? parseFloat(data.gszzl) : null;
          estimate_time = data.gztime || null;
          gzName = data.name || '';
          gzDate = data.jzrq || '';
          gzDwjz = parseFloat(data.dwjz) || 0;
        }
      } catch { /* 估值接口解析失败，忽略 */ }
    }

    // 官方净值优先；若官方净值日期比估值接口的dwjz更新，说明今日已出净值
    const officialNav = official?.nav ?? 0;
    const officialDate = official?.date ?? '';
    const officialPrevNav = official?.prevNav ?? 0;
    const useOfficial = officialNav > 0 && officialDate >= gzDate;

    // prev_nav: 上一交易日净值（用于计算当日收益）
    // 优先用lsjz的第2条（最可靠），回退到估值接口的dwjz
    const prevNav = officialPrevNav > 0 ? officialPrevNav : gzDwjz;

    const finalNav = useOfficial ? officialNav : gzDwjz;
    if (finalNav <= 0 && !estimated_nav) {
      res.status(404).json({ error: '未找到该基金净值数据' });
      return;
    }

    res.json({
      code,
      name: gzName || code,
      date: useOfficial ? officialDate : gzDate,
      nav: finalNav,
      prev_nav: prevNav,
      estimated_nav,
      estimated_change,
      estimate_time,
      source: useOfficial ? 'official' : 'estimate',
    });
  } catch (err: any) {
    res.status(500).json({ error: '获取净值失败: ' + err.message });
  }
});

// 批量获取所有基金的实时估值 + 官方净值
router.get('/estimate/all', async (_req: Request, res: Response) => {
  try {
    const funds = db.prepare("SELECT id, code FROM funds WHERE code != '' AND code IS NOT NULL AND deleted_at IS NULL").all() as any[];
    const results: Record<number, { gsz: number; gszzl: number; gztime: string; dwjz: number; name: string; officialNav: number; officialDate: string; prevNav: number }> = {};

    await Promise.all(funds.map(async (f: any) => {
      try {
        // 并行获取估值 + 官方净值
        const [gzRes, official] = await Promise.all([
          fetch(`https://fundgz.1234567.com.cn/js/${f.code}.js?rt=${Date.now()}`, {
            headers: { 'Referer': 'https://fund.eastmoney.com/' },
          }).catch(() => null),
          fetchOfficialNav(f.code),
        ]);

        let gsz = 0, gszzl = 0, gztime = '', dwjz = 0, name = '';
        if (gzRes && gzRes.ok) {
          try {
            const text = await gzRes.text();
            if (text.includes('jsonpgz')) {
              const json = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
              const data = JSON.parse(json);
              gsz = data.gsz ? parseFloat(data.gsz) : 0;
              gszzl = data.gszzl ? parseFloat(data.gszzl) : 0;
              gztime = data.gztime || '';
              dwjz = parseFloat(data.dwjz) || 0;
              name = data.name || '';
            }
          } catch { /* ignore */ }
        }

        const officialNav = official?.nav ?? 0;
        const officialDate = official?.date ?? '';
        const prevNav = official?.prevNav ?? dwjz;

        if (gsz > 0 || officialNav > 0) {
          results[f.id] = { gsz, gszzl, gztime, dwjz, name, officialNav, officialDate, prevNav };
        }
      } catch { /* skip failed */ }
    }));

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: '批量估值失败: ' + err.message });
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
