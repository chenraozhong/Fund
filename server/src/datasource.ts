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
  // 汇总评分 -100~+100
  flowScore: number;
  flowLabel: string;
}

/** 获取大盘主力资金近N日流向 */
async function fetchMarketMainFlow(days: number = 5): Promise<CapitalFlowData['market']> {
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=1.000001&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&lmt=${days}&klt=101&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    const klines = data?.data?.klines || [];
    // 格式: "日期,主力净流入,超大单,大单,中单,小单,主力净占比,...
    return klines.map((line: string) => {
      const parts = line.split(',');
      return {
        date: parts[0],
        mainNetInflow: parseFloat(parts[1]) || 0,
        superLargeIn: parseFloat(parts[2]) || 0,
        largeIn: parseFloat(parts[3]) || 0,
        mainPct: parseFloat(parts[6]) || 0,
      };
    });
  } catch { return []; }
}

/** 获取北向资金近N日净买入 */
async function fetchNorthboundFlow(days: number = 5): Promise<CapitalFlowData['northbound']> {
  try {
    const url = `https://push2his.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=${days}&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as any;
    // hk2sh[i] = "日期,买入,卖出,净买入"; hk2sz[i] = 同理
    const hk2sh = data?.data?.hk2sh || [];
    const hk2sz = data?.data?.hk2sz || [];
    const result: CapitalFlowData['northbound'] = [];
    for (let i = 0; i < Math.max(hk2sh.length, hk2sz.length); i++) {
      const shParts = (hk2sh[i] || '').split(',');
      const szParts = (hk2sz[i] || '').split(',');
      const date = shParts[0] || szParts[0] || '';
      // 净买入 = 买入 - 卖出（单位万元，转亿）
      const shNet = (parseFloat(shParts[1]) || 0) - (parseFloat(shParts[2]) || 0);
      const szNet = (parseFloat(szParts[1]) || 0) - (parseFloat(szParts[2]) || 0);
      result.push({ date, netBuy: Math.round((shNet + szNet) / 10000) / 10000 }); // 万元→亿元
    }
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

/** 获取板块资金流（当日） */
async function fetchSectorFlow(fundName: string): Promise<CapitalFlowData['sector']> {
  // 根据基金名推断板块
  let targetSector = '';
  for (const [re, name] of sectorFlowMapping) {
    if (re.test(fundName)) { targetSector = name; break; }
  }
  if (!targetSector) return null;

  try {
    // 获取全部板块资金流（按主力净流入排序）
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f12,f14,f62,f184,f66,f69,f72,f75,f78,f81&ut=b2884a393a59ad64002292a3e90d46a5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const list = data?.data?.diff || [];

    // 模糊匹配板块名
    const match = list.find((item: any) => item.f14 && item.f14.includes(targetSector));
    if (!match) return null;

    return {
      name: match.f14,
      mainNetInflow: Math.round((match.f62 || 0) / 1e8 * 100) / 100,  // 元→亿元
      mainPct: match.f184 || 0,
      superLargeIn: Math.round((match.f66 || 0) / 1e8 * 100) / 100,
    };
  } catch { return null; }
}

/** 综合获取资金流向数据并评分 */
export async function fetchCapitalFlow(fundName: string): Promise<CapitalFlowData> {
  const [market, northbound, sector] = await Promise.all([
    fetchMarketMainFlow(5),
    fetchNorthboundFlow(5),
    fetchSectorFlow(fundName),
  ]);

  // 资金流向评分
  let flowScore = 0;

  // 1. 大盘主力资金趋势（近5日）
  if (market.length >= 2) {
    const recentInflows = market.map(m => m.mainNetInflow);
    const avgInflow = recentInflows.reduce((a, b) => a + b, 0) / recentInflows.length;
    const latestInflow = recentInflows[recentInflows.length - 1] || 0;
    // 最新一天的主力净流入（亿元级别）
    const latestBillion = latestInflow / 1e8;
    if (latestBillion > 50) flowScore += 25;       // 大幅流入 >50亿
    else if (latestBillion > 10) flowScore += 15;   // 中度流入
    else if (latestBillion > 0) flowScore += 5;
    else if (latestBillion < -50) flowScore -= 25;  // 大幅流出
    else if (latestBillion < -10) flowScore -= 15;
    else if (latestBillion < 0) flowScore -= 5;

    // 连续流入/流出趋势
    const inflowDays = recentInflows.filter(v => v > 0).length;
    if (inflowDays >= 4) flowScore += 10;           // 连续流入
    else if (inflowDays <= 1) flowScore -= 10;      // 连续流出

    // 加速/减速
    const avgBillion = avgInflow / 1e8;
    if (latestBillion > avgBillion && latestBillion > 0) flowScore += 5; // 流入加速
    if (latestBillion < avgBillion && latestBillion < 0) flowScore -= 5; // 流出加速
  }

  // 2. 北向资金
  if (northbound.length >= 2) {
    const latestNB = northbound[northbound.length - 1]?.netBuy || 0;
    if (latestNB > 50) flowScore += 15;             // 北向大幅买入 >50亿
    else if (latestNB > 10) flowScore += 8;
    else if (latestNB < -50) flowScore -= 15;
    else if (latestNB < -10) flowScore -= 8;

    // 北向连续方向
    const nbDays = northbound.filter(n => n.netBuy > 0).length;
    if (nbDays >= 4) flowScore += 8;
    else if (nbDays <= 1) flowScore -= 8;
  }

  // 3. 板块资金流
  if (sector) {
    if (sector.mainNetInflow > 10) flowScore += 15; // 板块大幅流入
    else if (sector.mainNetInflow > 2) flowScore += 8;
    else if (sector.mainNetInflow < -10) flowScore -= 15;
    else if (sector.mainNetInflow < -2) flowScore -= 8;
  }

  flowScore = Math.max(-100, Math.min(100, flowScore));

  const flowLabel = flowScore >= 30 ? '资金大幅流入'
    : flowScore >= 10 ? '资金温和流入'
    : flowScore <= -30 ? '资金大幅流出'
    : flowScore <= -10 ? '资金温和流出'
    : '资金中性';

  return { market, northbound, sector, flowScore, flowLabel };
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
