#!/usr/bin/env python3
"""
回测引擎 v1 - 基金策略多Agent竞技场
========================================
拉取真实A股基金历史净值数据，回测多个策略变体，
比较夏普比率/最大回撤/总收益，淘汰弱者，进化强者。
"""

import os
import sys

# 必须在 import urllib 之前清除代理（urllib在import时读取proxy env）
for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

import json
import math
import urllib.request
import urllib.parse
import ssl
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Optional
import numpy as np
import pandas as pd

ssl_ctx = ssl.create_default_context()

# ============================================================
# 数据获取
# ============================================================

def fetch_fund_nav_history(code: str, days: int = 365) -> pd.DataFrame:
    """从东方财富获取基金历史净值"""
    page_size = 20  # API实际每页最多返回20条
    all_data = []
    page = 1
    max_retries = 3
    import time as _time
    while len(all_data) < days:
        url = (f"https://api.fund.eastmoney.com/f10/lsjz?"
               f"fundCode={code}&pageIndex={page}&pageSize={page_size}")
        req = urllib.request.Request(url, headers={
            'Referer': 'https://fundf10.eastmoney.com/',
            'User-Agent': 'Mozilla/5.0'
        })
        items = []
        success = False
        for attempt in range(max_retries):
            try:
                if attempt > 0:
                    _time.sleep(2)
                else:
                    _time.sleep(0.3)
                resp = urllib.request.urlopen(req, context=ssl_ctx, timeout=20)
                raw = resp.read().decode()
                data = json.loads(raw)
                if data is None:
                    print(f"  [DEBUG] {code} p{page} attempt{attempt}: API returned null, raw={raw[:100]}")
                    continue
                data_inner = data.get('Data')
                if data_inner is None:
                    print(f"  [DEBUG] {code} p{page} attempt{attempt}: Data is None, keys={list(data.keys())}, ErrMsg={data.get('ErrMsg','')}")
                    continue
                items = data_inner.get('LSJZList', [])
                success = True
                break
            except Exception as e:
                if attempt == max_retries - 1:
                    print(f"  [WARN] 获取{code}第{page}页失败(重试{max_retries}次): {type(e).__name__}: {e}")
        if not success or not items:
            break
        for item in items:
            try:
                all_data.append({
                    'date': item['FSRQ'],
                    'nav': float(item['DWJZ']),
                    'change_pct': float(item['JZZZL']) if item.get('JZZZL') else 0.0,
                })
            except (ValueError, KeyError):
                continue
        if len(items) < page_size:
            break
        page += 1
        _time.sleep(0.5)

    if not all_data:
        return pd.DataFrame()

    df = pd.DataFrame(all_data)
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').reset_index(drop=True)
    df['daily_return'] = df['nav'].pct_change()
    return df


def fetch_index_history(secid: str, days: int = 365) -> pd.DataFrame:
    """从东方财富获取指数历史K线"""
    url = (f"https://push2his.eastmoney.com/api/qt/stock/kline/get?"
           f"secid={secid}&klt=101&fqt=1&lmt={days}"
           f"&end=20500101&fields1=f1,f2,f3,f4,f5,f6"
           f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urllib.request.urlopen(req, context=ssl_ctx, timeout=15)
        data = json.loads(resp.read().decode())
        klines = data.get('data', {}).get('klines', [])
        rows = []
        for k in klines:
            parts = k.split(',')
            rows.append({
                'date': parts[0],
                'open': float(parts[1]),
                'close': float(parts[2]),
                'high': float(parts[3]),
                'low': float(parts[4]),
                'volume': float(parts[5]) if len(parts) > 5 else 0,
                'change_pct': float(parts[8]) if len(parts) > 8 else 0,
            })
        df = pd.DataFrame(rows)
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date').reset_index(drop=True)
        return df
    except Exception as e:
        print(f"  [WARN] 获取指数{secid}失败: {e}")
        return pd.DataFrame()


# ============================================================
# 技术指标计算
# ============================================================

def calc_ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()

def calc_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def calc_macd(series: pd.Series, fast=12, slow=26, signal=9):
    ema_fast = calc_ema(series, fast)
    ema_slow = calc_ema(series, slow)
    dif = ema_fast - ema_slow
    dea = calc_ema(dif, signal)
    hist = 2 * (dif - dea)
    return dif, dea, hist

def calc_bollinger(series: pd.Series, period=20, mult=2):
    mid = series.rolling(period).mean()
    std = series.rolling(period).std()
    upper = mid + mult * std
    lower = mid - mult * std
    pct_b = (series - lower) / (upper - lower) * 100
    width = (upper - lower) / mid * 100
    return mid, upper, lower, pct_b, width

def calc_atr(navs: pd.Series, period=14) -> pd.Series:
    tr = navs.diff().abs()
    return tr.rolling(period).mean()


# ============================================================
# 回测绩效计算
# ============================================================

def calc_performance(returns: pd.Series, rf_annual: float = 0.02) -> Dict:
    """计算回测绩效指标"""
    if len(returns) < 5:
        return {'total_return': 0, 'sharpe': 0, 'max_drawdown': 0, 'calmar': 0, 'win_rate': 0}

    total_return = (1 + returns).prod() - 1
    daily_rf = (1 + rf_annual) ** (1/250) - 1
    excess = returns - daily_rf
    sharpe = excess.mean() / excess.std() * math.sqrt(250) if excess.std() > 0 else 0

    # 最大回撤
    cumulative = (1 + returns).cumprod()
    peak = cumulative.cummax()
    drawdown = (cumulative - peak) / peak
    max_drawdown = drawdown.min()

    # 年化收益
    n_days = len(returns)
    annual_return = (1 + total_return) ** (250 / max(n_days, 1)) - 1

    # 卡尔玛比率
    calmar = annual_return / abs(max_drawdown) if max_drawdown != 0 else 0

    # 胜率
    win_rate = (returns > 0).sum() / len(returns) * 100

    # 盈亏比
    wins = returns[returns > 0]
    losses = returns[returns < 0]
    pl_ratio = wins.mean() / abs(losses.mean()) if len(losses) > 0 and losses.mean() != 0 else 1

    return {
        'total_return': round(total_return * 100, 2),
        'annual_return': round(annual_return * 100, 2),
        'sharpe': round(sharpe, 3),
        'max_drawdown': round(max_drawdown * 100, 2),
        'calmar': round(calmar, 3),
        'win_rate': round(win_rate, 1),
        'pl_ratio': round(pl_ratio, 2),
        'n_trades': len(returns),
    }


# ============================================================
# 策略基类
# ============================================================

class Strategy:
    """策略基类"""
    def __init__(self, name: str, params: Dict):
        self.name = name
        self.params = params

    def generate_signal(self, df: pd.DataFrame, i: int, market_df: Optional[pd.DataFrame] = None) -> float:
        """生成信号: -1(强卖)到+1(强买), 0=持有"""
        raise NotImplementedError

    def describe(self) -> str:
        return f"{self.name}: {json.dumps(self.params, ensure_ascii=False)}"


# ============================================================
# 策略变体
# ============================================================

class OriginalStrategy(Strategy):
    """原始策略：还原当前strategy.ts的预测逻辑"""
    def __init__(self, params: Optional[Dict] = None):
        default = {
            'trend_weight': 0.6, 'reversion_weight': 0.12, 'rsi_weight': 0.025,
            'macd_weight': 0.15, 'bb_weight': 0.015, 'market_weight': 0.08,
            'streak_decay_3': 0.8, 'streak_decay_5': 0.5,
            'ma20_threshold': 2.0, 'ma5_threshold': 1.5,
            'rsi_overbought': 65, 'rsi_oversold': 35,
            'rsi_extreme_high': 80, 'rsi_extreme_low': 20,
            'vol_high': 25, 'vol_adj_high': 0.7, 'vol_adj_mid': 0.85,
        }
        if params:
            default.update(params)
        super().__init__('原始策略', default)

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        p = self.params
        if i < 30:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 趋势动量
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.2, 0.3, 0.5, 0.7, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0

        # 连涨连跌
        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        trend_factor = weighted_mom * p['trend_weight']
        if abs(streak) >= 5: trend_factor *= p['streak_decay_5']
        elif abs(streak) >= 3: trend_factor *= p['streak_decay_3']

        # MA趋势评分
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        trend_score = 0
        if current > ma5: trend_score += 15
        else: trend_score -= 15
        if current > ma10: trend_score += 15
        else: trend_score -= 15
        if current > ma20: trend_score += 20
        else: trend_score -= 20
        if ma5 > ma10: trend_score += 10
        else: trend_score -= 10

        trend_factor += trend_score * 0.015

        # 均值回归
        dev_ma20 = (current - ma20) / ma20 * 100
        dev_ma5 = (current - ma5) / ma5 * 100
        reversion = 0
        if abs(dev_ma20) > p['ma20_threshold']:
            sign = -1 if dev_ma20 > 0 else 1
            reversion += sign * math.sqrt(abs(dev_ma20) - p['ma20_threshold']) * p['reversion_weight']
        if abs(dev_ma5) > p['ma5_threshold']:
            sign = -1 if dev_ma5 > 0 else 1
            reversion += sign * (abs(dev_ma5) - p['ma5_threshold']) * 0.08

        # RSI
        rsi_series = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50
        rsi_factor = 0
        if rsi > p['rsi_extreme_high']: rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.08
        elif rsi > p['rsi_overbought']: rsi_factor = -(rsi - p['rsi_overbought']) * p['rsi_weight']
        elif rsi < p['rsi_extreme_low']: rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.08
        elif rsi < p['rsi_oversold']: rsi_factor = (p['rsi_oversold'] - rsi) * p['rsi_weight']

        # MACD
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea: macd_factor = p['macd_weight']
        elif hist < 0 and dif < dea: macd_factor = -p['macd_weight']

        # 布林带
        mid_s, upper_s, lower_s, pctb_s, width_s = calc_bollinger(pd.Series(navs))
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_factor = 0
        if pct_b > 95: bb_factor = -0.35
        elif pct_b > 80: bb_factor = -(pct_b - 80) * p['bb_weight']
        elif pct_b < 5: bb_factor = 0.35
        elif pct_b < 20: bb_factor = (20 - pct_b) * p['bb_weight']

        # 市场因子
        market_factor = 0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

        # 波动率调整
        daily_returns = pd.Series(navs).pct_change().dropna()
        vol_20d = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15
        vol_adj = p['vol_adj_high'] if vol_20d > p['vol_high'] else (p['vol_adj_mid'] if vol_20d > 15 else 1.0)
        trend_factor *= vol_adj
        reversion *= (2 - vol_adj)

        raw = trend_factor + reversion + rsi_factor + macd_factor + bb_factor + market_factor
        return max(-1, min(1, raw / 2))  # normalize to [-1, 1]


class MacroDefensiveStrategy(Strategy):
    """宏观防守策略：更注重大盘环境和风险控制"""
    def __init__(self, params: Optional[Dict] = None):
        default = {
            'trend_weight': 0.3, 'reversion_weight': 0.18, 'rsi_weight': 0.04,
            'macd_weight': 0.1, 'bb_weight': 0.02, 'market_weight': 0.25,
            'streak_decay_3': 0.6, 'streak_decay_5': 0.3,
            'ma20_threshold': 1.5, 'ma5_threshold': 1.0,
            'rsi_overbought': 60, 'rsi_oversold': 40,
            'rsi_extreme_high': 75, 'rsi_extreme_low': 25,
            'vol_high': 20, 'vol_adj_high': 0.5, 'vol_adj_mid': 0.7,
            'drawdown_kill': 8.0,   # 回撤超过8%强制做空
            'vol_kill': 35.0,       # 波动率超35%清仓
        }
        if params:
            default.update(params)
        super().__init__('宏观防守', default)

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        p = self.params
        if i < 30:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 风险优先：回撤和波动率检查
        peak = np.max(navs)
        drawdown = (peak - current) / peak * 100
        daily_returns = pd.Series(navs).pct_change().dropna()
        vol = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15

        if drawdown > p['drawdown_kill']:
            return -0.8  # 大回撤 → 强卖
        if vol > p['vol_kill']:
            return -0.6  # 极端波动 → 卖出

        # 原始信号计算（复用）
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.2, 0.3, 0.5, 0.7, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0
        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        trend_factor = weighted_mom * p['trend_weight']
        if abs(streak) >= 5: trend_factor *= p['streak_decay_5']
        elif abs(streak) >= 3: trend_factor *= p['streak_decay_3']

        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        trend_score = 0
        if current > ma5: trend_score += 10
        else: trend_score -= 15
        if current > ma10: trend_score += 10
        else: trend_score -= 15
        if current > ma20: trend_score += 15
        else: trend_score -= 25  # 空头加权
        trend_factor += trend_score * 0.015

        dev_ma20 = (current - ma20) / ma20 * 100
        reversion = 0
        if abs(dev_ma20) > p['ma20_threshold']:
            sign = -1 if dev_ma20 > 0 else 1
            reversion += sign * math.sqrt(abs(dev_ma20) - p['ma20_threshold']) * p['reversion_weight']

        rsi_series = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50
        rsi_factor = 0
        if rsi > p['rsi_extreme_high']: rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.1
        elif rsi > p['rsi_overbought']: rsi_factor = -(rsi - p['rsi_overbought']) * p['rsi_weight']
        elif rsi < p['rsi_extreme_low']: rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.06
        elif rsi < p['rsi_oversold']: rsi_factor = (p['rsi_oversold'] - rsi) * p['rsi_weight']

        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea: macd_factor = p['macd_weight']
        elif hist < 0 and dif < dea: macd_factor = -p['macd_weight']

        # 大盘因子（权重加大）
        market_factor = 0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100
            # 大盘5日均线下穿 → 额外空头信号
            if i >= 5 and 'close' in market_df.columns:
                mkt_navs = market_df['close'].values[:i+1]
                mkt_ma5 = np.mean(mkt_navs[-5:])
                mkt_ma10 = np.mean(mkt_navs[-10:]) if len(mkt_navs) >= 10 else mkt_ma5
                if mkt_ma5 < mkt_ma10:
                    market_factor -= 0.15

        vol_adj = p['vol_adj_high'] if vol > p['vol_high'] else (p['vol_adj_mid'] if vol > 15 else 1.0)
        trend_factor *= vol_adj
        reversion *= (2 - vol_adj)

        raw = trend_factor + reversion + rsi_factor + macd_factor + market_factor
        return max(-1, min(1, raw / 1.5))


class AggressiveEventStrategy(Strategy):
    """事件激进策略：捕捉超跌反弹，追踪趋势加速"""
    def __init__(self, params: Optional[Dict] = None):
        default = {
            'trend_weight': 0.9, 'reversion_weight': 0.06, 'rsi_weight': 0.05,
            'macd_weight': 0.25, 'bb_weight': 0.025, 'market_weight': 0.05,
            'streak_decay_3': 0.9, 'streak_decay_5': 0.7,
            'ma20_threshold': 3.0, 'ma5_threshold': 2.0,
            'rsi_overbought': 75, 'rsi_oversold': 25,
            'rsi_extreme_high': 85, 'rsi_extreme_low': 15,
            'vol_high': 30, 'vol_adj_high': 0.9, 'vol_adj_mid': 0.95,
            'capitulation_rsi': 25, 'capitulation_dd': 12,
            'breakout_bb': 95,
        }
        if params:
            default.update(params)
        super().__init__('事件激进', default)

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        p = self.params
        if i < 30:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 极端事件检测
        peak = np.max(navs[-60:]) if len(navs) >= 60 else np.max(navs)
        drawdown = (peak - current) / peak * 100

        rsi_series = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50

        # 恐慌探底 = 极端买入机会
        if drawdown > p['capitulation_dd'] and rsi < p['capitulation_rsi']:
            return 0.9  # 恐慌时贪婪

        # 趋势动量（高权重）
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.1, 0.2, 0.4, 0.8, 1.0])  # 更重最近
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0
        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        trend_factor = weighted_mom * p['trend_weight']
        if abs(streak) >= 5: trend_factor *= p['streak_decay_5']
        elif abs(streak) >= 3: trend_factor *= p['streak_decay_3']

        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        trend_score = 0
        if current > ma5: trend_score += 20
        else: trend_score -= 10
        if current > ma10: trend_score += 15
        else: trend_score -= 10
        if current > ma20: trend_score += 15
        else: trend_score -= 15
        if ma5 > ma10: trend_score += 15
        else: trend_score -= 10
        trend_factor += trend_score * 0.02

        # MACD（高权重，金叉全力做多）
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea: macd_factor = p['macd_weight']
        elif hist < 0 and dif < dea: macd_factor = -p['macd_weight']
        # 金叉/死叉 extra boost
        if i >= 2:
            prev_hist = calc_macd(pd.Series(navs[:-1]))[2].iloc[-1]
            if not np.isnan(prev_hist):
                if prev_hist <= 0 and hist > 0: macd_factor += 0.4  # 金叉
                if prev_hist >= 0 and hist < 0: macd_factor -= 0.4  # 死叉

        # 布林突破
        mid_s, upper_s, lower_s, pctb_s, _ = calc_bollinger(pd.Series(navs))
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_factor = 0
        if pct_b > p['breakout_bb']: bb_factor = 0.2   # 突破上轨继续追涨
        elif pct_b < 5: bb_factor = 0.3                  # 突破下轨极端买入
        elif pct_b < 20: bb_factor = (20 - pct_b) * p['bb_weight']
        elif pct_b > 80: bb_factor = -(pct_b - 80) * p['bb_weight']

        rsi_factor = 0
        if rsi > p['rsi_extreme_high']: rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.06
        elif rsi > p['rsi_overbought']: rsi_factor = -(rsi - p['rsi_overbought']) * p['rsi_weight']
        elif rsi < p['rsi_extreme_low']: rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.1
        elif rsi < p['rsi_oversold']: rsi_factor = (p['rsi_oversold'] - rsi) * p['rsi_weight']

        raw = trend_factor + rsi_factor + macd_factor + bb_factor
        return max(-1, min(1, raw / 2.5))


class AdaptiveHybridStrategy(Strategy):
    """自适应混合策略：根据市场状态动态切换权重"""
    def __init__(self, params: Optional[Dict] = None):
        default = {
            # 趋势市参数
            'trend_trend_w': 0.8, 'trend_reversion_w': 0.04,
            # 震荡市参数
            'range_trend_w': 0.3, 'range_reversion_w': 0.2,
            # RSI参数
            'rsi_weight': 0.035, 'rsi_overbought': 65, 'rsi_oversold': 35,
            'rsi_extreme_high': 80, 'rsi_extreme_low': 20,
            # MACD
            'macd_weight': 0.2, 'macd_golden_cross_boost': 0.35,
            # 布林
            'bb_weight': 0.02,
            # 市场
            'market_weight': 0.12,
            # 波动率
            'vol_high': 25, 'vol_adj': 0.65,
            # ATR
            'atr_exit_mult': 2.0,
            # 背离检测
            'divergence_lookback': 10, 'divergence_weight': 0.2,
            # 连涨衰减
            'streak_decay_3': 0.75, 'streak_decay_5': 0.4,
        }
        if params:
            default.update(params)
        super().__init__('自适应混合', default)

    def _detect_regime(self, navs: np.ndarray) -> str:
        """判断市场状态：trending/ranging/volatile"""
        if len(navs) < 30:
            return 'ranging'
        returns = np.diff(navs) / navs[:-1]
        recent = returns[-20:]
        vol = np.std(recent) * math.sqrt(250) * 100

        # 趋势检测：ADX概念用均线排列替代
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        aligned_bull = ma5 > ma10 > ma20
        aligned_bear = ma5 < ma10 < ma20

        if vol > 30:
            return 'volatile'
        elif aligned_bull or aligned_bear:
            return 'trending'
        else:
            return 'ranging'

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        p = self.params
        if i < 30:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        # 动态权重
        if regime == 'trending':
            tw, rw = p['trend_trend_w'], p['trend_reversion_w']
        elif regime == 'volatile':
            tw, rw = p['range_trend_w'] * 0.5, p['range_reversion_w'] * 1.5
        else:
            tw, rw = p['range_trend_w'], p['range_reversion_w']

        # 趋势动量
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.15, 0.25, 0.45, 0.75, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0
        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        trend_factor = weighted_mom * tw
        if abs(streak) >= 5: trend_factor *= p['streak_decay_5']
        elif abs(streak) >= 3: trend_factor *= p['streak_decay_3']

        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        trend_score = 0
        if current > ma5: trend_score += 15
        else: trend_score -= 15
        if current > ma10: trend_score += 15
        else: trend_score -= 15
        if current > ma20: trend_score += 20
        else: trend_score -= 20
        if ma5 > ma10: trend_score += 10
        else: trend_score -= 10
        trend_factor += trend_score * 0.015

        # 均值回归
        dev_ma20 = (current - ma20) / ma20 * 100
        dev_ma5 = (current - ma5) / ma5 * 100
        reversion = 0
        if abs(dev_ma20) > 2:
            sign = -1 if dev_ma20 > 0 else 1
            reversion += sign * math.sqrt(abs(dev_ma20) - 2) * rw
        if abs(dev_ma5) > 1.5:
            sign = -1 if dev_ma5 > 0 else 1
            reversion += sign * (abs(dev_ma5) - 1.5) * 0.08

        # RSI + 背离
        rsi_series = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50
        rsi_factor = 0
        if rsi > p['rsi_extreme_high']: rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.08
        elif rsi > p['rsi_overbought']: rsi_factor = -(rsi - p['rsi_overbought']) * p['rsi_weight']
        elif rsi < p['rsi_extreme_low']: rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.08
        elif rsi < p['rsi_oversold']: rsi_factor = (p['rsi_oversold'] - rsi) * p['rsi_weight']

        # RSI背离
        lb = p['divergence_lookback']
        if i >= lb:
            past_nav = navs[-lb-1]
            past_rsi = rsi_series.iloc[-lb-1] if len(rsi_series) > lb else 50
            if not np.isnan(past_rsi):
                if current > past_nav and rsi < past_rsi: rsi_factor -= p['divergence_weight']  # 顶背离
                if current < past_nav and rsi > past_rsi: rsi_factor += p['divergence_weight']  # 底背离

        # MACD
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea: macd_factor = p['macd_weight']
        elif hist < 0 and dif < dea: macd_factor = -p['macd_weight']
        if i >= 2:
            prev_hist = calc_macd(pd.Series(navs[:-1]))[2].iloc[-1]
            if not np.isnan(prev_hist):
                if prev_hist <= 0 and hist > 0: macd_factor += p['macd_golden_cross_boost']
                if prev_hist >= 0 and hist < 0: macd_factor -= p['macd_golden_cross_boost']

        # 布林带
        _, _, _, pctb_s, _ = calc_bollinger(pd.Series(navs))
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_factor = 0
        if regime == 'ranging':  # 震荡市布林带权重更大
            if pct_b > 95: bb_factor = -0.4
            elif pct_b > 80: bb_factor = -(pct_b - 80) * p['bb_weight'] * 1.5
            elif pct_b < 5: bb_factor = 0.4
            elif pct_b < 20: bb_factor = (20 - pct_b) * p['bb_weight'] * 1.5
        else:
            if pct_b > 95: bb_factor = -0.3
            elif pct_b > 80: bb_factor = -(pct_b - 80) * p['bb_weight']
            elif pct_b < 5: bb_factor = 0.3
            elif pct_b < 20: bb_factor = (20 - pct_b) * p['bb_weight']

        # 大盘
        market_factor = 0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

        # 波动率修正
        daily_returns = pd.Series(navs).pct_change().dropna()
        vol = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15
        if vol > p['vol_high']:
            trend_factor *= p['vol_adj']
            reversion *= (2 - p['vol_adj'])

        raw = trend_factor + reversion + rsi_factor + macd_factor + bb_factor + market_factor
        return max(-1, min(1, raw / 2))


# ============================================================
# 回测引擎
# ============================================================

def run_backtest(strategy: Strategy, fund_df: pd.DataFrame, market_df: Optional[pd.DataFrame] = None,
                 initial_cash: float = 100000, fee_rate: float = 0.0015) -> Dict:
    """
    回测策略
    信号 > 0.3 → 买入（信号强度决定仓位）
    信号 < -0.3 → 卖出
    """
    cash = initial_cash
    shares = 0.0
    portfolio_values = []
    trades = []
    daily_returns = []

    for i in range(len(fund_df)):
        nav = fund_df['nav'].iloc[i]
        date = fund_df['date'].iloc[i]

        signal = strategy.generate_signal(fund_df, i, market_df)

        # 信号执行
        if signal > 0.3 and cash > 100:
            # 买入比例 = 信号强度映射
            buy_pct = min(abs(signal), 1.0) * 0.5  # 最多一次买入50%现金
            buy_amount = cash * buy_pct
            fee = buy_amount * fee_rate
            buy_shares = (buy_amount - fee) / nav
            shares += buy_shares
            cash -= buy_amount
            trades.append({'date': date, 'type': 'buy', 'nav': nav, 'shares': buy_shares, 'amount': buy_amount, 'signal': signal})

        elif signal < -0.3 and shares > 0:
            # 卖出比例 = 信号强度
            sell_pct = min(abs(signal), 1.0) * 0.5
            sell_shares = shares * sell_pct
            sell_amount = sell_shares * nav
            fee = sell_amount * fee_rate
            shares -= sell_shares
            cash += sell_amount - fee
            trades.append({'date': date, 'type': 'sell', 'nav': nav, 'shares': sell_shares, 'amount': sell_amount, 'signal': signal})

        # 记录组合价值
        portfolio_value = cash + shares * nav
        portfolio_values.append(portfolio_value)

        if len(portfolio_values) > 1:
            daily_returns.append((portfolio_values[-1] - portfolio_values[-2]) / portfolio_values[-2])
        else:
            daily_returns.append(0)

    returns_series = pd.Series(daily_returns)
    perf = calc_performance(returns_series)
    perf['final_value'] = round(portfolio_values[-1], 2)
    perf['n_buy_trades'] = len([t for t in trades if t['type'] == 'buy'])
    perf['n_sell_trades'] = len([t for t in trades if t['type'] == 'sell'])
    perf['strategy'] = strategy.name

    # 检查逃顶能力：在大跌日是否持有较少份额
    fund_returns = fund_df['nav'].pct_change()
    crash_days = fund_returns[fund_returns < -0.02].index.tolist()
    if crash_days:
        # 比较策略在大跌日的回撤 vs 满仓持有
        crash_losses = []
        for ci in crash_days:
            if ci < len(daily_returns):
                strat_loss = daily_returns[ci]
                fund_loss = fund_returns.iloc[ci]
                crash_losses.append(strat_loss - fund_loss)  # 正值=策略更好
        perf['crash_avoidance'] = round(np.mean(crash_losses) * 100, 3) if crash_losses else 0
    else:
        perf['crash_avoidance'] = 0

    return perf


# ============================================================
# 参数变异
# ============================================================

def mutate_params(params: Dict, mutation_rate: float = 0.15) -> Dict:
    """对参数进行小幅随机变异"""
    new_params = {}
    for k, v in params.items():
        if isinstance(v, (int, float)):
            delta = v * mutation_rate * (np.random.random() * 2 - 1)
            new_val = v + delta
            if isinstance(v, int):
                new_val = int(round(new_val))
            new_params[k] = new_val
        else:
            new_params[k] = v
    return new_params


# ============================================================
# 主程序
# ============================================================

def main():
    print("=" * 60)
    print("  基金策略多Agent竞技场 v1")
    print("  回测区间：近1年 A股基金历史净值")
    print("=" * 60)

    # === 1. 获取数据 ===
    print("\n📊 Phase 1: 获取历史数据...")

    # 用户实际持仓基金（21只，覆盖黄金/AI/医药/半导体/光伏/新能源/有色/传媒/卫星等）
    test_funds = [
        ('000217', '华安黄金ETF联接C'),
        ('020982', '华安国证机器人产业指数C'),
        ('019671', '广发港股创新药ETF联接C'),
        ('010572', '易方达中证万得生物科技C'),
        ('002611', '博时黄金ETF联接C'),
        ('004253', '国泰黄金ETF联接C'),
        ('018897', '易方达消费电子ETF联接C'),
        ('023408', '华宝创业板AI ETF联接C'),
        ('012365', '广发中证光伏产业指数C'),
        ('022365', '永赢科技智选混合C'),
        ('019325', '易方达中证生物科技ETF联接C'),
        ('025209', '永赢先锋半导体智选混合C'),
        ('016387', '永赢低碳环保智选混合C'),
        ('024195', '永赢国证商用卫星通信C'),
        ('004753', '广发中证传媒ETF联接C'),
        ('016874', '广发远见智选混合C'),
        ('017074', '嘉实清洁能源股票C'),
        ('010990', '南方有色金属ETF联接E'),
        ('012832', '南方中证新能源ETF联接C'),
        ('011036', '嘉实中证稀土产业ETF联接C'),
        ('008888', '华夏国证半导体芯片ETF联接C'),
    ]

    # 用沪深300ETF基金作为市场基准（避免直接访问指数API）
    print("  获取沪深300基金作为市场基准...")
    market_df = fetch_fund_nav_history('000051', 365)  # 华夏沪深300ETF联接
    if len(market_df) > 0:
        market_df['close'] = market_df['nav']
    print(f"  市场基准: {len(market_df)} 天")

    fund_data = {}
    for code, name in test_funds:
        print(f"  获取 {name}({code})...")
        df = fetch_fund_nav_history(code, 365)
        if len(df) >= 60:
            fund_data[code] = (name, df)
            print(f"    ✅ {len(df)} 天")
        else:
            print(f"    ❌ 数据不足（{len(df)}天），跳过")

    if not fund_data:
        print("❌ 无法获取任何基金数据，退出")
        return

    # === 2. 构建策略Agent ===
    print("\n⚔️  Phase 2: 多Agent竞技...")

    strategies = [
        OriginalStrategy(),
        MacroDefensiveStrategy(),
        AggressiveEventStrategy(),
        AdaptiveHybridStrategy(),
    ]

    # === 3. 回测所有策略 ===
    all_results = {}
    for strat in strategies:
        strat_results = []
        for code, (name, df) in fund_data.items():
            perf = run_backtest(strat, df, market_df)
            perf['fund'] = name
            perf['code'] = code
            strat_results.append(perf)

        avg_sharpe = np.mean([r['sharpe'] for r in strat_results])
        avg_return = np.mean([r['total_return'] for r in strat_results])
        avg_drawdown = np.mean([r['max_drawdown'] for r in strat_results])
        avg_crash = np.mean([r['crash_avoidance'] for r in strat_results])

        all_results[strat.name] = {
            'details': strat_results,
            'avg_sharpe': round(avg_sharpe, 3),
            'avg_return': round(avg_return, 2),
            'avg_drawdown': round(avg_drawdown, 2),
            'avg_crash_avoidance': round(avg_crash, 3),
        }

        print(f"\n  📈 [{strat.name}]")
        print(f"     平均夏普: {avg_sharpe:.3f} | 平均收益: {avg_return:.2f}% | 平均回撤: {avg_drawdown:.2f}% | 逃顶: {avg_crash:.3f}%")
        for r in strat_results:
            print(f"     {r['fund']:12s} 收益:{r['total_return']:7.2f}% 夏普:{r['sharpe']:6.3f} 回撤:{r['max_drawdown']:7.2f}% 买{r['n_buy_trades']}卖{r['n_sell_trades']}")

    # === 4. 排名 & 淘汰 ===
    print("\n🏆 Phase 3: 排名与淘汰...")
    ranked = sorted(all_results.items(), key=lambda x: x[1]['avg_sharpe'], reverse=True)

    print("\n  排名（按夏普比率）：")
    for rank, (name, result) in enumerate(ranked, 1):
        emoji = "🥇" if rank == 1 else "🥈" if rank == 2 else "🥉" if rank == 3 else "  "
        print(f"  {emoji} #{rank} {name:12s} | 夏普:{result['avg_sharpe']:6.3f} | 收益:{result['avg_return']:7.2f}% | 回撤:{result['avg_drawdown']:7.2f}%")

    best_name = ranked[0][0]
    worst_name = ranked[-1][0]
    print(f"\n  ✅ 冠军: {best_name}")
    print(f"  ❌ 淘汰: {worst_name}")

    # === 5. 进化：对冠军策略做参数变异 ===
    print("\n🧬 Phase 4: 进化迭代（冠军变异x8）...")
    best_strat = next(s for s in strategies if s.name == best_name)

    evolution_results = [(best_name, all_results[best_name]['avg_sharpe'], all_results[best_name]['avg_return'], all_results[best_name]['avg_drawdown'], best_strat.params)]

    for gen in range(8):
        mutated_params = mutate_params(best_strat.params, mutation_rate=0.1)

        if isinstance(best_strat, OriginalStrategy):
            variant = OriginalStrategy(mutated_params)
        elif isinstance(best_strat, MacroDefensiveStrategy):
            variant = MacroDefensiveStrategy(mutated_params)
        elif isinstance(best_strat, AggressiveEventStrategy):
            variant = AggressiveEventStrategy(mutated_params)
        else:
            variant = AdaptiveHybridStrategy(mutated_params)
        variant.name = f"{best_name}_进化G{gen+1}"

        var_results = []
        for code, (name, df) in fund_data.items():
            perf = run_backtest(variant, df, market_df)
            var_results.append(perf)

        avg_s = np.mean([r['sharpe'] for r in var_results])
        avg_r = np.mean([r['total_return'] for r in var_results])
        avg_d = np.mean([r['max_drawdown'] for r in var_results])
        evolution_results.append((variant.name, round(avg_s, 3), round(avg_r, 2), round(avg_d, 2), mutated_params))
        print(f"  G{gen+1}: 夏普={avg_s:.3f} 收益={avg_r:.2f}% 回撤={avg_d:.2f}%")

        # 如果变异版更好，替换
        if avg_s > evolution_results[0][1]:
            best_strat.params = mutated_params
            evolution_results[0] = (variant.name, round(avg_s, 3), round(avg_r, 2), round(avg_d, 2), mutated_params)
            print(f"    🔥 进化成功！新冠军！")

    # 最终排名
    evolution_results.sort(key=lambda x: x[1], reverse=True)
    print(f"\n  🏆 最终冠军: {evolution_results[0][0]} (夏普={evolution_results[0][1]})")

    # === 5b. 按板块分析胜出策略的强弱项 ===
    print("\n📋 Phase 5: 按板块绩效分析...")
    best_final = evolution_results[0]
    # 重新跑一次冠军策略，获取逐基金数据
    if isinstance(best_strat, OriginalStrategy):
        final_strat = OriginalStrategy(best_final[4])
    elif isinstance(best_strat, MacroDefensiveStrategy):
        final_strat = MacroDefensiveStrategy(best_final[4])
    elif isinstance(best_strat, AggressiveEventStrategy):
        final_strat = AggressiveEventStrategy(best_final[4])
    else:
        final_strat = AdaptiveHybridStrategy(best_final[4])
    final_strat.name = best_final[0]

    print(f"\n  {'基金名称':18s} {'收益':>8s} {'夏普':>7s} {'回撤':>8s} {'逃顶':>7s}")
    print("  " + "-" * 52)
    sector_results = []
    for code, (name, df) in fund_data.items():
        perf = run_backtest(final_strat, df, market_df)
        emoji = "✅" if perf['sharpe'] > 0 else "⚠️" if perf['sharpe'] > -0.3 else "❌"
        print(f"  {emoji} {name:16s} {perf['total_return']:>7.2f}% {perf['sharpe']:>6.3f} {perf['max_drawdown']:>7.2f}% {perf.get('crash_avoidance',0):>6.3f}%")
        sector_results.append({'code': code, 'name': name, **perf})

    # 统计
    wins = [r for r in sector_results if r['sharpe'] > 0]
    losses = [r for r in sector_results if r['sharpe'] <= 0]
    print(f"\n  策略胜率: {len(wins)}/{len(sector_results)} ({len(wins)/len(sector_results)*100:.0f}%)")
    if losses:
        print(f"  弱势板块: {', '.join(r['name'] for r in sorted(losses, key=lambda x: x['sharpe'])[:5])}")
    if wins:
        print(f"  强势板块: {', '.join(r['name'] for r in sorted(wins, key=lambda x: x['sharpe'], reverse=True)[:5])}")

    # === 6. 输出最终参数 ===
    final_params = evolution_results[0][4]
    output = {
        'champion': evolution_results[0][0],
        'sharpe': evolution_results[0][1],
        'total_return': evolution_results[0][2],
        'max_drawdown': evolution_results[0][3],
        'params': final_params,
        'all_rankings': [
            {'name': r[0], 'sharpe': r[1], 'return': r[2], 'drawdown': r[3]} for r in evolution_results[:6]
        ],
        'fund_details': {code: {
            'name': name,
            'days': len(df),
        } for code, (name, df) in fund_data.items()},
        'full_results': all_results,
    }

    output_path = os.path.join(os.path.dirname(__file__), 'backtest_results.json')
    # Convert non-serializable types
    def default_serializer(obj):
        if isinstance(obj, (np.integer,)): return int(obj)
        if isinstance(obj, (np.floating,)): return float(obj)
        if isinstance(obj, (np.ndarray,)): return obj.tolist()
        if isinstance(obj, pd.Timestamp): return str(obj)
        return str(obj)

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=default_serializer)

    print(f"\n💾 结果已保存: {output_path}")
    print("\n" + "=" * 60)
    print("  回测完成！")
    print("=" * 60)

    return output


if __name__ == '__main__':
    main()
