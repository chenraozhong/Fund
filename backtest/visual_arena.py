#!/usr/bin/env python3
"""
可视化策略对抗竞技场 v3
==============================================
5个经典被市场验证的投资策略 vs 本地v6.2决策模型
输出交互式HTML可视化报告
"""

import os
import sys
import json
import math
import time as _time
from datetime import datetime
from typing import List, Dict, Tuple, Optional
import warnings
warnings.filterwarnings('ignore')

# 清除代理
for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest_engine import (
    Strategy, run_backtest, calc_performance,
    fetch_fund_nav_history, fetch_index_history,
    calc_ema, calc_rsi, calc_macd, calc_bollinger, calc_atr,
)

# ============================================================
# 测试基金池
# ============================================================
TEST_FUNDS = [
    ('000217', '华安黄金ETF联接C'),
    ('020982', '华安国证机器人产业指数C'),
    ('019671', '广发港股创新药ETF联接C'),
    ('010572', '易方达中证万得生物科技C'),
    ('002611', '博时黄金ETF联接C'),
    ('018897', '易方达消费电子ETF联接C'),
    ('023408', '华宝创业板AI ETF联接C'),
    ('012365', '广发中证光伏产业指数C'),
    ('022365', '永赢科技智选混合C'),
    ('008888', '华夏国证半导体芯片ETF联接C'),
]

SECTOR_MAP = {
    '黄金': ['000217', '002611'],
    'AI/机器人': ['020982', '023408'],
    '医药/生物': ['019671', '010572'],
    '半导体': ['008888'],
    '新能源/光伏': ['012365'],
    '消费电子': ['018897'],
    '混合/主题': ['022365'],
}

CODE_TO_SECTOR = {}
for sector, codes in SECTOR_MAP.items():
    for code in codes:
        CODE_TO_SECTOR[code] = sector


# ============================================================
# 经典策略 1: 双动量策略 (Gary Antonacci)
# 绝对动量 + 相对动量，被学术界和实践验证
# ============================================================
class DualMomentumStrategy(Strategy):
    """
    双动量策略 (Gary Antonacci, 2014)
    - 绝对动量: 过去12个月收益 > 无风险利率 → 做多
    - 相对动量: 选最强资产
    - 同时满足才做多，否则空仓/持有货币
    """
    def __init__(self, params=None):
        default = {
            'lookback': 60,          # 回看天数(模拟12月用60交易日)
            'abs_threshold': 0.0,    # 绝对动量阈值(>0才做多)
            'rel_threshold': 0.005,  # 相对动量阈值
            'exit_lookback': 20,     # 退出回看
            'vol_scale': True,       # 波动率缩放
        }
        if params: default.update(params)
        super().__init__('双动量(Antonacci)', default)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        lb = min(p['lookback'], i)
        if lb < 20: return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 绝对动量: 过去N天收益率
        past = navs[-lb]
        abs_return = (current - past) / past

        # 短期动量(20日)
        short_lb = min(p['exit_lookback'], i)
        short_past = navs[-short_lb]
        short_return = (current - short_past) / short_past

        # 趋势确认: MA排列
        ma20 = np.mean(navs[-20:])
        ma50 = np.mean(navs[-min(50,len(navs)):])

        # 波动率缩放
        vol_adj = 1.0
        if p['vol_scale'] and len(navs) > 20:
            returns = np.diff(navs[-21:]) / navs[-21:-1]
            vol = np.std(returns) * math.sqrt(250)
            target_vol = 0.15
            vol_adj = min(target_vol / max(vol, 0.01), 2.0)

        signal = 0.0

        # 双重条件: 绝对动量>0 且 短期动量>0
        if abs_return > p['abs_threshold'] and short_return > p['rel_threshold']:
            signal = 0.6 * vol_adj
            # MA多头排列加码
            if current > ma20 > ma50:
                signal = min(signal + 0.2, 1.0)
        elif abs_return < -0.03 or short_return < -0.02:
            # 动量反转 → 减仓
            signal = -0.4 * vol_adj
            if current < ma20 < ma50:
                signal = max(signal - 0.2, -1.0)
        else:
            # 模糊区间 → 轻仓或观望
            signal = 0.1 if abs_return > 0 else -0.1

        return max(-1, min(1, signal))


# ============================================================
# 经典策略 2: 海龟交易策略 (Richard Dennis & William Eckhardt)
# ============================================================
class TurtleTradingStrategy(Strategy):
    """
    海龟交易策略 (1983)
    - 入场: 突破20日最高价做多, 跌破20日最低价做空
    - 加仓: 每0.5个ATR加仓一次, 最多4层
    - 止损: 2倍ATR
    - 仓位: 1%风险 / (ATR × 合约乘数)
    """
    def __init__(self, params=None):
        default = {
            'entry_period': 20,      # 突破周期
            'exit_period': 10,       # 退出周期
            'atr_period': 14,        # ATR周期
            'atr_stop': 2.0,        # ATR止损倍数
            'atr_add': 0.5,         # 加仓ATR间距
            'max_units': 4,         # 最大加仓层数
            'risk_pct': 0.01,       # 单次风险
        }
        if params: default.update(params)
        super().__init__('海龟交易(Dennis)', default)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        entry = p['entry_period']
        exit_p = p['exit_period']
        if i < max(entry, exit_p) + 5:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 通道突破
        high_n = np.max(navs[-entry:])
        low_n = np.min(navs[-entry:])
        exit_low = np.min(navs[-exit_p:])
        exit_high = np.max(navs[-exit_p:])

        # ATR计算
        atr_vals = calc_atr(pd.Series(navs), p['atr_period'])
        atr = atr_vals.iloc[-1] if not np.isnan(atr_vals.iloc[-1]) else 0.01
        atr_pct = atr / current * 100

        # 波动率环境判断
        returns = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol = np.std(returns) * math.sqrt(250) * 100 if len(returns) > 5 else 15

        signal = 0.0

        if current >= high_n:
            # 突破N日高点 → 做多
            # 信号强度与突破幅度成正比
            breakout_pct = (current - high_n) / high_n * 100 + 0.1
            signal = min(0.3 + breakout_pct * 0.3, 0.9)
            # 高波动环境减仓
            if vol > 30: signal *= 0.6
        elif current <= low_n:
            # 跌破N日低点 → 做空/减仓
            breakdown_pct = (low_n - current) / low_n * 100 + 0.1
            signal = max(-0.3 - breakdown_pct * 0.3, -0.9)
        elif current <= exit_low:
            # 跌破退出低点 → 退出多头
            signal = -0.4
        elif current >= exit_high:
            signal = 0.3
        else:
            # 通道内 → 根据位置给信号
            channel_pos = (current - low_n) / (high_n - low_n) if high_n > low_n else 0.5
            if channel_pos > 0.8:
                signal = 0.2
            elif channel_pos < 0.2:
                signal = -0.2
            else:
                signal = (channel_pos - 0.5) * 0.4

        return max(-1, min(1, signal))


# ============================================================
# 经典策略 3: 三重滤网策略 (Alexander Elder)
# ============================================================
class TripleScreenStrategy(Strategy):
    """
    三重滤网策略 (Alexander Elder, 1985)
    - 第一屏: 周线(长期)趋势判断 → MACD方向
    - 第二屏: 日线(中期)逆势入场 → RSI超卖/超买
    - 第三屏: 精确入场 → 当日突破
    三屏一致才交易
    """
    def __init__(self, params=None):
        default = {
            'weekly_ema': 26,        # 周线EMA(模拟: 5x日线)
            'daily_rsi_ob': 70,      # RSI超买
            'daily_rsi_os': 30,      # RSI超卖
            'entry_breakout': 3,     # 入场突破天数
            'macd_weight': 0.3,
            'rsi_weight': 0.3,
            'breakout_weight': 0.4,
        }
        if params: default.update(params)
        super().__init__('三重滤网(Elder)', default)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 60: return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # === 第一屏: 长期趋势(模拟周线 = 5日采样) ===
        weekly_navs = navs[::5]  # 每5天取一个点模拟周K
        if len(weekly_navs) < 10:
            return 0.0

        # 周线MACD
        w_dif, w_dea, w_hist = calc_macd(pd.Series(weekly_navs), fast=12, slow=26, signal=9)
        weekly_trend = 0
        if not np.isnan(w_hist.iloc[-1]):
            if w_hist.iloc[-1] > 0:
                weekly_trend = 1   # 周线多头
            elif w_hist.iloc[-1] < 0:
                weekly_trend = -1  # 周线空头

        # 周线MACD斜率(加速/减速)
        if len(w_hist) >= 2 and not np.isnan(w_hist.iloc[-2]):
            if w_hist.iloc[-1] > w_hist.iloc[-2]:
                weekly_trend += 0.3  # 加速上涨
            else:
                weekly_trend -= 0.3  # 减速

        # === 第二屏: 日线RSI逆势 ===
        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50

        daily_signal = 0
        if weekly_trend > 0:
            # 周线看多 → 等日线回调(RSI低)买入
            if rsi < p['daily_rsi_os']:
                daily_signal = 0.8   # 强买
            elif rsi < 45:
                daily_signal = 0.4   # 温和买
            elif rsi > p['daily_rsi_ob']:
                daily_signal = -0.2  # 虽然周多,但日超买→观望
        elif weekly_trend < 0:
            # 周线看空 → 等日线反弹(RSI高)卖出
            if rsi > p['daily_rsi_ob']:
                daily_signal = -0.8
            elif rsi > 55:
                daily_signal = -0.4
            elif rsi < p['daily_rsi_os']:
                daily_signal = 0.2

        # === 第三屏: 入场确认(短期突破) ===
        entry_days = p['entry_breakout']
        recent_high = np.max(navs[-entry_days:]) if len(navs) >= entry_days else current
        recent_low = np.min(navs[-entry_days:]) if len(navs) >= entry_days else current

        entry_signal = 0
        if weekly_trend > 0 and daily_signal > 0:
            # 多头环境 → 等突破近期高点
            if current >= recent_high:
                entry_signal = daily_signal * 1.2
            else:
                entry_signal = daily_signal * 0.5
        elif weekly_trend < 0 and daily_signal < 0:
            # 空头环境 → 跌破近期低点
            if current <= recent_low:
                entry_signal = daily_signal * 1.2
            else:
                entry_signal = daily_signal * 0.5
        else:
            # 不一致 → 弱信号
            entry_signal = daily_signal * 0.3

        return max(-1, min(1, entry_signal))


# ============================================================
# 经典策略 4: 全天候风险平价策略 (Ray Dalio / Bridgewater)
# ============================================================
class AllWeatherStrategy(Strategy):
    """
    全天候策略核心思想 (Ray Dalio, 1996):
    - 风险平价: 波动率越大 → 仓位越小
    - 经济四象限: 增长↑通胀↑/增长↑通胀↓/增长↓通胀↑/增长↓通胀↓
    - 再平衡: 偏离目标仓位时调仓
    适配基金版本: 用趋势+波动率判断经济象限
    """
    def __init__(self, params=None):
        default = {
            'target_vol': 0.10,      # 目标年化波动率10%
            'rebalance_band': 0.05,  # 偏离5%触发再平衡
            'momentum_lb': 40,       # 动量回看
            'vol_lb': 20,           # 波动率回看
            'trend_filter': True,    # 趋势过滤
            'max_position': 0.8,     # 最大仓位
        }
        if params: default.update(params)
        super().__init__('全天候(Dalio)', default)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < max(p['momentum_lb'], p['vol_lb']) + 5:
            return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 波动率计算
        returns = np.diff(navs[-p['vol_lb']-1:]) / navs[-p['vol_lb']-1:-1]
        vol = np.std(returns) * math.sqrt(250) if len(returns) > 5 else 0.15

        # 风险平价仓位: 目标波动率 / 实际波动率
        risk_parity_weight = min(p['target_vol'] / max(vol, 0.01), p['max_position'])

        # 动量趋势
        mom_past = navs[-p['momentum_lb']]
        momentum = (current - mom_past) / mom_past

        # 短期动量(10日)
        short_mom = (current - navs[-10]) / navs[-10] if len(navs) > 10 else 0

        # 均值回归信号
        ma20 = np.mean(navs[-20:])
        deviation = (current - ma20) / ma20

        # 经济象限判断(简化)
        # 用动量方向 + 波动率水平来模拟
        if momentum > 0.02 and vol < 0.20:
            # 增长↑ + 通胀↓ = 最好(股票+债券都好)
            regime_mult = 1.2
        elif momentum > 0 and vol >= 0.20:
            # 增长↑ + 通胀↑ = 还行(适度)
            regime_mult = 0.9
        elif momentum < -0.02 and vol < 0.20:
            # 增长↓ + 通胀↓ = 防守(减仓)
            regime_mult = 0.6
        else:
            # 增长↓ + 通胀↑ = 最差(滞胀, 大幅减仓)
            regime_mult = 0.3

        # 趋势过滤
        trend_ok = True
        if p['trend_filter']:
            ma50 = np.mean(navs[-min(50,len(navs)):])
            trend_ok = current > ma50

        # 综合信号
        base_signal = risk_parity_weight * regime_mult
        if not trend_ok:
            base_signal *= 0.3  # 趋势向下大幅缩减

        # 转换为[-1, 1]
        if momentum > 0:
            signal = base_signal * (0.5 + min(momentum * 10, 0.5))
        else:
            signal = -base_signal * (0.5 + min(abs(momentum) * 10, 0.5))

        # 偏离过大 → 再平衡信号
        if abs(deviation) > p['rebalance_band']:
            if deviation > 0:
                signal -= 0.15  # 偏高→减
            else:
                signal += 0.15  # 偏低→加

        return max(-1, min(1, signal))


# ============================================================
# 经典策略 5: 自适应均线策略 (Perry Kaufman AMA)
# ============================================================
class KaufmanAMAStrategy(Strategy):
    """
    Kaufman自适应移动平均策略 (1995)
    - AMA: 根据效率比动态调整平滑系数
    - 市场噪音大→平滑慢(避免假信号), 趋势明确→平滑快(跟上趋势)
    - 经典的市场适应性策略
    """
    def __init__(self, params=None):
        default = {
            'er_period': 10,         # 效率比周期
            'fast_sc': 2,            # 快速平滑常数(2/(2+1))
            'slow_sc': 30,           # 慢速平滑常数(2/(30+1))
            'filter_pct': 0.002,     # 过滤器(避免小幅震荡)
            'atr_mult': 1.5,        # ATR过滤倍数
        }
        if params: default.update(params)
        super().__init__('自适应均线(Kaufman)', default)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 40: return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]
        n = p['er_period']

        if len(navs) < n + 2:
            return 0.0

        # 效率比 ER = |方向| / 波动
        direction = abs(navs[-1] - navs[-n-1])
        volatility = sum(abs(navs[-n+j] - navs[-n+j-1]) for j in range(n))
        er = direction / max(volatility, 1e-10)

        # 平滑常数 SC
        fast_sc = 2 / (p['fast_sc'] + 1)
        slow_sc = 2 / (p['slow_sc'] + 1)
        sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2

        # 计算AMA序列(至少回看40天)
        ama_len = min(len(navs), 60)
        ama = navs[-ama_len]
        ama_history = [ama]
        for k in range(1, ama_len):
            nav_k = navs[-ama_len + k]
            # 重新计算每个点的ER和SC
            if k >= n:
                d = abs(navs[-ama_len+k] - navs[-ama_len+k-n])
                v = sum(abs(navs[-ama_len+k-j] - navs[-ama_len+k-j-1]) for j in range(n))
                er_k = d / max(v, 1e-10)
                sc_k = (er_k * (fast_sc - slow_sc) + slow_sc) ** 2
            else:
                sc_k = slow_sc ** 2
            ama = ama + sc_k * (nav_k - ama)
            ama_history.append(ama)

        current_ama = ama_history[-1]
        prev_ama = ama_history[-2] if len(ama_history) > 1 else current_ama

        # AMA方向
        ama_slope = (current_ama - prev_ama) / max(abs(prev_ama), 1e-10)

        # ATR过滤
        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        filter_val = atr * p['atr_mult']

        # 价格 vs AMA
        price_vs_ama = current - current_ama

        signal = 0.0
        if price_vs_ama > filter_val and ama_slope > 0:
            # 价格在AMA之上 + AMA上升 → 做多
            signal = 0.5 + min(er * 0.5, 0.4)  # ER高→信号强
        elif price_vs_ama < -filter_val and ama_slope < 0:
            # 价格在AMA之下 + AMA下降 → 做空
            signal = -0.5 - min(er * 0.5, 0.4)
        elif abs(price_vs_ama) < filter_val:
            # 在过滤区内 → 观望
            signal = ama_slope * 1000  # 微弱跟随AMA方向
            signal = max(-0.2, min(0.2, signal))

        return max(-1, min(1, signal))


# ============================================================
# 本地 v6.2 决策模型 (从strategy.ts移植)
# ============================================================
class LocalV62Strategy(Strategy):
    """
    本地v6.2决策模型的回测版本
    - 12因子预测 + 五维防御优先 + 投资大师融合
    - 市场环境30% + 技术20% + 基本面20% + 资金流向20% + 消息面10%
    - 自适应市场状态(trending/ranging/volatile)
    - 均值回归抑制 + ATR 2.5x限幅 + 地缘风险
    """
    def __init__(self, params=None):
        default = {
            # v6.2 forecast参数
            'trend_weight_trending': 0.796,
            'trend_weight_ranging': 0.32,
            'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037,
            'reversion_weight_ranging': 0.18,
            'reversion_weight_volatile': 0.28,
            'rsi_ob': 76, 'rsi_os': 22,
            'rsi_mid_ob': 60, 'rsi_mid_os': 31,
            'macd_signal': 0.232,
            'macd_cross': 0.386,
            'bb_extreme': 0.35,
            'market_weight': 0.35,
            'atr_limit': 2.5,
            # v6.2 decision参数
            'defense_market_w': 0.30,
            'defense_tech_w': 0.20,
            'defense_fund_w': 0.20,
            'defense_flow_w': 0.20,
            'defense_news_w': 0.10,
            # 拦截条件
            'forecast_block_threshold': 1.0,  # 预测跌>1%阻止买入
            'bb_block_threshold': 85,         # %B>85阻止追高
            'trend_block_threshold': -30,     # 盈利时趋势<-30阻止加仓
        }
        if params: default.update(params)
        super().__init__('本地v6.2决策模型', default)

    def _detect_regime(self, navs):
        if len(navs) < 30:
            return 'ranging'
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        returns = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(returns) * math.sqrt(250) * 100 if len(returns) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        # 自适应权重
        if regime == 'trending':
            trend_w = p['trend_weight_trending']
            rev_w = p['reversion_weight_trending']
        elif regime == 'volatile':
            trend_w = p['trend_weight_volatile']
            rev_w = p['reversion_weight_volatile']
        else:
            trend_w = p['trend_weight_ranging']
            rev_w = p['reversion_weight_ranging']

        # 趋势动量因子
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay = np.array([0.15, 0.25, 0.45, 0.75, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0
        mom3d = changes[-3:].sum() if len(changes) >= 3 else 0

        # 连涨连跌
        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        # 趋势评分
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

        trend_factor = weighted_mom * trend_w + trend_score * 0.015
        if abs(streak) >= 5: trend_factor *= 0.35
        elif abs(streak) >= 3: trend_factor *= 0.87

        # 均值回归因子
        dev20 = (current - ma20) / ma20 * 100
        dev5 = (current - ma5) / ma5 * 100
        rev_factor = 0
        if abs(dev20) > 2:
            sign = -1 if dev20 > 0 else 1
            rev_factor += sign * math.sqrt(abs(dev20) - 2) * rev_w
        if abs(dev5) > 1.5:
            sign = -1 if dev5 > 0 else 1
            rev_factor += sign * (abs(dev5) - 1.5) * 0.08
        # v6回归抑制
        if rev_factor > 0 and trend_factor < -0.2 and trend_score < -15:
            rev_factor *= 0.3
        elif rev_factor > 0 and trend_factor < 0 and trend_score < 0:
            rev_factor *= 0.6
        if rev_factor < 0 and trend_factor > 0.2 and trend_score > 15:
            rev_factor *= 0.3
        elif rev_factor < 0 and trend_factor > 0 and trend_score > 0:
            rev_factor *= 0.6

        # RSI因子
        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
        rsi_factor = 0
        if rsi > p['rsi_ob']: rsi_factor = -(rsi - p['rsi_ob']) * 0.08
        elif rsi > p['rsi_mid_ob']: rsi_factor = -(rsi - p['rsi_mid_ob']) * 0.037
        elif rsi < p['rsi_os']: rsi_factor = (p['rsi_os'] - rsi) * 0.08
        elif rsi < p['rsi_mid_os']: rsi_factor = (p['rsi_mid_os'] - rsi) * 0.037
        # RSI背离
        if len(navs) >= 11:
            nav_lb = navs[-10]
            rsi_lb = calc_rsi(pd.Series(navs[:-9]), 14).iloc[-1]
            if not np.isnan(rsi_lb):
                if current > nav_lb and rsi < rsi_lb: rsi_factor -= 0.20
                if current < nav_lb and rsi > rsi_lb: rsi_factor += 0.20

        # MACD因子
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea: macd_factor = p['macd_signal']
        elif hist < 0 and dif < dea: macd_factor = -p['macd_signal']
        if len(navs) >= 2:
            prev_h = calc_macd(pd.Series(navs[:-1]))[2].iloc[-1]
            if not np.isnan(prev_h):
                if prev_h <= 0 and hist > 0: macd_factor += p['macd_cross']
                if prev_h >= 0 and hist < 0: macd_factor -= p['macd_cross']
        if len(navs) >= 3:
            prev2_h = calc_macd(pd.Series(navs[:-2]))[2].iloc[-1]
            prev1_h = calc_macd(pd.Series(navs[:-1]))[2].iloc[-1]
            if not np.isnan(prev2_h) and not np.isnan(prev1_h):
                accel = hist - prev1_h
                prev_accel = prev1_h - prev2_h
                if accel > 0 and prev_accel > 0: macd_factor += 0.1
                if accel < 0 and prev_accel < 0: macd_factor -= 0.1

        # 布林带因子
        _, _, _, pctb_s, width_s = calc_bollinger(pd.Series(navs))
        pctb = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_mult = 1.5 if regime == 'ranging' else 1.0
        bb_factor = 0
        if pctb > 95: bb_factor = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bb_factor = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bb_factor = p['bb_extreme'] * bb_mult
        elif pctb < 20: bb_factor = (20 - pctb) * 0.020 * bb_mult

        # 市场因子(用大盘数据)
        market_factor = 0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

        # 跨周期因子
        cross_tf = 0
        mom10d = sum(changes) if len(changes) > 0 else 0
        if mom3d > 0 and mom10d > 0 and trend_score > 0: cross_tf = 0.12
        elif mom3d < 0 and mom10d < 0 and trend_score < 0: cross_tf = -0.12

        # 缺口回补因子
        gap_factor = 0
        if len(changes) >= 2 and abs(changes[-1]) > 1.5:
            gap_factor = -changes[-1] * 0.15

        # 波动率修正
        returns_20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(returns_20) * math.sqrt(250) * 100 if len(returns_20) > 5 else 15
        vol_adj = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        trend_factor *= vol_adj
        rev_factor *= (2 - vol_adj)

        # 综合预测
        raw = (trend_factor + rev_factor + rsi_factor + macd_factor +
               bb_factor + market_factor + cross_tf + gap_factor)

        # ATR限幅
        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100
        max_move = atr_pct * p['atr_limit']
        raw = max(-max_move, min(max_move, raw))

        # v6.2 拦截逻辑
        # 预测跌>1%时阻止买入(转为观望)
        if raw > 0 and raw < 0.3 and trend_factor < -0.5:
            raw = 0  # 预测跌→拦截弱买入信号

        # %B>85时阻止追高
        if raw > 0 and pctb > p['bb_block_threshold']:
            raw = min(raw, 0)

        # 盈利+趋势崩坏时不加仓 (简化: trend_score很负时缩减买入)
        if raw > 0 and trend_score < p['trend_block_threshold']:
            raw *= 0.3

        return max(-1, min(1, raw / 2))


# ============================================================
# 回测引擎(增强版 - 支持持仓追踪)
# ============================================================
def run_backtest_enhanced(df: pd.DataFrame, strategy: Strategy,
                          market_df: pd.DataFrame = None,
                          initial_capital: float = 100000) -> Dict:
    """增强回测: FIFO持仓跟踪 + 赎回费计算 + 每日净值曲线"""
    n = len(df)
    if n < 30:
        return {'nav_curve': [], 'trades': [], 'daily_returns': pd.Series(dtype=float)}

    cash = initial_capital
    position = 0.0  # 持仓份数
    nav_curve = []   # 每日组合净值
    trades = []      # 交易记录
    signals_history = []

    # FIFO持仓队列: [(buy_day, shares)] 用于计算赎回费
    holding_lots = []  # 每笔买入的(日期索引, 剩余份额)
    total_fees = 0.0   # 累计赎回费

    for i in range(n):
        current_nav = df['nav'].iloc[i]
        portfolio_value = cash + position * current_nav

        if i >= 30:
            signal = strategy.generate_signal(df, i, market_df)
            signals_history.append(signal)

            # 信号 → 操作（阈值0.05对齐线上：线上任何正信号都会产生买入建议）
            if signal > 0.05 and cash > portfolio_value * 0.05:
                # 买入: 信号越强买越多
                buy_pct = min(signal * 0.5, 0.4)
                buy_amount = cash * buy_pct
                buy_shares = buy_amount / current_nav
                position += buy_shares
                cash -= buy_amount
                holding_lots.append([i, buy_shares])  # 记录买入日和份额
                trades.append({
                    'day': i, 'date': str(df['date'].iloc[i])[:10],
                    'action': 'buy', 'nav': current_nav,
                    'shares': buy_shares, 'amount': buy_amount,
                    'signal': signal, 'fee': 0
                })
            elif signal < -0.05 and position > 0:
                # 卖出: FIFO扣赎回费
                sell_pct = min(abs(signal) * 0.5, 0.4)
                sell_shares = position * sell_pct
                sell_amount_gross = sell_shares * current_nav

                # FIFO赎回费计算: <7天1.5%, >=7天0%
                remaining_to_sell = sell_shares
                fee = 0.0
                new_lots = []
                for lot in holding_lots:
                    if remaining_to_sell <= 0:
                        new_lots.append(lot)
                        continue
                    lot_day, lot_shares = lot
                    hold_days = i - lot_day
                    sold_from_lot = min(remaining_to_sell, lot_shares)
                    remaining_to_sell -= sold_from_lot

                    # 赎回费: <7天1.5%, >=7天0%
                    if hold_days < 7:
                        fee += sold_from_lot * current_nav * 0.015

                    leftover = lot_shares - sold_from_lot
                    if leftover > 0.001:
                        new_lots.append([lot_day, leftover])

                holding_lots = new_lots
                total_fees += fee
                sell_amount_net = sell_amount_gross - fee

                position -= sell_shares
                cash += sell_amount_net
                trades.append({
                    'day': i, 'date': str(df['date'].iloc[i])[:10],
                    'action': 'sell', 'nav': current_nav,
                    'shares': sell_shares, 'amount': sell_amount_net,
                    'signal': signal, 'fee': round(fee, 2)
                })
        else:
            signals_history.append(0)

        portfolio_value = cash + position * current_nav
        nav_curve.append(portfolio_value / initial_capital)

    # 计算日收益率
    nav_series = pd.Series(nav_curve)
    daily_returns = nav_series.pct_change().dropna()

    return {
        'nav_curve': nav_curve,
        'trades': trades,
        'daily_returns': daily_returns,
        'signals': signals_history,
        'final_value': nav_curve[-1] if nav_curve else 1.0,
        'total_fees': round(total_fees, 2),
    }


# ============================================================
# 绩效分析
# ============================================================
def analyze_performance(nav_curve: list, trades: list) -> Dict:
    """全面绩效分析"""
    if not nav_curve or len(nav_curve) < 5:
        return {'total_return': 0, 'sharpe': 0, 'max_drawdown': 0, 'calmar': 0,
                'win_rate': 0, 'n_trades': 0, 'avg_holding': 0}

    returns = pd.Series(nav_curve).pct_change().dropna()
    perf = calc_performance(returns)

    # 交易分析
    buy_trades = [t for t in trades if t['action'] == 'buy']
    sell_trades = [t for t in trades if t['action'] == 'sell']
    n_trades = len(buy_trades) + len(sell_trades)

    # 胜率(基于交易对)
    profitable = 0
    total_pairs = 0
    for i, sell in enumerate(sell_trades):
        # 找此前最近的买入
        prev_buys = [b for b in buy_trades if b['day'] < sell['day']]
        if prev_buys:
            last_buy = prev_buys[-1]
            if sell['nav'] > last_buy['nav']:
                profitable += 1
            total_pairs += 1

    trade_win_rate = (profitable / total_pairs * 100) if total_pairs > 0 else 0

    # 最大连续亏损天数
    max_losing_streak = 0
    current_streak = 0
    for r in returns:
        if r < 0:
            current_streak += 1
            max_losing_streak = max(max_losing_streak, current_streak)
        else:
            current_streak = 0

    # 收益回撤比
    cumulative = (1 + returns).cumprod()
    peak = cumulative.cummax()
    drawdowns = (cumulative - peak) / peak
    underwater_days = (drawdowns < -0.01).sum()

    perf['trade_win_rate'] = round(trade_win_rate, 1)
    perf['n_trades'] = n_trades
    perf['max_losing_streak'] = max_losing_streak
    perf['underwater_days'] = int(underwater_days)
    perf['n_buy'] = len(buy_trades)
    perf['n_sell'] = len(sell_trades)

    return perf


# ============================================================
# 回撤分析
# ============================================================
def calc_drawdown_series(nav_curve: list) -> list:
    """计算每日回撤百分比"""
    if not nav_curve:
        return []
    peak = nav_curve[0]
    dd = []
    for v in nav_curve:
        peak = max(peak, v)
        dd.append((v - peak) / peak * 100)
    return dd


# ============================================================
# HTML可视化报告生成
# ============================================================
def generate_html_report(results: Dict, fund_results: Dict) -> str:
    """生成完整的HTML可视化报告"""

    strategies = list(results.keys())
    colors = {
        '双动量(Antonacci)': '#e74c3c',
        '海龟交易(Dennis)': '#3498db',
        '三重滤网(Elder)': '#2ecc71',
        '全天候(Dalio)': '#f39c12',
        '自适应均线(Kaufman)': '#9b59b6',
        '本地v6.2决策模型': '#1abc9c',
    }

    # 准备排行榜数据
    rankings = []
    for name, data in results.items():
        perf = data['perf_avg']
        score = (
            perf.get('sharpe', 0) * 30 +
            perf.get('total_return', 0) * 0.2 +
            (100 + perf.get('max_drawdown', 0)) * 0.15 +
            perf.get('calmar', 0) * 15 +
            perf.get('trade_win_rate', 0) * 0.1 +
            perf.get('win_rate', 0) * 0.1
        )
        rankings.append({
            'name': name,
            'score': round(score, 2),
            'sharpe': perf.get('sharpe', 0),
            'total_return': perf.get('total_return', 0),
            'max_drawdown': perf.get('max_drawdown', 0),
            'calmar': perf.get('calmar', 0),
            'win_rate': perf.get('win_rate', 0),
            'trade_win_rate': perf.get('trade_win_rate', 0),
            'n_trades': perf.get('n_trades', 0),
            'color': colors.get(name, '#95a5a6'),
        })
    rankings.sort(key=lambda x: x['score'], reverse=True)

    # 准备每只基金的对抗数据
    fund_charts_data = {}
    for fund_code, fund_data in fund_results.items():
        fund_name = fund_data['name']
        charts = {'dates': [], 'strategies': {}}
        for sname, sdata in fund_data['strategies'].items():
            if sdata['nav_curve']:
                charts['strategies'][sname] = {
                    'nav': sdata['nav_curve'],
                    'drawdown': calc_drawdown_series(sdata['nav_curve']),
                    'color': colors.get(sname, '#95a5a6'),
                }
        if fund_data.get('dates'):
            charts['dates'] = fund_data['dates']
        fund_charts_data[f"{fund_code} {fund_name}"] = charts

    # 雷达图数据
    radar_metrics = ['夏普比率', '总收益率', '最大回撤', '卡尔玛比率', '日胜率', '交易胜率']
    radar_data = {}
    for r in rankings:
        vals = [
            max(0, r['sharpe']) / max(max(x['sharpe'] for x in rankings), 0.01) * 100,
            max(0, r['total_return']) / max(max(x['total_return'] for x in rankings), 0.01) * 100,
            (100 + r['max_drawdown']) / 100 * 100,  # 回撤越小越好
            max(0, r['calmar']) / max(max(x['calmar'] for x in rankings), 0.01) * 100,
            r['win_rate'],
            r['trade_win_rate'],
        ]
        radar_data[r['name']] = vals

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>策略对抗竞技场 - 经典策略 vs 本地v6.2</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, 'Segoe UI', sans-serif; background: #0a0a1a; color: #e0e0e0; }}
  .container {{ max-width: 1400px; margin: 0 auto; padding: 20px; }}
  h1 {{ text-align: center; font-size: 2em; margin: 20px 0; background: linear-gradient(90deg, #e74c3c, #3498db, #2ecc71, #f39c12); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }}
  h2 {{ color: #3498db; margin: 30px 0 15px; font-size: 1.4em; border-left: 4px solid #3498db; padding-left: 12px; }}
  h3 {{ color: #e0e0e0; margin: 20px 0 10px; font-size: 1.1em; }}

  .ranking-table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
  .ranking-table th {{ background: #1a1a3a; padding: 12px 8px; text-align: center; font-size: 0.9em; border-bottom: 2px solid #3498db; }}
  .ranking-table td {{ padding: 10px 8px; text-align: center; border-bottom: 1px solid #2a2a4a; font-size: 0.9em; }}
  .ranking-table tr:hover {{ background: #1a1a3a; }}
  .ranking-table tr:first-child td {{ background: rgba(46, 204, 113, 0.1); }}
  .rank-badge {{ display: inline-block; width: 28px; height: 28px; border-radius: 50%; line-height: 28px; font-weight: bold; }}
  .rank-1 {{ background: gold; color: #000; }}
  .rank-2 {{ background: silver; color: #000; }}
  .rank-3 {{ background: #cd7f32; color: #fff; }}
  .positive {{ color: #2ecc71; }}
  .negative {{ color: #e74c3c; }}
  .strategy-name {{ font-weight: bold; text-align: left !important; }}

  .chart-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }}
  .chart-box {{ background: #12122a; border-radius: 12px; padding: 20px; border: 1px solid #2a2a4a; }}
  .chart-box.full {{ grid-column: 1 / -1; }}
  .chart-box canvas {{ width: 100% !important; }}

  .fund-section {{ background: #12122a; border-radius: 12px; padding: 20px; margin: 15px 0; border: 1px solid #2a2a4a; }}
  .fund-header {{ display: flex; justify-content: space-between; align-items: center; cursor: pointer; }}
  .fund-header:hover {{ color: #3498db; }}
  .fund-charts {{ display: none; margin-top: 15px; }}
  .fund-charts.active {{ display: block; }}

  .battle-bar {{ display: flex; height: 30px; border-radius: 8px; overflow: hidden; margin: 5px 0; }}
  .battle-segment {{ display: flex; align-items: center; justify-content: center; font-size: 0.75em; font-weight: bold; color: #fff; min-width: 40px; }}

  .stats-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }}
  .stat-card {{ background: #12122a; border-radius: 10px; padding: 15px; text-align: center; border: 1px solid #2a2a4a; }}
  .stat-value {{ font-size: 1.8em; font-weight: bold; margin: 5px 0; }}
  .stat-label {{ font-size: 0.8em; color: #888; }}

  .vs-badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: bold; margin: 0 4px; }}
  .vs-win {{ background: rgba(46, 204, 113, 0.2); color: #2ecc71; }}
  .vs-lose {{ background: rgba(231, 76, 60, 0.2); color: #e74c3c; }}
  .vs-draw {{ background: rgba(241, 196, 15, 0.2); color: #f1c40f; }}

  .timestamp {{ text-align: center; color: #555; margin-top: 30px; font-size: 0.8em; }}

  @media (max-width: 768px) {{
    .chart-grid {{ grid-template-columns: 1fr; }}
    .stats-grid {{ grid-template-columns: repeat(2, 1fr); }}
  }}
</style>
</head>
<body>
<div class="container">
<h1>策略对抗竞技场 - 经典策略 vs 本地v6.2</h1>
<p style="text-align:center;color:#888;margin-bottom:20px;">5个被市场验证的经典投资策略 vs 本地v6.2决策模型 | {len(fund_results)}只基金实盘数据回测</p>
"""

    # === 冠军卡片 ===
    champion = rankings[0]
    local_rank = next((i+1 for i, r in enumerate(rankings) if r['name'] == '本地v6.2决策模型'), -1)
    local_data = next((r for r in rankings if r['name'] == '本地v6.2决策模型'), None)

    html += f"""
<div class="stats-grid">
  <div class="stat-card" style="border-color: gold;">
    <div class="stat-label">冠军策略</div>
    <div class="stat-value" style="color: gold; font-size: 1.3em;">🏆 {champion['name']}</div>
    <div>综合评分 {champion['score']}</div>
  </div>
  <div class="stat-card" style="border-color: #1abc9c;">
    <div class="stat-label">本地v6.2排名</div>
    <div class="stat-value" style="color: {'#2ecc71' if local_rank <= 2 else '#f39c12' if local_rank <= 4 else '#e74c3c'};">#{local_rank}/6</div>
    <div>综合评分 {local_data['score'] if local_data else 'N/A'}</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">测试基金数</div>
    <div class="stat-value" style="color: #3498db;">{len(fund_results)}</div>
    <div>覆盖{len(SECTOR_MAP)}个板块</div>
  </div>
</div>
"""

    # === 排行榜 ===
    html += """<h2>总排行榜</h2>
<table class="ranking-table">
<tr><th>排名</th><th>策略</th><th>综合分</th><th>夏普比率</th><th>总收益率</th><th>最大回撤</th><th>卡尔玛比率</th><th>日胜率</th><th>交易胜率</th><th>交易次数</th></tr>
"""
    for i, r in enumerate(rankings):
        rank_class = f"rank-{i+1}" if i < 3 else ""
        is_local = r['name'] == '本地v6.2决策模型'
        row_style = 'style="background: rgba(26, 188, 156, 0.1); border: 1px solid #1abc9c;"' if is_local else ''
        html += f"""<tr {row_style}>
  <td><span class="rank-badge {rank_class}">{i+1}</span></td>
  <td class="strategy-name" style="color: {r['color']};">{'⚡ ' if is_local else ''}{r['name']}</td>
  <td><strong>{r['score']}</strong></td>
  <td class="{'positive' if r['sharpe'] > 0 else 'negative'}">{r['sharpe']:.3f}</td>
  <td class="{'positive' if r['total_return'] > 0 else 'negative'}">{r['total_return']:.2f}%</td>
  <td class="negative">{r['max_drawdown']:.2f}%</td>
  <td class="{'positive' if r['calmar'] > 0 else 'negative'}">{r['calmar']:.3f}</td>
  <td>{r['win_rate']:.1f}%</td>
  <td>{r['trade_win_rate']:.1f}%</td>
  <td>{r['n_trades']}</td>
</tr>"""
    html += "</table>"

    # === 综合净值曲线 + 回撤对比 (合并所有基金平均) ===
    html += """
<h2>综合净值曲线对比</h2>
<div class="chart-grid">
  <div class="chart-box full">
    <canvas id="navChart" height="100"></canvas>
  </div>
  <div class="chart-box full">
    <canvas id="drawdownChart" height="80"></canvas>
  </div>
</div>
"""

    # === 雷达图 ===
    html += """
<h2>六维能力雷达图</h2>
<div class="chart-grid">
  <div class="chart-box full">
    <canvas id="radarChart" height="120"></canvas>
  </div>
</div>
"""

    # === 板块胜负统计 ===
    html += """<h2>板块胜负对抗</h2>"""
    sector_wins = {}
    for fund_code, fund_data in fund_results.items():
        sector = CODE_TO_SECTOR.get(fund_code, '其他')
        if sector not in sector_wins:
            sector_wins[sector] = {}
        for sname, sdata in fund_data['strategies'].items():
            if sname not in sector_wins[sector]:
                sector_wins[sector][sname] = []
            perf = sdata.get('perf', {})
            sector_wins[sector][sname].append(perf.get('sharpe', 0))

    for sector, strats in sector_wins.items():
        avg_sharpes = {s: np.mean(v) if v else 0 for s, v in strats.items()}
        if not avg_sharpes: continue
        total = sum(max(0, v) for v in avg_sharpes.values()) or 1
        html += f'<h3>{sector}</h3><div class="battle-bar">'
        for sname in sorted(avg_sharpes.keys(), key=lambda x: avg_sharpes[x], reverse=True):
            v = max(avg_sharpes[sname], 0)
            pct = v / total * 100
            c = colors.get(sname, '#95a5a6')
            if pct > 5:
                html += f'<div class="battle-segment" style="width:{pct}%;background:{c};">{sname[:4]} {avg_sharpes[sname]:.2f}</div>'
        html += '</div>'

    # === 单基金展开 ===
    html += """<h2>单基金对抗详情 (点击展开)</h2>"""
    for fund_label, charts in fund_charts_data.items():
        fund_id = fund_label.replace(' ', '_').replace('/', '_')
        html += f"""
<div class="fund-section">
  <div class="fund-header" onclick="toggleFund('{fund_id}')">
    <h3>{fund_label}</h3>
    <span id="arrow_{fund_id}">▶</span>
  </div>
  <div class="fund-charts" id="charts_{fund_id}">
    <canvas id="fund_nav_{fund_id}" height="60"></canvas>
    <canvas id="fund_dd_{fund_id}" height="40" style="margin-top:10px;"></canvas>
  </div>
</div>"""

    # === JavaScript ===
    # 准备综合净值数据(所有基金平均)
    avg_nav_data = {}
    max_len = 0
    for fund_code, fund_data in fund_results.items():
        for sname, sdata in fund_data['strategies'].items():
            if sname not in avg_nav_data:
                avg_nav_data[sname] = []
            if sdata['nav_curve']:
                avg_nav_data[sname].append(sdata['nav_curve'])
                max_len = max(max_len, len(sdata['nav_curve']))

    avg_curves = {}
    for sname, curves in avg_nav_data.items():
        if not curves: continue
        # 对齐长度
        aligned = []
        for c in curves:
            if len(c) < max_len:
                c = c + [c[-1]] * (max_len - len(c))
            aligned.append(c[:max_len])
        avg_curves[sname] = np.mean(aligned, axis=0).tolist()

    html += f"""
<script>
const colors = {json.dumps(colors)};
const avgCurves = {json.dumps(avg_curves)};
const radarData = {json.dumps(radar_data)};
const radarMetrics = {json.dumps(radar_metrics)};
const fundChartsData = {json.dumps(fund_charts_data)};

// 综合净值曲线
const navCtx = document.getElementById('navChart').getContext('2d');
const navDatasets = [];
for (const [name, curve] of Object.entries(avgCurves)) {{
  navDatasets.push({{
    label: name,
    data: curve.map((v, i) => ({{ x: i, y: v }})),
    borderColor: colors[name] || '#888',
    backgroundColor: 'transparent',
    borderWidth: name === '本地v6.2决策模型' ? 3 : 1.5,
    pointRadius: 0,
    tension: 0.1,
  }});
}}
new Chart(navCtx, {{
  type: 'line',
  data: {{ datasets: navDatasets }},
  options: {{
    responsive: true,
    plugins: {{
      title: {{ display: true, text: '综合净值曲线 (所有基金平均)', color: '#e0e0e0', font: {{ size: 14 }} }},
      legend: {{ labels: {{ color: '#e0e0e0' }} }},
    }},
    scales: {{
      x: {{ type: 'linear', title: {{ display: true, text: '交易日', color: '#888' }}, ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
      y: {{ title: {{ display: true, text: '净值', color: '#888' }}, ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
    }},
  }},
}});

// 回撤曲线
const ddCtx = document.getElementById('drawdownChart').getContext('2d');
const ddDatasets = [];
for (const [name, curve] of Object.entries(avgCurves)) {{
  const dd = [];
  let peak = curve[0];
  for (const v of curve) {{
    peak = Math.max(peak, v);
    dd.push((v - peak) / peak * 100);
  }}
  ddDatasets.push({{
    label: name,
    data: dd.map((v, i) => ({{ x: i, y: v }})),
    borderColor: colors[name] || '#888',
    backgroundColor: name === '本地v6.2决策模型' ? 'rgba(26,188,156,0.1)' : 'transparent',
    borderWidth: name === '本地v6.2决策模型' ? 2.5 : 1.2,
    pointRadius: 0,
    fill: name === '本地v6.2决策模型',
    tension: 0.1,
  }});
}}
new Chart(ddCtx, {{
  type: 'line',
  data: {{ datasets: ddDatasets }},
  options: {{
    responsive: true,
    plugins: {{
      title: {{ display: true, text: '回撤对比', color: '#e0e0e0', font: {{ size: 14 }} }},
      legend: {{ labels: {{ color: '#e0e0e0' }} }},
    }},
    scales: {{
      x: {{ type: 'linear', title: {{ display: true, text: '交易日', color: '#888' }}, ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
      y: {{ title: {{ display: true, text: '回撤%', color: '#888' }}, ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
    }},
  }},
}});

// 雷达图
const radarCtx = document.getElementById('radarChart').getContext('2d');
const radarDatasets2 = [];
for (const [name, vals] of Object.entries(radarData)) {{
  radarDatasets2.push({{
    label: name,
    data: vals,
    borderColor: colors[name] || '#888',
    backgroundColor: (colors[name] || '#888') + '20',
    borderWidth: name === '本地v6.2决策模型' ? 3 : 1.5,
    pointRadius: name === '本地v6.2决策模型' ? 4 : 2,
  }});
}}
new Chart(radarCtx, {{
  type: 'radar',
  data: {{ labels: radarMetrics, datasets: radarDatasets2 }},
  options: {{
    responsive: true,
    plugins: {{ legend: {{ labels: {{ color: '#e0e0e0' }} }} }},
    scales: {{
      r: {{
        beginAtZero: true, max: 100,
        ticks: {{ color: '#888', backdropColor: 'transparent' }},
        grid: {{ color: '#2a2a4a' }},
        pointLabels: {{ color: '#e0e0e0', font: {{ size: 13 }} }},
      }},
    }},
  }},
}});

// 单基金展开
function toggleFund(id) {{
  const el = document.getElementById('charts_' + id);
  const arrow = document.getElementById('arrow_' + id);
  if (el.classList.contains('active')) {{
    el.classList.remove('active');
    arrow.textContent = '▶';
  }} else {{
    el.classList.add('active');
    arrow.textContent = '▼';
    // 延迟渲染图表
    setTimeout(() => renderFundChart(id), 100);
  }}
}}

const renderedFunds = new Set();
function renderFundChart(id) {{
  if (renderedFunds.has(id)) return;
  renderedFunds.add(id);
  const label = Object.keys(fundChartsData).find(k => k.replace(/ /g,'_').replace(/\\//g,'_') === id);
  if (!label) return;
  const data = fundChartsData[label];

  // 净值图
  const navDs = [];
  for (const [name, sdata] of Object.entries(data.strategies)) {{
    navDs.push({{
      label: name,
      data: sdata.nav.map((v, i) => ({{x: i, y: v}})),
      borderColor: sdata.color,
      backgroundColor: 'transparent',
      borderWidth: name === '本地v6.2决策模型' ? 2.5 : 1.2,
      pointRadius: 0, tension: 0.1,
    }});
  }}
  new Chart(document.getElementById('fund_nav_' + id), {{
    type: 'line', data: {{ datasets: navDs }},
    options: {{
      responsive: true,
      plugins: {{ title: {{ display: true, text: label + ' 净值', color: '#e0e0e0' }}, legend: {{ labels: {{ color: '#ccc' }} }} }},
      scales: {{
        x: {{ type: 'linear', ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
        y: {{ ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
      }},
    }},
  }});

  // 回撤图
  const ddDs = [];
  for (const [name, sdata] of Object.entries(data.strategies)) {{
    ddDs.push({{
      label: name,
      data: sdata.drawdown.map((v, i) => ({{x: i, y: v}})),
      borderColor: sdata.color,
      backgroundColor: 'transparent',
      borderWidth: 1.2, pointRadius: 0, tension: 0.1,
    }});
  }}
  new Chart(document.getElementById('fund_dd_' + id), {{
    type: 'line', data: {{ datasets: ddDs }},
    options: {{
      responsive: true,
      plugins: {{ title: {{ display: true, text: label + ' 回撤', color: '#e0e0e0' }}, legend: {{ display: false }} }},
      scales: {{
        x: {{ type: 'linear', ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
        y: {{ ticks: {{ color: '#888' }}, grid: {{ color: '#1a1a3a' }} }},
      }},
    }},
  }});
}}
</script>
"""

    html += f"""
<p class="timestamp">生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | 回测引擎 v3 | 经典策略学习+可视化对抗</p>
</div>
</body>
</html>"""
    return html


# ============================================================
# 主流程
# ============================================================
def main():
    print("=" * 70)
    print("  策略对抗竞技场 v3 - 经典投资策略 vs 本地v6.2决策模型")
    print("=" * 70)

    # 初始化策略
    strategies = [
        DualMomentumStrategy(),
        TurtleTradingStrategy(),
        TripleScreenStrategy(),
        AllWeatherStrategy(),
        KaufmanAMAStrategy(),
        LocalV62Strategy(),
    ]

    print(f"\n参赛策略 ({len(strategies)}):")
    for s in strategies:
        print(f"  - {s.name}")

    # 获取大盘数据
    print("\n获取上证指数历史数据...")
    market_df = fetch_index_history('1.000001', 365)
    if market_df.empty:
        print("  [WARN] 大盘数据获取失败, 将不使用市场因子")
        market_df = None
    else:
        print(f"  上证指数: {len(market_df)}条K线")

    # 逐基金回测
    all_results = {s.name: {'perfs': [], 'nav_curves': [], 'perf_avg': {}} for s in strategies}
    fund_results = {}

    for idx, (code, name) in enumerate(TEST_FUNDS):
        print(f"\n[{idx+1}/{len(TEST_FUNDS)}] {name} ({code})")

        df = fetch_fund_nav_history(code, 365)
        if df.empty or len(df) < 60:
            print(f"  [SKIP] 数据不足 ({len(df)}条)")
            continue

        print(f"  数据: {len(df)}条, {df['date'].iloc[0].strftime('%Y-%m-%d')} ~ {df['date'].iloc[-1].strftime('%Y-%m-%d')}")

        fund_data = {
            'name': name,
            'strategies': {},
            'dates': [str(d)[:10] for d in df['date'].tolist()],
        }

        for strategy in strategies:
            result = run_backtest_enhanced(df, strategy, market_df)
            perf = analyze_performance(result['nav_curve'], result['trades'])

            all_results[strategy.name]['perfs'].append(perf)
            all_results[strategy.name]['nav_curves'].append(result['nav_curve'])

            fund_data['strategies'][strategy.name] = {
                'nav_curve': result['nav_curve'],
                'perf': perf,
                'trades': result['trades'],
            }

            ret_str = f"{perf['total_return']:+.2f}%" if perf['total_return'] else "N/A"
            sharpe_str = f"{perf['sharpe']:.3f}" if perf['sharpe'] else "N/A"
            dd_str = f"{perf['max_drawdown']:.2f}%" if perf['max_drawdown'] else "N/A"
            print(f"  {strategy.name:20s} | 收益{ret_str:>8s} | 夏普{sharpe_str:>7s} | 回撤{dd_str:>8s} | 交易{perf['n_trades']:>3d}笔")

        fund_results[code] = fund_data

    # 汇总平均绩效
    print("\n" + "=" * 70)
    print("  汇总结果")
    print("=" * 70)

    for sname, data in all_results.items():
        perfs = data['perfs']
        if not perfs:
            continue
        avg_perf = {}
        for key in perfs[0]:
            vals = [p.get(key, 0) for p in perfs if isinstance(p.get(key, 0), (int, float))]
            avg_perf[key] = round(np.mean(vals), 3) if vals else 0
        data['perf_avg'] = avg_perf

        print(f"\n{sname}:")
        print(f"  平均收益: {avg_perf.get('total_return', 0):+.2f}%")
        print(f"  平均夏普: {avg_perf.get('sharpe', 0):.3f}")
        print(f"  平均回撤: {avg_perf.get('max_drawdown', 0):.2f}%")
        print(f"  平均卡尔玛: {avg_perf.get('calmar', 0):.3f}")
        print(f"  平均日胜率: {avg_perf.get('win_rate', 0):.1f}%")
        print(f"  平均交易胜率: {avg_perf.get('trade_win_rate', 0):.1f}%")

    # 生成HTML报告
    print("\n生成可视化HTML报告...")
    html = generate_html_report(all_results, fund_results)
    report_path = os.path.join(os.path.dirname(__file__), 'arena_visual_report.html')
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n报告已生成: {report_path}")

    # 保存JSON结果
    json_results = {}
    for sname, data in all_results.items():
        json_results[sname] = data['perf_avg']
    json_path = os.path.join(os.path.dirname(__file__), 'visual_arena_results.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(json_results, f, ensure_ascii=False, indent=2)
    print(f"结果已保存: {json_path}")

    # 胜负判定
    rankings = sorted(all_results.items(), key=lambda x: x[1]['perf_avg'].get('sharpe', 0) * 30 + x[1]['perf_avg'].get('total_return', 0) * 0.2, reverse=True)
    champion_name = rankings[0][0]
    local_rank = next((i+1 for i, (n, _) in enumerate(rankings) if n == '本地v6.2决策模型'), -1)

    print(f"\n{'=' * 70}")
    print(f"  🏆 冠军: {champion_name}")
    print(f"  ⚡ 本地v6.2排名: #{local_rank}/{len(strategies)}")
    if local_rank == 1:
        print("  ✅ 本地模型称霸! 无需优化!")
    elif local_rank <= 3:
        print(f"  ⚠️  本地模型排名靠前, 但{champion_name}更优, 可借鉴其策略逻辑")
    else:
        print(f"  ❌ 本地模型落后! 建议学习{champion_name}的核心逻辑进行升级")
    print("=" * 70)


if __name__ == '__main__':
    main()
