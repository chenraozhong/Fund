// 共享数据源：基本面 + 消息面获取

export interface FundFundamental {
  name: string; type: string; rate: string; minBuy: string;
  manager: string; managerDays: string; managerReturn: string;
  performance: string; assetAlloc: string; topHoldings: string;
  holderStructure: string; scale: string;
  // 用于评分的原始数值
  _managerReturnPct: number;   // 经理任期回报%
  _scaleBillion: number;       // 规模（亿）
  _syl3m: number;              // 近3月收益率%
  _syl6m: number;              // 近6月收益率%
  _syl1y: number;              // 近1年收益率%
  _perfScores: Record<string, string>; // 业绩评价原始分
}

const FUND_DEFAULTS: FundFundamental = {
  name: '', type: '', rate: '', minBuy: '', manager: '', managerDays: '', managerReturn: '',
  performance: '', assetAlloc: '', topHoldings: '', holderStructure: '', scale: '',
  _managerReturnPct: 0, _scaleBillion: 0, _syl3m: 0, _syl6m: 0, _syl1y: 0, _perfScores: {},
};

export async function fetchFundamental(code: string): Promise<FundFundamental> {
  try {
    const res = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      headers: { 'Referer': 'https://fund.eastmoney.com/' },
    });
    if (!res.ok) return { ...FUND_DEFAULTS };
    const text = await res.text();

    const extractStr = (varName: string) => {
      const re = new RegExp(`var ${varName}\\s*=\\s*(.+?);\n?(?:var |/\\*|$)`, 's');
      const m = text.match(re);
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };

    const name = extractStr('fS_name');
    const rate = extractStr('fund_Rate');

    let manager = '', managerDays = '', managerReturn = '', _managerReturnPct = 0;
    const mgrMatch = text.match(/var Data_currentFundManager\s*=\s*(\[.+?\]);/s);
    if (mgrMatch) {
      try {
        const mgrData = JSON.parse(mgrMatch[1]);
        if (mgrData.length > 0) {
          const m = mgrData[0];
          manager = m.name || '';
          managerDays = m.workTime || '';
          managerReturn = m.profit ? `${m.profit}%` : '';
          _managerReturnPct = m.profit ? parseFloat(m.profit) : 0;
        }
      } catch {}
    }

    let performance = '';
    let _perfScores: Record<string, string> = {};
    const perfMatch = text.match(/var Data_performanceEvaluation\s*=\s*(\{.+?\});/s);
    if (perfMatch) {
      try {
        const p = JSON.parse(perfMatch[1]);
        _perfScores = p;
        const keys: Record<string, string> = { SY: '收益', KHD: '抗风险', AQX: '安全性', WDX: '稳定性', ZZX: '选择性' };
        performance = Object.entries(p).filter(([k]) => keys[k]).map(([k, v]) => `${keys[k]}:${v}`).join(' | ');
      } catch {}
    }

    let assetAlloc = '';
    const allocMatch = text.match(/var Data_assetAllocation\s*=\s*(\{.+?\});/s);
    if (allocMatch) {
      try {
        const a = JSON.parse(allocMatch[1]);
        const categories = a.categories || [];
        const series = a.series || [];
        if (categories.length > 0 && series.length > 0) {
          const latest = categories.length - 1;
          assetAlloc = `${categories[latest]} | ${series.map((s: any) => `${s.name}:${s.data?.[latest] ?? '-'}%`).join(' | ')}`;
        }
      } catch {}
    }

    let topHoldings = '';
    const stockMatch = text.match(/var stockCodesNew\s*=\s*(\[.+?\]);/s);
    if (stockMatch) {
      try {
        const codes = JSON.parse(stockMatch[1]);
        topHoldings = `前${codes.length}大重仓股: ${codes.slice(0, 10).join(', ')}`;
      } catch {}
    }

    let holderStructure = '';
    const holderMatch = text.match(/var Data_holderStructure\s*=\s*(\{.+?\});/s);
    if (holderMatch) {
      try {
        const h = JSON.parse(holderMatch[1]);
        const categories = h.categories || [];
        const series = h.series || [];
        if (categories.length > 0 && series.length > 0) {
          const latest = categories.length - 1;
          holderStructure = `${categories[latest]} | ${series.map((s: any) => `${s.name}:${s.data?.[latest] ?? '-'}%`).join(' | ')}`;
        }
      } catch {}
    }

    let scale = '', _scaleBillion = 0;
    const scaleMatch = text.match(/var Data_fluctuationScale\s*=\s*(\{.+?\});/s);
    if (scaleMatch) {
      try {
        const s = JSON.parse(scaleMatch[1]);
        const categories = s.categories || [];
        const series = s.series || [];
        if (categories.length > 0 && series.length > 0) {
          const latest = categories.length - 1;
          const val = series[0]?.data?.[latest];
          scale = `${categories[latest]} | ${val ?? '-'}亿`;
          _scaleBillion = val ? parseFloat(val) : 0;
        }
      } catch {}
    }

    const syl1n = text.match(/var syl_1n="(.+?)"/)?.[1] || '';
    const syl6y = text.match(/var syl_6y="(.+?)"/)?.[1] || '';
    const syl3y = text.match(/var syl_3y="(.+?)"/)?.[1] || '';
    const _syl3m = syl3y ? parseFloat(syl3y) : 0;
    const _syl6m = syl6y ? parseFloat(syl6y) : 0;
    const _syl1y = syl1n ? parseFloat(syl1n) : 0;
    const perfSummary = [syl3y ? `近3月:${syl3y}%` : '', syl6y ? `近6月:${syl6y}%` : '', syl1n ? `近1年:${syl1n}%` : ''].filter(Boolean).join(' | ');

    return {
      name, type: '', rate: `${rate}%`, minBuy: '',
      manager, managerDays, managerReturn,
      performance: `${performance}${perfSummary ? '\n收益率: ' + perfSummary : ''}`,
      assetAlloc, topHoldings, holderStructure, scale,
      _managerReturnPct, _scaleBillion, _syl3m, _syl6m, _syl1y, _perfScores,
    };
  } catch { return { ...FUND_DEFAULTS }; }
}

export interface NewsItem { title: string; date: string; source: string; url: string }

export async function fetchSectorNews(keyword: string, count: number = 8): Promise<NewsItem[]> {
  try {
    const param = JSON.stringify({
      uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: count } },
    });
    const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=&param=${encodeURIComponent(param)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    let text = await res.text();
    text = text.replace(/^\(/, '').replace(/\)$/, '');
    const data = JSON.parse(text);
    const list = data.result?.cmsArticleWebOld || [];
    return list.map((item: any) => ({
      title: (item.title || '').replace(/<[^>]+>/g, ''),
      date: item.date || '',
      source: item.mediaName || '',
      url: item.url || '',
    }));
  } catch { return []; }
}

// 板块推断
export function inferSectorKeyword(name: string): string {
  const mapping: [RegExp, string][] = [
    [/有色|金属|矿/, '有色金属基金'],
    [/科技|芯片|半导体|信息|电子|通信|5G|AI|人工智能|计算机/, '科技基金'],
    [/医药|医疗|生物|健康|创新药/, '医药基金'],
    [/新能源|光伏|锂电|电池|碳中和|风电/, '新能源基金'],
    [/消费|白酒|食品|饮料|家电/, '消费基金'],
    [/金融|银行|证券|保险|券商/, '金融银行基金'],
    [/军工|国防|航天/, '军工基金'],
    [/红利|高股息|价值/, '红利价值基金'],
    [/纳斯达克|美国|标普|美股/, '美股QDII基金'],
    [/恒生|港股/, '港股基金'],
    [/债|固收|理财/, '债券基金'],
  ];
  for (const [re, kw] of mapping) {
    if (re.test(name)) return kw;
  }
  return name;
}

// 消息面情绪评分：分析新闻标题的利多/利空倾向
export function scoreNewsSentiment(news: NewsItem[]): { score: number; bullish: string[]; bearish: string[]; neutral: number } {
  const bullKeywords = /上涨|涨停|新高|利好|大涨|反弹|突破|买入|加仓|增持|超预期|回暖|复苏|放量|资金流入|抢筹|布局|机遇|景气|龙头/;
  const bearKeywords = /下跌|跌停|新低|利空|大跌|暴跌|减持|抛售|清仓|风险|回调|破位|亏损|缩水|资金流出|踩雷|退市|爆雷|下行|承压/;

  let bullCount = 0, bearCount = 0;
  const bullish: string[] = [], bearish: string[] = [];

  for (const n of news) {
    const isBull = bullKeywords.test(n.title);
    const isBear = bearKeywords.test(n.title);
    if (isBull && !isBear) { bullCount++; bullish.push(n.title); }
    else if (isBear && !isBull) { bearCount++; bearish.push(n.title); }
    else if (isBull && isBear) { /* 两者都有算中性 */ }
  }

  const total = news.length || 1;
  // -100 ~ +100
  const score = Math.round(((bullCount - bearCount) / total) * 100);
  return { score: Math.max(-100, Math.min(100, score)), bullish: bullish.slice(0, 3), bearish: bearish.slice(0, 3), neutral: total - bullCount - bearCount };
}

// 基本面评分
export function scoreFundamental(fund: FundFundamental): { score: number; highlights: string[] } {
  let score = 0;
  const highlights: string[] = [];

  // [Fix#10] 评分范围扩大到±100，与技术面/消息面对等
  // 经理任期回报 (max ±30)
  if (fund._managerReturnPct > 50) { score += 30; highlights.push(`经理任期回报优秀(${fund.managerReturn})`); }
  else if (fund._managerReturnPct > 20) { score += 20; highlights.push(`经理任期回报良好(${fund.managerReturn})`); }
  else if (fund._managerReturnPct > 0) { score += 10; }
  else if (fund._managerReturnPct < -10) { score -= 25; highlights.push(`经理任期回报为负(${fund.managerReturn})`); }

  // 规模 (max ±20)
  if (fund._scaleBillion >= 1 && fund._scaleBillion <= 100) { score += 15; }
  else if (fund._scaleBillion > 100) { score += 5; highlights.push(`规模偏大(${fund.scale})，灵活性受限`); }
  else if (fund._scaleBillion > 0 && fund._scaleBillion < 1) { score -= 20; highlights.push(`规模过小(${fund.scale})，有清盘风险`); }

  // 近期业绩 (max ±40)
  if (fund._syl3m > 10) { score += 25; highlights.push(`近3月涨${fund._syl3m.toFixed(1)}%，强势`); }
  else if (fund._syl3m > 5) { score += 20; highlights.push(`近3月涨${fund._syl3m.toFixed(1)}%，势头好`); }
  else if (fund._syl3m > 0) { score += 10; }
  else if (fund._syl3m < -10) { score -= 25; highlights.push(`近3月跌${Math.abs(fund._syl3m).toFixed(1)}%，弱势`); }
  else if (fund._syl3m < -5) { score -= 15; }

  if (fund._syl1y > 20) { score += 15; }
  else if (fund._syl1y > 10) { score += 10; }
  else if (fund._syl1y < -20) { score -= 15; highlights.push(`近1年跌${Math.abs(fund._syl1y).toFixed(1)}%`); }
  else if (fund._syl1y < -10) { score -= 10; }

  return { score: Math.max(-100, Math.min(100, score)), highlights };
}

// ============================================================
// 基金持仓明细（重仓股 + 权重）
// ============================================================

export interface FundHolding {
  code: string;
  name: string;
  pctOfNav: number;   // 占净值比例 %
  shares: number;     // 持股数（万股）
  value: number;      // 持仓市值（万元）
}

export interface FundHoldingsResult {
  quarter: string;    // 如 "2025年4季度"
  date: string;       // 截止日期 如 "2025-12-31"
  holdings: FundHolding[];
}

export async function fetchFundHoldings(code: string): Promise<FundHoldingsResult | null> {
  try {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10`;
    const res = await fetch(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    if (!res.ok) return null;
    const text = await res.text();

    // 提取季度和截止日期
    const quarterMatch = text.match(/(\d{4}年\d季度)股票投资明细/);
    const dateMatch = text.match(/截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/);
    const quarter = quarterMatch ? quarterMatch[1] : '';
    const date = dateMatch ? dateMatch[1] : '';

    // 解析第一个表格的 tbody 行
    const tbodyMatch = text.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) return null;

    const holdings: FundHolding[] = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    let row;
    while ((row = rowRe.exec(tbodyMatch[1])) !== null) {
      const cells: string[] = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let cell;
      while ((cell = cellRe.exec(row[1])) !== null) {
        cells.push(cell[1].replace(/<[^>]+>/g, '').trim());
      }
      // [Fix#8] 用从右往左定位：市值=最后一列, 持股数=倒数第2, 占净值%=倒数第3
      // 最新季度表格: 序号, 代码, 名称, 最新价, 涨跌幅, 相关资讯, 占净值%, 持股数, 市值
      // 历史季度表格: 序号, 代码, 名称, 相关资讯, 占净值%, 持股数, 市值
      if (cells.length >= 7) {
        const pctIdx = cells.length - 3; // 占净值%始终在倒数第3列
        if (cells[pctIdx]?.endsWith('%')) {
          const pct = parseFloat(cells[pctIdx].replace('%', ''));
          const sharesStr = cells[pctIdx + 1]?.replace(/,/g, '');
          const valueStr = cells[pctIdx + 2]?.replace(/,/g, '');
          holdings.push({
            code: cells[1] || '',
            name: cells[2] || '',
            pctOfNav: isNaN(pct) ? 0 : pct,
            shares: parseFloat(sharesStr) || 0,
            value: parseFloat(valueStr) || 0,
          });
        }
      }
    }

    return holdings.length > 0 ? { quarter, date, holdings } : null;
  } catch { return null; }
}

// ============================================================
// 赎回费率阶梯获取
// ============================================================

export interface RedeemFeeLevel {
  minDays: number;
  maxDays: number;    // Infinity表示无上限
  feeRate: number;    // 百分比，如1.5表示1.5%
  label: string;      // 原始描述
}

export async function fetchRedeemFees(code: string): Promise<RedeemFeeLevel[]> {
  const defaults: RedeemFeeLevel[] = [
    { minDays: 0, maxDays: 6, feeRate: 1.5, label: '小于等于6天' },
    { minDays: 7, maxDays: 29, feeRate: 0.75, label: '7-29天' },
    { minDays: 30, maxDays: 364, feeRate: 0.5, label: '30-364天' },
    { minDays: 365, maxDays: 729, feeRate: 0.25, label: '365-729天' },
    { minDays: 730, maxDays: Infinity, feeRate: 0, label: '730天以上' },
  ];
  try {
    const res = await fetch(`https://fundf10.eastmoney.com/jjfl_${code}.html`, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/' },
    });
    if (!res.ok) return defaults;
    const html = await res.text();

    // 定位赎回费率表格
    const redeemSection = html.match(/赎回费率<a name="shfl"><\/a>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
    if (!redeemSection) return defaults;

    const levels: RedeemFeeLevel[] = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
    let row;
    while ((row = rowRe.exec(redeemSection[1])) !== null) {
      const cells: string[] = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let cell;
      while ((cell = cellRe.exec(row[1])) !== null) {
        cells.push(cell[1].replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length >= 2) {
        const label = cells[0];
        const rateStr = cells[1].replace('%', '').trim();
        const feeRate = parseFloat(rateStr) || 0;

        // 解析天数范围
        let minDays = 0, maxDays = Infinity;
        // "小于等于6天" → 0-6
        const le = label.match(/小于等于(\d+)天/);
        if (le) { maxDays = parseInt(le[1]); }
        // "大于等于7天，小于等于29天" → 7-29
        const range = label.match(/大于等于(\d+)天[，,].*小于等于(\d+)天/);
        if (range) { minDays = parseInt(range[1]); maxDays = parseInt(range[2]); }
        // "大于等于730天" → 730-∞
        const ge = label.match(/^大于等于(\d+)天$/);
        if (ge) { minDays = parseInt(ge[1]); maxDays = Infinity; }

        levels.push({ minDays, maxDays, feeRate, label });
      }
    }

    return levels.length > 0 ? levels : defaults;
  } catch { return defaults; }
}

// 根据持有天数查赎回费率
export function getRedeemFeeRate(levels: RedeemFeeLevel[], holdDays: number): number {
  for (const l of levels) {
    if (holdDays >= l.minDays && holdDays <= l.maxDays) return l.feeRate / 100;
  }
  return 0.005; // 默认0.5%
}

// ============================================================
// 资金流向数据
// ============================================================

export interface HoldingFlow {
  code: string;
  name: string;
  pctOfNav: number;           // 占净值比例%
  mainNetInflow: number;      // 主力净流入（亿元）
  mainPct: number;            // 主力净占比%
}

export interface CapitalFlowData {
  // 大盘主力资金（近5日）
  market: {
    date: string;
    mainNetInflow: number;    // 主力净流入（元）
    superLargeIn: number;     // 超大单净流入
    largeIn: number;          // 大单净流入
    mainPct: number;          // 主力净占比%
  }[];
  // 北向资金（近5日净买入，亿元）
  northbound: {
    date: string;
    netBuy: number;           // 北向净买入（亿元）
  }[];
  // 板块资金流（匹配到的板块，当日）
  sector: {
    name: string;
    mainNetInflow: number;    // 主力净流入（亿元）
    mainPct: number;          // 主力净占比%
    superLargeIn: number;     // 超大单净流入（亿元）
  } | null;
  // 重仓股资金流（每只基金不同）
  holdings: HoldingFlow[];
  holdingsFlowScore: number;  // 重仓股加权资金评分 -100~+100
  // 汇总评分 -100~+100
  flowScore: number;
  flowLabel: string;
  flowDetail: string;         // 资金流向说明文字
}

// === 市场级数据缓存（10分钟TTL）===
let _marketCache: { data: CapitalFlowData['market']; ts: number } | null = null;
let _northboundCache: { data: CapitalFlowData['northbound']; ts: number } | null = null;
let _sectorCache: { data: Map<string, CapitalFlowData['sector']>; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10分钟

/** 获取大盘主力资金近N日流向（带缓存） */
async function fetchMarketMainFlow(days: number = 5): Promise<CapitalFlowData['market']> {
  if (_marketCache && Date.now() - _marketCache.ts < CACHE_TTL) return _marketCache.data;
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=1.000001&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&lmt=${days}&klt=101&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    const klines = data?.data?.klines || [];
    const result = klines.map((line: string) => {
      const parts = line.split(',');
      return {
        date: parts[0],
        mainNetInflow: parseFloat(parts[1]) || 0,
        superLargeIn: parseFloat(parts[2]) || 0,
        largeIn: parseFloat(parts[3]) || 0,
        mainPct: parseFloat(parts[6]) || 0,
      };
    });
    _marketCache = { data: result, ts: Date.now() };
    return result;
  } catch { return []; }
}

/** 获取北向资金近N日净买入（带缓存） */
async function fetchNorthboundFlow(days: number = 5): Promise<CapitalFlowData['northbound']> {
  if (_northboundCache && Date.now() - _northboundCache.ts < CACHE_TTL) return _northboundCache.data;
  try {
    const url = `https://push2his.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=${days}&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    const hk2sh = data?.data?.hk2sh || [];
    const hk2sz = data?.data?.hk2sz || [];
    const result: CapitalFlowData['northbound'] = [];
    for (let i = 0; i < Math.max(hk2sh.length, hk2sz.length); i++) {
      const shParts = (hk2sh[i] || '').split(',');
      const szParts = (hk2sz[i] || '').split(',');
      const date = shParts[0] || szParts[0] || '';
      const shNet = (parseFloat(shParts[1]) || 0) - (parseFloat(shParts[2]) || 0);
      const szNet = (parseFloat(szParts[1]) || 0) - (parseFloat(szParts[2]) || 0);
      result.push({ date, netBuy: Math.round((shNet + szNet) / 10000) / 10000 });
    }
    _northboundCache = { data: result, ts: Date.now() };
    return result;
  } catch { return []; }
}

// 板块关键词到板块代码映射
const sectorFlowMapping: [RegExp, string][] = [
  [/医药|医疗|生物|健康|创新药/, '医药生物'],
  [/科技|芯片|半导体|信息|电子|通信|5G|AI|人工智能|计算机/, '电子'],
  [/新能源|光伏|锂电|电池|碳中和|风电/, '电力设备'],
  [/消费|白酒|食品|饮料/, '食品饮料'],
  [/家电/, '家用电器'],
  [/金融|银行/, '银行'],
  [/证券|券商/, '非银金融'],
  [/军工|国防|航天/, '国防军工'],
  [/红利|高股息|价值/, '银行'],
  [/有色|金属|矿/, '有色金属'],
  [/汽车|新能源车/, '汽车'],
  [/房地产|地产/, '房地产'],
  [/钢铁/, '钢铁'],
  [/煤炭|能源/, '煤炭'],
];

/** 获取板块资金流（当日，带缓存） */
async function fetchSectorFlow(fundName: string): Promise<CapitalFlowData['sector']> {
  let targetSector = '';
  for (const [re, name] of sectorFlowMapping) {
    if (re.test(fundName)) { targetSector = name; break; }
  }
  if (!targetSector) return null;

  // 检查缓存
  if (_sectorCache && Date.now() - _sectorCache.ts < CACHE_TTL) {
    return _sectorCache.data.get(targetSector) ?? null;
  }

  try {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f62,f184,f66,f69,f72,f75,f78,f81&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const list = data?.data?.diff || [];

    // 构建缓存
    const sectorMap = new Map<string, CapitalFlowData['sector']>();
    for (const item of list) {
      const name = item.f14 || '';
      sectorMap.set(name, {
        name,
        mainNetInflow: Math.round((item.f62 || 0) / 1e8 * 100) / 100,
        mainPct: item.f184 || 0,
        superLargeIn: Math.round((item.f66 || 0) / 1e8 * 100) / 100,
      });
    }
    _sectorCache = { data: sectorMap, ts: Date.now() };

    // 模糊匹配
    for (const [, sector] of sectorMap) {
      if (sector && sector.name.includes(targetSector)) return sector;
    }
    return null;
  } catch { return null; }
}

/** 批量获取重仓股当日资金流向（每只基金不同！） */
async function fetchHoldingsFlow(holdings: FundHolding[]): Promise<HoldingFlow[]> {
  if (!holdings || holdings.length === 0) return [];
  const top = holdings.slice(0, 5); // 取前5大重仓股

  // 构建 secids：沪市(6开头)=1.xxx，深市(0/3开头)=0.xxx
  const secids = top.map(h => {
    const market = h.code.startsWith('6') ? '1' : '0';
    return `${market}.${h.code}`;
  }).join(',');

  try {
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f62,f184,f66,f69,f72,f75&secids=${secids}&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    const list = data?.data?.diff || [];

    return list.map((item: any) => {
      const code = item.f12 || '';
      const holding = top.find(h => h.code === code);
      return {
        code,
        name: item.f14 || '',
        pctOfNav: holding?.pctOfNav || 0,
        mainNetInflow: Math.round((item.f62 || 0) / 1e8 * 100) / 100,
        mainPct: item.f184 || 0,
      };
    });
  } catch { return []; }
}

/** 综合获取资金流向数据并评分（每只基金的重仓股不同→评分不同） */
export async function fetchCapitalFlow(fundName: string, holdings?: FundHolding[]): Promise<CapitalFlowData> {
  const [market, northbound, sector, holdingsFlow] = await Promise.all([
    fetchMarketMainFlow(5),
    fetchNorthboundFlow(5),
    fetchSectorFlow(fundName),
    fetchHoldingsFlow(holdings || []),
  ]);

  // === 重仓股加权资金评分（每只基金不同的关键！）===
  let holdingsFlowScore = 0;
  if (holdingsFlow.length > 0) {
    const totalWeight = holdingsFlow.reduce((s, h) => s + h.pctOfNav, 0) || 1;
    for (const h of holdingsFlow) {
      const weight = h.pctOfNav / totalWeight;
      // 单股主力净流入的影响（按持仓比例加权）
      if (h.mainNetInflow > 2) holdingsFlowScore += 20 * weight;
      else if (h.mainNetInflow > 0.5) holdingsFlowScore += 12 * weight;
      else if (h.mainNetInflow > 0) holdingsFlowScore += 5 * weight;
      else if (h.mainNetInflow < -2) holdingsFlowScore -= 20 * weight;
      else if (h.mainNetInflow < -0.5) holdingsFlowScore -= 12 * weight;
      else if (h.mainNetInflow < 0) holdingsFlowScore -= 5 * weight;
      // 主力净占比的影响
      if (h.mainPct > 5) holdingsFlowScore += 10 * weight;
      else if (h.mainPct < -5) holdingsFlowScore -= 10 * weight;
    }
    holdingsFlowScore = Math.round(Math.max(-100, Math.min(100, holdingsFlowScore * 3))); // 放大
  }

  // === 综合评分：重仓股40% + 板块30% + 大盘20% + 北向10% ===
  let marketScore = 0;
  if (market.length >= 2) {
    const latestBillion = (market[market.length - 1]?.mainNetInflow || 0) / 1e8;
    if (latestBillion > 50) marketScore = 30;
    else if (latestBillion > 10) marketScore = 15;
    else if (latestBillion > 0) marketScore = 5;
    else if (latestBillion < -50) marketScore = -30;
    else if (latestBillion < -10) marketScore = -15;
    else if (latestBillion < 0) marketScore = -5;
    // 连续趋势
    const inflowDays = market.filter(v => v.mainNetInflow > 0).length;
    if (inflowDays >= 4) marketScore += 10;
    else if (inflowDays <= 1) marketScore -= 10;
  }

  let nbScore = 0;
  if (northbound.length >= 2) {
    const latestNB = northbound[northbound.length - 1]?.netBuy || 0;
    if (latestNB > 50) nbScore = 20;
    else if (latestNB > 10) nbScore = 10;
    else if (latestNB < -50) nbScore = -20;
    else if (latestNB < -10) nbScore = -10;
  }

  let sectorScore = 0;
  if (sector) {
    if (sector.mainNetInflow > 10) sectorScore = 30;
    else if (sector.mainNetInflow > 2) sectorScore = 15;
    else if (sector.mainNetInflow > 0) sectorScore = 5;
    else if (sector.mainNetInflow < -10) sectorScore = -30;
    else if (sector.mainNetInflow < -2) sectorScore = -15;
    else if (sector.mainNetInflow < 0) sectorScore = -5;
  }

  // 加权：重仓股权重最高（因为最直接影响基金净值）
  const hasHoldings = holdingsFlow.length > 0;
  const flowScore = Math.max(-100, Math.min(100, Math.round(
    hasHoldings
      ? holdingsFlowScore * 0.4 + sectorScore * 0.3 + marketScore * 0.2 + nbScore * 0.1
      : sectorScore * 0.45 + marketScore * 0.35 + nbScore * 0.2   // 无重仓股数据时
  )));

  // === 生成说明文字 ===
  const detailParts: string[] = [];
  if (holdingsFlow.length > 0) {
    const inflowStocks = holdingsFlow.filter(h => h.mainNetInflow > 0).sort((a, b) => b.mainNetInflow - a.mainNetInflow);
    const outflowStocks = holdingsFlow.filter(h => h.mainNetInflow < 0).sort((a, b) => a.mainNetInflow - b.mainNetInflow);
    if (inflowStocks.length > 0) {
      detailParts.push(`重仓流入：${inflowStocks.slice(0, 3).map(h => `${h.name}+${h.mainNetInflow.toFixed(1)}亿`).join('、')}`);
    }
    if (outflowStocks.length > 0) {
      detailParts.push(`重仓流出：${outflowStocks.slice(0, 3).map(h => `${h.name}${h.mainNetInflow.toFixed(1)}亿`).join('、')}`);
    }
  }
  if (sector) {
    detailParts.push(`${sector.name}板块${sector.mainNetInflow >= 0 ? '+' : ''}${sector.mainNetInflow.toFixed(1)}亿`);
  }
  if (market.length > 0) {
    const latestB = (market[market.length - 1]?.mainNetInflow || 0) / 1e8;
    detailParts.push(`大盘主力${latestB >= 0 ? '+' : ''}${latestB.toFixed(0)}亿`);
  }
  if (northbound.length > 0) {
    const nb = northbound[northbound.length - 1]?.netBuy || 0;
    detailParts.push(`北向${nb >= 0 ? '+' : ''}${nb.toFixed(1)}亿`);
  }

  const flowLabel = flowScore >= 30 ? '资金大幅流入'
    : flowScore >= 10 ? '资金温和流入'
    : flowScore <= -30 ? '资金大幅流出'
    : flowScore <= -10 ? '资金温和流出'
    : '资金中性';

  return {
    market, northbound, sector,
    holdings: holdingsFlow, holdingsFlowScore,
    flowScore, flowLabel,
    flowDetail: detailParts.join('；'),
  };
}

// ============================================================
// 组合板块敞口检查（跨基金）
// ============================================================

export function checkSectorExposure(
  db: any,
  currentFundId: number,
  currentSector: string,
  opAmount: number
): { totalExposure: number; overExposed: boolean; reduction: number } {
  // 查询所有活跃基金（排除当前）
  const allFunds = db.prepare(`
    SELECT f.id, f.name,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as shares,
      f.market_nav
    FROM funds f
    LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL AND f.id != ?
    GROUP BY f.id
  `).all(currentFundId) as any[];

  // [Fix#4] 如果组合只有1-2个基金，跳过板块检查（避免单基金永远被惩罚）
  if (allFunds.length <= 1) {
    return { totalExposure: 0, overExposed: false, reduction: 1.0 };
  }

  let sectorTotal = 0;
  let portfolioTotal = 0;
  for (const f of allFunds) {
    const val = f.shares * (f.market_nav || 0);
    portfolioTotal += val;
    if (inferSectorKeyword(f.name) === currentSector) {
      sectorTotal += val;
    }
  }

  // 加上当前基金的持仓
  const currentFund = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as shares
    FROM transactions WHERE fund_id = ?
  `).get(currentFundId) as any;
  const currentNav = db.prepare('SELECT market_nav FROM funds WHERE id = ?').get(currentFundId) as any;
  const currentVal = (currentFund?.shares || 0) * (currentNav?.market_nav || 0);
  sectorTotal += currentVal;
  portfolioTotal += currentVal;

  // 加上本次操作金额
  const newSectorTotal = sectorTotal + opAmount;
  const newPortfolioTotal = portfolioTotal + opAmount;

  const exposurePct = newPortfolioTotal > 0 ? (newSectorTotal / newPortfolioTotal) * 100 : 0;
  // 单板块超40%视为过度集中
  const overExposed = exposurePct > 40;
  const reduction = overExposed ? 0.5 : 1.0; // 过度集中时缩减50%

  return { totalExposure: Math.round(exposurePct * 10) / 10, overExposed, reduction };
}
