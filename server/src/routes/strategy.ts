import { Router, Request, Response } from 'express';
import db from '../db';
import { fetchFundamental, fetchFundHoldings, fetchSectorNews, fetchRedeemFees, getRedeemFeeRate, inferSectorKeyword, scoreNewsSentiment, scoreFundamental, checkSectorExposure, fetchCapitalFlow, fetchWithTimeout, fetchGeopoliticalRisk, fetchMarketSentiment } from '../datasource';
import type { CapitalFlowData, GeopoliticalRisk } from '../datasource';

const router = Router();

// ============================================================
// 模型版本号
// ============================================================
const FORECAST_MODEL_VERSION = 'v7.5';  // 预测模型版本（v7.5: 港股休市+黄金专属因子+地缘衰减）
const DECISION_MODEL_VERSION = 'v7.5';  // 决策模型版本（v7.5: 修复6大漏洞 — 熔断主动卖出+euphoria避险豁免+capitulation门槛+冷却期+组合防御+越跌越买限制）

// ============================================================
// v7.0 工具函数
// ============================================================
/** sigmoid软化: 硬阈值→连续衰减, center=阈值中心, steepness=陡峭度 */
function sigmoid(x: number, center: number, steepness: number = 0.15): number {
  return 1 / (1 + Math.exp(-steepness * (x - center)));
}
/** 组合级风控: 查询今日已执行的买入总额 */
function getTodayBuyTotal(): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(shares * price), 0) as total FROM transactions WHERE type = 'buy' AND date = ?"
  ).get(today) as any;
  return row?.total || 0;
}
/** [v7.4] 组合总现金(未投资金额估算: 总成本 - 总市值的差额不算, 用总成本的剩余比) */
function getPortfolioCash(): number {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type='sell' THEN shares * price ELSE 0 END), 0) as total_cost
    FROM transactions t JOIN funds f ON t.fund_id = f.id WHERE f.deleted_at IS NULL
  `).get() as any;
  return row?.total_cost || 0;
}
/** [v7.4] 熔断状态机: 查询最近一次熔断触发记录 */
function getCircuitBreakerHistory(): { lastTriggeredDate: string | null; level: string | null } {
  const row = db.prepare(
    "SELECT date, json_extract(reasoning, '$[0]') as reason FROM decision_logs WHERE reasoning LIKE '%熔断%' ORDER BY date DESC LIMIT 1"
  ).get() as any;
  if (!row) return { lastTriggeredDate: null, level: null };
  return { lastTriggeredDate: row.date, level: row.reason?.includes('危急') ? 'critical' : 'review' };
}
/** 获取地缘风险+市场情绪的组合数据 */
async function fetchGeoWithSentiment() {
  const [geoRisk, sentiment] = await Promise.all([
    fetchGeopoliticalRisk(),
    fetchMarketSentiment(),
  ]);
  // 将情绪数据挂载到geoRisk上（通过类型扩展传递给computeForecastCore）
  (geoRisk as any)._sentiment = sentiment;
  return geoRisk;
}

/** [v7.4] 判断是否为避险资产(黄金类) */
function isHedgeAsset(fundName: string): boolean {
  return /黄金|gold/i.test(fundName);
}

/** [v7.5] 最近N天内同基金的卖出决策次数（冷却期用） */
function getRecentSellCount(fundId: number | string, days: number = 5): number {
  const since = new Date(); since.setDate(since.getDate() - days);
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM decision_logs WHERE fund_id = ? AND action = 'sell' AND date >= ?"
  ).get(fundId, since.toISOString().slice(0, 10)) as any;
  return row?.cnt || 0;
}

/** [v7.5] 最近N天内同基金的买入决策次数 */
function getRecentBuyCount(fundId: number | string, days: number = 7): number {
  const since = new Date(); since.setDate(since.getDate() - days);
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM decision_logs WHERE fund_id = ? AND action = 'buy' AND date >= ?"
  ).get(fundId, since.toISOString().slice(0, 10)) as any;
  return row?.cnt || 0;
}

/** [v7.5] 组合级系统性风险检测：>60%基金亏>10%时触发 */
function isSystemicCrisis(): boolean {
  const rows = db.prepare(`
    SELECT f.id,
      COALESCE(SUM(CASE WHEN t.type='buy' THEN t.shares*t.price ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN t.type='sell' THEN t.shares*t.price ELSE 0 END),0) +
      COALESCE(SUM(CASE WHEN t.type='dividend' THEN t.price ELSE 0 END),0) as cost,
      COALESCE(SUM(CASE WHEN t.type='buy' THEN t.shares ELSE 0 END),0) -
      COALESCE(SUM(CASE WHEN t.type='sell' THEN t.shares ELSE 0 END),0) as shares,
      f.market_nav
    FROM funds f LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL GROUP BY f.id HAVING shares > 0
  `).all() as any[];
  if (rows.length < 3) return false;
  const losing = rows.filter(r => {
    const mv = r.shares * (r.market_nav || 0);
    return r.cost > 0 && mv > 0 && ((r.cost - mv) / r.cost * 100) > 10;
  });
  return losing.length / rows.length > 0.6;
}
/** 组合总市值 */
function getPortfolioValue(): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN market_nav > 0 THEN (SELECT (COALESCE(SUM(CASE WHEN type='buy' THEN shares ELSE 0 END),0) - COALESCE(SUM(CASE WHEN type='sell' THEN shares ELSE 0 END),0)) FROM transactions WHERE fund_id = funds.id) * market_nav ELSE 0 END), 0) as total FROM funds WHERE deleted_at IS NULL"
  ).get() as any;
  return row?.total || 0;
}

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
    const res = await fetchWithTimeout(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
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
    const res = await fetchWithTimeout(url);
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
    const res = await fetchWithTimeout(url);
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
  // Wilder 指数平滑法（与通达信/同花顺一致）
  // 第一个周期用 SMA 初始化
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i]; else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  // 后续用 Wilder 平滑: avg = (prev * (period-1) + current) / period
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMACD(values: number[]): { dif: number; dea: number; histogram: number } {
  if (values.length < 26) return { dif: 0, dea: 0, histogram: 0 };
  const ema12 = calcEMA(values, 12);
  const ema26 = calcEMA(values, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = calcEMA(dif, 9); // 对全部DIF序列计算9周期EMA
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

// ============================================================
// 模型版本配置
// ============================================================
type ModelVersionId = 'v7.3' | 'v8.0' | 'v8.1';
interface ModelConfig {
  id: ModelVersionId;
  label: string;
  description: string;
  // 预测层
  streakTrending5: number;   // 趋势中连涨5+倍数
  streakTrending3: number;
  streakOther5: number;      // 非趋势连涨5+倍数
  streakOther3: number;
  atrLimitTrending: number;  // 趋势ATR限幅
  atrLimitDefault: number;
  // 决策层
  useSigmoid: boolean;       // sigmoid软化 vs 硬阈值
  trendModeThreshold: number; // 趋势模式compositeScore门槛
  lossBuyFloor: number;      // 亏损时最低买入compositeScore (-20=v6.2, -15=v7)
  circuitBreakerMode: 'single' | 'tiered'; // 单级25% vs 分级15/20/25%
  hasDailyBuyLimit: boolean; // 组合级日买入限额
  trailingDdSell: boolean;   // trailing drawdown卖出
  dynamicTPTrendMult: number; // 趋势止盈ATR倍数 (3=v6.2, 5=v7)
}

const MODEL_CONFIGS: Record<ModelVersionId, ModelConfig> = {
  // v6.2/v7.2/v7.4 已下线（被v8.0/v8.1全面覆盖，5年回测验证）
  'v7.3': {
    id: 'v7.3', label: 'v7.3 均衡冠军', description: '混合架构(sigmoid+硬底线), 卡尔玛3.05最优',
    streakTrending5: 1.20, streakTrending3: 1.08,
    streakOther5: 0.35, streakOther3: 0.80,  // 非趋势恢复v6.2强衰减
    atrLimitTrending: 3.5, atrLimitDefault: 2.5,
    useSigmoid: true, trendModeThreshold: 15,
    lossBuyFloor: -15, circuitBreakerMode: 'tiered',
    hasDailyBuyLimit: true, trailingDdSell: true, dynamicTPTrendMult: 5,
  },
  'v8.0': {
    id: 'v8.0', label: 'v8.0 非对称策略', description: '5年回测冠军: v7.3买入(趋势追踪)+v6.2卖出(快止损), 夏普0.441',
    // 买入层: v7.3参数（趋势加速，捕捉牛市）
    streakTrending5: 1.20, streakTrending3: 1.08,
    streakOther5: 0.35, streakOther3: 0.80,
    atrLimitTrending: 3.5, atrLimitDefault: 2.5,
    useSigmoid: true, trendModeThreshold: 15,
    lossBuyFloor: -15, circuitBreakerMode: 'tiered',
    hasDailyBuyLimit: true, trailingDdSell: true, dynamicTPTrendMult: 4,  // 从3提升到4，减少趋势截利
  },
  'v8.1': {
    id: 'v8.1', label: 'v8.1 动量守门员', description: '卡尔玛冠军: v6.2+动量过滤, 回撤最小(-14.4%), 6只基金冠军',
    // 底层: v6.2参数（硬阈值快止损）
    streakTrending5: 0.35, streakTrending3: 0.87,
    streakOther5: 0.35, streakOther3: 0.87,
    atrLimitTrending: 2.5, atrLimitDefault: 2.5,
    useSigmoid: false, trendModeThreshold: 999,
    lossBuyFloor: -30, circuitBreakerMode: 'tiered',  // 恢复tiered熔断(15/20/25%)
    hasDailyBuyLimit: false, trailingDdSell: false, dynamicTPTrendMult: 3,
  },
};

const DEFAULT_MODEL: ModelVersionId = 'v8.1';

// 获取可用模型列表（供前端）
function getAvailableModels() {
  return Object.values(MODEL_CONFIGS).map(m => ({ id: m.id, label: m.label, description: m.description }));
}

// 完整决策引擎核心函数（单基金）
async function computeDecision(fundId: number | string, realtimeNav: number, modelVersion?: ModelVersionId): Promise<any> {
  const modelCfg = MODEL_CONFIGS[modelVersion || DEFAULT_MODEL] || MODEL_CONFIGS[DEFAULT_MODEL];
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
  // 重仓股数据就绪后并行获取资金流向+地缘风险
  const [capitalFlow, geoRisk] = await Promise.all([
    fetchCapitalFlow(fund.name, (holdings as any)?.holdings),
    fetchGeoWithSentiment(),
  ]);

  const navValues = navHistory.map(p => p.nav);
  // 如果传入的实时NAV与历史最后一天不同，追加到序列（与forecast端点一致）
  if (nav > 0 && navValues.length > 0 && Math.abs(nav - navValues[navValues.length - 1]) > 0.0001) {
    navValues.push(nav);
  }
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
  // 五维综合评分（v6防御优先：竞技场验证市场40%权重夏普6.134远超技术50%的4.336）
  // 技术20% + 基本面20% + 市场环境30% + 消息面10% + 资金流向20%
  const compositeScore = Math.round(
    techScore * 0.20 + fundScore.score * 0.20 + market.marketScore * 0.30 + newsScore.score * 0.10 + flowScore * 0.20
  );

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
  // [v6修正] 五维共振：技术 + 基本面 + 市场环境 + 消息面 + 资金流向
  const dimSigns = [techScore > 10 ? 1 : techScore < -10 ? -1 : 0,
                    fundScore.score > 10 ? 1 : fundScore.score < -10 ? -1 : 0,
                    market.marketScore > 15 ? 1 : market.marketScore < -15 ? -1 : 0,
                    newsScore.score > 15 ? 1 : newsScore.score < -15 ? -1 : 0,
                    flowScore > 15 ? 1 : flowScore < -15 ? -1 : 0];
  const bullDims = dimSigns.filter(s => s > 0).length;
  const bearDims = dimSigns.filter(s => s < 0).length;
  const neutralDims = dimSigns.filter(s => s === 0).length;
  const allBull = dimSigns.every(s => s >= 0) && bullDims >= 3;    // 5维中至少3维看多
  const allBear = dimSigns.every(s => s <= 0) && bearDims >= 3;    // 5维中至少3维看空
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

  // === E4. 分级熔断 [v7.4: 有记忆的状态机] ===
  const totalLossPct = totalCost > 0 ? Math.max(0, (totalCost - marketValue) / totalCost * 100) : 0;
  type CircuitBreakerLevel = 'none' | 'review' | 'reduce' | 'critical';
  let cbLevel: CircuitBreakerLevel = 'none';
  if (modelCfg.circuitBreakerMode === 'tiered') {
    if (totalLossPct > 25) cbLevel = 'critical';
    else if (totalLossPct > 20) cbLevel = 'reduce';
    else if (totalLossPct > 15) cbLevel = 'review';

    // [v7.4 盲区1修复] 熔断状态机有记忆: 曾触发过熔断→需连续恢复才解锁
    // 防止假底反弹反复解锁买入
    if (cbLevel === 'none' && modelCfg.id === 'v7.4' || modelCfg.id === 'v8.0' || modelCfg.id === 'v8.1') {
      const cbHistory = getCircuitBreakerHistory();
      if (cbHistory.lastTriggeredDate) {
        const daysSinceCB = Math.round((Date.now() - new Date(cbHistory.lastTriggeredDate).getTime()) / 86400000);
        // 熔断后需冷却10天且亏损<12%才完全解锁, 否则维持review
        if (daysSinceCB < 10 || totalLossPct > 12) {
          cbLevel = 'review';
        }
      }
    }
  } else {
    if (totalLossPct > 25) cbLevel = 'review';
  }

  // === E5. 组合级风控 ===
  let dailyBuyRemaining = Infinity;
  let cashReserveLow = false;
  if (modelCfg.hasDailyBuyLimit) {
    const portfolioValue = getPortfolioValue();
    const todayBuyTotal = getTodayBuyTotal();
    const dailyBuyLimit = Math.max(portfolioValue * 0.10, 5000);
    dailyBuyRemaining = Math.max(0, dailyBuyLimit - todayBuyTotal);
    // [v7.4 盲区2修复] 现金占比下限: 已投资成本超过估算总资金80%时限制买入
    // 用总成本作为已投入资金的代理指标
    if (modelCfg.id === 'v7.4' || modelCfg.id === 'v8.0' || modelCfg.id === 'v8.1') {
      const totalInvested = getPortfolioCash();
      // 总投入>0时, 如果当前基金成本占总投入过高, 限制追加
      if (totalInvested > 0 && totalCost > totalInvested * 0.15) {
        // 单只基金占比>15%时, 买入缩减
        cashReserveLow = true;
      }
    }
  }

  // === F. 动态止盈线 ===
  const isTrending = technical.trend === 'strong_up' || technical.trend === 'up';
  const trailingMult = isTrending ? modelCfg.dynamicTPTrendMult : 3;
  const dynamicTakeProfit = Math.min(Math.max(atrPct * trailingMult, isTrending ? 15 : 8), stopProfit);

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

    // [v7 卖出精简] 趋势中仅2层(trailing stop + 反转), 非趋势保留网格
    if (cyclePhase === 'euphoria' && swingShares > 0) {
      // 层1: 极端过热
      // [v7.5 P0-2] 避险资产+地缘恐慌时 euphoria 降级处理（黄金不应因技术超买被大幅卖出）
      const isHedgeEuphoria = isHedgeAsset(fund.name);
      const geoFearEuphoria = geoRisk && geoRisk.riskScore <= -20;
      if (isHedgeEuphoria && geoFearEuphoria) {
        action = 'sell';
        opShares = r4(swingShares * 0.15 * sellCaution);
        confidence = 60; urgency = 'low';
        reasoning.push(`[v7.5避险豁免] 黄金过热（RSI ${technical.rsi14.toFixed(0)}）但地缘恐慌(${geoRisk!.riskScore})中，仅象征性止盈15%保留避险`);
      } else {
        action = 'sell';
        opShares = r4(swingShares * 0.85 * Math.min(contrarian, 2.0) * sellCaution);
        confidence = 85; urgency = 'high';
        reasoning.push(`[Marks] 周期过热（RSI ${technical.rsi14.toFixed(0)}），减仓${Math.round(85 * sellCaution)}%活仓`);
      }

    } else if (profitPct >= stopProfit && swingShares > 0) {
      // 层2: 硬止盈线
      // [v7.4 盲区4修复] 避险资产(黄金)止盈豁免: 危机中不卖避险仓位
      const isHedge = isHedgeAsset(fund.name);
      const geoFear = geoRisk && geoRisk.riskScore <= -30;
      if (isHedge && geoFear && (modelCfg.id === 'v7.4' || modelCfg.id === 'v8.0' || modelCfg.id === 'v8.1' || modelCfg.id === 'v8.0')) {
        // 黄金+地缘恐慌 → 延迟止盈, 仅卖30%锁定部分利润
        action = 'sell';
        const ratio = 0.3 * sellCaution;
        opShares = r4(swingShares * ratio);
        confidence = 65; urgency = 'low';
        reasoning.push(`[v7.4避险豁免] ${fund.name}为避险资产+地缘恐慌中，仅止盈30%保留避险仓位`);
      } else {
        action = 'sell';
        const ratio = (profitPct >= stopProfit * 1.5 ? 0.9 : 0.7) * sellCaution;
        opShares = r4(swingShares * ratio);
        confidence = 80; urgency = 'high';
        reasoning.push(`盈利${profitPct.toFixed(1)}%达止盈线${stopProfit}%，止盈${Math.round(ratio * 100)}%活仓`);
      }

    } else if (isTrending && swingShares > 0) {
      // [v7.1 趋势模式] 增加trailing drawdown退出
      if (compositeScore <= -10 && technical.macd.histogram < 0) {
        action = 'sell';
        const ratio = 0.5 * sellConviction * sellCaution;
        opShares = r4(swingShares * ratio);
        confidence = 70; urgency = 'high';
        reasoning.push(`[v7趋势反转] 综合${compositeScore}转空+MACD死叉，卖出${Math.round(ratio * 100)}%活仓`);
      } else if (riskMetrics.currentDrawdown > atrPct * 2) {
        // [v7.1] trailing drawdown: 回撤>2倍ATR → 部分止盈保护利润
        action = 'sell';
        const ratio = 0.25 * sellCaution;
        opShares = r4(swingShares * ratio);
        confidence = 65; urgency = 'medium';
        reasoning.push(`[v7.1 trailing] 趋势中回撤${riskMetrics.currentDrawdown.toFixed(1)}%>${(atrPct*2).toFixed(1)}%(2ATR)，保护性卖出25%活仓`);
      } else if (technical.bollingerBands.percentB < 35 && compositeScore > 0) {
        action = 'buy';
        opAmount = Math.round(rawBase * 1.0 * buyConviction * bf); // v7.1: 1.2→1.0 更保守
        opShares = r4(opAmount / nav);
        confidence = 70; urgency = 'medium';
        reasoning.push(`[v7趋势加仓] 趋势中回调（%B=${technical.bollingerBands.percentB.toFixed(0)}），加仓`);
      } else {
        action = 'hold'; confidence = 65;
        reasoning.push(`[v7趋势持有] 趋势未反转，持有等待（利润${profitPct.toFixed(1)}%继续奔跑）`);
      }

    } else if (profitPct >= dynamicTakeProfit && swingShares > 0) {
      // 非趋势: trailing stop
      action = 'sell';
      const overPct = profitPct - dynamicTakeProfit;
      const ratio = Math.min(0.3 + Math.floor(overPct / 5) * 0.2, 0.8) * sellCaution;
      opShares = r4(swingShares * ratio);
      confidence = 70; urgency = 'medium';
      reasoning.push(`[动态止盈] 盈利${profitPct.toFixed(1)}%达动态线${dynamicTakeProfit.toFixed(1)}%，卖${Math.round(ratio * 100)}%活仓`);

    } else if (compositeScore <= -10 && profitPct >= 1 && swingShares > 0) {
      // 非趋势: 信号转空
      action = 'sell'; opShares = r4(swingShares * 0.4 * sellConviction * sellCaution);
      confidence = 65; urgency = 'medium';
      reasoning.push(`[Soros] 信号转空（${compositeScore}分），快速锁利`);

    } else if (cyclePhase === 'recovery' || cyclePhase === 'expansion') {
      if (technical.bollingerBands.percentB < 40 && compositeScore > 0) {
        action = 'buy';
        opAmount = Math.round(rawBase * 1.0 * buyConviction * bf);
        opShares = r4(opAmount / nav);
        confidence = 65; urgency = 'medium';
        reasoning.push(`[Livermore] 上升趋势回调（%B=${technical.bollingerBands.percentB.toFixed(0)}），加活仓`);
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

    // [v7 分级熔断] critical→强制卖出50%活仓, reduce→暂停买入
    if (cbLevel === 'critical' && swingShares > 0) {
      action = 'sell';
      opShares = r4(swingShares * 0.5);
      confidence = 85; urgency = 'high';
      reasoning.push(`[v7熔断-危急] 总亏损${totalLossPct.toFixed(1)}%>25%，强制卖出50%活仓止损`);

    } else if (cbLevel === 'critical' && baseShares > 0) {
      action = 'sell';
      opShares = r4(baseShares * 0.3);
      confidence = 80; urgency = 'high';
      reasoning.push(`[v7熔断-危急] 总亏损${totalLossPct.toFixed(1)}%>25%且无活仓，减30%底仓`);

    // [索罗斯修正] 真正的卖出止损：超止损线+趋势strong_down+compositeScore极低→卖出活仓止损
    } else if (lossPct > stopLoss && compositeScore < -30 && technical.trend === 'strong_down' && swingShares > 0) {
      action = 'sell';
      opShares = r4(swingShares * 0.3);
      confidence = 65; urgency = 'high';
      reasoning.push(`[Soros止损] 亏${lossPct.toFixed(1)}%+趋势崩坏（${compositeScore}分），卖出30%活仓止损`);

    // [巴菲特修正] 底仓熔断：基本面极差+深亏→底仓也要减
    } else if (lossPct > 30 && fundScore.score < -20 && swingShares <= 0 && baseShares > 0) {
      action = 'sell';
      opShares = r4(baseShares * 0.3);
      confidence = 60; urgency = 'high';
      reasoning.push(`[底仓熔断] 亏${lossPct.toFixed(1)}%+基本面恶化（${fundScore.score}分），减30%底仓`);

    // [v7.5 P0-3] 分级熔断: review/reduce 主动卖出（不再只hold）
    } else if (cbLevel === 'reduce' && swingShares > 0) {
      action = 'sell';
      opShares = r4(swingShares * 0.4 * sellCaution);
      confidence = 75; urgency = 'high';
      reasoning.push(`[v7.5熔断-减仓] 亏${totalLossPct.toFixed(1)}%>20%，主动减仓40%活仓`);
    } else if (cbLevel === 'review' && swingShares > 0 && (compositeScore <= 0 || totalLossPct > 18)) {
      // review级：信号不积极(score<=0)或亏损>18%时卖出20%活仓
      action = 'sell';
      opShares = r4(swingShares * 0.2 * sellCaution);
      confidence = 65; urgency = 'medium';
      reasoning.push(`[v7.5熔断-审查] 亏${totalLossPct.toFixed(1)}%>15%+信号偏弱(${compositeScore})，减仓20%活仓`);
    } else if (cbLevel === 'reduce' || cbLevel === 'review') {
      action = 'hold'; confidence = 70; urgency = 'high';
      reasoning.push(`[v7.5熔断-${cbLevel}] 亏${totalLossPct.toFixed(1)}%，暂停买入观望`);

    // [v7.5 P0-1] Capitulation分步建仓：增加compositeScore门槛，不再无条件买入
    } else if (cyclePhase === 'capitulation' && compositeScore >= modelCfg.lossBuyFloor && (fundScore.score >= 0 || compositeScore >= -5)) {
      action = 'buy';
      // [v7.5] 深亏>12%时cap valueMultiplier到1.2，防止越跌越买
      const cappedVM = lossPct > 12 ? Math.min(valueMultiplier, 1.2) : valueMultiplier;
      const fullAmount = Math.round(rawBase * cycleMultiplier.capitulation * contrarian * buyConviction * cappedVM * bf);
      opAmount = Math.round(fullAmount * 0.3);
      opShares = r4(opAmount / nav);
      confidence = Math.min(70 + lossConfBoost, 85); urgency = 'high';
      reasoning.push(`[Soros试探] 恐慌探底+信号${compositeScore}>=${modelCfg.lossBuyFloor}，先投30%试探（¥${opAmount}/${fullAmount}）`);
    } else if (cyclePhase === 'capitulation') {
      // compositeScore太低或基本面差 → 不买入
      action = 'hold'; confidence = 50; urgency = 'medium';
      reasoning.push(`[v7.5反陷阱] 恐慌探底但信号过弱(${compositeScore})或基本面差(${fundScore.score})，不抄底`);
    } else if (cyclePhase === 'early_recovery' && compositeScore >= modelCfg.lossBuyFloor) {
      action = 'buy';
      const cappedVM = lossPct > 12 ? Math.min(valueMultiplier, 1.2) : valueMultiplier;
      opAmount = Math.round(rawBase * cycleMultiplier.early_recovery * cappedVM * buyConviction * bf * 0.7);
      opShares = r4(opAmount / nav);
      confidence = Math.min(75 + lossConfBoost, 90); urgency = 'high';
      reasoning.push(`[Marks确认] 复苏信号确认+信号${compositeScore}>=${modelCfg.lossBuyFloor}，加仓70%`);
    } else if (cyclePhase === 'early_recovery') {
      action = 'hold'; confidence = 50; urgency = 'medium';
      reasoning.push(`[v7.5反陷阱] 早期复苏但信号过弱(${compositeScore})，观望不追`);
    } else if (compositeScore >= 0) {
      action = 'buy';
      opAmount = Math.round(rawBase * valueMultiplier * buyConviction * cycleMultiplier[cyclePhase] * bf);
      opShares = r4(opAmount / nav);
      confidence = 60 + lossConfBoost; urgency = lossUrgency;
      reasoning.push(`[Graham] 价值平均：低于成本${lossPct.toFixed(1)}%，乘数${valueMultiplier.toFixed(1)}x`);
    } else if (compositeScore >= modelCfg.lossBuyFloor) {
      // 亏损偏空区: v6.2(-30~-20)小额买入, v7.2(-15~0)基本面过滤
      const fundOk = fundScore.score >= 0;
      if (modelCfg.useSigmoid) {
        // v7.2: 基本面好才买
        if (fundOk) {
          action = 'buy';
          opAmount = Math.round(rawBase * 0.5 * valueMultiplier * bf);
          opShares = r4(opAmount / nav);
          confidence = 50 + lossConfBoost; urgency = lossUrgency;
          reasoning.push(`[Lynch] 基本面尚可（${fundScore.score}分），小额逢低布局`);
        } else {
          action = 'hold'; confidence = 45; urgency = 'low';
          reasoning.push(`[观望] 评分${compositeScore}偏空+基本面弱，暂不加仓`);
        }
      } else {
        // v6.2: 继续小额买入
        const mult = fundOk ? 0.8 : 0.4;
        action = 'buy';
        opAmount = Math.round(rawBase * mult * valueMultiplier * bf);
        opShares = r4(opAmount / nav);
        confidence = 50 + lossConfBoost; urgency = lossUrgency;
        reasoning.push(`[Lynch] ${fundOk ? '基本面尚可，逢低布局' : '基本面也弱，谨慎小额'}`);
      }
    } else {
      // 低于lossBuyFloor: v6.2仍小额买入, v7.2观望
      if (modelCfg.useSigmoid) {
        action = 'hold'; confidence = 40; urgency = 'low';
        reasoning.push(`[观望] 综合评分${compositeScore}<${modelCfg.lossBuyFloor}，等待见底信号`);
      } else {
        action = 'buy';
        opAmount = Math.round(rawBase * 0.3 * Math.max(valueMultiplier, 1) * bf);
        opShares = r4(opAmount / nav);
        confidence = 40; urgency = 'low';
        reasoning.push(`[Graham] 偏空（${compositeScore}分），安全边际${lossPct.toFixed(1)}%，小额逆向买入`);
      }
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

  // [A股修正+v7] 7天赎回惩罚检查：紧急止损可覆盖赎回保护
  if (action === 'sell' && daysSinceLastBuy < 7) {
    const recentBuys = db.prepare(
      "SELECT COALESCE(SUM(shares), 0) as recent_shares FROM transactions WHERE fund_id = ? AND type = 'buy' AND date >= date('now', '-7 days')"
    ).get(fundId) as any;
    const recentBuyShares = recentBuys?.recent_shares || 0;
    const safeToSellShares = Math.max(0, holdingShares - recentBuyShares);
    // [v7] 紧急止损覆盖: 熔断级别critical 或 单日跌>3% → 接受1.5%费用
    const todayChange = navHistory.length >= 2 ? ((nav - navHistory[navHistory.length - 2]?.nav) / navHistory[navHistory.length - 2]?.nav * 100) : 0;
    const isEmergency = cbLevel === 'critical' || todayChange < -3;
    if (isEmergency && safeToSellShares <= 0) {
      // 紧急情况下仍然卖出，接受赎回费
      reasoning.push(`[v7紧急止损] 接受1.5%赎回费，止损优先于赎回保护（今日跌${todayChange.toFixed(1)}%）`);
    } else if (safeToSellShares <= 0) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[赎回保护] 全部持仓均为7天内买入（${recentBuyShares.toFixed(2)}份），赎回费1.5%，暂不卖出`);
    } else if (opShares > safeToSellShares) {
      opShares = r4(safeToSellShares);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[赎回保护] 7天内买入${recentBuyShares.toFixed(2)}份不可卖，仅卖出早期持仓${opShares}份`);
    }
  }

  // [v7.4 盲区2补充] 现金占比低时缩减买入
  if (action === 'buy' && opAmount > 0 && cashReserveLow) {
    opShares = r4(opShares * 0.5);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[v7.4集中度] 该基金占组合>15%，买入缩减50%分散风险`);
  }

  // [v7.5a] 卖出冷却期：5天内同基金sell不超2次
  // 豁免：critical熔断止损 + 高盈利(>20%)止盈 不受冷却限制
  if (action === 'sell' && opShares > 0) {
    const isCriticalSell = cbLevel === 'critical';
    const isHighProfitSell = (gainPct > 20);  // fix: 用gainPct替代可能未定义的profitPct
    if (!isCriticalSell && !isHighProfitSell) {
      const recentSells = getRecentSellCount(fundId, 5);
      if (recentSells >= 2) {
        action = 'hold'; opShares = 0; opAmount = 0;
        reasoning.push(`[v7.5冷却] 近5天已卖出${recentSells}次，暂停等待新信号`);
      }
    }
  }

  // [v7.5 P1] 买入冷却期：7天内同基金buy不超3次
  if (action === 'buy' && opAmount > 0) {
    const recentBuys = getRecentBuyCount(fundId, 7);
    if (recentBuys >= 3) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[v7.5冷却] 7天内已买入${recentBuys}次，暂停补仓避免过度集中`);
    }
  }

  // [v7.5 P1] 组合级系统性危机检测：>60%基金亏>10%时全局禁buy
  if (action === 'buy' && opAmount > 0 && isSystemicCrisis()) {
    action = 'hold'; opShares = 0; opAmount = 0;
    reasoning.push(`[v7.5组合防御] 超60%基金亏损>10%，系统性危机模式，全局暂停买入`);
  }

  // [v8.1a] FOMC会议周: 买入自动缩减50%（波动加大期间谨慎）
  if (action === 'buy' && opAmount > 0 && geoRisk && geoRisk.isFomcWeek) {
    opShares = r4(opShares * 0.5);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[v8.1a宏观] FOMC会议周，买入缩减50%防范波动`);
  }

  // [v8.1a] VIX高恐慌: 买入大幅缩减
  if (action === 'buy' && opAmount > 0 && geoRisk && geoRisk.vix && geoRisk.vix.value > 30) {
    const vixDecay = geoRisk.vix.value > 40 ? 0.2 : 0.4;
    opShares = r4(opShares * vixDecay);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[v8.1a宏观] VIX=${geoRisk.vix.value.toFixed(0)}高恐慌，买入缩减${Math.round((1-vixDecay)*100)}%`);
  }

  // [v8.1a] 动量守门员: sigmoid衰减（不再硬禁令）+ V型反转豁免
  if (action === 'buy' && opAmount > 0 && (modelCfg.id === 'v8.1')) {
    if (navValues.length >= 10) {
      const fundMom10 = ((navValues[navValues.length - 1] / navValues[navValues.length - 10]) - 1) * 100;
      if (fundMom10 < -1.0) {
        // V型反转检测: 近3日涨幅>2% + MACD柱由负转正 → 豁免动量禁令
        const recent3d = navValues.length >= 3 ? ((navValues[navValues.length-1] / navValues[navValues.length-4]) - 1) * 100 : 0;
        const isVReversal = recent3d > 2.0 && technical.macd.histogram > 0;
        if (isVReversal) {
          opShares = r4(opShares * 0.5); // V型���转允许半额买入
          opAmount = Math.round(opShares * nav);
          reasoning.push(`[v8.1a反转] 10日动量${fundMom10.toFixed(1)}%为负但近3日反弹${recent3d.toFixed(1)}%+MACD转正，半额试探`);
        } else {
          // sigmoid衰减: 动量越负衰减越强，但不完全归零
          const decay = Math.max(0.15, 1 / (1 + Math.exp(-0.8 * (Math.abs(fundMom10) - 3))));
          const keepRatio = 1 - decay; // mom=-1%→保留约85%, mom=-5%→保留约25%, mom=-8%→保留约15%
          opShares = r4(opShares * keepRatio);
          opAmount = Math.round(opShares * nav);
          reasoning.push(`[v8.1a动量] 10日动量${fundMom10.toFixed(1)}%，信号衰减至${Math.round(keepRatio*100)}%`);
        }
      }
    }
    // 大盘动量检查: 用当日大盘跌幅>1%时才缩减（修复P2: 0.5%过于敏感）
    if (action === 'buy' && opAmount > 0 && market && market.marketIndices) {
      const shIdx = market.marketIndices.find((idx: any) => idx.name === '上证指数');
      if (shIdx && shIdx.changePct < -1.0) {
        opShares = r4(opShares * 0.4);
        opAmount = Math.round(opShares * nav);
        reasoning.push(`[v8.1a大盘] 大盘跌${shIdx.changePct.toFixed(1)}%>1%，买入缩减60%`);
      }
    }
  }

  // === 预测整合（v6新增：决策与预测模型联动）===
  const forecast = computeForecastCore(navValues, technical, riskMetrics, newsScore, market, capitalFlow, geoRisk, fund.name);
  const fcDirLabel = forecast.direction === 'up' ? '上涨' : forecast.direction === 'down' ? '下跌' : '横盘';
  const fcGeoNote = geoRisk && geoRisk.signals.length > 0
    ? `，地缘${geoRisk.riskLevel === 'extreme_fear' ? '极度恐慌' : geoRisk.riskLevel === 'fear' ? '恐慌' : '中性'}（${geoRisk.riskDetail}）`
    : '';
  // 始终展示预测结果
  reasoning.push(`[明日预测] 预测明日${fcDirLabel}${forecast.predictedChangePct >= 0 ? '+' : ''}${forecast.predictedChangePct.toFixed(2)}%（置信${forecast.confidence}%）${fcGeoNote}`);

  // === v7 预测整合（sigmoid软化 + 趋势模式豁免）===
  // 趋势模式判定(由modelCfg.trendModeThreshold控制, v6.2=999禁用, v7.2=15)
  const isTrendMode = isTrending && technical.macd.histogram > 0 && compositeScore > modelCfg.trendModeThreshold;

  // 预测跌→买入调整(sigmoid模式 vs 硬阈值模式)
  if (action === 'buy' && forecast.direction === 'down' && opAmount > 0 && !isTrendMode && !modelCfg.useSigmoid) {
    // v6.2: 硬阈值拦截
    if (Math.abs(forecast.predictedChangePct) >= 1.0) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[预测拦截] 预测跌${Math.abs(forecast.predictedChangePct).toFixed(2)}%>1%，阻止买入`);
    } else if (Math.abs(forecast.predictedChangePct) > 0.3) {
      const reduction = Math.abs(forecast.predictedChangePct) > 0.6 ? 0.3 : 0.5;
      opShares = r4(opShares * reduction); opAmount = Math.round(opShares * nav);
      reasoning.push(`[预测调整] 预测跌→缩减买入至${Math.round(reduction * 100)}%`);
    }
  } else if (action === 'buy' && forecast.direction === 'down' && opAmount > 0 && !isTrendMode && modelCfg.useSigmoid) {
    const fcAbsPct = Math.abs(forecast.predictedChangePct);
    // sigmoid: 跌0.3%→衰减到85%, 跌1%→衰减到35%, 跌2%→衰减到8%
    const fcReduction = 1 - sigmoid(fcAbsPct, 0.8, 4);
    if (fcReduction < 0.15) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[v7预测] 预测跌${fcAbsPct.toFixed(2)}%→衰减${Math.round((1-fcReduction)*100)}%，阻止买入`);
    } else if (fcReduction < 0.9) {
      opShares = r4(opShares * fcReduction);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[v7预测] 预测跌${fcAbsPct.toFixed(2)}%→买入缩减至${Math.round(fcReduction*100)}%`);
    }
  }
  // 预测涨→缩减卖出
  if (action === 'sell' && forecast.direction === 'up' && Math.abs(forecast.predictedChangePct) > 0.3 && opShares > 0) {
    const reduction = Math.abs(forecast.predictedChangePct) > 1 ? 0.3 : 0.5;
    opShares = r4(opShares * reduction);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[预测调整] 预测明日涨→缩减卖出至${Math.round(reduction * 100)}%`);
  }
  // 预测确认
  if (action === 'buy' && forecast.direction === 'up' && forecast.predictedChangePct > 0.3) {
    reasoning.push(`[预测确认] 预测明日涨，买入时机合理`);
  }
  if (action === 'sell' && forecast.direction === 'down' && forecast.predictedChangePct < -0.3) {
    reasoning.push(`[预测确认] 预测明日跌，卖出时机合理`);
  }

  // [v7.4 盲区5] 赎回时滞提醒(forecast已计算)
  if (action === 'sell' && opShares > 0 && modelCfg.id === 'v7.4' || modelCfg.id === 'v8.0' || modelCfg.id === 'v8.1') {
    const estimatedDays = fund.code && /ETF|联接/.test(fund.name) ? 'T+1~T+2' : 'T+2~T+4';
    if (forecast.direction === 'down' && Math.abs(forecast.predictedChangePct) > 0.5) {
      reasoning.push(`[v7.4赎回时滞] 预计${estimatedDays}到账，期间可能再跌${(Math.abs(forecast.predictedChangePct) * 2).toFixed(1)}%`);
    }
  }

  // 布林带高位拦截(sigmoid vs 硬阈值)
  if (action === 'buy' && opAmount > 0 && !isTrendMode && !modelCfg.useSigmoid) {
    // v6.2: 硬阈值85
    if (technical.bollingerBands.percentB > 85) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[追高拦截] %B=${technical.bollingerBands.percentB.toFixed(0)}>85，禁止追高`);
    }
  } else if (action === 'buy' && opAmount > 0 && !isTrendMode && modelCfg.useSigmoid) {
    const pctB = technical.bollingerBands.percentB;
    // sigmoid: %B=70→衰减到95%, %B=85→衰减到50%, %B=100→衰减到10%
    const bbReduction = 1 - sigmoid(pctB, 85, 0.12);
    if (bbReduction < 0.15) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[v7布林] %B=${pctB.toFixed(0)}→衰减${Math.round((1-bbReduction)*100)}%，暂缓买入`);
    } else if (bbReduction < 0.85) {
      opShares = r4(opShares * bbReduction);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[v7布林] %B=${pctB.toFixed(0)}偏高→买入缩减至${Math.round(bbReduction*100)}%`);
    }
  } else if (action === 'buy' && isTrendMode && technical.bollingerBands.percentB > 85) {
    reasoning.push(`[v7趋势豁免] %B=${technical.bollingerBands.percentB.toFixed(0)}>85但趋势确认，允许买入`);
  }

  // [v7.3 混合架构] 硬底线层: 无论什么模式都生效（sigmoid之后的绝对保护）
  if (action === 'buy' && opAmount > 0 && technical.bollingerBands.percentB > 95) {
    action = 'hold'; opShares = 0; opAmount = 0;
    reasoning.push(`[v7.3硬底线] %B=${technical.bollingerBands.percentB.toFixed(0)}>95，绝对禁止追高`);
  }
  if (action === 'buy' && opAmount > 0 && technical.trendScore < -35) {
    opShares = r4(opShares * 0.25);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[v7.3硬底线] 趋势${technical.trendScore}<-35，硬性缩减至25%`);
  }

  // [v7] 地缘恐慌→sigmoid衰减买入
  if (action === 'buy' && geoRisk && geoRisk.riskScore <= -20 && opAmount > 0) {
    const geoReduction = 1 - sigmoid(Math.abs(geoRisk.riskScore), 40, 0.08);
    opShares = r4(opShares * geoReduction);
    opAmount = Math.round(opShares * nav);
    reasoning.push(`[v7地缘] 风险评分${geoRisk.riskScore}→买入缩减至${Math.round(geoReduction*100)}%`);
  }
  // [v7.4 盲区3修复] 地缘极度恐慌→主动卖出(不仅阻止买入)
  if (modelCfg.id === 'v7.4' || modelCfg.id === 'v8.0' || modelCfg.id === 'v8.1' && geoRisk && geoRisk.riskScore <= -70
      && action !== 'sell' && swingShares > 0 && !isHedgeAsset(fund.name)) {
    action = 'sell';
    opShares = r4(swingShares * 0.25);
    opAmount = Math.round(opShares * nav);
    confidence = 70; urgency = 'high';
    reasoning.push(`[v7.4地缘主动减仓] 极度恐慌(${geoRisk.riskScore})→主动卖出25%活仓避险`);
  }

  // [v7] 盈利+趋势崩坏→sigmoid衰减(替代硬阈值-30)
  if (action === 'buy' && gainPct > 3 && technical.trendScore < 0 && opAmount > 0) {
    // sigmoid: trendScore=0→无影响, -20→衰减到60%, -40→衰减到15%
    const trendReduction = 1 - sigmoid(Math.abs(technical.trendScore), 25, 0.12);
    if (trendReduction < 0.2) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[v7趋势] 盈利${gainPct.toFixed(1)}%+趋势${technical.trendScore}→持有等反转`);
    } else if (trendReduction < 0.85) {
      opShares = r4(opShares * trendReduction);
      opAmount = Math.round(opShares * nav);
      reasoning.push(`[v7趋势] 趋势${technical.trendScore}→买入缩减至${Math.round(trendReduction*100)}%`);
    }
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

  // 组合级日买入限额(仅v7.2启用)
  if (action === 'buy' && opAmount > 0 && dailyBuyRemaining < Infinity && opAmount > dailyBuyRemaining) {
    if (dailyBuyRemaining <= 0) {
      action = 'hold'; opShares = 0; opAmount = 0;
      reasoning.push(`[组合风控] 今日买入已达限额（组合10%），暂停`);
    } else {
      opAmount = Math.round(dailyBuyRemaining);
      opShares = r4(opAmount / nav);
      reasoning.push(`[v7组合风控] 今日剩余额度¥${Math.round(dailyBuyRemaining)}，缩减至限额内`);
    }
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
      market: { score: market.marketScore, regime: market.marketRegime },
      news: { score: newsScore.score, sentiment: newsScore.score > 20 ? '偏多' : newsScore.score < -20 ? '偏空' : '中性', bullish: newsScore.bullish, bearish: newsScore.bearish },
    },
    forecast: {
      direction: forecast.direction,
      predictedChangePct: forecast.predictedChangePct,
      confidence: forecast.confidence,
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
      circuitBreaker: cbLevel !== 'none',
      circuitBreakerLevel: cbLevel,
      totalLossPct: Math.round(totalLossPct * 10) / 10,
      daysSinceLastBuy,
      redeemFeeRate: Math.round(redeemFeeRate * 10000) / 100,
      redeemFeeLevels: redeemFeeLevels.map(l => ({ ...l, feeRate: l.feeRate })),
    },
    modelVersion: { forecast: FORECAST_MODEL_VERSION, decision: modelCfg.id, label: modelCfg.label },
    timestamp: new Date().toISOString(),
  };
}

/** 保存决策记录到数据库 */
function logDecision(fundId: number, decision: any) {
  try {
    const today = toLocalDateStr(new Date());
    db.prepare(`
      INSERT INTO decision_logs (fund_id, date, nav, action, shares, amount, confidence, urgency, composite_score, cycle_phase, fear_greed, reasoning, forecast_direction, forecast_change_pct, model_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fund_id, date, model_version) DO UPDATE SET
        nav=excluded.nav, action=excluded.action, shares=excluded.shares, amount=excluded.amount,
        confidence=excluded.confidence, urgency=excluded.urgency, composite_score=excluded.composite_score,
        cycle_phase=excluded.cycle_phase, fear_greed=excluded.fear_greed, reasoning=excluded.reasoning,
        forecast_direction=excluded.forecast_direction, forecast_change_pct=excluded.forecast_change_pct,
        created_at=datetime('now')
    `).run(
      fundId, today, decision.nav, decision.action, decision.shares, decision.amount,
      decision.confidence, decision.urgency, decision.compositeScore,
      decision.masterSignals?.cyclePhase || null, decision.masterSignals?.fearGreed || null,
      JSON.stringify(decision.reasoning),
      decision.forecast?.direction || null, decision.forecast?.predictedChangePct || null,
      DECISION_MODEL_VERSION
    );
  } catch { /* ignore save errors */ }
}

// 单基金决策端点
// 获取可用模型版本列表
router.get('/models', (_req: Request, res: Response) => {
  res.json({ models: getAvailableModels(), default: DEFAULT_MODEL });
});

router.get('/funds/:id/decision', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const realtimeNav = req.query.nav ? parseFloat(req.query.nav as string) : 0;
    const modelVersion = (req.query.model as ModelVersionId) || undefined;
    const result = await computeDecision(id, realtimeNav, modelVersion);
    logDecision(id, result);
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

    // 并行调用完整决策引擎(支持model参数)
    const batchModel = (req.query.model as ModelVersionId) || undefined;
    await Promise.all(funds.filter(f => f.holding_shares > 0).map(async (f) => {
      const nav = estimates[f.id] || 0;
      try {
        const decision = await computeDecision(f.id, nav, batchModel);
        logDecision(f.id, decision);
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
// 今日交易分析：评估每笔交易的质量
// ============================================================
router.get('/trade-analysis', async (req: Request, res: Response) => {
  try {
    const date = (req.query.date as string) || toLocalDateStr(new Date());

    // 获取指定日期的所有交易
    const txs = db.prepare(`
      SELECT t.*, f.name as fund_name, f.code as fund_code, f.color as fund_color,
        f.market_nav, f.stop_profit_pct, f.stop_loss_pct, f.base_position_pct
      FROM transactions t
      JOIN funds f ON f.id = t.fund_id
      WHERE t.date = ? AND (t.notes IS NULL OR t.notes NOT LIKE '%历史持仓%')
      ORDER BY t.created_at DESC
    `).all(date) as any[];

    if (txs.length === 0) {
      res.json({ date, trades: [], summary: { total: 0, good: 0, neutral: 0, bad: 0, totalScore: 0 } });
      return;
    }

    // === 按基金去重，并行预取所有数据（核心优化：N笔交易→M只基金的数据请求）===
    const uniqueFunds = new Map<number, { code: string; name: string }>();
    for (const tx of txs) {
      if (tx.fund_code && !uniqueFunds.has(tx.fund_id)) {
        uniqueFunds.set(tx.fund_id, { code: tx.fund_code, name: tx.fund_name });
      }
    }

    // 并行获取：地缘风险(1次) + 每只基金的NAV历史和市场数据
    const fundDataCache = new Map<number, { navValues: number[]; tech: TechnicalIndicators; risk: RiskMetrics; marketCtx: SectorInfo | null; forecast: ForecastCoreResult }>();
    const geoRiskPromise = fetchGeoWithSentiment();
    const fundPromises = Array.from(uniqueFunds.entries()).map(async ([fundId, { code, name }]) => {
      const [navHistory, marketCtx] = await Promise.all([
        fetchNavHistory(code, 60),
        fetchMarketContext(name),
      ]);
      const navValues = navHistory.map(p => p.nav);
      if (navValues.length >= 10) {
        const tech = calcTechnical(navValues);
        const risk = calcRisk(navValues);
        const geoRisk = await geoRiskPromise;
        const newsScore = scoreNewsSentiment([]);
        const forecast = computeForecastCore(navValues, tech, risk, newsScore, marketCtx, null, geoRisk, name);
        fundDataCache.set(fundId, { navValues, tech, risk, marketCtx, forecast });
      }
    });
    const [geoRisk] = await Promise.all([geoRiskPromise, ...fundPromises]);

    // 逐笔分析（纯计算，无网络请求）
    const trades: any[] = [];
    for (const tx of txs) {
      const analysis: string[] = [];
      let score = 0;

      const cached = fundDataCache.get(tx.fund_id);
      const txNav = tx.price;
      const txAmount = tx.type === 'dividend' ? tx.price : tx.shares * tx.price;

      if (tx.type === 'dividend') {
        score = 50;
        analysis.push('分红到账，被动收入');
        trades.push({
          id: tx.id, fundName: tx.fund_name, fundCode: tx.fund_code, color: tx.fund_color,
          type: tx.type, shares: tx.shares, price: tx.price, amount: txAmount,
          score, grade: 'good', analysis, details: {},
        });
        continue;
      }

      if (!cached) {
        analysis.push('历史数据不足，无法评估');
        trades.push({
          id: tx.id, fundName: tx.fund_name, fundCode: tx.fund_code, color: tx.fund_color,
          type: tx.type, shares: tx.shares, price: tx.price, amount: txAmount,
          score: 0, grade: 'neutral', analysis, details: {},
        });
        continue;
      }

      const { tech, risk, forecast, marketCtx } = cached;

      // === 1. 价格位置评估（相对布林带/均线）===
      const pctB = tech.bollingerBands.percentB;
      const vsMA20 = tech.ma20 > 0 ? ((txNav - tech.ma20) / tech.ma20) * 100 : 0;
      const vsMA5 = tech.ma5 > 0 ? ((txNav - tech.ma5) / tech.ma5) * 100 : 0;

      if (tx.type === 'buy') {
        // 买入：越低越好
        if (pctB < 10) { score += 25; analysis.push(`在布林下轨买入（%B=${pctB.toFixed(0)}），位置极佳`); }
        else if (pctB < 30) { score += 15; analysis.push(`在布林中下区买入（%B=${pctB.toFixed(0)}），位置不错`); }
        else if (pctB > 80) { score -= 20; analysis.push(`在布林上轨附近买入（%B=${pctB.toFixed(0)}），追高风险`); }
        else if (pctB > 60) { score -= 5; analysis.push(`在布林中上区买入（%B=${pctB.toFixed(0)}），价格偏高`); }
        else { analysis.push(`在布林中轨附近买入（%B=${pctB.toFixed(0)}），价格适中`); }

        if (vsMA20 < -3) { score += 15; analysis.push(`低于MA20 ${Math.abs(vsMA20).toFixed(1)}%，成本优势明显`); }
        else if (vsMA20 > 3) { score -= 10; analysis.push(`高于MA20 ${vsMA20.toFixed(1)}%，追高风险`); }

        // 支撑位附近买入加分
        if (tech.support > 0 && txNav <= tech.support * 1.01) {
          score += 15; analysis.push(`在支撑位${tech.support.toFixed(4)}附近买入，技术面有支撑`);
        }
      } else {
        // 卖出：越高越好
        if (pctB > 90) { score += 25; analysis.push(`在布林上轨卖出（%B=${pctB.toFixed(0)}），时机极佳`); }
        else if (pctB > 70) { score += 15; analysis.push(`在布林中上区卖出（%B=${pctB.toFixed(0)}），时机不错`); }
        else if (pctB < 20) { score -= 20; analysis.push(`在布林下轨附近卖出（%B=${pctB.toFixed(0)}），割肉风险`); }
        else if (pctB < 40) { score -= 5; analysis.push(`在布林中下区卖出（%B=${pctB.toFixed(0)}），价格偏低`); }
        else { analysis.push(`在布林中轨附近卖出（%B=${pctB.toFixed(0)}），价格适中`); }

        if (vsMA20 > 3) { score += 15; analysis.push(`高于MA20 ${vsMA20.toFixed(1)}%，卖在高位`); }
        else if (vsMA20 < -3) { score -= 10; analysis.push(`低于MA20 ${Math.abs(vsMA20).toFixed(1)}%，低位出货`); }

        // 阻力位附近卖出加分
        if (tech.resistance > 0 && txNav >= tech.resistance * 0.99) {
          score += 15; analysis.push(`在阻力位${tech.resistance.toFixed(4)}附近卖出，压力区出货`);
        }
      }

      // === 2. RSI 时机评估 ===
      if (tx.type === 'buy') {
        if (tech.rsi14 < 30) { score += 15; analysis.push(`RSI=${tech.rsi14.toFixed(0)} 超卖区买入，逆向价值买入`); }
        else if (tech.rsi14 > 70) { score -= 15; analysis.push(`RSI=${tech.rsi14.toFixed(0)} 超买区买入，追高风险大`); }
      } else {
        if (tech.rsi14 > 70) { score += 15; analysis.push(`RSI=${tech.rsi14.toFixed(0)} 超买区卖出，高位止盈`); }
        else if (tech.rsi14 < 30) { score -= 15; analysis.push(`RSI=${tech.rsi14.toFixed(0)} 超卖区卖出，恐慌割肉`); }
      }

      // === 3. 趋势一致性 ===
      if (tx.type === 'buy' && tech.trend === 'strong_down') {
        score -= 10; analysis.push(`均线空头排列（趋势${tech.trendScore}），逆势买入需谨慎`);
      } else if (tx.type === 'buy' && (tech.trend === 'up' || tech.trend === 'strong_up') && pctB < 50) {
        score += 10; analysis.push(`上升趋势回调买入，顺势操作`);
      }
      if (tx.type === 'sell' && tech.trend === 'strong_up') {
        score -= 5; analysis.push(`强势上涨中卖出，可能踏空`);
      }

      // === 4. 预测模型一致性（使用预取的forecast结果）===
      if (tx.type === 'buy' && forecast.direction === 'down' && Math.abs(forecast.predictedChangePct) > 0.3) {
        score -= 15;
        analysis.push(`预测明日跌${Math.abs(forecast.predictedChangePct).toFixed(2)}%，今天买入不如等明天低点`);
      } else if (tx.type === 'buy' && forecast.direction === 'up') {
        score += 10;
        analysis.push(`预测明日涨${forecast.predictedChangePct.toFixed(2)}%，买入时机合理`);
      }
      if (tx.type === 'sell' && forecast.direction === 'up' && Math.abs(forecast.predictedChangePct) > 0.3) {
        score -= 15;
        analysis.push(`预测明日涨${forecast.predictedChangePct.toFixed(2)}%，今天卖出不如等明天高点`);
      } else if (tx.type === 'sell' && forecast.direction === 'down') {
        score += 10;
        analysis.push(`预测明日跌${Math.abs(forecast.predictedChangePct).toFixed(2)}%，卖出时机合理`);
      }

      // === 5. 地缘风险环境 ===
      if (geoRisk && geoRisk.riskScore <= -30) {
        if (tx.type === 'buy') {
          score -= 10;
          analysis.push(`地缘恐慌（${geoRisk.riskLevel}，评分${geoRisk.riskScore}），恐慌期买入风险较高`);
        } else {
          score += 10;
          analysis.push(`地缘恐慌期减仓，风险管理合理`);
        }
      }

      // === 6. 持仓盈亏状态 ===
      const posRow = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
          COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
          COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
        FROM transactions WHERE fund_id = ?
      `).get(tx.fund_id) as any;
      const holdingShares = posRow.holding_shares;
      const costNav = holdingShares > 0 && posRow.cost_basis > 0 ? posRow.cost_basis / holdingShares : 0;
      const gainPct = costNav > 0 ? ((txNav - costNav) / costNav) * 100 : 0;
      const stopProfit = tx.stop_profit_pct || 20;
      const stopLoss = tx.stop_loss_pct || 15;

      if (tx.type === 'buy' && gainPct < -5) {
        score += 10; analysis.push(`亏损${Math.abs(gainPct).toFixed(1)}%时补仓摊低成本，价值策略`);
      }
      if (tx.type === 'sell' && gainPct >= stopProfit) {
        score += 20; analysis.push(`盈利${gainPct.toFixed(1)}%达止盈线${stopProfit}%，纪律性止盈`);
      } else if (tx.type === 'sell' && gainPct <= -stopLoss) {
        score += 5; analysis.push(`亏损${Math.abs(gainPct).toFixed(1)}%触及止损线，虽然痛苦但纪律性好`);
      } else if (tx.type === 'sell' && gainPct > 0 && gainPct < 3) {
        score -= 5; analysis.push(`仅盈利${gainPct.toFixed(1)}%就卖出，利润空间不足`);
      }

      // === 7. 波动率环境 ===
      if (risk.volatility20d > 30 && tx.type === 'buy') {
        score -= 5; analysis.push(`高波动环境（${risk.volatility20d.toFixed(0)}%），建议减小单笔金额`);
      }

      // 综合评级
      score = Math.max(-100, Math.min(100, score));
      const grade = score >= 30 ? 'excellent' : score >= 10 ? 'good' : score >= -10 ? 'neutral' : score >= -30 ? 'poor' : 'bad';
      const gradeLabel = { excellent: '优秀', good: '良好', neutral: '一般', poor: '欠佳', bad: '不佳' }[grade];

      trades.push({
        id: tx.id,
        fundName: tx.fund_name, fundCode: tx.fund_code, color: tx.fund_color,
        type: tx.type, shares: tx.shares, price: tx.price, amount: Math.round(txAmount * 100) / 100,
        score, grade, gradeLabel,
        analysis,
        details: {
          bollinger: { percentB: Math.round(pctB), position: pctB < 30 ? '低位' : pctB > 70 ? '高位' : '中位' },
          rsi: Math.round(tech.rsi14),
          trend: tech.trend, trendScore: tech.trendScore,
          vsMA20: Math.round(vsMA20 * 100) / 100,
          forecast: { direction: forecast.direction, changePct: forecast.predictedChangePct },
          costNav: r4(costNav), gainPct: Math.round(gainPct * 100) / 100,
          volatility: Math.round(risk.volatility20d * 10) / 10,
          geoRisk: geoRisk ? { score: geoRisk.riskScore, level: geoRisk.riskLevel } : null,
        },
      });
    }

    // 汇总
    const good = trades.filter(t => t.score >= 10).length;
    const neutral = trades.filter(t => t.score > -10 && t.score < 10).length;
    const bad = trades.filter(t => t.score <= -10).length;
    const avgScore = trades.length > 0 ? Math.round(trades.reduce((s, t) => s + t.score, 0) / trades.length) : 0;

    res.json({
      date,
      trades: trades.sort((a, b) => b.score - a.score),
      summary: {
        total: trades.length,
        good, neutral, bad,
        avgScore,
        verdict: avgScore >= 20 ? '今日交易整体优秀' : avgScore >= 5 ? '今日交易整体良好' : avgScore >= -5 ? '今日交易中规中矩' : '今日交易需要反思',
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: '交易分析失败: ' + err.message });
  }
});

// ============================================================
// 明日行情预测核心计算（供 forecast 端点和 computeDecision 共用）
// ============================================================
interface ForecastCoreResult {
  predictedChangePct: number;
  direction: 'up' | 'down' | 'sideways';
  confidence: number;
  factors: Record<string, number>;
}

function computeForecastCore(
  navValues: number[],
  tech: TechnicalIndicators,
  risk: RiskMetrics,
  newsScore: { score: number },
  marketCtx: SectorInfo | null,
  capitalFlow: CapitalFlowData | null,
  geoRisk?: GeopoliticalRisk | null,
  fundName?: string,
): ForecastCoreResult {
  if (navValues.length < 5) return { predictedChangePct: 0, direction: 'sideways', confidence: 20, factors: {} };

  // [v7.5] 港股休市日检测：港股基金在港股休市日预测横盘
  const nextTD = getNextTradingDay();
  if (fundName && isHKFund(fundName) && isHKHoliday(nextTD)) {
    return { predictedChangePct: 0, direction: 'sideways', confidence: 95, factors: { hkClosed: 0 } };
  }

  const current = navValues[navValues.length - 1];
  const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;

  // 市场状态自适应检测
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
  const adaptTrendW = forecastRegime === 'trending' ? 0.796 : forecastRegime === 'volatile' ? 0.14 : 0.32;
  const adaptReversionW = forecastRegime === 'trending' ? 0.037 : forecastRegime === 'volatile' ? 0.28 : 0.18;
  const adaptBBMult = forecastRegime === 'ranging' ? 1.5 : 1.0;

  // 趋势动量因子
  const changes = navValues.slice(-10).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100);
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
  let trendFactor = 0;
  trendFactor += weightedMom * adaptTrendW;
  trendFactor += tech.trendScore * 0.015;
  // [v7.3] 连涨/连跌: 趋势加速×1.2, 非趋势恢复v6.2强衰减×0.35
  if (forecastRegime === 'trending') {
    if (Math.abs(streak) >= 5) trendFactor *= 1.20;
    else if (Math.abs(streak) >= 3) trendFactor *= 1.08;
  } else {
    if (Math.abs(streak) >= 5) trendFactor *= 0.35;  // v7.2:0.55 → v7.3:恢复v6.2的0.35
    else if (Math.abs(streak) >= 3) trendFactor *= 0.80;
  }

  // 均值回归因子
  const deviationFromMA20 = ((current - tech.ma20) / tech.ma20) * 100;
  const deviationFromMA5 = ((current - tech.ma5) / tech.ma5) * 100;
  let reversionFactor = 0;
  if (Math.abs(deviationFromMA20) > 2) {
    const sign = deviationFromMA20 > 0 ? -1 : 1;
    reversionFactor += sign * Math.sqrt(Math.abs(deviationFromMA20) - 2) * adaptReversionW;
  }
  if (Math.abs(deviationFromMA5) > 1.5) {
    const sign = deviationFromMA5 > 0 ? -1 : 1;
    reversionFactor += sign * (Math.abs(deviationFromMA5) - 1.5) * 0.08;
  }
  // [v6修正] 系统性下跌时抑制回归看多：均线空头排列+趋势因子看空→回归减半
  // 复盘发现：光伏趋势-1.06被回归+0.678抵消导致错误预测上涨
  if (reversionFactor > 0 && trendFactor < -0.2 && tech.trendScore < -15) {
    reversionFactor *= 0.3; // 强空头下回归信号大幅衰减
  } else if (reversionFactor > 0 && trendFactor < 0 && tech.trendScore < 0) {
    reversionFactor *= 0.6; // 弱空头下回归信号适度衰减
  }
  // 系统性上涨时也抑制回归看空
  if (reversionFactor < 0 && trendFactor > 0.2 && tech.trendScore > 15) {
    reversionFactor *= 0.3;
  } else if (reversionFactor < 0 && trendFactor > 0 && tech.trendScore > 0) {
    reversionFactor *= 0.6;
  }

  // RSI因子
  let rsiFactor = 0;
  if (tech.rsi14 > 76) rsiFactor = -(tech.rsi14 - 76) * 0.08;
  else if (tech.rsi14 > 60) rsiFactor = -(tech.rsi14 - 60) * 0.037;
  else if (tech.rsi14 < 22) rsiFactor = (22 - tech.rsi14) * 0.08;
  else if (tech.rsi14 < 31) rsiFactor = (31 - tech.rsi14) * 0.037;
  if (navValues.length >= 11) {
    const navLookback = navValues[navValues.length - 10];
    const rsiLookback = calcRSI(navValues.slice(0, -9), 14);
    if (current > navLookback && tech.rsi14 < rsiLookback) rsiFactor -= 0.20;
    if (current < navLookback && tech.rsi14 > rsiLookback) rsiFactor += 0.20;
  }

  // MACD因子
  let macdFactor = 0;
  const hist = tech.macd.histogram;
  if (hist > 0 && tech.macd.dif > tech.macd.dea) macdFactor = 0.232;
  else if (hist < 0 && tech.macd.dif < tech.macd.dea) macdFactor = -0.232;
  if (navValues.length >= 2) {
    const prevMacd = calcMACD(navValues.slice(0, -1));
    if (prevMacd.histogram <= 0 && hist > 0) macdFactor += 0.386;
    if (prevMacd.histogram >= 0 && hist < 0) macdFactor -= 0.386;
  }
  if (navValues.length >= 3) {
    const prev2Macd = calcMACD(navValues.slice(0, -2));
    const prevMacd2 = calcMACD(navValues.slice(0, -1));
    const accel = hist - prevMacd2.histogram;
    const prevAccel = prevMacd2.histogram - prev2Macd.histogram;
    if (accel > 0 && prevAccel > 0) macdFactor += 0.1;
    if (accel < 0 && prevAccel < 0) macdFactor -= 0.1;
  }

  // 布林带因子
  let bbFactor = 0;
  const pctB = tech.bollingerBands.percentB;
  if (pctB > 95) bbFactor = -0.35 * adaptBBMult;
  else if (pctB > 80) bbFactor = -(pctB - 80) * 0.020 * adaptBBMult;
  else if (pctB < 5) bbFactor = 0.35 * adaptBBMult;
  else if (pctB < 20) bbFactor = (20 - pctB) * 0.020 * adaptBBMult;
  if (tech.bollingerBands.width < 3) {
    bbFactor += trendFactor > 0 ? 0.1 : trendFactor < 0 ? -0.1 : 0;
  }

  // 消息面因子
  const newsFactor = newsScore.score * 0.008;

  // 市场环境因子（v6增强：复盘发现大盘影响被严重低估）
  let marketFactor = 0;
  if (marketCtx) {
    const shIdx = marketCtx.marketIndices.find((i: any) => i.name === '上证指数');
    const shChangePct = shIdx?.changePct || 0;
    // [v6] 大盘涨跌幅权重从0.13提升到0.35，三大指数加权
    marketFactor += shChangePct * 0.35;
    // 三大指数联动：全部同向时加强信号
    const allDown = marketCtx.marketIndices.every((i: any) => i.changePct < -0.3);
    const allUp = marketCtx.marketIndices.every((i: any) => i.changePct > 0.3);
    if (allDown) marketFactor -= 0.25;  // 三大指数齐跌→系统性风险
    if (allUp) marketFactor += 0.25;    // 三大指数齐涨→系统性机会
    // marketScore趋势加成（提升阈值敏感度）
    if (marketCtx.marketScore > 30) marketFactor += 0.20;
    else if (marketCtx.marketScore > 10) marketFactor += 0.10;
    else if (marketCtx.marketScore < -30) marketFactor -= 0.20;
    else if (marketCtx.marketScore < -10) marketFactor -= 0.10;
  }

  // 季节性因子
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

  // 支撑阻力因子
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

  // 跨时间框架确认因子
  let crossTfFactor = 0;
  const mom10d = navValues.length >= 11 ? navValues.slice(-11).reduce((s, v, i, a) => i === 0 ? 0 : s + ((v - a[i-1]) / a[i-1]) * 100, 0) : 0;
  if (mom3d > 0 && mom10d > 0 && tech.trendScore > 0) crossTfFactor = 0.12;
  else if (mom3d < 0 && mom10d < 0 && tech.trendScore < 0) crossTfFactor = -0.12;

  // 缺口回补因子
  let gapFactor = 0;
  if (changes.length >= 2) {
    const lastChange = changes[changes.length - 1];
    if (Math.abs(lastChange) > 1.5) gapFactor = -lastChange * 0.15;
  }

  // 资金流向因子
  let capitalFlowFactor = 0;
  if (capitalFlow) {
    capitalFlowFactor = capitalFlow.flowScore * 0.005;
    if (capitalFlow.sector) {
      if (capitalFlow.sector.mainNetInflow > 5) capitalFlowFactor += 0.1;
      else if (capitalFlow.sector.mainNetInflow < -5) capitalFlowFactor -= 0.1;
    }
  }

  // [v7.5] 地缘/事件风险因子 — 增加时间衰减 + 黄金专属逻辑 + 油价/美元影响
  let geoRiskFactor = 0;
  if (geoRisk && (geoRisk.riskScore !== 0 || geoRisk.signals.length > 0)) {
    const isGold = fundName ? isHedgeAsset(fundName) : false;

    if (isGold) {
      // === 黄金专属因子：地缘恐慌利好、油价利好、美元反向 ===
      let goldFactor = 0;

      // 1. 地缘恐慌 → 利好黄金（方向反转！普通基金看空，黄金看多）
      // cap=0.50防止极端riskScore产生过大信号
      if (geoRisk.riskScore <= -50) goldFactor += Math.min(Math.abs(geoRisk.riskScore) * 0.008, 0.50);
      else if (geoRisk.riskScore <= -20) goldFactor += Math.abs(geoRisk.riskScore) * 0.006;
      else if (geoRisk.riskScore >= 30) goldFactor -= geoRisk.riskScore * 0.004;  // 乐观→轻微看空
      else goldFactor += Math.abs(geoRisk.riskScore) * 0.001;

      // 2. 油价 → 通胀预期（暴跌时区分衰退型vs供给过剩型）
      if (geoRisk.oil.changePct > 4) goldFactor += 0.15;
      else if (geoRisk.oil.changePct > 2) goldFactor += 0.08;
      else if (geoRisk.oil.changePct < -4) goldFactor += (geoRisk.riskScore <= -20) ? -0.05 : -0.10; // 衰退型减半

      // 3. 美元指数反向（恐慌时避险需求压过美元效应，压制减半）
      if (geoRisk.dxy.changePct > 1) {
        let dxyPressure = geoRisk.dxy.changePct * 0.12;
        if (geoRisk.riskScore <= -50) dxyPressure *= 0.5; // 恐慌时美元压制减弱
        goldFactor -= dxyPressure;
      } else if (geoRisk.dxy.changePct < -0.5) {
        goldFactor += Math.abs(geoRisk.dxy.changePct) * 0.10;
      }

      // 4. 油金齐涨确认 — 仅非极端恐慌下确认通胀（避免与地缘因子重复叠加）
      if (geoRisk.oil.changePct > 2 && geoRisk.gold.changePct > 1 && geoRisk.riskScore > -30) {
        goldFactor += 0.06;
      }

      geoRiskFactor = goldFactor;
    } else {
      // === 普通基金：原逻辑 + 时间衰减 ===
      if (geoRisk.riskScore <= -50) geoRiskFactor = geoRisk.riskScore * 0.016;
      else if (geoRisk.riskScore <= -20) geoRiskFactor = geoRisk.riskScore * 0.012;
      else if (geoRisk.riskScore >= 20) geoRiskFactor = geoRisk.riskScore * 0.005;
      else geoRiskFactor = geoRisk.riskScore * 0.003;

      // [v7.5] 时间衰减：如果地缘数据的信号不是今天产生的（缓存延续），衰减影响
      // 通过信号内容判断：如果涨跌幅很小(<1%)说明可能是隔日延续的旧数据
      const signalStrength = Math.abs(geoRisk.oil.changePct) + Math.abs(geoRisk.gold.changePct);
      if (signalStrength < 1.0 && Math.abs(geoRisk.riskScore) > 20) {
        // 信号弱但评分高 → 可能是昨日残留，衰减60%
        geoRiskFactor *= 0.4;
      } else if (signalStrength < 2.0 && Math.abs(geoRisk.riskScore) > 40) {
        // 信号中等但评分很高 → 衰减30%
        geoRiskFactor *= 0.7;
      }
    }
  }

  // [v8.1a] 市场情绪因子（北向资金+涨跌比 → 情绪驱动预测）
  let sentimentFactor = 0;
  // 情绪数据通过 geoRisk 旁路传入（避免改函数签名）
  // 在调用方通过 (geoRisk as any)?._sentiment 注入
  const sentiment = (geoRisk as any)?._sentiment as { northboundNetBuy?: number; northbound5dAvg?: number; sentimentScore?: number; advanceDeclineRatio?: number } | undefined;
  if (sentiment && sentiment.sentimentScore !== undefined) {
    // 情绪分 → 因子: 恐慌端放大（和地缘因子方向一致）, 乐观端保守
    if (sentiment.sentimentScore <= -30) {
      sentimentFactor = sentiment.sentimentScore * 0.008;  // -30→-0.24, -60→-0.48
    } else if (sentiment.sentimentScore >= 30) {
      sentimentFactor = sentiment.sentimentScore * 0.004;  // +30→+0.12, +60→+0.24
    } else {
      sentimentFactor = sentiment.sentimentScore * 0.003;  // 中性区轻微影响
    }

    // 北向资金强信号叠加
    if (sentiment.northboundNetBuy !== undefined) {
      if (sentiment.northboundNetBuy > 80) sentimentFactor += 0.10;       // 大额流入
      else if (sentiment.northboundNetBuy < -80) sentimentFactor -= 0.10;  // 大额流出
    }
  }

  // 波动率修正
  const volAdj = risk.volatility20d > 24 ? 0.626 : risk.volatility20d > 15 ? 0.85 : 1.0;
  trendFactor *= volAdj;
  reversionFactor *= (2 - volAdj);

  // 综合预测（新增sentimentFactor）
  const rawPrediction = trendFactor + reversionFactor + rsiFactor + macdFactor + bbFactor + newsFactor + marketFactor + seasonalFactor + srFactor + crossTfFactor + gapFactor + capitalFlowFactor + geoRiskFactor + sentimentFactor;
  // [v7.1] ATR限幅: 趋势3.5x(v7.0: 4x回撤过大), 极端地缘4x, 默认2.5x
  const atrLimitMult = (forecastRegime === 'trending') ? 3.5
    : (geoRisk && Math.abs(geoRisk.riskScore) > 60) ? 4.0
    : 2.5;
  const maxMove = atrPct * atrLimitMult;
  const predictedChangePct = Math.max(-maxMove, Math.min(maxMove, rawPrediction));

  // 方向判定
  let direction: 'up' | 'down' | 'sideways';
  if (predictedChangePct > 0.15) direction = 'up';
  else if (predictedChangePct < -0.15) direction = 'down';
  else direction = 'sideways';

  // 置信度（修正：因子增加到13个后降低单因子权重，防止普遍高置信度）
  const allFactors = [trendFactor, reversionFactor, rsiFactor, macdFactor, bbFactor, newsFactor, marketFactor, srFactor, crossTfFactor, gapFactor, capitalFlowFactor, geoRiskFactor, sentimentFactor];
  const totalSignificant = allFactors.filter(f => Math.abs(f) > 0.02).length;
  const sameDirection = allFactors.filter(f => (f > 0) === (predictedChangePct > 0) && Math.abs(f) > 0.02).length;
  // 用同向比例而非绝对数量: 8/13同向=62%置信度基础, 13/13=100%
  const agreementRatio = totalSignificant > 0 ? sameDirection / totalSignificant : 0.5;
  let confidence = 20 + agreementRatio * 40 + Math.abs(predictedChangePct) * 4;
  // 强共振加分（但幅度更小）
  if (Math.abs(crossTfFactor) > 0.1) confidence += 5;
  if ((capitalFlowFactor > 0) === (predictedChangePct > 0) && Math.abs(capitalFlowFactor) > 0.05) confidence += 4;
  if ((sentimentFactor > 0) === (predictedChangePct > 0) && Math.abs(sentimentFactor) > 0.05) confidence += 4;
  confidence = Math.min(85, Math.max(20, confidence));  // 上限从90降到85

  return {
    predictedChangePct: Math.round(predictedChangePct * 100) / 100,
    direction,
    confidence: Math.round(confidence),
    factors: {
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
      geoRisk: Math.round(geoRiskFactor * 1000) / 1000,
      sentiment: Math.round(sentimentFactor * 1000) / 1000,
    },
  };
}

// ============================================================
// 明日行情预测 + 投资策略
// ============================================================
router.get('/funds/:id/forecast', async (req: Request, res: Response) => {
  const fundId = Number(req.params.id);
  try {
    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
    if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

    // 支持实时估值参数：?estimate=1.2345
    const estimateNav = req.query.estimate ? parseFloat(req.query.estimate as string) : 0;
    const nav = estimateNav > 0 ? estimateNav : (fund.market_nav || 0);
    if (nav <= 0) { res.status(400).json({ error: '无当前净值' }); return; }
    const hasEstimate = estimateNav > 0;

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
    const [capitalFlow, geoRisk] = await Promise.all([
      fetchCapitalFlow(fund.name, fcHoldings?.holdings),
      fetchGeoWithSentiment(),
    ]);

    const navValues = navHistory.map(p => p.nav);
    // 如果有实时估值且与历史最后一天不同，追加为今天的数据点
    if (hasEstimate && navValues.length > 0 && Math.abs(estimateNav - navValues[navValues.length - 1]) > 0.0001) {
      navValues.push(estimateNav);
    }
    if (navValues.length < 5) {
      res.json({ error: null, prediction: null, message: '历史数据不足，无法预测' });
      return;
    }

    // 日期信息
    const baseDate = hasEstimate
      ? toLocalDateStr(new Date()) + '(估值)'
      : (navHistory.length > 0 ? navHistory[navHistory.length - 1].date : toLocalDateStr(new Date()));
    const targetDate = getNextTradingDay();

    // === 2. 技术面分析 ===
    const tech = calcTechnical(navValues);
    const risk = calcRisk(navValues);
    const fundScore = fundamental ? scoreFundamental(fundamental) : { score: 0, highlights: [] };
    const newsScore = scoreNewsSentiment(news);

    // === 3. 多因子预测模型（v6 共用 computeForecastCore + 地缘风险） ===
    const current = navValues[navValues.length - 1];
    const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;
    const forecastResult = computeForecastCore(navValues, tech, risk, newsScore, marketCtx, capitalFlow, geoRisk, fund.name);
    const { predictedChangePct, direction, confidence } = forecastResult;
    const { trend: trendFactor, reversion: reversionFactor, rsi: rsiFactor, macd: macdFactor,
      bollinger: bbFactor, news: newsFactor, market: marketFactor, supportResistance: srFactor,
      crossTimeframe: crossTfFactor, gap: gapFactor, capitalFlow: capitalFlowFactor } = forecastResult.factors;
    const predictedNav = Math.round((current * (1 + predictedChangePct / 100)) * 10000) / 10000;

    // 预测区间（基于ATR，非对称——趋势方向更宽）
    const upBias = predictedChangePct > 0 ? 1.3 : 1.0;
    const downBias = predictedChangePct < 0 ? 1.3 : 1.0;
    const navHigh = Math.round((current + tech.atr14 * 1.2 * upBias) * 10000) / 10000;
    const navLow = Math.round((current - tech.atr14 * 1.2 * downBias) * 10000) / 10000;

    // 近期涨跌用于后续展示
    const changes = navValues.slice(-10).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100);
    const mom3d = changes.slice(-3).reduce((a, b) => a + b, 0);
    const mom5d = changes.slice(-5).reduce((a, b) => a + b, 0);
    const deviationFromMA20 = ((current - tech.ma20) / tech.ma20) * 100;
    const deviationFromMA5 = ((current - tech.ma5) / tech.ma5) * 100;

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

    // === 6. 基于预测生成投资策略（v5：建议与预测方向严格一致） ===
    // 核心原则：预测跌→今天不买(等明天跌完再买)，可卖；预测涨→今天不卖(等涨完再卖)，可买
    let action: 'buy' | 'sell' | 'hold' = 'hold';
    let shares = 0;
    let amount = 0;
    const strategies: string[] = [];

    if (direction === 'down') {
      // 预测下跌 → 今天可减仓避跌，明天跌完再买回
      if (gainPct > 5 && swingShares > 0) {
        action = 'sell';
        shares = Math.round(swingShares * 0.15 * 100) / 100;
        amount = Math.round(shares * nav * 100) / 100;
        strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，今日先止盈${shares}份（¥${amount}）`);
        strategies.push(`明日跌至¥${navLow}附近可接回，完成高抛低吸`);
      } else if (swingShares > 0 && Math.abs(predictedChangePct) > 0.5) {
        action = 'sell';
        shares = Math.round(swingShares * 0.10 * 100) / 100;
        amount = Math.round(shares * nav * 100) / 100;
        strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，建议今日减仓${shares}份避险`);
        strategies.push(`明日跌至¥${navLow}后可低位补回`);
      } else {
        action = 'hold';
        strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，今日不宜买入`);
        const suggestAmt = Math.round(500 * Math.min(2, 1 + Math.max(0, Math.abs(gainPct)) / 20));
        strategies.push(`等待明日低点¥${navLow}附近再补仓（建议¥${suggestAmt}）`);
      }
    } else if (direction === 'up') {
      // 预测上涨 → 今天可买入等涨，不急于卖出
      if (gainPct < -3) {
        action = 'buy';
        const factor = Math.min(2, 1 + Math.abs(gainPct) / 15);
        amount = Math.round(500 * factor);
        shares = Math.round(amount / nav * 100) / 100;
        strategies.push(`预测${targetDate}上涨${predictedChangePct.toFixed(2)}%，当前亏损${Math.abs(gainPct).toFixed(1)}%`);
        strategies.push(`建议今日买入${shares}份（¥${amount}），趁上涨前补仓`);
      } else if (gainPct >= 0 && gainPct < stopProfit) {
        action = 'hold';
        strategies.push(`预测${targetDate}上涨${predictedChangePct.toFixed(2)}%，持有等涨`);
        strategies.push(`当前收益+${gainPct.toFixed(1)}%，涨至¥${navHigh}以上再考虑止盈`);
      } else if (gainPct >= stopProfit && swingShares > 0) {
        // 已达止盈线+预测还涨 → 持有再看，等涨完再止盈
        action = 'hold';
        strategies.push(`盈利${gainPct.toFixed(1)}%已达止盈线，预测${targetDate}还涨${predictedChangePct.toFixed(2)}%`);
        strategies.push(`建议持有一天，明日涨至¥${navHigh}后再分批止盈`);
      } else {
        action = 'hold';
        strategies.push(`预测${targetDate}上涨${predictedChangePct.toFixed(2)}%，持有观望`);
      }
    } else {
      // 震荡
      strategies.push(`预测${targetDate}横盘震荡（变动${predictedChangePct >= 0 ? '+' : ''}${predictedChangePct.toFixed(2)}%）`);
      if (gainPct < -5) {
        action = 'buy';
        amount = 300;
        shares = Math.round(amount / nav * 100) / 100;
        strategies.push(`当前亏损${Math.abs(gainPct).toFixed(1)}%，震荡期小额定投摊薄成本`);
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
    const geoRiskFactor = forecastResult.factors.geoRisk || 0;
    if (geoRisk && geoRisk.signals.length > 0) {
      reasoning.push(`[地缘] ${geoRisk.riskDetail}（${geoRisk.riskLevel === 'extreme_fear' ? '极度恐慌' : geoRisk.riskLevel === 'fear' ? '恐慌' : geoRisk.riskLevel === 'greed' ? '乐观' : '中性'}，评分${geoRisk.riskScore}） → ${geoRiskFactor >= 0 ? '+' : ''}${geoRiskFactor.toFixed(3)}`);
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
      baseDate,         // 基于哪天的数据
      targetDate,       // 预测哪天的行情
      hasEstimate,      // 是否使用了实时估值
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
      geoRisk: geoRisk && geoRisk.signals.length > 0 ? {
        riskScore: geoRisk.riskScore,
        riskLevel: geoRisk.riskLevel,
        riskDetail: geoRisk.riskDetail,
        signals: geoRisk.signals,
        gold: geoRisk.gold,
        oil: geoRisk.oil,
      } : null,
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
      modelVersion: FORECAST_MODEL_VERSION,
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
    // [v6] 地缘风险全局获取一次（所有基金共用）
    const geoRisk = await fetchGeoWithSentiment();

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
        const cfData = await fetchCapitalFlow(f.name, bfHoldings?.holdings);

        const navValues = navHistory.map(p => p.nav);
        if (navValues.length < 5) return;

        const tech = calcTechnical(navValues);
        const risk = calcRisk(navValues);
        const newsScore = scoreNewsSentiment(newsItems);
        const current = navValues[navValues.length - 1];
        const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;

        // v6: 统一调用 computeForecastCore，消除参数不一致问题
        const fc = computeForecastCore(navValues, tech, risk, newsScore, marketCtx, cfData, geoRisk, f.name);
        const { predictedChangePct, direction, confidence } = fc;
        const predictedNav = Math.round((current * (1 + predictedChangePct / 100)) * 10000) / 10000;

        const bTargetDate = getNextTradingDay();
        const bBaseDate = navHistory.length > 0 ? navHistory[navHistory.length - 1].date : toLocalDateStr(new Date());
        const forecastData = {
          direction,
          predictedNav,
          predictedChangePct,
          confidence,
          baseDate: bBaseDate,
          targetDate: bTargetDate,
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

        // 持久化预测到数据库（含版本号）
        const factorsJson = JSON.stringify(fc.factors);
        try {
          db.prepare(`
            INSERT INTO forecasts (fund_id, target_date, direction, predicted_nav, predicted_change_pct, confidence, nav_range_high, nav_range_low, factors, base_nav, rsi, trend, volatility, model_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fund_id, target_date) DO UPDATE SET
              direction=excluded.direction, predicted_nav=excluded.predicted_nav,
              predicted_change_pct=excluded.predicted_change_pct, confidence=excluded.confidence,
              nav_range_high=excluded.nav_range_high, nav_range_low=excluded.nav_range_low,
              factors=excluded.factors, base_nav=excluded.base_nav, rsi=excluded.rsi,
              trend=excluded.trend, volatility=excluded.volatility, model_version=excluded.model_version,
              created_at=datetime('now')
          `).run(f.id, bTargetDate, direction, predictedNav, predictedChangePct,
            confidence, forecastData.navRange.high, forecastData.navRange.low,
            factorsJson, current, forecastData.rsi, tech.trend, forecastData.volatility,
            FORECAST_MODEL_VERSION);
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

// 中国A股法定休市日（2025-2026，每年底需更新下一年）
// 港股额外休市日（不含与A股重叠的日期，只列港股独有休市日）
const HK_EXTRA_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-04-18', '2025-04-19', '2025-04-21', // 耶稣受难+复活节
  '2025-05-05', '2025-06-02', // 劳动节翌日, 端午翌日
  '2025-07-01', // 回归纪念日
  '2025-10-07', // 重阳节
  '2025-12-25', '2025-12-26', // 圣诞
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-04', '2026-04-06', // 耶稣受难+复活节
  '2026-05-25', // 佛诞
  '2026-07-01', // 回归纪念日
  '2026-10-19', // 重阳节
  '2026-12-25', '2026-12-26', // 圣诞
]);

/** 判断是否为港股休市日（包含A股休市日+港股独有休市日） */
function isHKHoliday(dateStr: string): boolean {
  if (CN_STOCK_HOLIDAYS.has(dateStr)) return true;
  if (HK_EXTRA_HOLIDAYS.has(dateStr)) return true;
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay() === 0 || d.getDay() === 6;
}

/** 判断是否为港股关联基金 */
function isHKFund(fundName: string): boolean {
  return /港股|恒生|港通|沪港深|QDII.*港|H股|港元/i.test(fundName);
}

const CN_STOCK_HOLIDAYS = new Set([
  // 2025
  '2025-01-01',
  '2025-01-28','2025-01-29','2025-01-30','2025-01-31','2025-02-01','2025-02-02','2025-02-03','2025-02-04',
  '2025-04-04',
  '2025-05-01','2025-05-02','2025-05-03','2025-05-04','2025-05-05',
  '2025-05-31','2025-06-01','2025-06-02',
  '2025-10-01','2025-10-02','2025-10-03','2025-10-04','2025-10-05','2025-10-06','2025-10-07','2025-10-08',
  // 2026
  '2026-01-01','2026-01-02',
  '2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22',
  '2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07',
]);

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isTradingDay(d: Date): boolean {
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  return !CN_STOCK_HOLIDAYS.has(toLocalDateStr(d));
}

function getNextTradingDay(): string {
  const now = new Date();
  const d = new Date(now);
  // 15:00前预测的是今天，15:00后预测明天
  if (d.getHours() >= 15) d.setDate(d.getDate() + 1);
  // 跳过周末和法定假日
  while (!isTradingDay(d)) d.setDate(d.getDate() + 1);
  return toLocalDateStr(d);
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
  geoRisk: '地缘风险',
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
  const today = toLocalDateStr(new Date());
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
    // [v6修正] 获取 target_date 当天的实际净值
    // 核心逻辑：actualNav 必须与 base_nav 不同，否则说明 NAV 还没更新（是旧数据）
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
    // [v6] 防止用旧NAV复盘：如果 actualNav == base_nav 说明 snapshot 存的是前一天的数据
    if (fc.base_nav > 0 && Math.abs(actualNav - fc.base_nav) < 0.0001) continue;

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
      ORDER BY CAST(SUM(r.direction_correct) AS REAL) / MAX(COUNT(*), 1) DESC
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

// 查询决策历史记录
router.get('/decision-logs', async (req: Request, res: Response) => {
  try {
    const fundId = req.query.fundId ? Number(req.query.fundId) : null;
    const days = Number(req.query.days) || 30;
    const since = new Date(); since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().slice(0, 10);

    let query = `
      SELECT d.*, f.name as fund_name, f.code as fund_code, f.color as fund_color
      FROM decision_logs d
      JOIN funds f ON f.id = d.fund_id
      WHERE d.date >= ?
    `;
    const params: any[] = [sinceStr];
    if (fundId) { query += ' AND d.fund_id = ?'; params.push(fundId); }
    query += ' ORDER BY d.date DESC, d.created_at DESC';

    const rows = db.prepare(query).all(...params) as any[];
    res.json({
      logs: rows.map(r => ({ ...r, reasoning: (() => { try { return JSON.parse(r.reasoning || '[]'); } catch { return []; } })() })),
      currentVersions: { forecast: FORECAST_MODEL_VERSION, decision: DECISION_MODEL_VERSION },
    });
  } catch (err: any) {
    res.status(500).json({ error: '查询决策历史失败: ' + err.message });
  }
});

// 获取模型版本信息
router.get('/model-versions', (_req: Request, res: Response) => {
  res.json({
    forecast: FORECAST_MODEL_VERSION,
    decision: DECISION_MODEL_VERSION,
    description: {
      forecast: '12因子+地缘风险+回归抑制+ATR2.5x+Wilder RSI+假日历',
      decision: '五维防御优先(技术20%+基本面20%+市场30%+消息10%+资金20%)+预测整合+地缘风险',
    },
  });
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

// ============================================================
// ============================================================
// 波段交易建议（活仓7-30天波段，基于波动率+网格+持有期约束）
// ============================================================

router.get('/funds/:id/band-trade', async (req: Request, res: Response) => {
  try {
    const fundId = Number(req.params.id);
    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
    if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

    const realtimeNav = req.query.nav ? parseFloat(req.query.nav as string) : (fund.market_nav || 0);
    if (realtimeNav <= 0) { res.status(400).json({ error: '需要净值' }); return; }

    // 获取历史净值
    let navHistory: NavPoint[] = [];
    if (fund.code) navHistory = await fetchNavHistory(fund.code, 60);
    const navValues = navHistory.map(p => p.nav);
    if (navValues.length < 20) { res.json({ suitable: false, reason: '历史数据不足', signals: [] }); return; }

    // 计算波动率（判断是否适合做波段）
    const ret20 = navValues.slice(-21).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100).slice(1);
    const vol20 = Math.sqrt(ret20.reduce((s, r) => s + r * r, 0) / ret20.length) * Math.sqrt(250);
    const avgDailyMove = ret20.reduce((s, r) => s + Math.abs(r), 0) / ret20.length;

    // 波段适合度评分
    let suitability = 0;
    const suitReasons: string[] = [];
    if (vol20 > 25) { suitability += 3; suitReasons.push(`高波动(${vol20.toFixed(0)}%)，差价空间大`); }
    else if (vol20 > 18) { suitability += 2; suitReasons.push(`中等波动(${vol20.toFixed(0)}%)`); }
    else { suitability += 1; suitReasons.push(`低波动(${vol20.toFixed(0)}%)，波段空间有限`); }

    if (avgDailyMove > 1.0) { suitability += 2; suitReasons.push(`日均波幅${avgDailyMove.toFixed(2)}%`); }
    else if (avgDailyMove > 0.5) { suitability += 1; }

    const suitable = suitability >= 3;

    // 持仓数据
    const posRow = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type='buy' THEN shares ELSE 0 END),0) -
        COALESCE(SUM(CASE WHEN type='sell' THEN shares ELSE 0 END),0) as holding_shares,
        COALESCE(SUM(CASE WHEN type='buy' THEN shares*price ELSE 0 END),0) -
        COALESCE(SUM(CASE WHEN type='sell' THEN shares*price ELSE 0 END),0) +
        COALESCE(SUM(CASE WHEN type='dividend' THEN price ELSE 0 END),0) as cost_basis
      FROM transactions WHERE fund_id = ?
    `).get(fundId) as any;
    const holdingShares = posRow.holding_shares;
    const costNav = holdingShares > 0 ? posRow.cost_basis / holdingShares : 0;
    const basePct = fund.base_position_pct ?? 70;
    const baseShares = r4(holdingShares * basePct / 100);
    const swingShares = r4(holdingShares - baseShares);
    const swingValue = Math.round(swingShares * realtimeNav);

    // 技术指标
    const tech = calcTechnical(navValues);
    const atrPct = tech.atr14 > 0 ? (tech.atr14 / realtimeNav) * 100 : 0.5;

    // 网格计算：基于ATR确定买卖档位
    const gridStep = Math.round(atrPct * 100) / 100;  // 每档=1个ATR
    const currentPctB = tech.bollingerBands.percentB;

    // 生成波段信号
    const signals: {
      action: 'buy' | 'sell' | 'hold';
      urgency: 'high' | 'medium' | 'low';
      amount: number;
      shares: number;
      targetNav: number;
      holdDays: string;
      reason: string;
      grid: { buyLevel: number; sellLevel: number; spread: number };
    }[] = [];

    const gainPct = costNav > 0 ? ((realtimeNav - costNav) / costNav) * 100 : 0;

    // === 买入信号 ===
    // 条件1: 布林带下轨附近 (%B < 20)
    if (currentPctB < 20 && swingValue < holdingShares * realtimeNav * 0.3) {
      const buyNav = realtimeNav;
      const sellTarget = r4(realtimeNav * (1 + gridStep * 2 / 100));
      const spread = r4((sellTarget - buyNav) / buyNav * 100);
      const buyAmount = Math.min(Math.round(swingValue * 0.3), 5000);
      const buyShares = r4(buyAmount / buyNav);
      signals.push({
        action: 'buy', urgency: currentPctB < 5 ? 'high' : 'medium',
        amount: buyAmount, shares: buyShares,
        targetNav: sellTarget,
        holdDays: '7-15天',
        reason: `布林下轨(%B=${currentPctB.toFixed(0)})，等反弹至${sellTarget.toFixed(4)}(+${spread}%)卖出`,
        grid: { buyLevel: buyNav, sellLevel: sellTarget, spread },
      });
    }

    // 条件2: RSI超卖 (< 25)
    if (tech.rsi14 < 25 && signals.length === 0) {
      const buyNav = realtimeNav;
      const sellTarget = r4(realtimeNav * (1 + atrPct * 1.5 / 100));
      const spread = r4((sellTarget - buyNav) / buyNav * 100);
      const buyAmount = Math.min(Math.round(swingValue * 0.2), 3000);
      signals.push({
        action: 'buy', urgency: 'medium',
        amount: buyAmount, shares: r4(buyAmount / buyNav),
        targetNav: sellTarget,
        holdDays: '7-20天',
        reason: `RSI超卖(${tech.rsi14.toFixed(0)})，技术性反弹概率大`,
        grid: { buyLevel: buyNav, sellLevel: sellTarget, spread },
      });
    }

    // 条件3: 大幅回调后（近5日跌>3%且趋势本身是上涨的）
    const mom5d = navValues.length >= 6 ? ((navValues[navValues.length-1] / navValues[navValues.length-6]) - 1) * 100 : 0;
    const mom20d = navValues.length >= 21 ? ((navValues[navValues.length-1] / navValues[navValues.length-21]) - 1) * 100 : 0;
    if (mom5d < -3 && mom20d > 0 && signals.length === 0) {
      const buyNav = realtimeNav;
      const sellTarget = r4(realtimeNav * (1 + Math.abs(mom5d) * 0.6 / 100));
      const spread = r4((sellTarget - buyNav) / buyNav * 100);
      signals.push({
        action: 'buy', urgency: 'medium',
        amount: Math.min(3000, Math.round(swingValue * 0.25)),
        shares: r4(3000 / buyNav),
        targetNav: sellTarget,
        holdDays: '7-14天',
        reason: `上升趋势中回调${mom5d.toFixed(1)}%，反弹至${sellTarget.toFixed(4)}卖出`,
        grid: { buyLevel: buyNav, sellLevel: sellTarget, spread },
      });
    }

    // === 卖出信号 ===
    // 条件1: 布林上轨 (%B > 85)
    if (currentPctB > 85 && swingShares > 0) {
      const sellShares = r4(swingShares * (currentPctB > 95 ? 0.5 : 0.3));
      signals.push({
        action: 'sell', urgency: currentPctB > 95 ? 'high' : 'medium',
        amount: Math.round(sellShares * realtimeNav),
        shares: sellShares,
        targetNav: r4(realtimeNav * (1 - gridStep / 100)),
        holdDays: '立即',
        reason: `布林上轨(%B=${currentPctB.toFixed(0)})，活仓${currentPctB > 95 ? '50%' : '30%'}止盈`,
        grid: { buyLevel: r4(realtimeNav * (1 - gridStep * 2 / 100)), sellLevel: realtimeNav, spread: gridStep * 2 },
      });
    }

    // 条件2: 连涨5天+活仓盈利
    const streak5up = ret20.slice(-5).every(r => r > 0);
    if (streak5up && gainPct > 3 && swingShares > 0 && signals.filter(s => s.action === 'sell').length === 0) {
      const sellShares = r4(swingShares * 0.2);
      signals.push({
        action: 'sell', urgency: 'low',
        amount: Math.round(sellShares * realtimeNav),
        shares: sellShares,
        targetNav: r4(realtimeNav * (1 - atrPct / 100)),
        holdDays: '立即',
        reason: `连涨5天+盈利${gainPct.toFixed(1)}%，锁定20%活仓利润`,
        grid: { buyLevel: r4(realtimeNav * (1 - gridStep * 1.5 / 100)), sellLevel: realtimeNav, spread: gridStep * 1.5 },
      });
    }

    // === 无信号时 ===
    if (signals.length === 0) {
      signals.push({
        action: 'hold', urgency: 'low',
        amount: 0, shares: 0,
        targetNav: 0, holdDays: '-',
        reason: `当前%B=${currentPctB.toFixed(0)} RSI=${tech.rsi14.toFixed(0)}，无明确波段机会，等待回调或突破`,
        grid: {
          buyLevel: r4(realtimeNav * (1 - gridStep * 1.5 / 100)),
          sellLevel: r4(realtimeNav * (1 + gridStep * 1.5 / 100)),
          spread: gridStep * 3,
        },
      });
    }

    // 7天持有期检查
    const recentBuys = db.prepare(
      "SELECT date, shares, price FROM transactions WHERE fund_id = ? AND type = 'buy' AND date >= date('now', '-7 days') ORDER BY date DESC"
    ).all(fundId) as any[];
    const recentBuyShares = recentBuys.reduce((s: number, t: any) => s + t.shares, 0);
    const hasRecentBuy = recentBuys.length > 0;

    res.json({
      suitable,
      suitability,
      suitReasons,
      fundName: fund.name,
      nav: realtimeNav,
      volatility: Math.round(vol20 * 10) / 10,
      avgDailyMove: Math.round(avgDailyMove * 100) / 100,
      atrPct: Math.round(atrPct * 100) / 100,
      position: {
        holdingShares: r4(holdingShares),
        costNav: r4(costNav),
        gainPct: Math.round(gainPct * 100) / 100,
        baseShares, swingShares, swingValue,
        basePct,
      },
      technical: {
        percentB: Math.round(currentPctB),
        rsi14: Math.round(tech.rsi14),
        trend: tech.trend,
        macdHistogram: tech.macd.histogram > 0 ? 'positive' : 'negative',
        support: tech.support,
        resistance: tech.resistance,
      },
      gridStep: Math.round(gridStep * 100) / 100,
      signals,
      holdingWarning: hasRecentBuy ? `近7天有${recentBuys.length}笔买入(${recentBuyShares.toFixed(0)}份)，卖出将产生1.5%赎回费` : null,
      recentBuys: recentBuys.map((t: any) => ({ date: t.date, shares: r4(t.shares), price: r4(t.price) })),
    });
  } catch (err: any) {
    res.status(500).json({ error: '波段分析失败: ' + err.message });
  }
});

// Exported service functions for local-router (Harmony WebView)
// These extract route-handler logic so both Express routes and
// local-router share the same code — any fix applies to both.
// ============================================================

export { getAvailableModels, DEFAULT_MODEL };
export { computeDecision, logDecision };
export { computeForecastCore };
export { FORECAST_MODEL_VERSION, DECISION_MODEL_VERSION };
export { fetchNavHistory, fetchMarketContext, fetchGeopoliticalRisk };
export { calcTechnical, calcRisk, calcCompositeScore };
export { generateSignals, generateAdvice, generateSummary };
export { generateShortTermPlan, generateLongTermPlan, generateRecoveryPlan };
export { scoreNewsSentiment };
export { r4, toLocalDateStr, getNextTradingDay, getTodayStr };

/** Full strategy analysis for a fund (mirrors GET /strategy/funds/:id) */
export async function getFullStrategy(fundId: number | string, realtimeNav?: number) {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
  if (!fund) throw { status: 404, error: '基金不存在' };

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
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0;
  const mNav = (realtimeNav && realtimeNav > 0) ? realtimeNav : (fund.market_nav || 0);
  const marketValue = mNav > 0 ? holdingShares * mNav : totalCost;
  const gain = marketValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : 0;
  const stopProfit = fund.stop_profit_pct || 20;
  const stopLoss = fund.stop_loss_pct || 15;

  let navHistory: NavPoint[] = [];
  if (fund.code) navHistory = await fetchNavHistory(fund.code, 60);
  const navValues = navHistory.map(p => p.nav);
  const effectiveNav = navValues.length > 0 ? navValues[navValues.length - 1] : mNav;

  const technical = navValues.length >= 5 ? calcTechnical(navValues) : calcTechnical(effectiveNav > 0 ? [effectiveNav] : [1]);
  const riskMetrics = calcRisk(navValues);
  const market = await fetchMarketContext(fund.name);
  const signals = generateSignals(technical, riskMetrics, market, effectiveNav, costNav, gainPct, stopProfit, stopLoss);
  const compositeScore = calcCompositeScore(signals, technical, market);
  const advice = generateAdvice(compositeScore, signals, technical, riskMetrics, effectiveNav, costNav, totalCost, gainPct, holdingShares, stopProfit, stopLoss);
  const summary = generateSummary(compositeScore, technical, riskMetrics, market, gainPct, signals);
  const shortTermPlan = generateShortTermPlan(effectiveNav, technical, riskMetrics, costNav, gainPct, totalCost, stopProfit, stopLoss);
  const longTermPlan = generateLongTermPlan(effectiveNav, technical, riskMetrics, costNav, totalCost, holdingShares, gainPct, market);
  const recoveryPlan = generateRecoveryPlan(effectiveNav, costNav, totalCost, holdingShares, gainPct, riskMetrics, technical);

  return {
    fund: { id: fund.id, name: fund.name, code: fund.code, market_nav: mNav },
    position: {
      holdingShares: r4(holdingShares), costNav: r4(costNav),
      totalCost: Math.round(totalCost * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      gainPct: Math.round(gainPct * 100) / 100,
    },
    technical, risk: riskMetrics, market, signals,
    compositeScore, advice, shortTermPlan, longTermPlan, recoveryPlan, summary,
    navHistory: navHistory.slice(-30),
    timestamp: new Date().toISOString(),
  };
}

/** Batch decisions for all funds (mirrors GET /strategy/decisions/all) */
export async function getBatchDecisions(estimates: Record<number, number>, modelVersion?: string) {
  const funds = db.prepare(`
    SELECT f.id, f.name, f.code, f.color,
      COALESCE(SUM(CASE WHEN t.type = 'buy' THEN t.shares ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.type = 'sell' THEN t.shares ELSE 0 END), 0) as holding_shares
    FROM funds f LEFT JOIN transactions t ON t.fund_id = f.id
    WHERE f.deleted_at IS NULL GROUP BY f.id
  `).all() as any[];

  const results: any[] = [];
  const batchModel = modelVersion as ModelVersionId | undefined;
  await Promise.all(funds.filter(f => f.holding_shares > 0).map(async (f) => {
    const nav = estimates[f.id] || 0;
    try {
      const decision = await computeDecision(f.id, nav, batchModel);
      logDecision(f.id, decision);
      results.push({ fundId: f.id, name: f.name, code: f.code, color: f.color, ...decision });
    } catch {
      results.push({
        fundId: f.id, name: f.name, code: f.code, color: f.color,
        nav, action: 'hold', shares: 0, amount: 0, summary: '无法计算',
        confidence: 0, position: { holdingShares: f.holding_shares, costNav: 0, gainPct: 0 },
      });
    }
  }));
  return results;
}

/** Batch forecasts for all funds (mirrors GET /strategy/forecasts/all) */
export async function getBatchForecasts() {
  const funds = db.prepare(`
    SELECT f.id, f.name, f.code, f.color, f.market_nav
    FROM funds f WHERE f.deleted_at IS NULL AND f.code IS NOT NULL AND f.code != ''
  `).all() as any[];

  const targetDate = getNextTradingDay();
  const geoRisk = await fetchGeoWithSentiment();
  const results: any[] = [];

  await Promise.all(funds.map(async (f) => {
    try {
      const navHistory = await fetchNavHistory(f.code, 60);
      const navValues = navHistory.map(p => p.nav);
      if (navValues.length < 10) {
        results.push({ fundId: f.id, name: f.name, code: f.code, color: f.color, error: '历史数据不足' });
        return;
      }
      const tech = calcTechnical(navValues);
      const risk = calcRisk(navValues);
      const newsScore = scoreNewsSentiment([]);
      const marketCtx = await fetchMarketContext(f.name);
      const capitalFlow = null;
      const forecast = computeForecastCore(navValues, tech, risk, newsScore, marketCtx, capitalFlow, geoRisk, f.name);
      const currentNav = navValues[navValues.length - 1];
      const predictedNav = currentNav * (1 + forecast.predictedChangePct / 100);

      // Upsert to forecasts table
      try {
        db.prepare(`
          INSERT INTO forecasts (fund_id, target_date, direction, predicted_nav, predicted_change_pct, confidence, nav_range_low, nav_range_high, base_nav, factors, model_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fund_id, target_date) DO UPDATE SET
            direction=excluded.direction, predicted_nav=excluded.predicted_nav,
            predicted_change_pct=excluded.predicted_change_pct, confidence=excluded.confidence,
            nav_range_low=excluded.nav_range_low, nav_range_high=excluded.nav_range_high,
            base_nav=excluded.base_nav, factors=excluded.factors, model_version=excluded.model_version,
            created_at=datetime('now')
        `).run(
          f.id, targetDate, forecast.direction, r4(predictedNav), Math.round(forecast.predictedChangePct * 100) / 100,
          forecast.confidence,
          r4(currentNav * (1 + (forecast.predictedChangePct - Math.abs(forecast.predictedChangePct) * 0.5) / 100)),
          r4(currentNav * (1 + (forecast.predictedChangePct + Math.abs(forecast.predictedChangePct) * 0.5) / 100)),
          r4(currentNav), JSON.stringify(forecast.factors), FORECAST_MODEL_VERSION,
        );
      } catch { /* ignore upsert errors */ }

      results.push({
        fundId: f.id, name: f.name, code: f.code, color: f.color,
        targetDate, direction: forecast.direction,
        predictedNav: r4(predictedNav), currentNav: r4(currentNav),
        predictedChangePct: Math.round(forecast.predictedChangePct * 100) / 100,
        confidence: forecast.confidence, factors: forecast.factors,
        rsi: Math.round(tech.rsi14), trend: tech.trend, trendScore: tech.trendScore,
        volatility: Math.round(risk.volatility20d * 10) / 10,
        modelVersion: FORECAST_MODEL_VERSION,
      });
    } catch {
      results.push({ fundId: f.id, name: f.name, code: f.code, color: f.color, error: '预测失败' });
    }
  }));
  return { targetDate, modelVersion: FORECAST_MODEL_VERSION, forecasts: results };
}

/** Forecast review summary (mirrors GET /strategy/forecast-reviews/summary) */
export function getForecastReviewSummary(days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);
  const since = sinceDate.toISOString().slice(0, 10);

  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(direction_correct) as correct,
      AVG(error_pct) as avg_error, SUM(within_range) as in_range
    FROM forecast_reviews WHERE target_date >= ?
  `).get(since) as any;

  const byFund = db.prepare(`
    SELECT r.fund_id, f.name, f.code, f.color,
      COUNT(*) as total, SUM(r.direction_correct) as correct,
      AVG(r.error_pct) as avg_error, SUM(r.within_range) as in_range
    FROM forecast_reviews r JOIN funds f ON f.id = r.fund_id
    WHERE r.target_date >= ? GROUP BY r.fund_id
    ORDER BY CAST(SUM(r.direction_correct) AS REAL) / MAX(COUNT(*), 1) DESC
  `).all(since) as any[];

  const recent = db.prepare(`
    SELECT r.*, f.name as fund_name, f.code as fund_code, f.color as fund_color,
      fc.direction, fc.predicted_nav, fc.predicted_change_pct, fc.confidence, fc.factors
    FROM forecast_reviews r JOIN funds f ON f.id = r.fund_id
    JOIN forecasts fc ON fc.id = r.forecast_id
    ORDER BY r.target_date DESC, r.fund_id LIMIT 20
  `).all() as any[];

  return {
    stats: {
      total: stats.total || 0, correct: stats.correct || 0,
      accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
      avgError: Math.round((stats.avg_error || 0) * 100) / 100,
      inRange: stats.in_range || 0,
      inRangePct: stats.total > 0 ? Math.round((stats.in_range / stats.total) * 100) : 0,
    },
    byFund: byFund.map(f => ({
      ...f, accuracy: f.total > 0 ? Math.round((f.correct / f.total) * 100) : 0,
      avg_error: Math.round((f.avg_error || 0) * 100) / 100,
      inRangePct: f.total > 0 ? Math.round((f.in_range / f.total) * 100) : 0,
    })),
    recent: recent.map(r => ({
      ...r, factors: undefined,
      factorsParsed: (() => { try { return JSON.parse(r.factors || '{}'); } catch { return {}; } })(),
    })),
    days,
  };
}

/** Get decision logs (mirrors GET /strategy/decision-logs) */
export function getDecisionLogs(fundId?: number, days: number = 30) {
  const since = new Date(); since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  let query = `SELECT d.*, f.name as fund_name, f.code as fund_code, f.color as fund_color
    FROM decision_logs d JOIN funds f ON f.id = d.fund_id WHERE d.date >= ?`;
  const params: any[] = [sinceStr];
  if (fundId) { query += ' AND d.fund_id = ?'; params.push(fundId); }
  query += ' ORDER BY d.date DESC, d.created_at DESC';
  const rows = db.prepare(query).all(...params) as any[];
  return {
    logs: rows.map(r => ({ ...r, reasoning: (() => { try { return JSON.parse(r.reasoning || '[]'); } catch { return []; } })() })),
    currentVersions: { forecast: FORECAST_MODEL_VERSION, decision: DECISION_MODEL_VERSION },
  };
}

/** Get forecast history for a fund (mirrors GET /strategy/forecasts/fund/:id) */
export function getForecastHistory(fundId: number, limit: number = 30) {
  const rows = db.prepare(`
    SELECT f.*, r.actual_nav, r.actual_change_pct, r.direction_correct, r.error_pct, r.within_range, r.analysis
    FROM forecasts f LEFT JOIN forecast_reviews r ON r.forecast_id = f.id
    WHERE f.fund_id = ? ORDER BY f.target_date DESC LIMIT ?
  `).all(fundId, limit) as any[];
  return rows.map(r => ({
    ...r, factors: (() => { try { return JSON.parse(r.factors || '{}'); } catch { return {}; } })(),
  }));
}

/** Single fund forecast (mirrors GET /strategy/funds/:id/forecast) */
export async function getSingleForecast(fundId: number, estimateNav?: number) {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(fundId) as any;
  if (!fund) throw { status: 404, error: '基金不存在' };
  const nav = (estimateNav && estimateNav > 0) ? estimateNav : (fund.market_nav || 0);
  if (nav <= 0) throw { status: 400, error: '无当前净值' };
  const hasEstimate = !!(estimateNav && estimateNav > 0);

  let navHistory: NavPoint[] = [];
  let fundamental: any = null; let news: any[] = []; let marketCtx: any = null; let fcHoldings: any = null;
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
  const [capitalFlow, geoRisk] = await Promise.all([fetchCapitalFlow(fund.name, fcHoldings?.holdings), fetchGeoWithSentiment()]);

  const navValues = navHistory.map(p => p.nav);
  if (hasEstimate && navValues.length > 0 && Math.abs(estimateNav! - navValues[navValues.length - 1]) > 0.0001) navValues.push(estimateNav!);
  if (navValues.length < 5) return { error: null, prediction: null, message: '历史数据不足，无法预测' };

  const baseDate = hasEstimate ? toLocalDateStr(new Date()) + '(估值)' : (navHistory.length > 0 ? navHistory[navHistory.length - 1].date : toLocalDateStr(new Date()));
  const targetDate = getNextTradingDay();
  const tech = calcTechnical(navValues);
  const riskM = calcRisk(navValues);
  const fundScore = fundamental ? scoreFundamental(fundamental) : { score: 0, highlights: [] };
  const newsScore = scoreNewsSentiment(news);
  const current = navValues[navValues.length - 1];
  const atrPct = tech.atr14 > 0 ? (tech.atr14 / current) * 100 : 0.5;
  const forecastResult = computeForecastCore(navValues, tech, riskM, newsScore, marketCtx, capitalFlow, geoRisk, fund.name);
  const { predictedChangePct, direction, confidence } = forecastResult;
  const predictedNav = Math.round((current * (1 + predictedChangePct / 100)) * 10000) / 10000;
  const upBias = predictedChangePct > 0 ? 1.3 : 1.0;
  const downBias = predictedChangePct < 0 ? 1.3 : 1.0;
  const navHigh = Math.round((current + tech.atr14 * 1.2 * upBias) * 10000) / 10000;
  const navLow = Math.round((current - tech.atr14 * 1.2 * downBias) * 10000) / 10000;
  const changes = navValues.slice(-10).map((v, i, a) => i === 0 ? 0 : ((v - a[i-1]) / a[i-1]) * 100);
  const mom3d = changes.slice(-3).reduce((a, b) => a + b, 0);
  const mom5d = changes.slice(-5).reduce((a, b) => a + b, 0);
  const deviationFromMA20 = ((current - tech.ma20) / tech.ma20) * 100;
  const deviationFromMA5 = ((current - tech.ma5) / tech.ma5) * 100;

  const posRow = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='buy' THEN shares ELSE 0 END),0)-COALESCE(SUM(CASE WHEN type='sell' THEN shares ELSE 0 END),0) as holding_shares, COALESCE(SUM(CASE WHEN type='buy' THEN shares*price ELSE 0 END),0)-COALESCE(SUM(CASE WHEN type='sell' THEN shares*price ELSE 0 END),0)+COALESCE(SUM(CASE WHEN type='dividend' THEN price ELSE 0 END),0) as cost_basis FROM transactions WHERE fund_id=?`).get(fundId) as any;
  const holdingShares = posRow.holding_shares;
  const totalCost = posRow.cost_basis;
  const costNav = holdingShares > 0 && totalCost > 0 ? totalCost / holdingShares : 0;
  const basePct = fund.base_position_pct ?? 30;
  const baseShares = r4(holdingShares * basePct / 100);
  const swingShares = r4(holdingShares - baseShares);
  const stopProfit = fund.stop_profit_pct || 20;
  const stopLoss = fund.stop_loss_pct || 15;
  const gainPct = costNav > 0 ? ((nav - costNav) / costNav) * 100 : 0;

  let action: 'buy' | 'sell' | 'hold' = 'hold'; let shares = 0; let amount = 0;
  const strategies: string[] = [];
  if (direction === 'down') {
    if (gainPct > 5 && swingShares > 0) { action = 'sell'; shares = Math.round(swingShares * 0.15 * 100) / 100; amount = Math.round(shares * nav * 100) / 100; strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，今日先止盈${shares}份`); strategies.push(`明日跌至¥${navLow}附近可接回`); }
    else if (swingShares > 0 && Math.abs(predictedChangePct) > 0.5) { action = 'sell'; shares = Math.round(swingShares * 0.10 * 100) / 100; amount = Math.round(shares * nav * 100) / 100; strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，建议减仓${shares}份`); }
    else { strategies.push(`预测${targetDate}下跌${Math.abs(predictedChangePct).toFixed(2)}%，今日不宜买入`); strategies.push(`等待明日低点¥${navLow}附近再补仓`); }
  } else if (direction === 'up') {
    if (gainPct < -3) { const factor = Math.min(2, 1 + Math.abs(gainPct) / 15); amount = Math.round(500 * factor); shares = Math.round(amount / nav * 100) / 100; action = 'buy'; strategies.push(`预测${targetDate}上涨${predictedChangePct.toFixed(2)}%，建议买入${shares}份`); }
    else if (gainPct >= stopProfit && swingShares > 0) { strategies.push(`盈利${gainPct.toFixed(1)}%已达止盈线，预测还涨，持有一天`); }
    else { strategies.push(`预测${targetDate}上涨${predictedChangePct.toFixed(2)}%，持有等涨`); }
  } else { strategies.push(`预测${targetDate}横盘震荡`); if (gainPct < -5) { action = 'buy'; amount = 300; shares = Math.round(amount / nav * 100) / 100; strategies.push(`亏损${Math.abs(gainPct).toFixed(1)}%，小额定投`); } }

  const reasoning: string[] = [];
  reasoning.push(`[动量] 近3日${mom3d >= 0 ? '+' : ''}${mom3d.toFixed(2)}%，趋势因子${forecastResult.factors.trend >= 0 ? '+' : ''}${forecastResult.factors.trend.toFixed(3)}`);
  reasoning.push(`[RSI] ${tech.rsi14.toFixed(0)} → ${forecastResult.factors.rsi >= 0 ? '+' : ''}${forecastResult.factors.rsi.toFixed(3)}`);
  reasoning.push(`[布林] %B=${tech.bollingerBands.percentB.toFixed(0)} → ${forecastResult.factors.bollinger >= 0 ? '+' : ''}${forecastResult.factors.bollinger.toFixed(3)}`);
  if (geoRisk && geoRisk.signals.length > 0) reasoning.push(`[地缘] ${geoRisk.riskDetail}（评分${geoRisk.riskScore}）`);

  const recentChanges = navHistory.slice(-20).map((p, i, a) => i === 0 ? 0 : ((p.nav - a[i-1].nav) / a[i-1].nav) * 100).slice(1);
  const upDays = recentChanges.filter(c => c > 0).length;
  const downDays = recentChanges.filter(c => c < 0).length;

  return {
    fundName: fund.name, currentNav: nav, baseDate, targetDate, hasEstimate,
    prediction: { direction, predictedNav, predictedChangePct: Math.round(predictedChangePct * 100) / 100, navRange: { high: navHigh, low: navLow }, confidence: Math.round(confidence) },
    strategy: { action, shares, amount, strategies },
    factors: {
      trend: { value: Math.round(forecastResult.factors.trend * 1000) / 1000, label: '趋势动量', mom3d: Math.round(mom3d * 100) / 100, mom5d: Math.round(mom5d * 100) / 100 },
      reversion: { value: Math.round(forecastResult.factors.reversion * 1000) / 1000, label: '均值回归', deviationMA20: Math.round(deviationFromMA20 * 100) / 100 },
      rsi: { value: Math.round(forecastResult.factors.rsi * 1000) / 1000, label: 'RSI', rsi14: tech.rsi14 },
      macd: { value: Math.round(forecastResult.factors.macd * 1000) / 1000, label: 'MACD', histogram: tech.macd.histogram > 0 ? 'red' : 'green' },
      bollinger: { value: Math.round(forecastResult.factors.bollinger * 1000) / 1000, label: '布林带', percentB: Math.round(tech.bollingerBands.percentB) },
      news: { value: Math.round(forecastResult.factors.news * 1000) / 1000, label: '消息面', score: newsScore.score },
      market: { value: Math.round(forecastResult.factors.market * 1000) / 1000, label: '大盘环境' },
      supportResistance: { value: Math.round(forecastResult.factors.supportResistance * 1000) / 1000, label: '支撑阻力' },
      crossTimeframe: { value: Math.round(forecastResult.factors.crossTimeframe * 1000) / 1000, label: '跨周期确认' },
      gap: { value: Math.round(forecastResult.factors.gap * 1000) / 1000, label: '缺口回补' },
      capitalFlow: { value: Math.round((forecastResult.factors.capitalFlow || 0) * 1000) / 1000, label: '资金流向', score: capitalFlow?.flowScore ?? 0 },
    },
    position: { holdingShares, costNav: r4(costNav), gainPct: Math.round(gainPct * 100) / 100, baseShares, swingShares },
    stats: { recent20: { upDays, downDays, avgUp: recentChanges.filter(c => c > 0).length > 0 ? Math.round(recentChanges.filter(c => c > 0).reduce((a, b) => a + b, 0) / upDays * 100) / 100 : 0, avgDown: recentChanges.filter(c => c < 0).length > 0 ? Math.round(recentChanges.filter(c => c < 0).reduce((a, b) => a + b, 0) / downDays * 100) / 100 : 0 }, volatility: riskM.volatility20d, atrPct: Math.round(atrPct * 100) / 100 },
    reasoning,
    fundamentalHighlights: fundScore.highlights,
    geoRisk: geoRisk && geoRisk.signals.length > 0 ? { riskScore: geoRisk.riskScore, riskLevel: geoRisk.riskLevel, riskDetail: geoRisk.riskDetail, signals: geoRisk.signals } : null,
    capitalFlow: capitalFlow ? { flowScore: capitalFlow.flowScore, flowLabel: capitalFlow.flowLabel, flowDetail: capitalFlow.flowDetail } : null,
    modelVersion: FORECAST_MODEL_VERSION, timestamp: new Date().toISOString(),
  };
}

/** Trade analysis (mirrors GET /strategy/trade-analysis) */
export { fetchCapitalFlow, fetchFundamental, fetchFundHoldings, fetchSectorNews, inferSectorKeyword, scoreFundamental };

export default router;
