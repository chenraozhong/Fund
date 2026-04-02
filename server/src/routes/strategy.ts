import { Router, Request, Response } from 'express';
import db from '../db';
import { fetchFundamental, fetchFundHoldings, fetchSectorNews, fetchRedeemFees, getRedeemFeeRate, inferSectorKeyword, scoreNewsSentiment, scoreFundamental, checkSectorExposure, fetchCapitalFlow } from '../datasource';
import type { CapitalFlowData } from '../datasource';

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

interface ShortTermPlan {
  triggers: { condition: string; action: string; amount: number; nav: number }[];
  stopLossNav: number;
  takeProfitNav: number;
  outlook: string;
}

interface LongTermPlan {
  monthlyBase: number;       // 基础月定投
  smartDCA: { condition: string; multiplier: number; amount: number }[];
  targetCostNav: number;     // 6个月后目标成本均价
  targetGainPct: number;     // 预期年化收益
  horizonMonths: number;
  outlook: string;
}

interface RecoveryPlan {
  isLosing: boolean;
  currentLoss: number;       // 当前亏损金额
  currentLossPct: number;
  breakevenNav: number;      // 不补仓时回本净值
  scenarios: {
    label: string;
    investAmount: number;    // 补仓金额
    newCostNav: number;      // 补仓后新成本
    newShares: number;
    breakevenChangePct: number; // 只需涨x%回本
    estimatedDays: number;   // 基于波动率估算回本天数
  }[];
  recommendation: string;
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
  compositeScore: number;
  advice: PositionAdvice;
  shortTermPlan: ShortTermPlan;
  longTermPlan: LongTermPlan;
  recoveryPlan: RecoveryPlan;
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
// 短线计划
// ============================================================

function generateShortTermPlan(
  nav: number, tech: TechnicalIndicators, risk: RiskMetrics,
  costNav: number, gainPct: number, totalCost: number,
  stopProfit: number, stopLoss: number
): ShortTermPlan {
  const atrPct = nav > 0 ? (tech.atr14 / nav) * 100 : 1;
  const base = Math.max(totalCost * 0.05, 300);
  const triggers: ShortTermPlan['triggers'] = [];

  // 下跌触发：分3档加仓
  const dip1 = r4(nav * (1 - atrPct / 100));
  const dip2 = r4(nav * (1 - atrPct * 2 / 100));
  const dip3 = r4(tech.support);
  triggers.push({ condition: `净值跌至 ${dip1}（-${atrPct.toFixed(1)}%）`, action: '轻仓买入', amount: Math.round(base * 0.5), nav: dip1 });
  triggers.push({ condition: `净值跌至 ${dip2}（-${(atrPct * 2).toFixed(1)}%）`, action: '常规买入', amount: Math.round(base), nav: dip2 });
  if (dip3 < dip2) triggers.push({ condition: `净值跌至支撑位 ${dip3}`, action: '重仓买入', amount: Math.round(base * 1.5), nav: dip3 });

  // 上涨触发
  const rise1 = r4(nav * (1 + atrPct / 100));
  const rise2 = r4(tech.resistance);
  if (gainPct > 0) {
    triggers.push({ condition: `净值涨至 ${rise1}（+${atrPct.toFixed(1)}%）`, action: '小额止盈', amount: Math.round(base * 0.3), nav: rise1 });
    if (gainPct >= stopProfit * 0.8) {
      triggers.push({ condition: `净值涨至阻力位 ${rise2}`, action: '大幅止盈', amount: Math.round(base * 2), nav: rise2 });
    }
  } else {
    triggers.push({ condition: `净值涨至成本位 ${r4(costNav)}`, action: '回本减仓（可选）', amount: Math.round(base * 0.5), nav: r4(costNav) });
  }

  // 止损/止盈位
  const stopLossNav = r4(costNav * (1 - stopLoss / 100));
  const takeProfitNav = r4(costNav * (1 + stopProfit / 100));

  // 短线展望
  let outlook = '';
  if (tech.trendScore >= 30) outlook = '短期趋势偏强，以持有为主，回调可加仓。';
  else if (tech.trendScore >= 0) outlook = '短期震荡偏多，轻仓参与，控制单次金额。';
  else if (tech.trendScore >= -30) outlook = '短期方向不明，观望为主，严格执行触发条件。';
  else outlook = '短期偏弱，不宜追涨，等待超跌信号再入场。';

  if (risk.volatility20d > 25) outlook += '波动率偏高，建议缩小每次操作金额至正常的60%。';

  return { triggers, stopLossNav, takeProfitNav, outlook };
}

// ============================================================
// 长线计划
// ============================================================

function generateLongTermPlan(
  nav: number, tech: TechnicalIndicators, risk: RiskMetrics,
  costNav: number, totalCost: number, holdingShares: number,
  gainPct: number, market: SectorInfo
): LongTermPlan {
  // 基础月定投金额：持仓的5-8%，最低500
  const monthlyBase = Math.max(Math.round(totalCost * 0.06 / 100) * 100, 500);

  // 智能定投条件
  const smartDCA: LongTermPlan['smartDCA'] = [];
  smartDCA.push({
    condition: `净值 < MA20（${tech.ma20.toFixed(4)}）`,
    multiplier: 1.5,
    amount: Math.round(monthlyBase * 1.5),
  });
  smartDCA.push({
    condition: `MA20 ≤ 净值 < MA10（${tech.ma10.toFixed(4)}）`,
    multiplier: 1.0,
    amount: monthlyBase,
  });
  smartDCA.push({
    condition: `净值 ≥ MA10`,
    multiplier: 0.5,
    amount: Math.round(monthlyBase * 0.5),
  });
  smartDCA.push({
    condition: `净值 < 布林下轨（${tech.bollingerBands.lower.toFixed(4)}）`,
    multiplier: 2.0,
    amount: Math.round(monthlyBase * 2),
  });

  // 6个月后目标成本
  // 假设平均定投在MA20附近，6个月后加权平均成本
  const avgInvestNav = tech.ma20 > 0 ? tech.ma20 : nav;
  const totalNewInvest = monthlyBase * 6;
  const newShares = avgInvestNav > 0 ? totalNewInvest / avgInvestNav : 0;
  const targetCostNav = (holdingShares + newShares) > 0
    ? r4((totalCost + totalNewInvest) / (holdingShares + newShares))
    : costNav;

  // 预期年化收益（基于历史日均收益率年化）
  const dailyAvg = risk.winRate > 50 ? risk.profitLossRatio * 0.001 : -0.001;
  const targetGainPct = Math.round(dailyAvg * 250 * 100) / 100;

  // 展望
  let outlook = '';
  if (market.marketRegime === 'bull') {
    outlook = `大盘偏多，${market.sector}板块有配置价值。建议维持定投节奏，可适当提高单次金额。`;
  } else if (market.marketRegime === 'bear') {
    outlook = `大盘偏弱，但正是低位收集筹码的好时机。坚持智能定投，低位多买高位少买，耐心等待周期反转。`;
  } else {
    outlook = `市场震荡期，适合网格化操作。按MA20上下浮动调整定投金额，积少成多降低成本。`;
  }

  if (gainPct < -10) {
    outlook += `当前浮亏较大，不宜急于止损。通过持续定投摊低成本是当前最优策略。`;
  }

  return { monthlyBase, smartDCA, targetCostNav, targetGainPct, horizonMonths: 6, outlook };
}

// ============================================================
// 亏损翻盈计划
// ============================================================

function generateRecoveryPlan(
  nav: number, costNav: number, totalCost: number,
  holdingShares: number, gainPct: number,
  risk: RiskMetrics, tech: TechnicalIndicators
): RecoveryPlan {
  const isLosing = gainPct < 0;
  const currentLoss = isLosing ? Math.round((totalCost - holdingShares * nav) * 100) / 100 : 0;
  const breakevenNav = costNav; // 不补仓时，净值需涨回成本均价

  if (!isLosing || nav <= 0 || costNav <= 0) {
    return {
      isLosing: false, currentLoss: 0, currentLossPct: 0,
      breakevenNav: costNav, scenarios: [],
      recommendation: gainPct >= 0 ? '当前持仓盈利中，无需翻盈计划。' : '',
    };
  }

  // 日均波动率（绝对值）
  const dailyVol = risk.volatility20d / Math.sqrt(250); // 日波动率 %
  const scenarios: RecoveryPlan['scenarios'] = [];

  // 生成3档补仓方案
  const ratios = [
    { label: '小额补仓（20%仓位）', ratio: 0.2 },
    { label: '中等补仓（50%仓位）', ratio: 0.5 },
    { label: '大额补仓（100%仓位）', ratio: 1.0 },
  ];

  for (const { label, ratio } of ratios) {
    const investAmount = Math.round(totalCost * ratio);
    const newShares = nav > 0 ? investAmount / nav : 0;
    const newTotalCost = totalCost + investAmount;
    const newTotalShares = holdingShares + newShares;
    const newCostNav = newTotalShares > 0 ? r4(newTotalCost / newTotalShares) : costNav;
    const breakevenChangePct = nav > 0 ? Math.round(((newCostNav - nav) / nav) * 10000) / 100 : 0;

    // 估算回本天数：E[days] = breakevenChangePct / dailyDrift
    // 保守估计日均涨幅 = 0（随机游走），用波动率估算
    // 简化：平均需 (changePct / dailyVol)^2 个交易日 (反射原理)
    let estimatedDays = 0;
    if (dailyVol > 0 && breakevenChangePct > 0) {
      estimatedDays = Math.round((breakevenChangePct / dailyVol) ** 2);
      estimatedDays = Math.min(estimatedDays, 365); // cap at 1 year
    }

    scenarios.push({
      label, investAmount, newCostNav,
      newShares: Math.round(newTotalShares * 100) / 100,
      breakevenChangePct, estimatedDays,
    });
  }

  // 推荐方案
  let recommendation = '';
  const lossPct = Math.abs(gainPct);

  if (lossPct <= 3) {
    recommendation = `浮亏仅${lossPct.toFixed(1)}%，接近回本。建议耐心持有等待净值回升，无需补仓。`;
  } else if (lossPct <= 8) {
    recommendation = `浮亏${lossPct.toFixed(1)}%，适合小额补仓（方案一）摊低成本。补仓后只需涨${scenarios[0].breakevenChangePct.toFixed(1)}%即可回本。`;
  } else if (lossPct <= 15) {
    recommendation = `浮亏${lossPct.toFixed(1)}%，建议中等补仓（方案二），将成本大幅拉低至${scenarios[1].newCostNav.toFixed(4)}。`;
    if (tech.trendScore < -30) recommendation += '但当前趋势偏弱，建议分3次在未来1-2周内逐步补入，不要一次性打满。';
    else recommendation += '当前技术面尚可，可择机一次性补入。';
  } else {
    recommendation = `浮亏${lossPct.toFixed(1)}%较深。`;
    if (tech.trendScore < -40) {
      recommendation += '趋势仍在恶化，暂不建议大额补仓。先小额补仓（方案一）观察，待趋势企稳（RSI>30且MACD金叉）再加码。';
    } else {
      recommendation += '底部信号初现，建议分批补仓：本周先投入方案一金额，若继续下跌再投入方案二。切忌一次All-in。';
    }
  }

  return {
    isLosing: true,
    currentLoss,
    currentLossPct: Math.round(lossPct * 100) / 100,
    breakevenNav,
    scenarios,
    recommendation,
  };
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
  // 支持 ?nav=xxx 实时净值覆盖
  const realtimeNav = req.query.nav ? parseFloat(req.query.nav as string) : 0;
  const mNav = realtimeNav > 0 ? realtimeNav : (fund.market_nav || 0);
  const marketValue = mNav > 0 ? holdingShares * mNav : totalCost;
  const gain = marketValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const stopProfit = fund.stop_profit_pct || 20;
  const stopLoss = fund.stop_loss_pct || 15;

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

  // 生成投资计划
  const shortTermPlan = generateShortTermPlan(effectiveNav, technical, riskMetrics, costNav, gainPct, totalCost, stopProfit, stopLoss);
  const longTermPlan = generateLongTermPlan(effectiveNav, technical, riskMetrics, costNav, totalCost, holdingShares, gainPct, market);
  const recoveryPlan = generateRecoveryPlan(effectiveNav, costNav, totalCost, holdingShares, gainPct, riskMetrics, technical);

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
    advice, shortTermPlan, longTermPlan, recoveryPlan,
    summary,
    navHistory: navHistory.slice(-30),
    timestamp: new Date().toISOString(),
  };

  res.json(result);
});

// ============================================================
// 实时配对交易建议
// ============================================================

router.get('/funds/:id/swing', async (req: Request, res: Response) => {
  const { id } = req.params;
  const realtimeNav = req.query.nav ? parseFloat(req.query.nav as string) : 0;

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

  const nav = realtimeNav > 0 ? realtimeNav : (fund.market_nav || 0);
  if (nav <= 0) { res.status(400).json({ error: '需要提供净值' }); return; }

  // 获取已配对的交易ID
  const pairedTxIds = new Set<number>();
  const trades = db.prepare('SELECT * FROM trades WHERE fund_id = ?').all(id) as any[];
  // 通过买卖日期+价格+份额匹配原始交易（trades表记录了配对关系）

  // 获取所有买入交易
  const allBuys = db.prepare(`
    SELECT * FROM transactions WHERE fund_id = ? AND type = 'buy' ORDER BY date ASC
  `).all(id) as any[];

  // 获取所有卖出交易
  const allSells = db.prepare(`
    SELECT * FROM transactions WHERE fund_id = ? AND type = 'sell' ORDER BY date ASC
  `).all(id) as any[];

  // === FIFO 配对：找出未配对的买入和卖出 ===

  // 未配对买入：总买入份额 - 总卖出份额 = 持仓，从最早的买入开始扣除已卖出份额
  let remainSold = allSells.reduce((s: number, t: any) => s + t.shares, 0);
  const unpairedBuys: { id: number; date: string; shares: number; price: number; remainShares: number; profitPct: number }[] = [];
  for (const buy of allBuys) {
    let remain = buy.shares;
    if (remainSold > 0) { const m = Math.min(remainSold, remain); remain -= m; remainSold -= m; }
    if (remain > 0.001) {
      unpairedBuys.push({
        id: buy.id, date: buy.date, shares: buy.shares, price: buy.price,
        remainShares: r4(remain),
        profitPct: buy.price > 0 ? Math.round(((nav - buy.price) / buy.price) * 10000) / 100 : 0,
      });
    }
  }

  // 未配对卖出：总卖出份额 - 总买入份额（从最早卖出扣除已买入回来的份额）
  // 逻辑：如果之前高价卖出过，后来又没买回等量份额，那就是未配对的卖出
  let remainBought = allBuys.reduce((s: number, t: any) => s + t.shares, 0);
  const unpairedSells: { id: number; date: string; shares: number; price: number; remainShares: number; spreadPct: number }[] = [];
  for (const sell of allSells) {
    let remain = sell.shares;
    if (remainBought > 0) { const m = Math.min(remainBought, remain); remain -= m; remainBought -= m; }
    if (remain > 0.001) {
      unpairedSells.push({
        id: sell.id, date: sell.date, shares: sell.shares, price: sell.price,
        remainShares: r4(remain),
        spreadPct: sell.price > 0 ? Math.round(((sell.price - nav) / nav) * 10000) / 100 : 0,
      });
    }
  }

  // 持仓总体信息
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
  const overallLosing = costNav > nav;

  // === 底仓 vs 活仓分离（FIFO：最早的份额为底仓，其余为活仓）===
  const basePositionPct = fund.base_position_pct ?? 30;
  const baseShares = r4(holdingShares * basePositionPct / 100);
  const swingShares = r4(holdingShares - baseShares);

  // FIFO 分离：前 baseShares 份为底仓，之后为活仓
  let baseRemain = baseShares;
  let baseCost = 0;
  type BuyEntry = typeof unpairedBuys[0] & { zone: 'base' | 'swing'; swingShares: number };
  const taggedBuys: BuyEntry[] = [];
  for (const buy of unpairedBuys) {
    if (baseRemain >= buy.remainShares - 0.001) {
      // 整笔归入底仓
      taggedBuys.push({ ...buy, zone: 'base', swingShares: 0 });
      baseCost += buy.remainShares * buy.price;
      baseRemain -= buy.remainShares;
    } else if (baseRemain > 0.001) {
      // 跨区：部分底仓 + 部分活仓
      const swPart = r4(buy.remainShares - baseRemain);
      taggedBuys.push({ ...buy, zone: 'swing', swingShares: swPart });
      baseCost += baseRemain * buy.price;
      baseRemain = 0;
    } else {
      // 全部归入活仓
      taggedBuys.push({ ...buy, zone: 'swing', swingShares: buy.remainShares });
    }
  }
  const baseCostNav = baseShares > 0 ? r4(baseCost / baseShares) : 0;

  // === 活仓卖出建议（只卖活仓，利润归入底仓降成本）===
  type Suggestion = {
    direction: 'sell' | 'buy';
    txId: number; date: string; refPrice: number; shares: number;
    opShares: number; keepShares: number;
    profit: number; action: string; reason: string;
  };
  const suggestions: Suggestion[] = [];

  // 按盈利率从高到低排序，优先卖利润最大的（贪心：最大化底仓降成本）
  const swingBuys = taggedBuys
    .filter(b => b.swingShares > 0.001 && b.profitPct > 0)
    .sort((a, b) => b.profitPct - a.profitPct);

  for (const buy of swingBuys) {
    const availShares = buy.swingShares;
    // 活仓盈利 → 积极卖出，利润越高越激进
    let sellRatio: number, reason: string;
    const profitPerShare = r4(nav - buy.price);
    const estProfit = r4(availShares * profitPerShare);
    const costDropEst = baseShares > 0 ? r4(estProfit / baseShares) : 0;

    if (buy.profitPct >= 5) {
      sellRatio = 1.0;
      reason = `活仓盈利+${buy.profitPct.toFixed(1)}%，全部卖出`;
    } else if (buy.profitPct >= 3) {
      sellRatio = 0.9;
      reason = `活仓盈利+${buy.profitPct.toFixed(1)}%，卖出90%锁利`;
    } else if (buy.profitPct >= 1) {
      sellRatio = 0.8;
      reason = `活仓盈利+${buy.profitPct.toFixed(1)}%，卖出80%赚差价`;
    } else {
      // 0~1% 微利，也积极卖出（积少成多降成本）
      sellRatio = 0.6;
      reason = `活仓微利+${buy.profitPct.toFixed(1)}%，卖出60%积累降成本`;
    }

    const opShares = r4(availShares * sellRatio);
    const keepShares = r4(availShares - opShares);
    const profit = Math.round(opShares * profitPerShare * 100) / 100;
    const actualCostDrop = baseShares > 0 ? r4(profit / baseShares) : 0;
    if (opShares > 0.001) {
      reason += `，底仓成本降${actualCostDrop.toFixed(4)}`;
      suggestions.push({
        direction: 'sell', txId: buy.id, date: buy.date, refPrice: buy.price,
        shares: availShares, opShares, keepShares, profit,
        action: sellRatio >= 1 ? '全部卖出' : `卖出${Math.round(sellRatio * 100)}%`,
        reason,
      });
    }
  }

  // === 买入建议（低价买回 → 扩充活仓，为下次卖出降成本做准备）===
  for (const sell of unpairedSells) {
    if (sell.spreadPct <= 0) continue;
    let buyRatio: number, reason: string;

    // 买回逻辑服务于降成本目标：
    // 低位买回 → 增加活仓 → 等涨后卖出 → 利润降低底仓成本
    if (sell.spreadPct >= 5) {
      buyRatio = 1.0;
      reason = `${sell.date}以${sell.price.toFixed(4)}卖出，现价低${sell.spreadPct.toFixed(1)}%，全部买回充入活仓`;
    } else if (sell.spreadPct >= 2) {
      buyRatio = 0.7;
      reason = `${sell.date}以${sell.price.toFixed(4)}卖出，现价低${sell.spreadPct.toFixed(1)}%，买回70%补充活仓`;
    } else {
      buyRatio = 0.5;
      reason = `${sell.date}以${sell.price.toFixed(4)}卖出，现价低${sell.spreadPct.toFixed(1)}%，买回50%补充活仓`;
    }

    const opShares = r4(sell.remainShares * buyRatio);
    const keepShares = r4(sell.remainShares - opShares);
    const profit = Math.round(opShares * (sell.price - nav) * 100) / 100;
    const investAmount = Math.round(opShares * nav * 100) / 100;
    // 买回后潜在降成本空间：等涨回卖出价时可赚的利润
    const potentialDrop = baseShares > 0 ? r4(profit / baseShares) : 0;
    if (opShares > 0.001) {
      reason += `，回涨后可降底仓成本${potentialDrop.toFixed(4)}`;
      suggestions.push({
        direction: 'buy', txId: sell.id, date: sell.date, refPrice: sell.price,
        shares: sell.remainShares, opShares, keepShares, profit,
        action: buyRatio >= 1 ? `全部买回（¥${investAmount}）` : `买回${Math.round(buyRatio * 100)}%（¥${investAmount}）`,
        reason,
      });
    }
  }

  // === 下跌补仓策略：净值低于成本时生成网格买入 + 回弹卖出降成本计划 ===
  type DipLevel = {
    level: number;           // 档位 1,2,3...
    nav: number;             // 买入净值
    dropPct: number;         // 相对当前净值跌幅 %
    amount: number;          // 建议买入金额
    shares: number;          // 买入份额
    newCostNav: number;      // 补仓后整体成本
    costReduction: number;   // 成本降低幅度
    reason: string;
    // 回弹预估：如果买入后涨回某价位卖出，可降底仓成本多少
    rebounds: { targetNav: number; targetLabel: string; sellProfit: number; baseCostDrop: number }[];
  };
  type DipStrategy = {
    enabled: boolean;
    currentLossPct: number;
    dropFromCost: number;     // 当前净值距成本跌幅 %
    levels: DipLevel[];
    totalPlan: { totalAmount: number; newCostNav: number; totalCostReduction: number };
    outlook: string;
  };

  let dipStrategy: DipStrategy = { enabled: false, currentLossPct: 0, dropFromCost: 0, levels: [], totalPlan: { totalAmount: 0, newCostNav: 0, totalCostReduction: 0 }, outlook: '' };

  if (nav < costNav && costNav > 0 && holdingShares > 0) {
    // 获取历史数据计算 ATR 和支撑位
    let atr = 0;
    let support = 0;
    let ma5 = nav, ma10 = nav, ma20 = nav;
    if (fund.code) {
      const navHistory = await fetchNavHistory(fund.code, 60);
      const navValues = navHistory.map(p => p.nav);
      if (navValues.length >= 5) {
        atr = calcATR(navValues);
        const sr = findSupportResistance(navValues);
        support = sr.support;
        const maCalc = (p: number) => { const s = navValues.slice(-p); return s.reduce((a, b) => a + b, 0) / s.length; };
        ma5 = maCalc(5); ma10 = maCalc(10); ma20 = navValues.length >= 20 ? maCalc(20) : maCalc(Math.min(navValues.length, 10));
      }
    }

    const lossPct = ((costNav - nav) / costNav) * 100;
    const atrPct = nav > 0 && atr > 0 ? (atr / nav) * 100 : 1;
    // 基础补仓金额：持仓市值的3-5%，最低300
    const baseAmount = Math.max(Math.round(holdingShares * nav * 0.04 / 100) * 100, 300);

    const levels: DipLevel[] = [];
    let cumShares = holdingShares;
    let cumCost = totalCost;

    // 回弹目标价位
    const reboundTargets = [
      { targetNav: r4(costNav), targetLabel: '成本价' },
      { targetNav: r4(costNav * 0.98), targetLabel: '成本-2%' },
      { targetNav: r4(nav * (1 + atrPct * 2 / 100)), targetLabel: `+${(atrPct * 2).toFixed(1)}%` },
    ];

    // 第0档：当前价位补仓
    const genLevel = (level: number, levelNav: number, dropPct: number, multiplier: number, reason: string) => {
      const amount = Math.round(baseAmount * multiplier / 100) * 100 || 300;
      const shares = levelNav > 0 ? r4(amount / levelNav) : 0;
      const newCumShares = cumShares + shares;
      const newCumCost = cumCost + amount;
      const newCostNav = newCumShares > 0 ? r4(newCumCost / newCumShares) : costNav;
      const costReduction = r4(costNav - newCostNav);

      // 回弹预估：买入这些份额后，涨到目标价卖出赚的利润可以降底仓成本
      const rebounds = reboundTargets
        .filter(t => t.targetNav > levelNav)
        .map(t => {
          const sellProfit = Math.round(shares * (t.targetNav - levelNav) * 100) / 100;
          const baseCostDropVal = baseShares > 0 ? r4(sellProfit / baseShares) : 0;
          return { targetNav: t.targetNav, targetLabel: t.targetLabel, sellProfit, baseCostDrop: baseCostDropVal };
        });

      const l: DipLevel = { level, nav: levelNav, dropPct, amount, shares, newCostNav, costReduction, reason, rebounds };
      cumShares = newCumShares;
      cumCost = newCumCost;
      return l;
    };

    // 档位1：当前价位
    levels.push(genLevel(1, nav, 0, 1, `当前净值已低于成本${lossPct.toFixed(1)}%，轻仓补入`));

    // 档位2：再跌1个ATR
    const nav2 = r4(nav * (1 - atrPct / 100));
    levels.push(genLevel(2, nav2, atrPct, 1.5, `再跌${atrPct.toFixed(1)}%至${nav2.toFixed(4)}，加大补仓`));

    // 档位3：再跌2个ATR
    const nav3 = r4(nav * (1 - atrPct * 2 / 100));
    levels.push(genLevel(3, nav3, atrPct * 2, 2, `跌${(atrPct * 2).toFixed(1)}%至${nav3.toFixed(4)}，重仓补入`));

    // 档位4：支撑位（如果比nav3更低）
    if (support > 0 && support < nav3 * 0.998) {
      const dropToSupport = ((nav - support) / nav) * 100;
      levels.push(genLevel(4, support, dropToSupport, 2.5, `跌至支撑位${support.toFixed(4)}（-${dropToSupport.toFixed(1)}%），关键位置重仓`));
    }

    // 档位5：MA20下方（如果MA20低于当前净值，说明均线在下方，可参考）
    if (ma20 > 0 && ma20 < nav * 0.995 && ma20 < (levels[levels.length - 1]?.nav ?? nav) * 0.998) {
      const dropToMa20 = ((nav - ma20) / nav) * 100;
      levels.push(genLevel(5, r4(ma20), dropToMa20, 2, `跌至MA20（${ma20.toFixed(4)}），均线支撑补仓`));
    }

    const totalAmount = levels.reduce((s, l) => s + l.amount, 0);
    const totalNewShares = levels.reduce((s, l) => s + l.shares, 0);
    const finalCostNav = (holdingShares + totalNewShares) > 0 ? r4((totalCost + totalAmount) / (holdingShares + totalNewShares)) : costNav;

    // 展望
    let outlook = '';
    if (lossPct <= 3) {
      outlook = `浮亏${lossPct.toFixed(1)}%，接近回本。小额补仓即可有效降低成本，等待净值回升。`;
    } else if (lossPct <= 8) {
      outlook = `浮亏${lossPct.toFixed(1)}%，建议按网格分档补仓。每档买入后归入活仓，回弹即卖出锁利，利润持续降低底仓成本。`;
    } else {
      outlook = `浮亏${lossPct.toFixed(1)}%较深，需耐心分批布局。严格按档位执行，不要一次性投入。每次回弹卖出活仓利润都在蚕食底仓成本。`;
    }

    dipStrategy = {
      enabled: true,
      currentLossPct: Math.round(lossPct * 100) / 100,
      dropFromCost: Math.round(lossPct * 100) / 100,
      levels,
      totalPlan: { totalAmount, newCostNav: finalCostNav, totalCostReduction: r4(costNav - finalCostNav) },
      outlook,
    };
  }

  // === 计算执行后的影响 ===
  const sellSugs = suggestions.filter(s => s.direction === 'sell');
  const buySugs = suggestions.filter(s => s.direction === 'buy');
  const totalSellShares = sellSugs.reduce((s, t) => s + t.opShares, 0);
  const totalBuyShares = buySugs.reduce((s, t) => s + t.opShares, 0);
  const totalSellProfit = sellSugs.reduce((s, t) => s + t.profit, 0);
  const totalBuyProfit = buySugs.reduce((s, t) => s + t.profit, 0);
  const totalProfit = totalSellProfit + totalBuyProfit;

  const newHoldingShares = holdingShares - totalSellShares + totalBuyShares;
  const sellCostReduction = sellSugs.reduce((s, t) => s + t.opShares * t.refPrice, 0);
  const buyCostAddition = totalBuyShares * nav;
  const newTotalCost = totalCost - sellCostReduction + buyCostAddition;
  const newCostNav = newHoldingShares > 0 ? newTotalCost / newHoldingShares : 0;

  // 底仓有效成本 = (底仓原始成本 - 波段卖出利润) / 底仓份额
  // 波段利润直接补贴底仓，持续降低底仓持有成本
  const newBaseCost = baseCost - totalSellProfit;
  const newBaseCostNav = baseShares > 0 ? r4(newBaseCost / baseShares) : 0;
  const baseCostDrop = r4(baseCostNav - newBaseCostNav);

  res.json({
    nav,
    costNav: r4(costNav),
    holdingShares: r4(holdingShares),
    basePosition: {
      pct: basePositionPct,
      shares: baseShares,
      maxSellable: swingShares,
      baseCostNav,
      newBaseCostNav,
      baseCostDrop,
    },
    unpairedBuys,
    unpairedSells,
    suggestions,
    dipStrategy,
    impact: {
      totalProfit: Math.round(totalProfit * 100) / 100,
      sellProfit: Math.round(totalSellProfit * 100) / 100,
      buyProfit: Math.round(totalBuyProfit * 100) / 100,
      totalSellShares: r4(totalSellShares),
      totalBuyShares: r4(totalBuyShares),
      newHoldingShares: r4(newHoldingShares),
      newCostNav: r4(newCostNav),
      costReduction: r4(costNav - newCostNav),
    },
  });
});

// ============================================================
// 统一决策引擎：完整循环降成本模型
//
// 核心数学：
//   只卖不买 → costNav 不变（份额和成本等比减少）
//   真正降成本 = 高卖 + 低买回 = 一个完整循环
//   循环降成本 = opShares × (sellNav - buyNav) / holdingShares
//
// 所以每次操作都附带"闭环计划"：
//   卖出 → 预设买回价和份额 → 算循环完成后的成本降幅
//   买入 → 预设卖出价和份额 → 算循环完成后的成本降幅
// ============================================================

// 完整决策引擎核心函数（单基金）
async function computeDecision(fundId: number | string, realtimeNav: number): Promise<any> {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
  if (!fund) throw new Error('基金不存在');

  const nav = realtimeNav > 0 ? realtimeNav : (fund.market_nav || 0);
  if (nav <= 0) throw new Error('需要提供净值');

  // === 1. 持仓数据 ===
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
    FROM transactions WHERE fund_id = ?
  `).get(fundId) as any;

  const holdingShares = row.holding_shares;
  const totalCost = row.cost_basis;
  // [Fix#3] costNav<=0 时视为0（已回本或无持仓），避免gainPct符号反转
  const costNav = holdingShares > 0 && totalCost > 0 ? totalCost / holdingShares : 0;
  const gainPct = costNav > 0 ? ((nav - costNav) / costNav) * 100 : 0;
  const stopProfit = fund.stop_profit_pct || 20;
  const stopLoss = fund.stop_loss_pct || 15;

  const basePositionPct = fund.base_position_pct ?? 30;
  const baseShares = r4(holdingShares * basePositionPct / 100);
  const swingShares = r4(holdingShares - baseShares);
  const marketValue = holdingShares * nav;

  // 底仓因子：底仓占比高→活仓少→需要更积极买入补充活仓弹药
  const baseFactor = basePositionPct >= 60 ? 1.5
    : basePositionPct >= 40 ? 1.2
    : basePositionPct >= 20 ? 1.0
    : 0.8;
  // 卖出谨慎因子：底仓占比高→活仓少→每次卖出比例缩小
  const sellCaution = basePositionPct <= 30 ? 1.0
    : basePositionPct <= 50 ? 0.8
    : basePositionPct <= 70 ? 0.6
    : 0.4;

  // === 2. 并行获取：技术面 + 基本面 + 消息面 + 资金流向 ===
  let navHistory: NavPoint[] = [];
  let fundamental = null;
  let holdings = null;
  let redeemFeeLevels: { minDays: number; maxDays: number; feeRate: number; label: string }[] = [];
  let news: { title: string; date: string; source: string; url: string }[] = [];
  const _cf: { v: CapitalFlowData | null } = { v: null };

  const sectorKeyword = inferSectorKeyword(fund.name);
  const promises: Promise<void>[] = [];
  if (fund.code) {
    promises.push(fetchNavHistory(fund.code, 60).then(h => { navHistory = h; }));
    promises.push(fetchFundamental(fund.code).then(f => { fundamental = f; }));
    promises.push(fetchFundHoldings(fund.code).then(h => { holdings = h; }));
    promises.push(fetchRedeemFees(fund.code).then(f => { redeemFeeLevels = f; }));
  }
  promises.push(fetchSectorNews(sectorKeyword, 8).then(n => { news = n; }));
  await Promise.all(promises);
  // 重仓股数据就绪后再获取资金流向（需要传入holdings列表）
  const capitalFlow = await fetchCapitalFlow(fund.name, (holdings as any)?.holdings);

  const navValues = navHistory.map(p => p.nav);
  const effectiveNav = navValues.length > 0 ? navValues[navValues.length - 1] : nav;

  // === 3. 四维评分（新增资金流向维度） ===
  const technical = navValues.length >= 5 ? calcTechnical(navValues) : calcTechnical(effectiveNav > 0 ? [effectiveNav] : [1]);
  const riskMetrics = calcRisk(navValues);
  const market = await fetchMarketContext(fund.name);
  const signals = generateSignals(technical, riskMetrics, market, nav, costNav, gainPct, stopProfit, stopLoss);
  const techScore = calcCompositeScore(signals, technical, market);
  const fundScore = fundamental ? scoreFundamental(fundamental) : { score: 0, highlights: ['无基金代码，跳过基本面'] };
  const newsScore = scoreNewsSentiment(news);
  const flowScore = capitalFlow?.flowScore ?? 0;
  // 四维综合评分：技术50% + 基本面15% + 消息面15% + 资金流向20%
  const compositeScore = Math.round(techScore * 0.5 + fundScore.score * 0.15 + newsScore.score * 0.15 + flowScore * 0.2);

  // ================================================================
  // 投资大师策略融合 (v2 - 四方辩论优化版)
  //
  // Buffett/Graham : 恐惧时贪婪，安全边际越大买越多（价值平均）
  // Livermore/O'Neil: 顺趋势操作，上升趋势中回调买入最强
  // Soros/Druckenmiller: 高确信重仓，低确信轻仓，错了快跑
  // Howard Marks   : 识别周期位置，底部区域积极，顶部区域谨慎
  // 彼得林奇       : 了解你买的东西，基本面好的跌了就是机会
  //
  // v2 修正（来自四方辩论）：
  //  [量化] 恐惧贪婪回撤用sqrt非线性，防止单因子锁死
  //  [多头] capitulation放宽至drawdown>10&&RSI<35
  //  [熊派] 单次金额上限15%市值，distribution卖60%
  //  [场景] 动态止盈=max(ATR*3, 8%)，网格阶梯卖出
  //  [量化] 价值平均改分段函数，中度区间放大更显著
  //  [量化] 买入闭环卖出目标改ATR阶梯，不锚定costNav
  //  [量化] conviction增加中间档1.3
  // ================================================================

  const atrPct = nav > 0 && technical.atr14 > 0 ? (technical.atr14 / nav) * 100 : 1;

  // === A. 恐惧/贪婪指数 (Buffett) ===
  // [量化修正] 回撤用 sqrt 非线性化，防止单因子主导
  let fearGreed = 50;
  fearGreed += (technical.rsi14 - 50) * 0.4;                                    // RSI 30→-8, 70→+8
  fearGreed -= Math.sqrt(Math.max(riskMetrics.currentDrawdown, 0)) * 4;         // 回撤10%→-12.6, 20%→-17.9（非线性）
  fearGreed -= Math.max(0, riskMetrics.volatility20d - 15) * 0.3;
  fearGreed += newsScore.score * 0.15;
  fearGreed += technical.trendScore * 0.12;
  fearGreed += flowScore * 0.12;                                                // 资金流入→贪婪，流出→恐惧
  fearGreed = Math.max(0, Math.min(100, Math.round(fearGreed)));

  // [多头修正] contrarian 上限提升到 2.5
  const contrarian = fearGreed < 25 ? 1.5 + (25 - fearGreed) / 25 * 1.0        // 最高2.5
                   : fearGreed > 75 ? 1.5 + (fearGreed - 75) / 25 * 1.0
                   : 1.0;

  // === B. 周期定位 (Howard Marks) ===
  type CyclePhase = 'capitulation' | 'early_recovery' | 'recovery' | 'expansion' | 'euphoria' | 'distribution' | 'decline';
  let cyclePhase: CyclePhase = 'recovery';

  // [多头修正] capitulation 放宽：drawdown>10且RSI<35（原15+30太严）
  if (riskMetrics.currentDrawdown > 10 && technical.rsi14 < 35) {
    cyclePhase = 'capitulation';
  // [多头修正] early_recovery: MACD histogram 收窄（>前一个值）也算，不必>0
  } else if (riskMetrics.currentDrawdown > 6 && technical.rsi14 < 45 && technical.macd.histogram > technical.macd.dea * -0.5) {
    cyclePhase = 'early_recovery';
  } else if (technical.trend === 'up' && technical.rsi14 >= 40 && technical.rsi14 <= 60) {
    cyclePhase = 'recovery';
  } else if (technical.trend === 'strong_up' && technical.rsi14 > 60) {
    cyclePhase = 'expansion';
  // [熊派修正] euphoria 放宽：RSI>70或%B>85（原75+90太难触发）
  } else if (technical.rsi14 > 70 || (technical.rsi14 > 65 && technical.bollingerBands.percentB > 85)) {
    cyclePhase = 'euphoria';
  } else if (technical.trend === 'sideways' && technical.macd.histogram < 0 && technical.rsi14 > 45) {
    cyclePhase = 'distribution';
  } else if (technical.trend === 'down' || technical.trend === 'strong_down') {
    // [Fix#5] 兜底分支加RSI过滤，避免普通回调被误判为capitulation
    cyclePhase = (riskMetrics.currentDrawdown > 12 && technical.rsi14 < 40) ? 'capitulation' : 'decline';
  }

  const cycleMultiplier: Record<CyclePhase, number> = {
    capitulation: 2.0, early_recovery: 1.8, recovery: 1.2,
    expansion: 0.8, euphoria: 0.5, distribution: 0.7, decline: 1.0,
  };

  // === C. 信念乘数 (Soros/Druckenmiller) ===
  // [v3修正] 四维共振：技术 + 基本面 + 消息面 + 资金流向
  const dimSigns = [techScore > 10 ? 1 : techScore < -10 ? -1 : 0,
                    fundScore.score > 10 ? 1 : fundScore.score < -10 ? -1 : 0,
                    newsScore.score > 15 ? 1 : newsScore.score < -15 ? -1 : 0,
                    flowScore > 15 ? 1 : flowScore < -15 ? -1 : 0];
  const bullDims = dimSigns.filter(s => s > 0).length;
  const bearDims = dimSigns.filter(s => s < 0).length;
  const neutralDims = dimSigns.filter(s => s === 0).length;
  const allBull = dimSigns.every(s => s >= 0) && bullDims >= 3;    // 4维中至少3维看多
  const allBear = dimSigns.every(s => s <= 0) && bearDims >= 3;    // 4维中至少3维看空
  const singleStrong = dimSigns.filter(s => s !== 0).length === 1;
  // conviction 区分方向：allBull→放大买入, allBear→放大卖出但缩小买入
  const buyConviction = allBull ? 1.8 : bullDims >= 3 ? 1.5 : allBear ? 0.4 : bearDims >= 3 ? 0.6
    : singleStrong ? 1.2 : neutralDims >= 3 ? 0.7 : 1.0;
  const sellConviction = allBear ? 1.8 : bearDims >= 3 ? 1.5 : allBull ? 0.4 : bullDims >= 3 ? 0.6
    : singleStrong ? 1.2 : neutralDims >= 3 ? 0.7 : 1.0;
  const conviction = Math.max(buyConviction, sellConviction); // 用于显示

  // === D. 价值平均 (Graham) ===
  // [量化修正] 改分段函数，中度亏损区间放大更显著
  const lossPctAbs = costNav > 0 ? Math.abs((nav - costNav) / costNav * 100) : 0;
  let valueMultiplier = 1.0;
  if (nav < costNav && costNav > 0) {
    // 分段：亏5%→1.3x, 亏10%→1.6x, 亏20%→2.2x, 亏30%→2.8x, cap 4.0
    if (lossPctAbs <= 5)       valueMultiplier = 1.0 + lossPctAbs * 0.06;      // 0→1.0, 5→1.3
    else if (lossPctAbs <= 15) valueMultiplier = 1.3 + (lossPctAbs - 5) * 0.06; // 5→1.3, 15→1.9
    else if (lossPctAbs <= 30) valueMultiplier = 1.9 + (lossPctAbs - 15) * 0.06; // 15→1.9, 30→2.8
    else                       valueMultiplier = 2.8 + (lossPctAbs - 30) * 0.04; // 30→2.8, 55→3.8
    valueMultiplier = Math.min(valueMultiplier, 4.0);
  } else if (nav > costNav && costNav > 0) {
    const profitAbs = (nav - costNav) / costNav * 100;
    valueMultiplier = Math.min(1.0 + profitAbs * 0.04, 2.5);   // 盈利越多卖出越大
  }

  // === E. 基础金额 ===
  const rawBase = Math.max(Math.round(totalCost * 0.08 / 100) * 100, 500);
  const maxSingleAmount = Math.round(Math.max(totalCost, marketValue) * 0.15);

  // === E2. 交易费用模型（自动获取真实费率）===
  const FEE_SUBSCRIBE = 0.0015;   // 申购费0.15%（天天基金打折价）
  const MIN_CYCLE_PROFIT_PCT = 1.0; // 扣费后最低循环利润率1%

  // === E3. 持仓时间分析 ===
  const recentBuy = db.prepare(
    "SELECT date FROM transactions WHERE fund_id = ? AND type = 'buy' ORDER BY date DESC LIMIT 1"
  ).get(fundId) as any;
  const firstTx = db.prepare(
    "SELECT date FROM transactions WHERE fund_id = ? ORDER BY date ASC LIMIT 1"
  ).get(fundId) as any;
  const daysSinceLastBuy = recentBuy
    ? Math.round((Date.now() - new Date(recentBuy.date).getTime()) / 86400000)
    : 999;
  const daysSinceFirstTx = firstTx
    ? Math.round((Date.now() - new Date(firstTx.date).getTime()) / 86400000)
    : 0;
  const txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE fund_id = ?").get(fundId) as any)?.c || 0;
  // 从真实费率阶梯查询当前赎回费率
  const redeemFeeRate = redeemFeeLevels.length > 0
    ? getRedeemFeeRate(redeemFeeLevels, daysSinceLastBuy)
    : (daysSinceLastBuy < 7 ? 0.015 : daysSinceLastBuy < 30 ? 0.0075 : 0.005); // fallback
  // 闭环买回的预估赎回费率（假设持有30天后卖出）
  const FEE_REDEEM_CYCLE = redeemFeeLevels.length > 0
    ? getRedeemFeeRate(redeemFeeLevels, 30) : 0.005;

  // === E4. 总亏损熔断 [巴菲特+达利欧修正] ===
  const totalLossPct = totalCost > 0 ? Math.max(0, (totalCost - marketValue) / totalCost * 100) : 0;
  let circuitBreaker = false;
  if (totalLossPct > 25) {
    circuitBreaker = true; // 总亏损超25%，暂停所有买入
  }

  // === F. 动态止盈线 ===
  const dynamicTakeProfit = Math.min(Math.max(atrPct * 3, 8), stopProfit);

  // === G. 综合决策 ===
  let action: 'buy' | 'sell' | 'hold' = 'hold';
  let opShares = 0;
  let opAmount = 0;
  let confidence = 50;
  let urgency: 'high' | 'medium' | 'low' = 'medium';
  const reasoning: string[] = [];

  const cycleLabel: Record<CyclePhase, string> = {
    capitulation: '恐慌探底', early_recovery: '早期复苏', recovery: '稳步回升',
    expansion: '加速上涨', euphoria: '过热狂热', distribution: '高位派发', decline: '下行调整',
  };
  // 持仓状态总结
  const positionDesc = holdingShares > 0
    ? `持仓${holdingShares.toFixed(0)}份（底仓${baseShares.toFixed(0)}+活仓${swingShares.toFixed(0)}），建仓${daysSinceFirstTx}天，共${txCount}笔交易`
    : '空仓';
  const holdTimeDesc = daysSinceLastBuy < 7 ? `最近买入仅${daysSinceLastBuy}天（赎回惩罚期，费率${(redeemFeeRate * 100).toFixed(2)}%）`
    : daysSinceLastBuy < 30 ? `最近买入${daysSinceLastBuy}天（赎回费${(redeemFeeRate * 100).toFixed(2)}%）`
    : daysSinceLastBuy < 365 ? `最近买入${daysSinceLastBuy}天（赎回费${(redeemFeeRate * 100).toFixed(2)}%）`
    : daysSinceLastBuy < 730 ? `最近买入${daysSinceLastBuy}天（赎回费${(redeemFeeRate * 100).toFixed(2)}%，接近免费）`
    : `最近买入${daysSinceLastBuy}天（已免赎回费）`;
  const costDesc = costNav > 0 ? `成本${costNav.toFixed(4)}，当前净值${nav.toFixed(4)}，${gainPct >= 0 ? '盈利' : '亏损'}${Math.abs(gainPct).toFixed(2)}%` : '';

  reasoning.push(`[持仓] ${positionDesc}，${holdTimeDesc}`);
  if (costDesc) reasoning.push(`[成本] ${costDesc}，底仓因子${baseFactor}x（${basePositionPct}%底仓→${baseFactor > 1 ? '活仓少需补充' : baseFactor < 1 ? '活仓充足' : '标准'}），卖出谨慎度${sellCaution}x`);
  reasoning.push(`[环境] 周期：${cycleLabel[cyclePhase]} | 恐惧贪婪：${fearGreed}（${fearGreed < 30 ? '恐惧=买入机会' : fearGreed > 70 ? '贪婪=卖出信号' : '中性观望'}）| 信念：${conviction >= 1.5 ? `四维共振(${bullDims}多${bearDims}空)→重仓` : conviction < 0.8 ? `信号分歧(${neutralDims}中性)→轻仓` : '一般'}`);

  if (nav > costNav && costNav > 0) {
    // -------- 盈利状态 --------
    const profitPct = gainPct;
    const bf = baseFactor;

    if (cyclePhase === 'euphoria' && swingShares > 0) {
      action = 'sell';
      opShares = r4(swingShares * 0.85 * Math.min(contrarian, 2.0) * sellCaution);
      confidence = 85; urgency = 'high';
      reasoning.push(`[Marks] 周期过热（RSI ${technical.rsi14.toFixed(0)}），减仓${Math.round(85 * sellCaution)}%活仓（底仓${basePositionPct}%）`);

    } else if (profitPct >= stopProfit && swingShares > 0) {
      action = 'sell';
      const ratio = (profitPct >= stopProfit * 1.5 ? 0.9 : 0.7) * sellCaution;
      opShares = r4(swingShares * ratio);
      confidence = 80; urgency = 'high';
      reasoning.push(`盈利${profitPct.toFixed(1)}%达止盈线${stopProfit}%，止盈${Math.round(ratio * 100)}%活仓`);

    } else if (profitPct >= dynamicTakeProfit && swingShares > 0) {
      action = 'sell';
      const overPct = profitPct - dynamicTakeProfit;
      const ratio = Math.min(0.3 + Math.floor(overPct / 5) * 0.2, 0.8) * sellCaution;
      opShares = r4(swingShares * ratio);
      confidence = 70; urgency = 'medium';
      reasoning.push(`[动态止盈] 盈利${profitPct.toFixed(1)}%达动态线${dynamicTakeProfit.toFixed(1)}%，阶梯卖${Math.round(ratio * 100)}%活仓`);

    } else if (profitPct >= 3 && swingShares > 0 && (compositeScore <= 10 || cyclePhase === 'distribution')) {
      action = 'sell';
      const baseRatio = cyclePhase === 'distribution' ? 0.6 : Math.min(0.1 + Math.floor(profitPct / 3) * 0.1, 0.5);
      const ratio = baseRatio * sellCaution;
      opShares = r4(swingShares * ratio);
      confidence = 60; urgency = cyclePhase === 'distribution' ? 'high' : 'low';
      reasoning.push(`[网格止盈] 浮盈${profitPct.toFixed(1)}%${cyclePhase === 'distribution' ? '+ 派发期' : ''}，卖${Math.round(ratio * 100)}%活仓（底仓${basePositionPct}%）`);

    } else if (compositeScore <= -10 && profitPct >= 1 && swingShares > 0) {
      action = 'sell'; opShares = r4(swingShares * 0.4 * sellConviction * sellCaution);
      confidence = 65; urgency = 'medium';
      reasoning.push(`[Soros] 信号转空（${compositeScore}分），快速锁利`);

    } else if (cyclePhase === 'recovery' || cyclePhase === 'expansion') {
      if (technical.bollingerBands.percentB < 40 && compositeScore > 0) {
        action = 'buy';
        // 底仓高→活仓少→更积极补充活仓
        opAmount = Math.round(rawBase * 1.0 * buyConviction * bf);
        opShares = r4(opAmount / nav);
        confidence = 65; urgency = 'medium';
        reasoning.push(`[Livermore] 上升趋势回调（%B=${technical.bollingerBands.percentB.toFixed(0)}），加活仓${bf !== 1 ? `(底仓${basePositionPct}%→${bf}x)` : ''}`);
      } else {
        action = 'hold'; confidence = 55;
        reasoning.push(`上升趋势中持有，等回调到布林中下轨再加仓`);
      }
    } else {
      action = 'hold'; confidence = 50;
      reasoning.push(`浮盈${profitPct.toFixed(1)}%，等待更好的卖点或回调买点`);
    }
  } else if (costNav > 0) {
    // -------- 亏损状态 --------
    const lossPct = Math.abs(gainPct);
    const lossUrgency = (lossPct > 10 && (cyclePhase === 'capitulation' || cyclePhase === 'early_recovery') ? 'high' : lossPct > 5 ? 'medium' : 'low') as 'high' | 'medium' | 'low';
    const lossConfBoost = Math.min(Math.floor(lossPct / 5) * 5, 15);
    const bf = baseFactor;

    // [索罗斯修正] 真正的卖出止损：超止损线+趋势strong_down+compositeScore极低→卖出活仓止损
    if (lossPct > stopLoss && compositeScore < -30 && technical.trend === 'strong_down' && swingShares > 0) {
      action = 'sell';
      opShares = r4(swingShares * 0.3); // 卖30%活仓止损
      confidence = 65; urgency = 'high';
      reasoning.push(`[Soros止损] 亏${lossPct.toFixed(1)}%+趋势崩坏（${compositeScore}分），卖出30%活仓止损`);

    // [巴菲特修正] 底仓熔断：基本面极差+深亏→底仓也要减
    } else if (lossPct > 30 && fundScore.score < -20 && swingShares <= 0 && baseShares > 0) {
      action = 'sell';
      opShares = r4(baseShares * 0.3); // 卖30%底仓
      confidence = 60; urgency = 'high';
      reasoning.push(`[底仓熔断] 亏${lossPct.toFixed(1)}%+基本面恶化（${fundScore.score}分），减30%底仓`);

    // [达利欧修正] 总亏损熔断
    } else if (circuitBreaker) {
      action = 'hold'; confidence = 70; urgency = 'high';
      reasoning.push(`[熔断] 总亏损${totalLossPct.toFixed(1)}%超25%，暂停所有买入，等待市场企稳`);

    // [索罗斯修正] Capitulation分步建仓：先30%试探，不一次性重仓
    } else if (cyclePhase === 'capitulation') {
      action = 'buy';
      // 分步：只投入计划量的30%作为试探仓
      const fullAmount = Math.round(rawBase * cycleMultiplier.capitulation * contrarian * buyConviction * valueMultiplier * bf);
      opAmount = Math.round(fullAmount * 0.3);
      opShares = r4(opAmount / nav);
      confidence = Math.min(70 + lossConfBoost, 85); urgency = 'high';
      reasoning.push(`[Soros试探] 恐慌探底，先投30%试探（¥${opAmount}/${fullAmount}），确认反转再加仓`);
    } else if (cyclePhase === 'early_recovery') {
      action = 'buy';
      // early_recovery = 确认阶段，投入70%
      opAmount = Math.round(rawBase * cycleMultiplier.early_recovery * valueMultiplier * buyConviction * bf * 0.7);
      opShares = r4(opAmount / nav);
      confidence = Math.min(75 + lossConfBoost, 90); urgency = 'high';
      reasoning.push(`[Marks确认] 复苏信号确认，加仓70%，乘数${valueMultiplier.toFixed(1)}x`);
    } else if (compositeScore >= 0) {
      action = 'buy';
      opAmount = Math.round(rawBase * valueMultiplier * buyConviction * cycleMultiplier[cyclePhase] * bf);
      opShares = r4(opAmount / nav);
      confidence = 60 + lossConfBoost; urgency = lossUrgency;
      reasoning.push(`[Graham] 价值平均：低于成本${lossPct.toFixed(1)}%，乘数${valueMultiplier.toFixed(1)}x`);
    } else if (compositeScore >= -20) {
      action = 'buy';
      const fundOk = fundScore.score >= 0;
      const mult = fundOk ? 0.8 : 0.4;
      opAmount = Math.round(rawBase * mult * valueMultiplier * bf);
      opShares = r4(opAmount / nav);
      confidence = 50 + lossConfBoost; urgency = lossUrgency;
      reasoning.push(`[Lynch] ${fundOk ? '基本面尚可，逢低布局' : '基本面也弱，谨慎小额'}`);
    } else {
      // 偏空但未触发止损卖出（compositeScore在-20~-30之间）
      action = 'buy';
      opAmount = Math.round(rawBase * 0.3 * Math.max(valueMultiplier, 1) * bf);
      opShares = r4(opAmount / nav);
      confidence = 40; urgency = 'low';
      reasoning.push(`[Graham] 偏空（${compositeScore}分），安全边际${lossPct.toFixed(1)}%，小额逆向买入`);
    }
  }

  // [Fix#1] 卖出分支只设了opShares没设opAmount，统一补算
  if (action === 'sell' && opShares > 0 && opAmount === 0) {
    opAmount = Math.round(opShares * nav);
  }
  // [Fix#6] 空持仓建仓：新基金应该买入建仓而非永远hold
  if (holdingShares <= 0 && action === 'hold' && costNav === 0) {
    action = 'buy';
    opAmount = Math.max(rawBase, 500);
    opShares = r4(opAmount / nav);
    confidence = 60; urgency = 'medium';
    reasoning.push(`[建仓] 无持仓，初始建仓 ¥${opAmount}`);
  }
  // [Fix#7] 底仓100%时不买入（买了也永远卖不出，资金陷阱）
  if (action === 'buy' && basePositionPct >= 100 && holdingShares > 0) {
    action = 'hold'; opShares = 0; opAmount = 0;
    reasoning.push(`[警告] 底仓100%，买入后无法卖出，请先调低底仓比例`);
  }

  // [A股修正] 7天赎回惩罚检查：持有<7天时阻止卖出
  if (action === 'sell' && daysSinceLastBuy < 7) {
    action = 'hold'; opShares = 0; opAmount = 0;
    reasoning.push(`[赎回保护] 最近买入仅${daysSinceLastBuy}天，持有<7天赎回费1.5%，暂不卖出`);
  }

  // === 波动率修正 ===
  if (riskMetrics.volatility20d > 30 && action !== 'hold') {
    const volReduction = riskMetrics.volatility20d > 40 ? 0.6 : 0.8;
    opShares = r4(opShares * volReduction);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`波动率${riskMetrics.volatility20d.toFixed(0)}%偏高，缩减至${Math.round(volReduction * 100)}%`);
  }

  // === 资金流向仓位调整 ===
  if (capitalFlow && action !== 'hold' && opAmount > 0) {
    const fs = capitalFlow.flowScore;
    if (action === 'buy' && fs < -30) {
      // 大幅资金流出 → 缩减买入（逆势补仓需更谨慎）
      const flowReduction = fs < -60 ? 0.5 : 0.7;
      opShares = r4(opShares * flowReduction);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[资金风控] ${capitalFlow.flowLabel}（评分${fs}），买入缩减至${Math.round(flowReduction * 100)}%`);
    } else if (action === 'buy' && fs > 30) {
      // 大幅资金流入 → 增加买入（顺势加仓）
      const flowBoost = fs > 60 ? 1.4 : 1.2;
      opShares = r4(opShares * flowBoost);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[资金助推] ${capitalFlow.flowLabel}（评分${fs}），买入增加至${Math.round(flowBoost * 100)}%`);
    } else if (action === 'sell' && fs > 30) {
      // 资金大幅流入但要卖 → 缩减卖出（不急着卖）
      const flowHold = fs > 60 ? 0.6 : 0.8;
      opShares = r4(opShares * flowHold);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[资金风控] 资金仍在流入，卖出缩减至${Math.round(flowHold * 100)}%`);
    } else if (action === 'sell' && fs < -30) {
      // 资金大幅流出且要卖 → 加速卖出（顺势离场）
      const flowAccel = fs < -60 ? 1.4 : 1.2;
      opShares = r4(Math.min(opShares * flowAccel, swingShares)); // 不超过活仓
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[资金助推] 资金加速流出，卖出增加至${Math.round(flowAccel * 100)}%`);
    }
  }

  // === 金额上限 + 组合风控 + 取整 ===
  if (opAmount > maxSingleAmount && maxSingleAmount > 0) {
    opAmount = maxSingleAmount;
    opShares = r4(opAmount / nav);
    reasoning.push(`[风控] 单次上限¥${maxSingleAmount}（总成本15%）`);
  }

  // [假设质疑修正] 组合板块敞口检查
  let sectorExposure = { totalExposure: 0, overExposed: false, reduction: 1 };
  if (action === 'buy' && opAmount > 0) {
    sectorExposure = checkSectorExposure(db, Number(fundId), sectorKeyword, opAmount);
    if (sectorExposure.overExposed) {
      opAmount = Math.round(opAmount * sectorExposure.reduction);
      opShares = r4(opAmount / nav);
      reasoning.push(`[组合风控] ${sectorKeyword}板块敞口${sectorExposure.totalExposure}%过高，缩减50%`);
    }
  }

  opAmount = Math.round(opAmount / 100) * 100 || opAmount;
  if (opAmount > 0 && nav > 0) opShares = r4(opAmount / nav);

  // === H. 真实成本影响 ===
  let newShares = holdingShares;
  let newCost = totalCost;
  if (action === 'buy') {
    newShares = r4(holdingShares + opShares);
    newCost = totalCost + opAmount;
  } else if (action === 'sell') {
    newShares = r4(holdingShares - opShares);
    newCost = totalCost - opShares * costNav;
  }
  const newCostNav = newShares > 0 ? r4(newCost / newShares) : 0;
  const costChange = r4(costNav - newCostNav);

  // === I. 完整循环计划 ===
  type CycleStep = { action: string; nav: number; shares: number; amount: number };
  type CyclePlan = {
    step1: CycleStep;
    step2: CycleStep;
    cycleCostDrop: number;
    cycleProfit: number;
    newCostNavAfterCycle: number;
  };
  let cycle: CyclePlan | null = null;

  if (action === 'sell' && opShares > 0) {
    const maxDip = Math.min(atrPct * 3, 15);
    const buyBackNav = r4(Math.max(
      Math.min(nav * (1 - atrPct * 2.5 / 100), technical.support > 0 ? technical.support : nav * 0.97),
      nav * (1 - maxDip / 100)
    ));
    const buyBackAmount = Math.round(opShares * buyBackNav * 100) / 100;
    // [巴菲特修正] 扣除交易费用后的真实循环利润
    const grossProfit = opShares * (nav - buyBackNav);
    const fees = opAmount * redeemFeeRate + buyBackAmount * FEE_SUBSCRIBE;
    const netProfit = Math.round((grossProfit - fees) * 100) / 100;
    const cycleCostDrop = holdingShares > 0 && netProfit > 0 ? r4(netProfit / holdingShares) : 0;
    const newNavAfterCycle = costNav > 0 ? r4(costNav - cycleCostDrop) : 0;
    const profitPctAfterFee = opAmount > 0 ? (netProfit / opAmount * 100) : 0;

    cycle = {
      step1: { action: `卖出活仓`, nav, shares: opShares, amount: opAmount },
      step2: { action: `买回（目标）`, nav: buyBackNav, shares: opShares, amount: buyBackAmount },
      cycleCostDrop, cycleProfit: netProfit, newCostNavAfterCycle: newNavAfterCycle,
    };

    if (profitPctAfterFee < MIN_CYCLE_PROFIT_PCT && netProfit > 0) {
      reasoning.push(`闭环：卖@${nav.toFixed(4)}→买@${buyBackNav.toFixed(4)}，扣费后利润仅${profitPctAfterFee.toFixed(1)}%<${MIN_CYCLE_PROFIT_PCT}%，循环性价比低`);
    } else if (netProfit <= 0) {
      reasoning.push(`闭环：卖@${nav.toFixed(4)}→买@${buyBackNav.toFixed(4)}，扣费后亏损¥${Math.abs(netProfit)}，不建议执行循环`);
    } else {
      reasoning.push(`闭环：卖@${nav.toFixed(4)}→买@${buyBackNav.toFixed(4)}，扣费后净利¥${netProfit}，降成本${cycleCostDrop.toFixed(4)}`);
    }
  } else if (action === 'buy' && opShares > 0) {
    const targetUp = Math.max(atrPct * 2.5, 3);
    const sellTargetNav = r4(nav * (1 + targetUp / 100));
    const sellAmount = Math.round(opShares * sellTargetNav * 100) / 100;
    const grossProfit = opShares * (sellTargetNav - nav);
    const fees = opAmount * FEE_SUBSCRIBE + sellAmount * FEE_REDEEM_CYCLE;
    const netProfit = Math.round((grossProfit - fees) * 100) / 100;
    const cycleCostDrop = holdingShares > 0 && netProfit > 0 ? r4(netProfit / holdingShares) : 0;
    const newNavAfterCycle = costNav > 0 ? r4(costNav - cycleCostDrop) : 0;

    cycle = {
      step1: { action: `买入活仓`, nav, shares: opShares, amount: opAmount },
      step2: { action: `卖出（目标）`, nav: sellTargetNav, shares: opShares, amount: sellAmount },
      cycleCostDrop, cycleProfit: netProfit, newCostNavAfterCycle: newNavAfterCycle,
    };
    reasoning.push(`闭环：买@${nav.toFixed(4)}→卖@${sellTargetNav.toFixed(4)}，扣费后净利¥${netProfit}，降成本${cycleCostDrop.toFixed(4)}`);
  }

  // === J. 各维度要点 ===
  const techSignals = signals
    .sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength))
    .slice(0, 4)
    .map(s => `[${s.source}] ${s.reason}`);

  if (techScore >= 30) reasoning.push(`技术面偏多（${techScore}分）：${technical.trend === 'strong_up' ? '强势上涨' : technical.trend === 'up' ? '温和上涨' : '震荡'}`);
  else if (techScore <= -30) reasoning.push(`技术面偏空（${techScore}分）：${technical.trend === 'strong_down' ? '加速下跌' : '偏弱下行'}`);
  if (fundScore.highlights.length > 0) reasoning.push(`基本面：${fundScore.highlights[0]}`);
  if (newsScore.bullish.length > 0) reasoning.push(`消息面利多：${newsScore.bullish[0].slice(0, 30)}...`);
  if (newsScore.bearish.length > 0) reasoning.push(`消息面利空：${newsScore.bearish[0].slice(0, 30)}...`);
  if (capitalFlow && capitalFlow.flowDetail) {
    reasoning.push(`[资金] ${capitalFlow.flowLabel}（评分${capitalFlow.flowScore}）：${capitalFlow.flowDetail}`);
  }

  const actionLabel = action === 'buy' ? `买入 ${opShares} 份（¥${opAmount}）` : action === 'sell' ? `卖出 ${opShares} 份（¥${opAmount}）` : '持有观望';
  const cycleNote = cycle && cycle.cycleProfit > 0 ? `，循环净利¥${cycle.cycleProfit}` : '';
  const summary = `建议${actionLabel}${cycleNote}`;

  // [达利欧修正] 最坏情况预估
  const worstCaseLoss = action === 'buy' && opAmount > 0
    ? Math.round(opAmount * Math.max(riskMetrics.maxDrawdown, 10) / 100)
    : 0;

  return {
    nav,
    action,
    shares: opShares,
    amount: opAmount,
    confidence,
    urgency,
    summary,
    compositeScore,
    masterSignals: {
      fearGreed,
      cyclePhase,
      cycleLabel: cycleLabel[cyclePhase],
      conviction: Math.round(conviction * 100) / 100,
      valueMultiplier: Math.round(valueMultiplier * 100) / 100,
      contrarian: Math.round(contrarian * 100) / 100,
      dynamicTakeProfit: Math.round(dynamicTakeProfit * 100) / 100,
      baseFactor,
    },
    position: {
      holdingShares: r4(holdingShares), costNav: r4(costNav),
      gainPct: Math.round(gainPct * 100) / 100,
      baseShares, swingShares,
      marketValue: Math.round(marketValue * 100) / 100,
      daysSinceFirstTx, txCount,
    },
    impact: { newShares, newCostNav, costChange },
    cycle,
    dimensions: {
      technical: { score: techScore, trend: technical.trend, rsi: technical.rsi14, signals: techSignals },
      fundamental: { score: fundScore.score, highlights: fundScore.highlights },
      news: { score: newsScore.score, sentiment: newsScore.score > 20 ? '偏多' : newsScore.score < -20 ? '偏空' : '中性', bullish: newsScore.bullish, bearish: newsScore.bearish },
    },
    holdings: holdings ? { quarter: (holdings as any).quarter, top5: (holdings as any).holdings?.slice(0, 5).map((h: any) => `${h.name} ${h.pctOfNav}%`) } : null,
    sectorExposure: sectorExposure.totalExposure > 0 ? sectorExposure : null,
    capitalFlow: capitalFlow ? {
      flowScore: capitalFlow.flowScore,
      flowLabel: capitalFlow.flowLabel,
      flowDetail: capitalFlow.flowDetail,
      holdingsFlowScore: capitalFlow.holdingsFlowScore,
      holdings: capitalFlow.holdings.slice(0, 5),
      sector: capitalFlow.sector,
      latestMarket: capitalFlow.market.length > 0 ? { mainNetInflow: Math.round(capitalFlow.market[capitalFlow.market.length - 1].mainNetInflow / 1e8 * 100) / 100 } : null,
      latestNorthbound: capitalFlow.northbound.length > 0 ? capitalFlow.northbound[capitalFlow.northbound.length - 1] : null,
    } : null,
    reasoning,
    riskWarnings: {
      worstCaseLoss,
      circuitBreaker,
      totalLossPct: Math.round(totalLossPct * 10) / 10,
      daysSinceLastBuy,
      redeemFeeRate: Math.round(redeemFeeRate * 10000) / 100,
      redeemFeeLevels: redeemFeeLevels.map(l => ({ ...l, feeRate: l.feeRate })),
    },
    timestamp: new Date().toISOString(),
  };
}

// 单基金决策端点
router.get('/funds/:id/decision', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const realtimeNav = req.query.nav ? parseFloat(req.query.nav as string) : 0;
    const result = await computeDecision(id, realtimeNav);
    res.json(result);
  } catch (err: any) {
    const status = err.message === '基金不存在' ? 404 : err.message === '需要提供净值' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// 批量获取所有基金的完整决策（用于总览面板）
router.get('/decisions/all', async (req: Request, res: Response) => {
  try {
    const funds = db.prepare(`
      SELECT f.id, f.name, f.code, f.color,
        COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares
      FROM funds f
      LEFT JOIN transactions t ON t.fund_id = f.id
      WHERE f.deleted_at IS NULL
      GROUP BY f.id
    `).all() as any[];

    const estimatesParam = req.query.estimates as string;
    let estimates: Record<number, number> = {};
    if (estimatesParam) {
      try { estimates = JSON.parse(estimatesParam); } catch {}
    }

    const results: any[] = [];

    // 并行调用完整决策引擎
    await Promise.all(funds.filter(f => f.holding_shares > 0).map(async (f) => {
      const nav = estimates[f.id] || 0;
      try {
        const decision = await computeDecision(f.id, nav);
        results.push({
          fundId: f.id,
          name: f.name,
          code: f.code,
          color: f.color,
          ...decision,
        });
      } catch {
        results.push({
          fundId: f.id, name: f.name, code: f.code, color: f.color,
          nav, action: 'hold', shares: 0, amount: 0, summary: '无法计算',
          confidence: 0, position: { holdingShares: f.holding_shares, costNav: 0, gainPct: 0 },
        });
      }
    }));

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: '批量决策失败: ' + err.message });
  }
});

// ============================================================
// 明日行情预测 + 投资策略
// ============================================================
router.get('/funds/:id/forecast', async (req: Request, res: Response) => {
  const fundId = Number(req.params.id);
  try {
    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
    if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

    const nav = fund.market_nav || 0;
    if (nav <= 0) { res.status(400).json({ error: '无当前净值' }); return; }

    // === 1. 并行获取数据 ===
    let navHistory: NavPoint[] = [];
    let fundamental: any = null;
    let news: any[] = [];
    let marketCtx: any = null;
    let fcHoldings: any = null;

    const sectorKeyword = inferSectorKeyword(fund.name);
    const promises: Promise<void>[] = [];
    if (fund.code) {
      promises.push(fetchNavHistory(fund.code, 60).then(h => { navHistory = h; }));
      promises.push(fetchFundamental(fund.code).then(f => { fundamental = f; }));
      promises.push(fetchFundHoldings(fund.code).then(h => { fcHoldings = h; }));
    }
    promises.push(fetchSectorNews(sectorKeyword, 10).then(n => { news = n; }));
    promises.push(fetchMarketContext(fund.name).then(m => { marketCtx = m; }));
    await Promise.all(promises);
    const capitalFlow = await fetchCapitalFlow(fund.name, fcHoldings?.holdings);

    const navValues = navHistory.map(p => p.nav);
    if (navValues.length < 5) {
      res.json({ error: null, prediction: null, message: '历史数据不足，无法预测' });
      return;
    }

    // === 2. 技术面分析 ===
    const tech = calcTechnical(navValues);
    const risk = calcRisk(navValues);
    const fundScore = fundamental ? scoreFundamental(fundamental) : { score: 0, highlights: [] };
    const newsScore = scoreNewsSentiment(news);

    // === 3. 多因子预测模型 (v4自适应优化版 - 回测竞技场进化) ===
    // v4核心改进：自适应市场状态检测，趋势市/震荡市/高波动市动态切权重
    const current = navValues[navValues.length - 1];
    const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;

    // --- 3z. 市场状态自适应检测 (v4新增) ---
    // 判断当前处于趋势市、震荡市还是高波动市，动态调整因子权重
    type ForecastRegime = 'trending' | 'ranging' | 'volatile';
    let forecastRegime: ForecastRegime = 'ranging';
    if (navValues.length >= 30) {
      const ma5v = navValues.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const ma10v = navValues.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const ma20v = navValues.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const alignedBull = ma5v > ma10v && ma10v > ma20v;
      const alignedBear = ma5v < ma10v && ma10v < ma20v;
      if (risk.volatility20d > 30) forecastRegime = 'volatile';
      else if (alignedBull || alignedBear) forecastRegime = 'trending';
      else forecastRegime = 'ranging';
    }
    // 自适应权重（v4.2：21只持仓基金+20只泛基金综合进化）
    const adaptTrendW = forecastRegime === 'trending' ? 0.87 : forecastRegime === 'volatile' ? 0.14 : 0.30;
    const adaptReversionW = forecastRegime === 'trending' ? 0.04 : forecastRegime === 'volatile' ? 0.28 : 0.18;
    const adaptBBMult = forecastRegime === 'ranging' ? 1.5 : 1.0;

    // --- 3a. 趋势动量因子（带衰减权重） ---
    const changes = navValues.slice(-10).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100);
    // 近期权重更高（v4微调衰减曲线）
    const decayWeights = [0.15, 0.25, 0.45, 0.75, 1.0];
    const recentChanges5 = changes.slice(-5);
    const weightedMom = recentChanges5.reduce((s, c, i) => s + c * (decayWeights[i] || 0.15), 0) / decayWeights.reduce((a, b) => a + b, 0);
    const mom3d = changes.slice(-3).reduce((a, b) => a + b, 0);
    const mom5d = changes.slice(-5).reduce((a, b) => a + b, 0);
    // 连涨连跌天数（动量持续性）
    let streak = 0;
    for (let i = changes.length - 1; i >= 1; i--) {
      if (changes[i] > 0 && streak >= 0) streak++;
      else if (changes[i] < 0 && streak <= 0) streak--;
      else break;
    }
    let trendFactor = 0;
    trendFactor += weightedMom * adaptTrendW;      // v4：自适应动量权重
    trendFactor += tech.trendScore * 0.015;
    // v4.2连涨衰减（持仓进化：5天0.43, 3天0.82）
    if (Math.abs(streak) >= 5) trendFactor *= 0.43;
    else if (Math.abs(streak) >= 3) trendFactor *= 0.82;

    // --- 3b. 均值回归因子（v4自适应权重） ---
    const deviationFromMA20 = ((current - tech.ma20) / tech.ma20) * 100;
    const deviationFromMA5 = ((current - tech.ma5) / tech.ma5) * 100;
    let reversionFactor = 0;
    // v4：使用自适应回归权重（趋势市权重极低0.04，震荡市0.19）
    if (Math.abs(deviationFromMA20) > 2) {
      const sign = deviationFromMA20 > 0 ? -1 : 1;
      reversionFactor += sign * Math.sqrt(Math.abs(deviationFromMA20) - 2) * adaptReversionW;
    }
    if (Math.abs(deviationFromMA5) > 1.5) {
      const sign = deviationFromMA5 > 0 ? -1 : 1;
      reversionFactor += sign * (Math.abs(deviationFromMA5) - 1.5) * 0.08;
    }

    // --- 3c. RSI因子（v4.2：综合41只基金阈值+背离） ---
    let rsiFactor = 0;
    // v4.2阈值（持仓+泛基金综合：overbought=62, oversold=37, extreme_high=77, extreme_low=21）
    if (tech.rsi14 > 77) rsiFactor = -(tech.rsi14 - 77) * 0.08;
    else if (tech.rsi14 > 62) rsiFactor = -(tech.rsi14 - 62) * 0.033;
    else if (tech.rsi14 < 21) rsiFactor = (21 - tech.rsi14) * 0.08;
    else if (tech.rsi14 < 37) rsiFactor = (37 - tech.rsi14) * 0.033;
    // v4.2背离检测（lookback=9, weight=0.20）
    if (navValues.length >= 11) {
      const navLookback = navValues[navValues.length - 10];
      const rsiLookback = calcRSI(navValues.slice(0, -9), 14);
      if (current > navLookback && tech.rsi14 < rsiLookback) rsiFactor -= 0.20; // 顶背离
      if (current < navLookback && tech.rsi14 > rsiLookback) rsiFactor += 0.20; // 底背离
    }

    // --- 3d. MACD信号因子（v4.2综合MACD权重） ---
    let macdFactor = 0;
    const hist = tech.macd.histogram;
    // v4.2 MACD基础权重（综合进化：0.21）
    if (hist > 0 && tech.macd.dif > tech.macd.dea) macdFactor = 0.21;
    else if (hist < 0 && tech.macd.dif < tech.macd.dea) macdFactor = -0.21;
    // v4.2金叉/死叉boost（综合进化：0.36）
    if (navValues.length >= 2) {
      const prevMacd = calcMACD(navValues.slice(0, -1));
      if (prevMacd.histogram <= 0 && hist > 0) macdFactor += 0.36;
      if (prevMacd.histogram >= 0 && hist < 0) macdFactor -= 0.36;
    }
    // MACD柱状图加速/减速（二阶导数）
    if (navValues.length >= 3) {
      const prev2Macd = calcMACD(navValues.slice(0, -2));
      const prevMacd2 = calcMACD(navValues.slice(0, -1));
      const accel = hist - prevMacd2.histogram;
      const prevAccel = prevMacd2.histogram - prev2Macd.histogram;
      if (accel > 0 && prevAccel > 0) macdFactor += 0.1;
      if (accel < 0 && prevAccel < 0) macdFactor -= 0.1;
    }

    // --- 3e. 布林带因子（v4自适应倍率） ---
    let bbFactor = 0;
    const pctB = tech.bollingerBands.percentB;
    // v4.1布林权重（20基金进化：0.019→0.020）
    if (pctB > 95) bbFactor = -0.35 * adaptBBMult;
    else if (pctB > 80) bbFactor = -(pctB - 80) * 0.020 * adaptBBMult;
    else if (pctB < 5) bbFactor = 0.35 * adaptBBMult;
    else if (pctB < 20) bbFactor = (20 - pctB) * 0.020 * adaptBBMult;
    // 布林带收窄→波动率即将扩大，顺趋势加权
    if (tech.bollingerBands.width < 3) {
      bbFactor += trendFactor > 0 ? 0.1 : trendFactor < 0 ? -0.1 : 0;
    }

    // --- 3f. 消息面因子 ---
    const newsFactor = newsScore.score * 0.008;

    // --- 3g. 市场环境因子（v4增强权重） ---
    let marketFactor = 0;
    if (marketCtx) {
      const shIdx = marketCtx.marketIndices.find((i: any) => i.name === '上证指数');
      const shChangePct = shIdx?.changePct || 0;
      // v4.2市场权重（持仓进化：0.11→0.13）
      marketFactor += shChangePct * 0.13;
      if (marketCtx.marketScore > 20) marketFactor += 0.12;
      else if (marketCtx.marketScore < -20) marketFactor -= 0.12;
    }

    // --- 3h. 周内季节性因子 ---
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayOfWeek = tomorrow.getDay();
    let seasonalFactor = 0;
    if (dayOfWeek === 1) seasonalFactor = -0.03;
    else if (dayOfWeek === 2 || dayOfWeek === 3) seasonalFactor = 0.02;
    else if (dayOfWeek === 5) seasonalFactor = -0.02;
    const todayDate = new Date();
    const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate();
    if (todayDate.getDate() >= daysInMonth - 2) seasonalFactor -= 0.03;
    if (todayDate.getDate() <= 3) seasonalFactor += 0.02;

    // --- 3i. 支撑/阻力位接近因子 ---
    let srFactor = 0;
    if (tech.support > 0 && tech.resistance > 0) {
      const distToSupport = ((current - tech.support) / current) * 100;
      const distToResist = ((tech.resistance - current) / current) * 100;
      if (distToSupport < 1.0 && distToSupport >= 0) srFactor += 0.2;
      else if (distToSupport < 2.0 && distToSupport >= 0) srFactor += 0.1;
      if (distToSupport < 0) srFactor -= 0.15;
      if (distToResist < 1.0 && distToResist >= 0) srFactor -= 0.15;
      else if (distToResist < 2.0 && distToResist >= 0) srFactor -= 0.08;
      if (distToResist < 0) srFactor += 0.2;
    }

    // --- 3j. 跨时间框架确认因子 ---
    let crossTfFactor = 0;
    const mom10d = navValues.length >= 11 ? navValues.slice(-11).reduce((s, v, i, a) => i === 0 ? 0 : s + ((v - a[i-1]) / a[i-1]) * 100, 0) : 0;
    if (mom3d > 0 && mom10d > 0 && tech.trendScore > 0) crossTfFactor = 0.12;
    else if (mom3d < 0 && mom10d < 0 && tech.trendScore < 0) crossTfFactor = -0.12;
    else if ((mom3d > 0) !== (mom10d > 0)) crossTfFactor = 0;

    // --- 3k. 缺口回补因子 ---
    let gapFactor = 0;
    if (changes.length >= 2) {
      const lastChange = changes[changes.length - 1];
      if (Math.abs(lastChange) > 1.5) {
        gapFactor = -lastChange * 0.15;
      }
    }

    // --- 3l. 资金流向因子 ---
    let capitalFlowFactor = 0;
    if (capitalFlow) {
      capitalFlowFactor = capitalFlow.flowScore * 0.005;
      if (capitalFlow.sector) {
        if (capitalFlow.sector.mainNetInflow > 5) capitalFlowFactor += 0.1;
        else if (capitalFlow.sector.mainNetInflow < -5) capitalFlowFactor -= 0.1;
      }
    }

    // --- 3m. 波动率调整因子（v4.2：综合进化） ---
    // v4.2：阈值24%，系数0.63 — 持仓基金波动较大需更积极调节
    const volAdj = risk.volatility20d > 24 ? 0.63 : risk.volatility20d > 15 ? 0.85 : 1.0;
    trendFactor *= volAdj;
    reversionFactor *= (2 - volAdj);

    // === 4. 综合预测（v3加权融合） ===
    const rawPrediction = trendFactor + reversionFactor + rsiFactor + macdFactor + bbFactor + newsFactor + marketFactor + seasonalFactor + srFactor + crossTfFactor + gapFactor + capitalFlowFactor;
    const maxMove = atrPct * 1.5;
    const predictedChangePct = Math.max(-maxMove, Math.min(maxMove, rawPrediction));
    const predictedNav = Math.round((current * (1 + predictedChangePct / 100)) * 10000) / 10000;

    // 预测区间（基于ATR，非对称——趋势方向更宽）
    const upBias = predictedChangePct > 0 ? 1.3 : 1.0;
    const downBias = predictedChangePct < 0 ? 1.3 : 1.0;
    const navHigh = Math.round((current + tech.atr14 * 1.2 * upBias) * 10000) / 10000;
    const navLow = Math.round((current - tech.atr14 * 1.2 * downBias) * 10000) / 10000;

    // 方向判定
    let direction: 'up' | 'down' | 'sideways';
    if (predictedChangePct > 0.15) direction = 'up';
    else if (predictedChangePct < -0.15) direction = 'down';
    else direction = 'sideways';

    // 置信度（v3优化：多因子一致性 + 跨时间框架确认加分 + 资金流向加分）
    const factors = [trendFactor, reversionFactor, rsiFactor, macdFactor, bbFactor, newsFactor, marketFactor, srFactor, crossTfFactor, gapFactor, capitalFlowFactor];
    const sameDirection = factors.filter(f => (f > 0) === (predictedChangePct > 0) && Math.abs(f) > 0.02).length;
    let confidence = 30 + sameDirection * 7 + Math.abs(predictedChangePct) * 5;
    // 跨时间框架共振加分
    if (Math.abs(crossTfFactor) > 0.1) confidence += 8;
    // 支撑阻力位确认加分
    if ((srFactor > 0) === (predictedChangePct > 0) && Math.abs(srFactor) > 0.05) confidence += 5;
    // 资金流向确认加分
    if ((capitalFlowFactor > 0) === (predictedChangePct > 0) && Math.abs(capitalFlowFactor) > 0.05) confidence += 6;
    confidence = Math.min(90, Math.max(20, confidence));

    // === 5. 持仓数据 ===
    const posRow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
        COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
        COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
      FROM transactions WHERE fund_id = ?
    `).get(fundId) as any;
    const holdingShares = posRow.holding_shares;
    const totalCost = posRow.cost_basis;
    const costNav = holdingShares > 0 && totalCost > 0 ? totalCost / holdingShares : 0;
    const basePct = fund.base_position_pct ?? 30;
    const baseShares = r4(holdingShares * basePct / 100);
    const swingShares = r4(holdingShares - baseShares);
    const stopProfit = fund.stop_profit_pct || 20;
    const stopLoss = fund.stop_loss_pct || 15;
    const gainPct = costNav > 0 ? ((nav - costNav) / costNav) * 100 : 0;

    // === 6. 基于预测生成投资策略 ===
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let shares = 0;
    let amount = 0;
    const strategies: string[] = [];

    if (direction === 'down') {
      // 预测下跌 → 机会：明天低点买入；今天可少量止盈
      if (gainPct > 5 && swingShares > 0) {
        // 有盈利且有活仓，今天可先止盈一部分
        action = 'sell';
        shares = Math.round(swingShares * 0.15 * 100) / 100;
        amount = Math.round(shares * nav * 100) / 100;
        strategies.push(`预测明日下跌${Math.abs(predictedChangePct).toFixed(2)}%，建议今日先止盈${shares}份（¥${amount}）`);
        strategies.push(`明日若跌至${navLow}附近可接回，完成高抛低吸降低成本`);
      } else if (gainPct < -5) {
        // 已亏损，预测继续跌 → 等待更好买点
        action = 'hold';
        strategies.push(`预测明日下跌${Math.abs(predictedChangePct).toFixed(2)}%，当前已亏${Math.abs(gainPct).toFixed(1)}%`);
        strategies.push(`建议等待明日低点¥${navLow}附近再补仓，不急于今天操作`);
        const suggestAmt = Math.round(500 * Math.min(2, 1 + Math.abs(gainPct) / 20));
        strategies.push(`明日建议补仓金额：¥${suggestAmt}（约${Math.round(suggestAmt / navLow)}份）`);
      } else {
        action = 'hold';
        strategies.push(`预测明日小幅下跌${Math.abs(predictedChangePct).toFixed(2)}%，持有观望`);
        strategies.push(`若明日跌至¥${navLow}以下可考虑小额补仓`);
      }
    } else if (direction === 'up') {
      // 预测上涨
      if (gainPct >= stopProfit && swingShares > 0) {
        // 已达止盈线 + 预测还涨 → 分批止盈
        action = 'sell';
        shares = Math.round(swingShares * 0.2 * 100) / 100;
        amount = Math.round(shares * nav * 100) / 100;
        strategies.push(`盈利${gainPct.toFixed(1)}%已达止盈线，虽预测明日涨${predictedChangePct.toFixed(2)}%`);
        strategies.push(`但盈利落袋优先，建议今日减仓${shares}份（¥${amount}），剩余观察`);
      } else if (gainPct < -3) {
        // 亏损中 + 预测涨 → 今天趁低位加仓
        action = 'buy';
        const factor = Math.min(2, 1 + Math.abs(gainPct) / 15);
        amount = Math.round(500 * factor);
        shares = Math.round(amount / nav * 100) / 100;
        strategies.push(`预测明日上涨${predictedChangePct.toFixed(2)}%，当前亏损${Math.abs(gainPct).toFixed(1)}%`);
        strategies.push(`建议今日买入${shares}份（¥${amount}），趁上涨前补仓降低成本`);
      } else {
        action = 'hold';
        strategies.push(`预测明日上涨${predictedChangePct.toFixed(2)}%，当前收益${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%`);
        strategies.push(`持有等待，若明日涨至¥${navHigh}以上可适当减仓`);
      }
    } else {
      // 震荡
      strategies.push(`预测明日横盘震荡（变动${predictedChangePct >= 0 ? '+' : ''}${predictedChangePct.toFixed(2)}%）`);
      if (gainPct < -5) {
        action = 'buy';
        amount = 300;
        shares = Math.round(amount / nav * 100) / 100;
        strategies.push(`当前亏损${Math.abs(gainPct).toFixed(1)}%，震荡期可小额定投摊薄成本`);
        strategies.push(`建议买入${shares}份（¥${amount}）`);
      } else {
        strategies.push(`无明确方向信号，建议持有观望`);
      }
    }

    // === 7. 预测理由 ===
    const reasoning: string[] = [];
    reasoning.push(`[动量] 近3日涨跌${mom3d >= 0 ? '+' : ''}${mom3d.toFixed(2)}%，近5日${mom5d >= 0 ? '+' : ''}${mom5d.toFixed(2)}% → ${trendFactor > 0 ? '看多' : trendFactor < 0 ? '看空' : '中性'}（${trendFactor >= 0 ? '+' : ''}${trendFactor.toFixed(3)}）`);
    reasoning.push(`[均值回归] 偏离MA20 ${deviationFromMA20 >= 0 ? '+' : ''}${deviationFromMA20.toFixed(2)}%，偏离MA5 ${deviationFromMA5 >= 0 ? '+' : ''}${deviationFromMA5.toFixed(2)}% → ${reversionFactor > 0 ? '反弹' : reversionFactor < 0 ? '回调' : '中性'}（${reversionFactor >= 0 ? '+' : ''}${reversionFactor.toFixed(3)}）`);
    reasoning.push(`[RSI] ${tech.rsi14.toFixed(0)}${tech.rsi14 > 70 ? '（超买）' : tech.rsi14 < 30 ? '（超卖）' : ''} → ${rsiFactor >= 0 ? '+' : ''}${rsiFactor.toFixed(3)}`);
    reasoning.push(`[MACD] DIF=${tech.macd.dif.toFixed(4)} DEA=${tech.macd.dea.toFixed(4)} 柱=${tech.macd.histogram > 0 ? '红' : '绿'} → ${macdFactor >= 0 ? '+' : ''}${macdFactor.toFixed(3)}`);
    reasoning.push(`[布林] 位置${tech.bollingerBands.percentB.toFixed(0)}%（0=下轨 100=上轨） → ${bbFactor >= 0 ? '+' : ''}${bbFactor.toFixed(3)}`);
    if (newsScore.bullish.length > 0 || newsScore.bearish.length > 0) {
      reasoning.push(`[消息] ${newsScore.score > 0 ? '偏多' : newsScore.score < 0 ? '偏空' : '中性'}（${newsScore.bullish.length}多/${newsScore.bearish.length}空） → ${newsFactor >= 0 ? '+' : ''}${newsFactor.toFixed(3)}`);
    }
    if (marketCtx) {
      const shIdx = marketCtx.marketIndices.find((i: any) => i.name === '上证指数');
      const shPct = shIdx?.changePct ?? 0;
      reasoning.push(`[大盘] 上证 ${shPct >= 0 ? '+' : ''}${shPct.toFixed(2)}%，市场评分${marketCtx.marketScore}（${marketCtx.marketRegime === 'bull' ? '偏多' : marketCtx.marketRegime === 'bear' ? '偏空' : '震荡'}） → ${marketFactor >= 0 ? '+' : ''}${marketFactor.toFixed(3)}`);
    }
    if (Math.abs(srFactor) > 0.01) {
      reasoning.push(`[支撑阻力] ${srFactor > 0 ? '接近支撑位/突破阻力' : '接近阻力位/跌破支撑'} → ${srFactor >= 0 ? '+' : ''}${srFactor.toFixed(3)}`);
    }
    if (Math.abs(crossTfFactor) > 0.01) {
      reasoning.push(`[跨周期] 短中长期${crossTfFactor > 0 ? '共振看多' : '共振看空'} → ${crossTfFactor >= 0 ? '+' : ''}${crossTfFactor.toFixed(3)}`);
    }
    if (Math.abs(gapFactor) > 0.01) {
      reasoning.push(`[缺口] 前日跳空${gapFactor > 0 ? '向下' : '向上'}，回补压力 → ${gapFactor >= 0 ? '+' : ''}${gapFactor.toFixed(3)}`);
    }
    if (capitalFlow && capitalFlow.flowDetail) {
      reasoning.push(`[资金] ${capitalFlow.flowLabel}（评分${capitalFlow.flowScore}）：${capitalFlow.flowDetail} → ${capitalFlowFactor >= 0 ? '+' : ''}${capitalFlowFactor.toFixed(3)}`);
    }

    // === 8. 历史胜率统计 ===
    const recentChanges = navHistory.slice(-20).map((p, i, a) => i === 0 ? 0 : ((p.nav - a[i-1].nav) / a[i-1].nav) * 100).slice(1);
    const upDays = recentChanges.filter(c => c > 0).length;
    const downDays = recentChanges.filter(c => c < 0).length;
    const avgUp = recentChanges.filter(c => c > 0).length > 0 ? recentChanges.filter(c => c > 0).reduce((a, b) => a + b, 0) / upDays : 0;
    const avgDown = recentChanges.filter(c => c < 0).length > 0 ? recentChanges.filter(c => c < 0).reduce((a, b) => a + b, 0) / downDays : 0;

    res.json({
      fundName: fund.name,
      currentNav: nav,
      prediction: {
        direction,
        predictedNav,
        predictedChangePct: Math.round(predictedChangePct * 100) / 100,
        navRange: { high: navHigh, low: navLow },
        confidence: Math.round(confidence),
      },
      strategy: {
        action,
        shares,
        amount,
        strategies,
      },
      factors: {
        trend: { value: Math.round(trendFactor * 1000) / 1000, label: '趋势动量', mom3d: Math.round(mom3d * 100) / 100, mom5d: Math.round(mom5d * 100) / 100 },
        reversion: { value: Math.round(reversionFactor * 1000) / 1000, label: '均值回归', deviationMA20: Math.round(deviationFromMA20 * 100) / 100 },
        rsi: { value: Math.round(rsiFactor * 1000) / 1000, label: 'RSI', rsi14: tech.rsi14 },
        macd: { value: Math.round(macdFactor * 1000) / 1000, label: 'MACD', histogram: tech.macd.histogram > 0 ? 'red' : 'green' },
        bollinger: { value: Math.round(bbFactor * 1000) / 1000, label: '布林带', percentB: Math.round(tech.bollingerBands.percentB) },
        news: { value: Math.round(newsFactor * 1000) / 1000, label: '消息面', score: newsScore.score },
        market: { value: Math.round(marketFactor * 1000) / 1000, label: '大盘环境' },
        supportResistance: { value: Math.round(srFactor * 1000) / 1000, label: '支撑阻力' },
        crossTimeframe: { value: Math.round(crossTfFactor * 1000) / 1000, label: '跨周期确认' },
        gap: { value: Math.round(gapFactor * 1000) / 1000, label: '缺口回补' },
        capitalFlow: { value: Math.round(capitalFlowFactor * 1000) / 1000, label: '资金流向', score: capitalFlow?.flowScore ?? 0, sectorFlow: capitalFlow?.sector?.mainNetInflow ?? 0 },
      },
      position: {
        holdingShares, costNav: r4(costNav), gainPct: Math.round(gainPct * 100) / 100,
        baseShares, swingShares,
      },
      stats: {
        recent20: { upDays, downDays, avgUp: Math.round(avgUp * 100) / 100, avgDown: Math.round(avgDown * 100) / 100 },
        volatility: risk.volatility20d,
        atrPct: Math.round(atrPct * 100) / 100,
      },
      reasoning,
      fundamentalHighlights: fundScore.highlights,
      capitalFlow: capitalFlow ? {
        flowScore: capitalFlow.flowScore,
        flowLabel: capitalFlow.flowLabel,
        flowDetail: capitalFlow.flowDetail,
        holdingsFlowScore: capitalFlow.holdingsFlowScore,
        holdings: capitalFlow.holdings.slice(0, 5),
        sector: capitalFlow.sector,
        latestMarket: capitalFlow.market.length > 0 ? {
          date: capitalFlow.market[capitalFlow.market.length - 1].date,
          mainNetInflow: Math.round(capitalFlow.market[capitalFlow.market.length - 1].mainNetInflow / 1e8 * 100) / 100,
        } : null,
        latestNorthbound: capitalFlow.northbound.length > 0 ? capitalFlow.northbound[capitalFlow.northbound.length - 1] : null,
      } : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: '预测失败: ' + err.message });
  }
});

// ============================================================
// 批量预测（总览面板用）
// ============================================================
router.get('/forecasts/all', async (_req: Request, res: Response) => {
  try {
    const funds = db.prepare(`
      SELECT f.id, f.name, f.code, f.color, f.market_nav,
        COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares
      FROM funds f
      LEFT JOIN transactions t ON t.fund_id = f.id
      WHERE f.deleted_at IS NULL
      GROUP BY f.id
    `).all() as any[];

    const results: Record<number, any> = {};

    await Promise.all(funds.filter(f => f.holding_shares > 0 && f.code).map(async (f) => {
      try {
        const nav = f.market_nav || 0;
        if (nav <= 0) return;

        let navHistory: NavPoint[] = [];
        let newsItems: any[] = [];
        let marketCtx: any = null;
        let bfHoldings: any = null;

        const sectorKeyword = inferSectorKeyword(f.name);
        await Promise.all([
          fetchNavHistory(f.code, 60).then(h => { navHistory = h; }),
          fetchSectorNews(sectorKeyword, 5).then(n => { newsItems = n; }),
          fetchMarketContext(f.name).then(m => { marketCtx = m; }),
          fetchFundHoldings(f.code).then(h => { bfHoldings = h; }),
        ]);
        // 重仓股就绪后获取资金流向（传入holdings使每只基金评分不同）
        const cfData = await fetchCapitalFlow(f.name, bfHoldings?.holdings);

        const navValues = navHistory.map(p => p.nav);
        if (navValues.length < 5) return;

        const tech = calcTechnical(navValues);
        const risk = calcRisk(navValues);
        const newsScore = scoreNewsSentiment(newsItems);
        const current = navValues[navValues.length - 1];
        const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;

        // v4自适应多因子预测（与完整版相同算法）
        const changes = navValues.slice(-10).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100);

        // v4自适应市场状态检测
        let batchRegime: 'trending' | 'ranging' | 'volatile' = 'ranging';
        if (navValues.length >= 30) {
          const bma5 = navValues.slice(-5).reduce((a, b) => a + b, 0) / 5;
          const bma10 = navValues.slice(-10).reduce((a, b) => a + b, 0) / 10;
          const bma20 = navValues.slice(-20).reduce((a, b) => a + b, 0) / 20;
          if (risk.volatility20d > 30) batchRegime = 'volatile';
          else if ((bma5 > bma10 && bma10 > bma20) || (bma5 < bma10 && bma10 < bma20)) batchRegime = 'trending';
        }
        const bTrendW = batchRegime === 'trending' ? 0.87 : batchRegime === 'volatile' ? 0.14 : 0.30;
        const bRevW = batchRegime === 'trending' ? 0.04 : batchRegime === 'volatile' ? 0.28 : 0.18;
        const bBBMult = batchRegime === 'ranging' ? 1.5 : 1.0;

        const decayWeights = [0.15, 0.25, 0.45, 0.75, 1.0];
        const recentChanges5 = changes.slice(-5);
        const weightedMom = recentChanges5.reduce((s, c, i) => s + c * (decayWeights[i] || 0.15), 0) / decayWeights.reduce((a, b) => a + b, 0);
        const mom3d = changes.slice(-3).reduce((a, b) => a + b, 0);
        let streak = 0;
        for (let i = changes.length - 1; i >= 1; i--) {
          if (changes[i] > 0 && streak >= 0) streak++;
          else if (changes[i] < 0 && streak <= 0) streak--;
          else break;
        }
        let trendFactor = weightedMom * bTrendW + tech.trendScore * 0.015;
        if (Math.abs(streak) >= 5) trendFactor *= 0.43;
        else if (Math.abs(streak) >= 3) trendFactor *= 0.82;

        const deviationFromMA20 = ((current - tech.ma20) / tech.ma20) * 100;
        const deviationFromMA5 = ((current - tech.ma5) / tech.ma5) * 100;
        let reversionFactor = 0;
        if (Math.abs(deviationFromMA20) > 2) reversionFactor += (deviationFromMA20 > 0 ? -1 : 1) * Math.sqrt(Math.abs(deviationFromMA20) - 2) * bRevW;  // bRevW已更新
        if (Math.abs(deviationFromMA5) > 1.5) reversionFactor += (deviationFromMA5 > 0 ? -1 : 1) * (Math.abs(deviationFromMA5) - 1.5) * 0.08;

        let rsiFactor = 0;
        if (tech.rsi14 > 77) rsiFactor = -(tech.rsi14 - 77) * 0.08;
        else if (tech.rsi14 > 62) rsiFactor = -(tech.rsi14 - 62) * 0.033;
        else if (tech.rsi14 < 21) rsiFactor = (21 - tech.rsi14) * 0.08;
        else if (tech.rsi14 < 37) rsiFactor = (37 - tech.rsi14) * 0.033;

        let macdFactor = 0;
        const hist = tech.macd.histogram;
        if (hist > 0 && tech.macd.dif > tech.macd.dea) macdFactor = 0.21;
        else if (hist < 0 && tech.macd.dif < tech.macd.dea) macdFactor = -0.21;

        let bbFactor = 0;
        const pctB = tech.bollingerBands.percentB;
        if (pctB > 95) bbFactor = -0.35 * bBBMult;
        else if (pctB > 80) bbFactor = -(pctB - 80) * 0.020 * bBBMult;
        else if (pctB < 5) bbFactor = 0.35 * bBBMult;
        else if (pctB < 20) bbFactor = (20 - pctB) * 0.020 * bBBMult;

        const newsFactor = newsScore.score * 0.008;
        let marketFactor = 0;
        if (marketCtx) {
          const shIdx = marketCtx.marketIndices.find((i: any) => i.name === '上证指数');
          marketFactor += (shIdx?.changePct || 0) * 0.13;
          if (marketCtx.marketScore > 20) marketFactor += 0.12;
          else if (marketCtx.marketScore < -20) marketFactor -= 0.12;
        }

        // v4.1波动率（同步更新）
        let srFactor = 0;
        if (tech.support > 0 && tech.resistance > 0) {
          const distToSupport = ((current - tech.support) / current) * 100;
          const distToResist = ((tech.resistance - current) / current) * 100;
          if (distToSupport < 1.0 && distToSupport >= 0) srFactor += 0.2;
          else if (distToSupport < 2.0 && distToSupport >= 0) srFactor += 0.1;
          if (distToSupport < 0) srFactor -= 0.15;
          if (distToResist < 1.0 && distToResist >= 0) srFactor -= 0.15;
          else if (distToResist < 2.0 && distToResist >= 0) srFactor -= 0.08;
          if (distToResist < 0) srFactor += 0.2;
        }

        const mom10d = navValues.length >= 11 ? navValues.slice(-11).reduce((s, v, i, a) => i === 0 ? 0 : s + ((v - a[i-1]) / a[i-1]) * 100, 0) : 0;
        let crossTfFactor = 0;
        if (mom3d > 0 && mom10d > 0 && tech.trendScore > 0) crossTfFactor = 0.12;
        else if (mom3d < 0 && mom10d < 0 && tech.trendScore < 0) crossTfFactor = -0.12;

        let gapFactor = 0;
        if (changes.length >= 2 && Math.abs(changes[changes.length - 1]) > 1.5) {
          gapFactor = -changes[changes.length - 1] * 0.15;
        }

        let capitalFlowFactor = 0;
        if (cfData) {
          capitalFlowFactor = cfData.flowScore * 0.005;
          if (cfData.sector) {
            if (cfData.sector.mainNetInflow > 5) capitalFlowFactor += 0.1;
            else if (cfData.sector.mainNetInflow < -5) capitalFlowFactor -= 0.1;
          }
        }

        const volAdj = risk.volatility20d > 24 ? 0.63 : risk.volatility20d > 15 ? 0.85 : 1.0;
        trendFactor *= volAdj;
        reversionFactor *= (2 - volAdj);

        const rawPrediction = trendFactor + reversionFactor + rsiFactor + macdFactor + bbFactor + newsFactor + marketFactor + srFactor + crossTfFactor + gapFactor + capitalFlowFactor;
        const maxMove = atrPct * 1.5;
        const predictedChangePct = Math.max(-maxMove, Math.min(maxMove, rawPrediction));
        const predictedNav = Math.round((current * (1 + predictedChangePct / 100)) * 10000) / 10000;

        let direction: 'up' | 'down' | 'sideways';
        if (predictedChangePct > 0.15) direction = 'up';
        else if (predictedChangePct < -0.15) direction = 'down';
        else direction = 'sideways';

        const allFactors = [trendFactor, reversionFactor, rsiFactor, macdFactor, bbFactor, newsFactor, marketFactor, srFactor, crossTfFactor, gapFactor, capitalFlowFactor];
        const sameDirection = allFactors.filter(ft => (ft > 0) === (predictedChangePct > 0) && Math.abs(ft) > 0.02).length;
        let confidence = 30 + sameDirection * 7 + Math.abs(predictedChangePct) * 5;
        if (Math.abs(crossTfFactor) > 0.1) confidence += 8;
        if ((srFactor > 0) === (predictedChangePct > 0) && Math.abs(srFactor) > 0.05) confidence += 5;
        if ((capitalFlowFactor > 0) === (predictedChangePct > 0) && Math.abs(capitalFlowFactor) > 0.05) confidence += 6;
        confidence = Math.min(90, Math.max(20, confidence));

        const forecastData = {
          direction,
          predictedNav,
          predictedChangePct: Math.round(predictedChangePct * 100) / 100,
          confidence: Math.round(confidence),
          navRange: {
            high: Math.round((current + tech.atr14 * 1.2 * (predictedChangePct > 0 ? 1.3 : 1.0)) * 10000) / 10000,
            low: Math.round((current - tech.atr14 * 1.2 * (predictedChangePct < 0 ? 1.3 : 1.0)) * 10000) / 10000,
          },
          rsi: Math.round(tech.rsi14),
          trend: tech.trend,
          volatility: Math.round(risk.volatility20d * 10) / 10,
          flowScore: cfData?.flowScore ?? 0,
          flowLabel: cfData?.flowLabel ?? '',
        };
        results[f.id] = forecastData;

        // 持久化预测到数据库（target_date = 下一交易日）
        const targetDate = getNextTradingDay();
        const factorsJson = JSON.stringify({
          trend: Math.round(trendFactor * 1000) / 1000,
          reversion: Math.round(reversionFactor * 1000) / 1000,
          rsi: Math.round(rsiFactor * 1000) / 1000,
          macd: Math.round(macdFactor * 1000) / 1000,
          bollinger: Math.round(bbFactor * 1000) / 1000,
          news: Math.round(newsFactor * 1000) / 1000,
          market: Math.round(marketFactor * 1000) / 1000,
          supportResistance: Math.round(srFactor * 1000) / 1000,
          crossTimeframe: Math.round(crossTfFactor * 1000) / 1000,
          gap: Math.round(gapFactor * 1000) / 1000,
          capitalFlow: Math.round(capitalFlowFactor * 1000) / 1000,
        });
        try {
          db.prepare(`
            INSERT INTO forecasts (fund_id, target_date, direction, predicted_nav, predicted_change_pct, confidence, nav_range_high, nav_range_low, factors, base_nav, rsi, trend, volatility)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fund_id, target_date) DO UPDATE SET
              direction=excluded.direction, predicted_nav=excluded.predicted_nav,
              predicted_change_pct=excluded.predicted_change_pct, confidence=excluded.confidence,
              nav_range_high=excluded.nav_range_high, nav_range_low=excluded.nav_range_low,
              factors=excluded.factors, base_nav=excluded.base_nav, rsi=excluded.rsi,
              trend=excluded.trend, volatility=excluded.volatility, created_at=datetime('now')
          `).run(f.id, targetDate, direction, predictedNav, forecastData.predictedChangePct,
            forecastData.confidence, forecastData.navRange.high, forecastData.navRange.low,
            factorsJson, current, forecastData.rsi, tech.trend, forecastData.volatility);
        } catch { /* ignore save errors */ }
      } catch { /* skip failed fund */ }
    }));

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: '批量预测失败: ' + err.message });
  }
});

// ============================================================
// 预测辅助函数
// ============================================================

function getNextTradingDay(): string {
  const now = new Date();
  const d = new Date(now);
  // 15:00前预测的是今天，15:00后预测明天
  if (d.getHours() >= 15) d.setDate(d.getDate() + 1);
  // 跳过周末
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// 自动复盘：对比预测与实际
// ============================================================

const factorLabels: Record<string, string> = {
  trend: '趋势动量', reversion: '均值回归', rsi: 'RSI', macd: 'MACD',
  bollinger: '布林带', news: '消息面', market: '大盘环境',
  supportResistance: '支撑阻力', crossTimeframe: '跨周期确认', gap: '缺口回补',
  capitalFlow: '资金流向',
};

function generateReviewAnalysis(
  forecast: any,
  actualNav: number,
  actualChangePct: number,
): string {
  const lines: string[] = [];
  const dirCorrect = (forecast.direction === 'up' && actualChangePct > 0.15)
    || (forecast.direction === 'down' && actualChangePct < -0.15)
    || (forecast.direction === 'sideways' && Math.abs(actualChangePct) <= 0.15);
  const errorPct = Math.abs(forecast.predicted_change_pct - actualChangePct);
  const withinRange = actualNav >= forecast.nav_range_low && actualNav <= forecast.nav_range_high;

  // 总体评价
  if (dirCorrect && errorPct < 0.3) {
    lines.push(`预测准确：方向正确，误差仅${errorPct.toFixed(2)}%`);
  } else if (dirCorrect) {
    lines.push(`方向正确但幅度偏差${errorPct.toFixed(2)}%：预测${forecast.predicted_change_pct > 0 ? '+' : ''}${forecast.predicted_change_pct.toFixed(2)}%，实际${actualChangePct >= 0 ? '+' : ''}${actualChangePct.toFixed(2)}%`);
  } else {
    lines.push(`方向错误：预测${forecast.direction === 'up' ? '上涨' : forecast.direction === 'down' ? '下跌' : '横盘'}${forecast.predicted_change_pct >= 0 ? '+' : ''}${forecast.predicted_change_pct.toFixed(2)}%，实际${actualChangePct >= 0 ? '+' : ''}${actualChangePct.toFixed(2)}%`);
  }

  if (!withinRange) {
    lines.push(`实际净值${actualNav.toFixed(4)}超出预测区间[${forecast.nav_range_low.toFixed(4)}, ${forecast.nav_range_high.toFixed(4)}]`);
  }

  // 因子归因分析
  let factors: Record<string, number> = {};
  try { factors = JSON.parse(forecast.factors || '{}'); } catch {}
  const actualDirection = actualChangePct > 0 ? 1 : actualChangePct < 0 ? -1 : 0;

  const correct: string[] = [];
  const wrong: string[] = [];
  for (const [key, value] of Object.entries(factors)) {
    if (Math.abs(value) < 0.01) continue;
    const label = factorLabels[key] || key;
    const factorDir = value > 0 ? 1 : -1;
    if (factorDir === actualDirection || actualDirection === 0) {
      correct.push(`${label}(${value > 0 ? '+' : ''}${value.toFixed(3)})`);
    } else {
      wrong.push(`${label}(${value > 0 ? '+' : ''}${value.toFixed(3)})`);
    }
  }

  if (correct.length > 0) lines.push(`正确因子：${correct.join('、')}`);
  if (wrong.length > 0) lines.push(`误判因子：${wrong.join('、')}`);

  // 主要误差来源
  if (!dirCorrect && wrong.length > 0) {
    const sorted = Object.entries(factors)
      .filter(([, v]) => Math.abs(v) > 0.01)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const biggestWrong = sorted.find(([, v]) => (v > 0 ? 1 : -1) !== actualDirection);
    if (biggestWrong) {
      const label = factorLabels[biggestWrong[0]] || biggestWrong[0];
      lines.push(`主要误差来源：${label}因子（权重${biggestWrong[1] > 0 ? '+' : ''}${biggestWrong[1].toFixed(3)}）方向相反`);
    }
  }

  // 置信度反思
  if (!dirCorrect && forecast.confidence >= 70) {
    lines.push(`高置信度(${forecast.confidence}%)预测失败，需警惕过度自信`);
  } else if (dirCorrect && forecast.confidence < 40) {
    lines.push(`低置信度(${forecast.confidence}%)但方向正确，模型可能低估了信号强度`);
  }

  return lines.join('\n');
}

/** 执行自动复盘：查找所有未复盘的历史预测，用实际净值对比 */
export function autoReviewForecasts() {
  const today = getTodayStr();
  // 找到所有 target_date <= today 且尚未复盘的预测
  const unreviewed = db.prepare(`
    SELECT f.*, funds.code, funds.market_nav, funds.name as fund_name
    FROM forecasts f
    JOIN funds ON funds.id = f.fund_id
    WHERE f.target_date <= ?
      AND NOT EXISTS (SELECT 1 FROM forecast_reviews r WHERE r.forecast_id = f.id)
      AND funds.code != '' AND funds.code IS NOT NULL
    ORDER BY f.target_date
  `).all(today) as any[];

  let reviewed = 0;
  for (const fc of unreviewed) {
    // 需要获取 target_date 当天的实际净值
    // 先查 daily_snapshots，再 fallback 用 market_nav（如果target_date是今天）
    let actualNav = 0;
    const snapshot = db.prepare(
      'SELECT market_nav FROM daily_snapshots WHERE fund_id = ? AND date = ?'
    ).get(fc.fund_id, fc.target_date) as any;
    if (snapshot && snapshot.market_nav > 0) {
      actualNav = snapshot.market_nav;
    } else if (fc.target_date === today && fc.market_nav > 0) {
      actualNav = fc.market_nav;
    }
    if (actualNav <= 0) continue; // 实际净值尚不可用，跳过

    const baseNav = fc.base_nav > 0 ? fc.base_nav : actualNav;
    const actualChangePct = baseNav > 0 ? ((actualNav - baseNav) / baseNav) * 100 : 0;
    const dirCorrect = (fc.direction === 'up' && actualChangePct > 0.15)
      || (fc.direction === 'down' && actualChangePct < -0.15)
      || (fc.direction === 'sideways' && Math.abs(actualChangePct) <= 0.15);
    const errorPct = Math.abs(fc.predicted_change_pct - actualChangePct);
    const withinRange = actualNav >= (fc.nav_range_low || 0) && actualNav <= (fc.nav_range_high || Infinity);

    const analysis = generateReviewAnalysis(fc, actualNav, actualChangePct);

    try {
      db.prepare(`
        INSERT INTO forecast_reviews (forecast_id, fund_id, target_date, actual_nav, actual_change_pct, direction_correct, error_pct, within_range, analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fund_id, target_date) DO UPDATE SET
          actual_nav=excluded.actual_nav, actual_change_pct=excluded.actual_change_pct,
          direction_correct=excluded.direction_correct, error_pct=excluded.error_pct,
          within_range=excluded.within_range, analysis=excluded.analysis, created_at=datetime('now')
      `).run(fc.id, fc.fund_id, fc.target_date, r4(actualNav), Math.round(actualChangePct * 100) / 100,
        dirCorrect ? 1 : 0, Math.round(errorPct * 100) / 100, withinRange ? 1 : 0, analysis);
      reviewed++;
    } catch { /* ignore */ }
  }
  return reviewed;
}

// ============================================================
// 复盘端点
// ============================================================

// 获取复盘摘要（最近N天的统计 + 最近复盘记录）
router.get('/forecast-reviews/summary', async (req: Request, res: Response) => {
  try {
    const days = Number(req.query.days) || 30;
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const since = sinceDate.toISOString().slice(0, 10);

    // 总体统计
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(direction_correct) as correct,
        AVG(error_pct) as avg_error,
        SUM(within_range) as in_range
      FROM forecast_reviews WHERE target_date >= ?
    `).get(since) as any;

    // 按基金统计准确率
    const byFund = db.prepare(`
      SELECT r.fund_id, f.name, f.code, f.color,
        COUNT(*) as total,
        SUM(r.direction_correct) as correct,
        AVG(r.error_pct) as avg_error,
        SUM(r.within_range) as in_range
      FROM forecast_reviews r
      JOIN funds f ON f.id = r.fund_id
      WHERE r.target_date >= ?
      GROUP BY r.fund_id
      ORDER BY CAST(r.correct AS REAL) / MAX(r.total, 1) DESC
    `).all(since) as any[];

    // 最近10条复盘
    const recent = db.prepare(`
      SELECT r.*, f.name as fund_name, f.code as fund_code, f.color as fund_color,
        fc.direction, fc.predicted_nav, fc.predicted_change_pct, fc.confidence, fc.factors
      FROM forecast_reviews r
      JOIN funds f ON f.id = r.fund_id
      JOIN forecasts fc ON fc.id = r.forecast_id
      ORDER BY r.target_date DESC, r.fund_id
      LIMIT 20
    `).all() as any[];

    // 因子准确率统计
    const allReviews = db.prepare(`
      SELECT r.actual_change_pct, fc.factors
      FROM forecast_reviews r
      JOIN forecasts fc ON fc.id = r.forecast_id
      WHERE r.target_date >= ? AND fc.factors IS NOT NULL
    `).all(since) as any[];

    const factorStats: Record<string, { correct: number; wrong: number; total: number }> = {};
    for (const rv of allReviews) {
      let factors: Record<string, number> = {};
      try { factors = JSON.parse(rv.factors || '{}'); } catch { continue; }
      const actualDir = rv.actual_change_pct > 0 ? 1 : rv.actual_change_pct < 0 ? -1 : 0;
      for (const [key, value] of Object.entries(factors)) {
        if (Math.abs(value) < 0.01) continue;
        if (!factorStats[key]) factorStats[key] = { correct: 0, wrong: 0, total: 0 };
        factorStats[key].total++;
        const fDir = value > 0 ? 1 : -1;
        if (fDir === actualDir || actualDir === 0) factorStats[key].correct++;
        else factorStats[key].wrong++;
      }
    }
    const factorAccuracy = Object.entries(factorStats).map(([key, s]) => ({
      factor: key,
      label: factorLabels[key] || key,
      total: s.total,
      correct: s.correct,
      accuracy: s.total > 0 ? Math.round(s.correct / s.total * 100) : 0,
    })).sort((a, b) => b.accuracy - a.accuracy);

    res.json({
      stats: {
        total: stats.total || 0,
        correct: stats.correct || 0,
        accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
        avgError: Math.round((stats.avg_error || 0) * 100) / 100,
        inRange: stats.in_range || 0,
        inRangePct: stats.total > 0 ? Math.round((stats.in_range / stats.total) * 100) : 0,
      },
      byFund: byFund.map(f => ({
        ...f,
        accuracy: f.total > 0 ? Math.round((f.correct / f.total) * 100) : 0,
        avg_error: Math.round((f.avg_error || 0) * 100) / 100,
        inRangePct: f.total > 0 ? Math.round((f.in_range / f.total) * 100) : 0,
      })),
      factorAccuracy,
      recent: recent.map(r => ({
        ...r,
        factors: undefined, // 不返回原始JSON
        factorsParsed: (() => { try { return JSON.parse(r.factors || '{}'); } catch { return {}; } })(),
      })),
      days,
    });
  } catch (err: any) {
    res.status(500).json({ error: '获取复盘数据失败: ' + err.message });
  }
});

// 手动触发复盘
router.post('/forecast-reviews/run', async (_req: Request, res: Response) => {
  try {
    const reviewed = autoReviewForecasts();
    res.json({ success: true, reviewed });
  } catch (err: any) {
    res.status(500).json({ error: '复盘失败: ' + err.message });
  }
});

// 获取单个基金的预测历史
router.get('/forecasts/fund/:id', async (req: Request, res: Response) => {
  try {
    const fundId = Number(req.params.id);
    const limit = Number(req.query.limit) || 30;
    const rows = db.prepare(`
      SELECT f.*, r.actual_nav, r.actual_change_pct, r.direction_correct, r.error_pct, r.within_range, r.analysis
      FROM forecasts f
      LEFT JOIN forecast_reviews r ON r.forecast_id = f.id
      WHERE f.fund_id = ?
      ORDER BY f.target_date DESC
      LIMIT ?
    `).all(fundId, limit) as any[];

    res.json(rows.map(r => ({
      ...r,
      factors: (() => { try { return JSON.parse(r.factors || '{}'); } catch { return {}; } })(),
    })));
  } catch (err: any) {
    res.status(500).json({ error: '获取预测历史失败: ' + err.message });
  }
});

export default router;
