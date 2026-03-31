import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

// ============================================================
// Types
// ============================================================

interface NavPoint { date: string; nav: number; change?: number }

interface TechnicalIndicators {
  rsi14: number;          // RSI(14) 0-100
  macd: { dif: number; dea: number; histogram: number };
  bollingerBands: { upper: number; middle: number; lower: number; width: number; percentB: number };
  atr14: number;          // 14日平均真实波幅
  ma5: number; ma10: number; ma20: number; ma60: number;
  ema12: number; ema26: number;
  trend: 'strong_up' | 'up' | 'sideways' | 'down' | 'strong_down';
  trendScore: number;     // -100 ~ +100
  support: number;        // 支撑位
  resistance: number;     // 阻力位
  volumeMomentum: number; // 涨跌幅动量 -100~+100
}

interface RiskMetrics {
  maxDrawdown: number;       // 最大回撤 (%)
  maxDrawdownDays: number;   // 最大回撤持续天数
  currentDrawdown: number;   // 当前回撤 (%)
  volatility20d: number;     // 20日年化波动率 (%)
  sharpeRatio: number;       // 夏普比率（年化，无风险利率2%）
  var95: number;             // 95% VaR 日损失 (%)
  calmarRatio: number;       // 卡尔玛比率
  winRate: number;           // 日胜率 (%)
  profitLossRatio: number;   // 盈亏比
}

interface MarketIndex {
  name: string;
  code: string;
  price: number;
  changePct: number;
  trend: string;
}

interface SectorInfo {
  sector: string;
  sectorIndex: string;    // 对应板块指数代码
  marketIndices: MarketIndex[];
  marketRegime: 'bull' | 'bear' | 'shock';
  marketScore: number;    // -100 ~ +100
}

interface Signal {
  source: string;         // 信号来源
  type: 'buy' | 'sell' | 'hold';
  strength: number;       // -100 ~ +100
  reason: string;
}

interface PositionAdvice {
  kellyPct: number;           // Kelly 建议仓位占比 (%)
  suggestedAction: string;
  suggestedAmount: number;
  pyramidLevels: { nav: number; action: string; amount: number; reason: string }[];
  holdingDays: number;
  costEfficiency: number;     // 当前成本效率 (相对MA20)
}

interface StrategyResult {
  fund: { id: number; name: string; code: string; market_nav: number };
  position: {
    holdingShares: number; costNav: number; totalCost: number;
    marketValue: number; gain: number; gainPct: number;
  };
  technical: TechnicalIndicators;
  risk: RiskMetrics;
  market: SectorInfo;
  signals: Signal[];
  compositeScore: number;     // -100 ~ +100，<-30卖出，>30买入
  advice: PositionAdvice;
  summary: {
    verdict: string;
    verdictColor: string;
    oneLiner: string;
    keyPoints: string[];
  };
  navHistory: NavPoint[];
  timestamp: string;
}

// ============================================================
// 数据获取
// ============================================================

async function fetchNavHistory(code: string, days: number = 60): Promise<NavPoint[]> {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${days}&startDate=&endDate=`;
    const res = await fetch(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
    const data = await res.json() as any;
    if (data.Data?.LSJZList) {
      return data.Data.LSJZList.map((item: any) => ({
        date: item.FSRQ,
        nav: parseFloat(item.DWJZ),
        change: item.JZZZL ? parseFloat(item.JZZZL) : undefined,
      })).reverse();
    }
    return [];
  } catch { return []; }
}

async function fetchMarketIndex(secid: string): Promise<{ price: number; changePct: number } | null> {
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f170`;
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.data) {
      return {
        price: data.data.f43 / (data.data.f43 > 10000 ? 100 : 1), // 指数不需要除100
        changePct: data.data.f170 / 100,
      };
    }
    return null;
  } catch { return null; }
}

async function fetchIndexHistory(secid: string, days: number = 20): Promise<number[]> {
  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${days}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
    const res = await fetch(url);
    const data = await res.json() as any;
    if (data.data?.klines) {
      return data.data.klines.map((k: string) => parseFloat(k.split(',')[2])); // 收盘价
    }
    return [];
  } catch { return []; }
}

// ============================================================
// 技术指标计算
// ============================================================

function calcEMA(values: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  ema[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(values: number[], period: number = 14): number {
  if (values.length < period + 1) return 50;
  const changes = values.slice(1).map((v, i) => v - values[i]);
  const recent = changes.slice(-period);
  let avgGain = 0, avgLoss = 0;
  for (const c of recent) {
    if (c > 0) avgGain += c; else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(values: number[]): { dif: number; dea: number; histogram: number } {
  if (values.length < 26) return { dif: 0, dea: 0, histogram: 0 };
  const ema12 = calcEMA(values, 12);
  const ema26 = calcEMA(values, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif.slice(-9), 9); // 只用最近9个DIF算DEA
  const lastDif = dif[dif.length - 1];
  const lastDea = dea[dea.length - 1];
  return { dif: lastDif, dea: lastDea, histogram: 2 * (lastDif - lastDea) };
}

function calcBollinger(values: number[], period: number = 20, mult: number = 2) {
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const width = mean > 0 ? (upper - lower) / mean * 100 : 0;
  const current = values[values.length - 1];
  const percentB = (upper - lower) > 0 ? (current - lower) / (upper - lower) * 100 : 50;
  return { upper, middle: mean, lower, width, percentB };
}

function calcATR(navs: number[], period: number = 14): number {
  if (navs.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    trs.push(Math.abs(navs[i] - navs[i - 1])); // 基金只有收盘价，TR = |今收 - 昨收|
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function findSupportResistance(navs: number[]): { support: number; resistance: number } {
  if (navs.length < 5) return { support: navs[navs.length - 1] * 0.97, resistance: navs[navs.length - 1] * 1.03 };
  const recent = navs.slice(-20);
  // 支撑位 = 近20日最低点附近
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const current = recent[recent.length - 1];
  // 寻找局部低点作为支撑
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i] <= recent[i - 1] && recent[i] <= recent[i + 1]) lows.push(recent[i]);
    if (recent[i] >= recent[i - 1] && recent[i] >= recent[i + 1]) highs.push(recent[i]);
  }
  const support = lows.filter(l => l < current).length > 0
    ? Math.max(...lows.filter(l => l < current))
    : min;
  const resistance = highs.filter(h => h > current).length > 0
    ? Math.min(...highs.filter(h => h > current))
    : max;
  return { support: Math.round(support * 10000) / 10000, resistance: Math.round(resistance * 10000) / 10000 };
}

function calcTechnical(navs: number[]): TechnicalIndicators {
  const current = navs[navs.length - 1];
  const ma = (p: number) => {
    const s = navs.slice(-p);
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20), ma60 = navs.length >= 60 ? ma(60) : ma20;
  const ema12arr = calcEMA(navs, 12);
  const ema26arr = calcEMA(navs, 26);
  const rsi14 = calcRSI(navs, 14);
  const macd = calcMACD(navs);
  const bb = calcBollinger(navs);
  const atr14 = calcATR(navs);
  const { support, resistance } = findSupportResistance(navs);

  // 趋势评分
  let trendScore = 0;
  if (current > ma5) trendScore += 15; else trendScore -= 15;
  if (current > ma10) trendScore += 15; else trendScore -= 15;
  if (current > ma20) trendScore += 20; else trendScore -= 20;
  if (current > ma60) trendScore += 10; else trendScore -= 10;
  if (ma5 > ma10) trendScore += 10; else trendScore -= 10;
  if (ma10 > ma20) trendScore += 10; else trendScore -= 10;
  if (macd.histogram > 0) trendScore += 10; else trendScore -= 10;
  if (rsi14 > 50) trendScore += 5; else trendScore -= 5;
  if (rsi14 > 70) trendScore -= 10; // 超买扣分
  if (rsi14 < 30) trendScore += 10; // 超卖加分
  trendScore = Math.max(-100, Math.min(100, trendScore));

  const trend: TechnicalIndicators['trend'] =
    trendScore >= 50 ? 'strong_up' :
    trendScore >= 15 ? 'up' :
    trendScore <= -50 ? 'strong_down' :
    trendScore <= -15 ? 'down' : 'sideways';

  // 涨跌动量
  const changes = navs.slice(-10).map((v, i, arr) => i === 0 ? 0 : (v - arr[i - 1]) / arr[i - 1] * 100);
  const recentMomentum = changes.slice(1).reduce((a, b) => a + b, 0);
  const volumeMomentum = Math.max(-100, Math.min(100, recentMomentum * 10));

  return {
    rsi14: Math.round(rsi14 * 100) / 100,
    macd, bollingerBands: bb, atr14: Math.round(atr14 * 10000) / 10000,
    ma5: r4(ma5), ma10: r4(ma10), ma20: r4(ma20), ma60: r4(ma60),
    ema12: r4(ema12arr[ema12arr.length - 1]), ema26: r4(ema26arr[ema26arr.length - 1]),
    trend, trendScore, support, resistance,
    volumeMomentum: Math.round(volumeMomentum),
  };
}

// ============================================================
// 风险指标
// ============================================================

function calcRisk(navs: number[]): RiskMetrics {
  if (navs.length < 5) {
    return { maxDrawdown: 0, maxDrawdownDays: 0, currentDrawdown: 0, volatility20d: 0, sharpeRatio: 0, var95: 0, calmarRatio: 0, winRate: 50, profitLossRatio: 1 };
  }

  // 日收益率
  const returns = navs.slice(1).map((v, i) => (v - navs[i]) / navs[i] * 100);

  // 最大回撤
  let peak = navs[0], maxDD = 0, maxDDDays = 0, ddStart = 0;
  let currentDD = 0;
  for (let i = 0; i < navs.length; i++) {
    if (navs[i] > peak) { peak = navs[i]; ddStart = i; }
    const dd = (peak - navs[i]) / peak * 100;
    if (dd > maxDD) { maxDD = dd; maxDDDays = i - ddStart; }
    if (i === navs.length - 1) currentDD = dd;
  }

  // 20日年化波动率
  const recent20 = returns.slice(-20);
  const dailyStd = recent20.length > 1
    ? Math.sqrt(recent20.reduce((s, r) => s + (r - recent20.reduce((a, b) => a + b, 0) / recent20.length) ** 2, 0) / (recent20.length - 1))
    : 0;
  const volatility20d = dailyStd * Math.sqrt(250); // 年化

  // 夏普比率 (年化，无风险利率2%)
  const avgDailyReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const annualReturn = avgDailyReturn * 250;
  const sharpeRatio = dailyStd > 0 ? (annualReturn - 2) / volatility20d : 0;

  // 95% VaR (参数法)
  const var95 = avgDailyReturn - 1.645 * dailyStd;

  // 卡尔玛比率
  const calmarRatio = maxDD > 0 ? annualReturn / maxDD : 0;

  // 胜率和盈亏比
  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0);
  const winRate = returns.length > 0 ? (wins.length / returns.length) * 100 : 50;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 1;
  const profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

  return {
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownDays: maxDDDays,
    currentDrawdown: Math.round(currentDD * 100) / 100,
    volatility20d: Math.round(volatility20d * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    var95: Math.round(var95 * 100) / 100,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    winRate: Math.round(winRate * 10) / 10,
    profitLossRatio: Math.round(profitLossRatio * 100) / 100,
  };
}

// ============================================================
// 市场环境分析
// ============================================================

// 根据基金名称推断板块
function inferSector(name: string): { sector: string; indexCode: string } {
  const mapping: [RegExp, string, string][] = [
    [/有色|金属|矿/, '有色金属', '1.000819'],
    [/科技|芯片|半导体|信息|电子|通信|5G|AI|人工智能|计算机/, '科技', '1.000986'],
    [/医药|医疗|生物|健康|创新药/, '医药', '0.399989'],
    [/新能源|光伏|锂电|电池|碳中和|风电/, '新能源', '0.399808'],
    [/消费|白酒|食品|饮料|家电/, '消费', '0.399932'],
    [/金融|银行|证券|保险|券商/, '金融', '0.399986'],
    [/军工|国防|航天/, '军工', '0.399959'],
    [/地产|房地产|基建/, '地产', '1.000950'],
    [/红利|高股息|价值/, '红利价值', '1.000922'],
    [/创业板|成长/, '创业板', '0.399006'],
    [/沪深300|蓝筹/, '沪深300', '1.000300'],
    [/中证500|中小盘/, '中证500', '1.000905'],
    [/中证1000|小盘/, '中证1000', '1.000852'],
    [/纳斯达克|美国|标普|美股/, '美股', '0.100'],  // placeholder
    [/恒生|港股/, '港股', '0.100'],
    [/债|固收|理财/, '债券', '1.000012'],
  ];
  for (const [re, sector, code] of mapping) {
    if (re.test(name)) return { sector, indexCode: code };
  }
  return { sector: '综合', indexCode: '1.000300' }; // 默认沪深300
}

async function fetchMarketContext(fundName: string): Promise<SectorInfo> {
  const { sector, indexCode } = inferSector(fundName);

  const indices = [
    { name: '上证指数', secid: '1.000001' },
    { name: '深证成指', secid: '0.399001' },
    { name: '创业板指', secid: '0.399006' },
  ];

  const marketIndices: MarketIndex[] = [];
  for (const idx of indices) {
    const data = await fetchMarketIndex(idx.secid);
    if (data) {
      marketIndices.push({
        name: idx.name,
        code: idx.secid,
        price: data.price,
        changePct: data.changePct,
        trend: data.changePct > 0.5 ? '上涨' : data.changePct < -0.5 ? '下跌' : '震荡',
      });
    }
  }

  // 大盘趋势判断：获取上证指数近20日数据
  const shHistory = await fetchIndexHistory('1.000001', 20);
  let marketScore = 0;
  if (shHistory.length >= 10) {
    const shMa5 = shHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const shMa10 = shHistory.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const shMa20 = shHistory.reduce((a, b) => a + b, 0) / shHistory.length;
    const shCurrent = shHistory[shHistory.length - 1];
    if (shCurrent > shMa5) marketScore += 20;
    if (shCurrent > shMa10) marketScore += 20;
    if (shCurrent > shMa20) marketScore += 20;
    if (shMa5 > shMa10) marketScore += 15;
    if (shMa10 > shMa20) marketScore += 15;
    // 近5日涨跌
    const sh5dChange = (shCurrent - shHistory[Math.max(0, shHistory.length - 6)]) / shHistory[Math.max(0, shHistory.length - 6)] * 100;
    if (sh5dChange > 2) marketScore += 10;
    else if (sh5dChange < -2) marketScore -= 10;
    marketScore = Math.max(-100, Math.min(100, marketScore * 1.1 - 50)); // normalize
  }

  const marketRegime: SectorInfo['marketRegime'] =
    marketScore >= 20 ? 'bull' : marketScore <= -20 ? 'bear' : 'shock';

  return { sector, sectorIndex: indexCode, marketIndices, marketRegime, marketScore: Math.round(marketScore) };
}

// ============================================================
// 信号生成
// ============================================================

function generateSignals(
  tech: TechnicalIndicators, risk: RiskMetrics, market: SectorInfo,
  nav: number, costNav: number, gainPct: number,
  stopProfit: number, stopLoss: number
): Signal[] {
  const signals: Signal[] = [];
  const rsi = tech.rsi14;
  const bb = tech.bollingerBands;

  // — 技术面信号 —

  // RSI
  if (rsi >= 80) signals.push({ source: 'RSI', type: 'sell', strength: -80, reason: `RSI=${rsi.toFixed(0)}，严重超买，短期见顶概率高` });
  else if (rsi >= 70) signals.push({ source: 'RSI', type: 'sell', strength: -50, reason: `RSI=${rsi.toFixed(0)}，超买区域，注意回调` });
  else if (rsi <= 20) signals.push({ source: 'RSI', type: 'buy', strength: 80, reason: `RSI=${rsi.toFixed(0)}，严重超卖，反弹概率大` });
  else if (rsi <= 30) signals.push({ source: 'RSI', type: 'buy', strength: 50, reason: `RSI=${rsi.toFixed(0)}，超卖区域，可逐步布局` });

  // MACD
  if (tech.macd.histogram > 0 && tech.macd.dif > tech.macd.dea) {
    if (tech.macd.dif > 0) signals.push({ source: 'MACD', type: 'buy', strength: 40, reason: 'MACD金叉且在零轴上方，多头强势' });
    else signals.push({ source: 'MACD', type: 'hold', strength: 20, reason: 'MACD金叉但在零轴下方，反弹中，观察持续性' });
  } else if (tech.macd.histogram < 0 && tech.macd.dif < tech.macd.dea) {
    if (tech.macd.dif < 0) signals.push({ source: 'MACD', type: 'sell', strength: -40, reason: 'MACD死叉且在零轴下方，空头主导' });
    else signals.push({ source: 'MACD', type: 'hold', strength: -20, reason: 'MACD死叉但在零轴上方，上涨动能减弱' });
  }

  // 布林带
  if (bb.percentB >= 100) signals.push({ source: '布林带', type: 'sell', strength: -60, reason: `突破布林带上轨（%B=${bb.percentB.toFixed(0)}），超涨回归概率大` });
  else if (bb.percentB <= 0) signals.push({ source: '布林带', type: 'buy', strength: 60, reason: `跌破布林带下轨（%B=${bb.percentB.toFixed(0)}），超跌反弹概率大` });
  else if (bb.percentB <= 20) signals.push({ source: '布林带', type: 'buy', strength: 30, reason: `接近布林带下轨（%B=${bb.percentB.toFixed(0)}），低位区间` });
  else if (bb.percentB >= 80) signals.push({ source: '布林带', type: 'sell', strength: -30, reason: `接近布林带上轨（%B=${bb.percentB.toFixed(0)}），高位区间` });

  // 均线趋势
  if (tech.trend === 'strong_up') signals.push({ source: '均线', type: 'hold', strength: 50, reason: `均线多头排列（MA5>${tech.ma5.toFixed(4)}>MA10>MA20>MA60），强势上涨` });
  else if (tech.trend === 'strong_down') signals.push({ source: '均线', type: 'sell', strength: -50, reason: `均线空头排列，弱势下跌，避免抄底` });

  // 支撑阻力
  if (nav <= tech.support * 1.005) signals.push({ source: '支撑位', type: 'buy', strength: 35, reason: `接近支撑位 ${tech.support.toFixed(4)}，支撑有效可加仓` });
  if (nav >= tech.resistance * 0.995) signals.push({ source: '阻力位', type: 'sell', strength: -35, reason: `接近阻力位 ${tech.resistance.toFixed(4)}，突破前观望` });

  // — 风险面信号 —

  if (risk.currentDrawdown > 10) signals.push({ source: '回撤', type: 'buy', strength: 40, reason: `当前回撤 ${risk.currentDrawdown.toFixed(1)}%，历史最大 ${risk.maxDrawdown.toFixed(1)}%，价值区间` });
  if (risk.volatility20d > 30) signals.push({ source: '波动率', type: 'hold', strength: -20, reason: `年化波动率 ${risk.volatility20d.toFixed(0)}%，高波动环境需降低仓位` });
  if (risk.var95 < -2) signals.push({ source: 'VaR', type: 'hold', strength: -15, reason: `日VaR(95%) = ${risk.var95.toFixed(2)}%，单日极端损失风险较高` });

  // — 持仓面信号 —

  if (gainPct >= stopProfit * 1.5) signals.push({ source: '止盈', type: 'sell', strength: -90, reason: `收益 ${gainPct.toFixed(1)}% 远超止盈线 ${stopProfit}%，强烈建议止盈` });
  else if (gainPct >= stopProfit) signals.push({ source: '止盈', type: 'sell', strength: -70, reason: `收益 ${gainPct.toFixed(1)}% 达到止盈线 ${stopProfit}%，建议分批止盈` });
  if (gainPct <= -stopLoss * 1.5) signals.push({ source: '止损', type: 'sell', strength: -85, reason: `亏损 ${Math.abs(gainPct).toFixed(1)}% 远超止损线 ${stopLoss}%，建议果断止损` });
  else if (gainPct <= -stopLoss) signals.push({ source: '止损', type: 'sell', strength: -60, reason: `亏损 ${Math.abs(gainPct).toFixed(1)}% 触及止损线 ${stopLoss}%，评估是否止损` });

  // 成本位
  const costDev = costNav > 0 ? (nav - costNav) / costNav * 100 : 0;
  if (costDev < -8 && gainPct > -stopLoss) {
    signals.push({ source: '成本偏离', type: 'buy', strength: 45, reason: `净值低于成本 ${Math.abs(costDev).toFixed(1)}%，但未到止损线，可补仓摊低` });
  }

  // — 市场面信号 —

  if (market.marketRegime === 'bull') signals.push({ source: '大盘', type: 'hold', strength: 25, reason: `大盘偏多（评分 ${market.marketScore}），系统性风险低` });
  else if (market.marketRegime === 'bear') signals.push({ source: '大盘', type: 'hold', strength: -30, reason: `大盘偏空（评分 ${market.marketScore}），系统性风险高，控制仓位` });

  return signals;
}

// ============================================================
// 综合评分 & 操作建议
// ============================================================

function calcCompositeScore(signals: Signal[], tech: TechnicalIndicators, market: SectorInfo): number {
  // 加权平均，按信号类型分权重
  const weights: Record<string, number> = {
    '止盈': 3, '止损': 3, 'RSI': 2, 'MACD': 1.5, '布林带': 1.5,
    '均线': 1.5, '支撑位': 1, '阻力位': 1, '回撤': 1.5, '波动率': 1,
    'VaR': 0.5, '成本偏离': 1.5, '大盘': 1.5,
  };

  let weightedSum = 0, totalWeight = 0;
  for (const s of signals) {
    const w = weights[s.source] || 1;
    weightedSum += s.strength * w;
    totalWeight += Math.abs(s.strength) > 0 ? w : 0;
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  // 趋势加成
  score = score * 0.7 + tech.trendScore * 0.2 + market.marketScore * 0.1;
  return Math.max(-100, Math.min(100, Math.round(score)));
}

function generateAdvice(
  score: number, signals: Signal[], tech: TechnicalIndicators, risk: RiskMetrics,
  nav: number, costNav: number, totalCost: number, gainPct: number,
  holdingShares: number, stopProfit: number, stopLoss: number
): PositionAdvice {
  // Kelly Criterion: f* = (bp - q) / b
  // b = 盈亏比, p = 胜率, q = 1-p
  const p = risk.winRate / 100;
  const b = risk.profitLossRatio;
  const kellyPct = b > 0 ? Math.max(0, Math.min(50, ((b * p - (1 - p)) / b) * 100)) : 0;

  const baseAmount = Math.max(totalCost * 0.1, 500); // 至少500元
  const atrPct = nav > 0 ? (tech.atr14 / nav) * 100 : 1;

  let suggestedAction = '';
  let suggestedAmount = 0;

  if (score <= -50) {
    suggestedAction = '强烈建议卖出';
    suggestedAmount = Math.round(holdingShares * nav * 0.5);
  } else if (score <= -30) {
    suggestedAction = '建议减仓';
    suggestedAmount = Math.round(holdingShares * nav * 0.3);
  } else if (score <= -10) {
    suggestedAction = '谨慎持有，可小额减仓';
    suggestedAmount = Math.round(baseAmount * 0.3);
  } else if (score <= 10) {
    suggestedAction = '观望持有';
    suggestedAmount = 0;
  } else if (score <= 30) {
    suggestedAction = '持有，可小额加仓';
    suggestedAmount = Math.round(baseAmount * 0.5);
  } else if (score <= 50) {
    suggestedAction = '建议加仓';
    suggestedAmount = Math.round(baseAmount * (risk.volatility20d > 25 ? 0.7 : 1));
  } else {
    suggestedAction = '积极加仓';
    suggestedAmount = Math.round(baseAmount * 1.5);
  }

  // 持有天数
  const latestTx = db.prepare(
    "SELECT date FROM transactions WHERE fund_id IN (SELECT id FROM funds WHERE market_nav = ?) ORDER BY date DESC LIMIT 1"
  ).get(nav) as any;
  const holdingDays = latestTx
    ? Math.round((Date.now() - new Date(latestTx.date).getTime()) / 86400000)
    : 0;

  // 成本效率 = 当前成本相对MA20的偏差
  const costEfficiency = tech.ma20 > 0 ? ((tech.ma20 - costNav) / tech.ma20) * 100 : 0;

  // 金字塔加仓/减仓价位
  const pyramidLevels: PositionAdvice['pyramidLevels'] = [];
  if (nav > 0) {
    const step = Math.max(atrPct, 0.5); // 每档间隔至少0.5%
    // 加仓位（下方3档）
    for (let i = 1; i <= 3; i++) {
      const levelNav = r4(nav * (1 - i * step / 100));
      const amount = Math.round(baseAmount * (0.3 + i * 0.2)); // 越跌越多买
      pyramidLevels.push({
        nav: levelNav,
        action: `加仓第${i}档`,
        amount,
        reason: `跌${(i * step).toFixed(1)}%，${i === 1 ? '轻仓试探' : i === 2 ? '常规加仓' : '重仓补入'}`,
      });
    }
    // 减仓位（上方3档）
    for (let i = 1; i <= 3; i++) {
      const levelNav = r4(nav * (1 + i * step / 100));
      const shares = Math.round(holdingShares * (0.1 + i * 0.1) * 100) / 100;
      pyramidLevels.push({
        nav: levelNav,
        action: `减仓第${i}档`,
        amount: Math.round(shares * levelNav),
        reason: `涨${(i * step).toFixed(1)}%，${i === 1 ? '小额锁利' : i === 2 ? '常规止盈' : '大幅止盈'}`,
      });
    }
  }

  return { kellyPct: Math.round(kellyPct * 10) / 10, suggestedAction, suggestedAmount, pyramidLevels, holdingDays, costEfficiency: Math.round(costEfficiency * 100) / 100 };
}

function generateSummary(
  score: number, tech: TechnicalIndicators, risk: RiskMetrics, market: SectorInfo,
  gainPct: number, signals: Signal[]
): StrategyResult['summary'] {
  let verdict = '', verdictColor = '';
  if (score >= 40) { verdict = '积极看多'; verdictColor = 'text-emerald-600'; }
  else if (score >= 15) { verdict = '偏多持有'; verdictColor = 'text-green-600'; }
  else if (score >= -15) { verdict = '中性观望'; verdictColor = 'text-amber-600'; }
  else if (score >= -40) { verdict = '偏空谨慎'; verdictColor = 'text-orange-600'; }
  else { verdict = '建议离场'; verdictColor = 'text-red-600'; }

  // 一句话总结
  const trendText = tech.trend === 'strong_up' ? '强势上涨' : tech.trend === 'up' ? '温和上涨' :
    tech.trend === 'sideways' ? '横盘震荡' : tech.trend === 'down' ? '偏弱下行' : '加速下跌';
  const riskText = risk.volatility20d > 25 ? '高波动' : risk.volatility20d > 15 ? '中等波动' : '低波动';
  const marketText = market.marketRegime === 'bull' ? '大盘偏多' : market.marketRegime === 'bear' ? '大盘偏空' : '大盘震荡';

  const oneLiner = `${market.sector}板块 | ${trendText} | ${riskText}（年化${risk.volatility20d.toFixed(0)}%）| ${marketText} | RSI ${tech.rsi14.toFixed(0)}`;

  // 要点
  const keyPoints: string[] = [];
  // 取最重要的信号
  const sorted = [...signals].sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
  for (const s of sorted.slice(0, 4)) {
    keyPoints.push(`[${s.source}] ${s.reason}`);
  }

  if (gainPct > 0) keyPoints.push(`当前浮盈 ${gainPct.toFixed(2)}%，注意设好止盈位`);
  else if (gainPct < -5) keyPoints.push(`当前浮亏 ${Math.abs(gainPct).toFixed(2)}%，关注止损纪律`);

  if (risk.currentDrawdown > 5) keyPoints.push(`当前回撤 ${risk.currentDrawdown.toFixed(1)}%，耐心等待修复`);

  return { verdict, verdictColor, oneLiner, keyPoints: keyPoints.slice(0, 6) };
}

// ============================================================
// 工具函数
// ============================================================

function r4(n: number) { return Math.round(n * 10000) / 10000; }

// ============================================================
// API Endpoint
// ============================================================

router.get('/funds/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

  // 持仓计算
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
    FROM transactions WHERE fund_id = ?
  `).get(id) as any;

  const holdingShares = row.holding_shares;
  const totalCost = row.cost_basis;
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0;
  const mNav = fund.market_nav || 0;
  const marketValue = mNav > 0 ? holdingShares * mNav : totalCost;
  const gain = marketValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const stopProfit = fund.stop_profit_pct || 5;
  const stopLoss = fund.stop_loss_pct || 5;

  // 获取历史净值（60日）
  let navHistory: NavPoint[] = [];
  if (fund.code) navHistory = await fetchNavHistory(fund.code, 60);

  const navValues = navHistory.map(p => p.nav);
  const effectiveNav = navValues.length > 0 ? navValues[navValues.length - 1] : mNav;

  // 计算技术指标
  const technical = navValues.length >= 5 ? calcTechnical(navValues) : calcTechnical(effectiveNav > 0 ? [effectiveNav] : [1]);

  // 计算风险指标
  const riskMetrics = calcRisk(navValues);

  // 获取市场环境
  const market = await fetchMarketContext(fund.name);

  // 生成信号
  const signals = generateSignals(technical, riskMetrics, market, effectiveNav, costNav, gainPct, stopProfit, stopLoss);

  // 综合评分
  const compositeScore = calcCompositeScore(signals, technical, market);

  // 生成建议
  const advice = generateAdvice(compositeScore, signals, technical, riskMetrics, effectiveNav, costNav, totalCost, gainPct, holdingShares, stopProfit, stopLoss);

  // 生成总结
  const summary = generateSummary(compositeScore, technical, riskMetrics, market, gainPct, signals);

  const result: StrategyResult = {
    fund: { id: fund.id, name: fund.name, code: fund.code, market_nav: mNav },
    position: {
      holdingShares: r4(holdingShares), costNav: r4(costNav),
      totalCost: Math.round(totalCost * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      gainPct: Math.round(gainPct * 100) / 100,
    },
    technical, risk: riskMetrics, market, signals,
    compositeScore,
    advice,
    summary,
    navHistory: navHistory.slice(-30),
    timestamp: new Date().toISOString(),
  };

  res.json(result);
});

export default router;
