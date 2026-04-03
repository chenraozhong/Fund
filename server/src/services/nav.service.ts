import db from '../db';
import { recordDailySnapshots } from './stats.service';

async function fetchOfficialNav(code: string): Promise<{ date: string; nav: number; prevDate: string; prevNav: number } | null> {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`;
    const res = await fetch(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    const data = await res.json() as any;
    const list = data.Data?.LSJZList;
    if (list?.length >= 2) {
      return { date: list[0].FSRQ, nav: parseFloat(list[0].DWJZ), prevDate: list[1].FSRQ, prevNav: parseFloat(list[1].DWJZ) };
    }
    if (list?.length === 1) {
      return { date: list[0].FSRQ, nav: parseFloat(list[0].DWJZ), prevDate: '', prevNav: 0 };
    }
  } catch { /* fallback */ }
  return null;
}

export { fetchOfficialNav };

export async function refreshAllNav() {
  const funds = db.prepare("SELECT id, name, code FROM funds WHERE code != '' AND code IS NOT NULL").all() as any[];
  const results: { id: number; name: string; code: string; nav: number | null; date?: string; source?: string; error?: string }[] = [];

  for (const f of funds) {
    try {
      const official = await fetchOfficialNav(f.code);
      if (official && official.nav > 0) {
        db.prepare('UPDATE funds SET market_nav = ? WHERE id = ?').run(official.nav, f.id);
        results.push({ id: f.id, name: f.name, code: f.code, nav: official.nav, date: official.date, source: 'official' });
        continue;
      }

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

  try { recordDailySnapshots(); } catch { /* ignore */ }
  // autoReviewForecasts is in strategy.ts - defer to v1.1
  try {
    const { autoReviewForecasts } = await import('../routes/strategy');
    autoReviewForecasts();
  } catch { /* ignore if strategy not available */ }

  return { updated: results.filter(r => r.nav !== null).length, total: funds.length, results };
}

export async function getLatestNav(code: string) {
  const [official, gzRes] = await Promise.all([
    fetchOfficialNav(code),
    fetch(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`).catch(() => null),
  ]);

  let estimated_nav: number | null = null;
  let estimated_change: number | null = null;
  let estimate_time: string | null = null;
  let gzName = '', gzDate = '', gzDwjz = 0;

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
    } catch { /* ignore */ }
  }

  const officialNav = official?.nav ?? 0;
  const officialDate = official?.date ?? '';
  const officialPrevNav = official?.prevNav ?? 0;
  const useOfficial = officialNav > 0 && officialDate >= gzDate;
  const prevNav = officialPrevNav > 0 ? officialPrevNav : gzDwjz;
  const finalNav = useOfficial ? officialNav : gzDwjz;

  if (finalNav <= 0 && !estimated_nav) {
    throw { status: 404, error: '未找到该基金净值数据' };
  }

  return {
    code, name: gzName || code,
    date: useOfficial ? officialDate : gzDate,
    nav: finalNav, prev_nav: prevNav,
    estimated_nav, estimated_change, estimate_time,
    source: useOfficial ? 'official' : 'estimate',
  };
}

export async function getEstimateAll() {
  const funds = db.prepare("SELECT id, code FROM funds WHERE code != '' AND code IS NOT NULL AND deleted_at IS NULL").all() as any[];
  const results: Record<number, any> = {};

  await Promise.all(funds.map(async (f: any) => {
    try {
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
    } catch { /* skip */ }
  }));

  return results;
}

export async function getNavByDate(code: string, date: string) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=5&startDate=${date}&endDate=${date}`;
  const apiRes = await fetch(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
  const data = await apiRes.json() as any;

  if (data.Data?.LSJZList?.length > 0) {
    const item = data.Data.LSJZList[0];
    return { date: item.FSRQ, nav: parseFloat(item.DWJZ) };
  }

  const fallbackUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=3&startDate=&endDate=${date}`;
  const fallbackRes = await fetch(fallbackUrl, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
  const fallbackData = await fallbackRes.json() as any;

  if (fallbackData.Data?.LSJZList?.length > 0) {
    const item = fallbackData.Data.LSJZList[0];
    return { date: item.FSRQ, nav: parseFloat(item.DWJZ), note: '非交易日，返回最近交易日净值' };
  }

  throw { status: 404, error: '未找到该日期净值' };
}

export async function getNavHistory(code: string, params?: { start?: string; end?: string; pageSize?: string }) {
  const size = params?.pageSize || '30';
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${size}&startDate=${params?.start || ''}&endDate=${params?.end || ''}`;
  const apiRes = await fetch(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
  const data = await apiRes.json() as any;

  if (data.Data?.LSJZList) {
    const list = data.Data.LSJZList.map((item: any) => ({
      date: item.FSRQ, nav: parseFloat(item.DWJZ),
      cumulative_nav: parseFloat(item.LJJZ),
      change_pct: item.JZZZL ? parseFloat(item.JZZZL) : null,
    }));
    return { total: data.Data.TotalCount, list };
  }

  return { total: 0, list: [] };
}
