#!/usr/bin/env python3
"""
均值回归大师策略 (Mean Reversion Master Strategy)
=================================================
核心理念：价格终将回归均值，但需要多维度验证回归信号的可靠性。

关键技术：
- 多尺度均值偏离（MA5/10/20/60）加权评分
- 非线性回归强度（sqrt偏离，避免过度反应）
- 布林带 + Keltner通道挤压检测
- RSI极端值 + 顶底背离组合
- Ornstein-Uhlenbeck半衰期估计
- ATR止损保护（超3倍ATR不逆势）
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional

from backtest_engine import Strategy, calc_ema, calc_rsi, calc_macd, calc_bollinger, calc_atr


class MeanReversionStrategy(Strategy):
    """均值回归大师策略：多尺度偏离 + 布林/Keltner挤压 + RSI背离"""

    def __init__(self, params: Optional[Dict] = None):
        default = {
            # --- 核心权重 ---
            'trend_weight': 0.18,       # 低趋势追随（均值回归策略不追趋势）
            'reversion_weight': 0.35,   # 核心：均值回归因子权重
            'macd_weight': 0.12,        # MACD辅助判断
            'bb_weight': 0.045,         # 布林带权重（v4.2的2倍）
            'market_weight': 0.06,      # 大盘因子

            # --- 多尺度均值偏离阈值（%） ---
            'ma5_dev_threshold': 0.8,   # MA5偏离触发阈值
            'ma10_dev_threshold': 1.2,  # MA10偏离触发阈值
            'ma20_dev_threshold': 1.8,  # MA20偏离触发阈值
            'ma60_dev_threshold': 3.0,  # MA60偏离触发阈值
            'ma_weights': [0.15, 0.20, 0.35, 0.30],  # 各均线权重（MA5/10/20/60）

            # --- RSI参数 ---
            'rsi_overbought': 58,       # 超买阈值（比常规更敏感）
            'rsi_oversold': 42,         # 超卖阈值（比常规更敏感）
            'rsi_extreme_high': 75,     # RSI极端高位
            'rsi_extreme_low': 25,      # RSI极端低位
            'rsi_divergence_lookback': 10,  # 背离检测回溯周期
            'rsi_divergence_weight': 0.30,  # 背离信号权重（比v4.2的0.20更重）

            # --- 布林带 & Keltner通道 ---
            'bb_squeeze_threshold': 3.0,  # 布林带宽 < 3% 视为挤压
            'keltner_mult': 2.0,          # Keltner通道 = MA20 ± 2*ATR

            # --- 风控参数 ---
            'max_deviation_atr': 3.0,   # 超过3倍ATR偏离不再逆势加仓
            'vol_threshold': 22,        # 高波动阈值
            'vol_adj': 0.55,            # 高波动时信号衰减系数

            # --- 连涨连跌衰减 ---
            'streak_decay_3': 0.65,     # 连续3天同方向→信号衰减
            'streak_decay_5': 0.35,     # 连续5天同方向→信号大幅衰减
        }
        if params:
            default.update(params)
        super().__init__('均值回归大师', default)

    def _calc_keltner(self, navs_series: pd.Series, period: int = 20) -> tuple:
        """
        计算Keltner通道
        返回: (中轨MA20, 上轨, 下轨)
        """
        ma = navs_series.rolling(period).mean()
        atr = calc_atr(navs_series, period=14)
        mult = self.params['keltner_mult']
        upper = ma + mult * atr
        lower = ma - mult * atr
        return ma, upper, lower

    def _detect_squeeze(self, bb_upper: float, bb_lower: float,
                        kc_upper: float, kc_lower: float) -> bool:
        """
        检测布林带挤压：当布林带完全位于Keltner通道内部时 = 挤压状态
        挤压意味着波动率极低，即将爆发大行情
        """
        return bb_upper < kc_upper and bb_lower > kc_lower

    def _detect_rsi_divergence(self, navs: np.ndarray, rsi_values: np.ndarray,
                                lookback: int) -> int:
        """
        检测RSI与价格的背离
        返回: +1 = 底背离（看涨）, -1 = 顶背离（看跌）, 0 = 无背离

        底背离：价格创新低，但RSI没有创新低（看涨信号）
        顶背离：价格创新高，但RSI没有创新高（看跌信号）
        """
        if len(navs) < lookback + 2 or len(rsi_values) < lookback + 2:
            return 0

        # 取最近lookback期的数据
        recent_navs = navs[-lookback:]
        recent_rsi = rsi_values[-lookback:]

        # 去除NaN
        valid_mask = ~np.isnan(recent_rsi)
        if valid_mask.sum() < lookback // 2:
            return 0

        # 将前半段和后半段分开比较
        half = lookback // 2
        first_half_nav = recent_navs[:half]
        second_half_nav = recent_navs[half:]
        first_half_rsi = recent_rsi[:half]
        second_half_rsi = recent_rsi[half:]

        # 过滤NaN
        valid_first_rsi = first_half_rsi[~np.isnan(first_half_rsi)]
        valid_second_rsi = second_half_rsi[~np.isnan(second_half_rsi)]
        if len(valid_first_rsi) == 0 or len(valid_second_rsi) == 0:
            return 0

        nav_min_first = np.min(first_half_nav)
        nav_min_second = np.min(second_half_nav)
        nav_max_first = np.max(first_half_nav)
        nav_max_second = np.max(second_half_nav)
        rsi_min_first = np.min(valid_first_rsi)
        rsi_min_second = np.min(valid_second_rsi)
        rsi_max_first = np.max(valid_first_rsi)
        rsi_max_second = np.max(valid_second_rsi)

        # 底背离：价格创新低，RSI未创新低
        if nav_min_second < nav_min_first and rsi_min_second > rsi_min_first:
            return 1

        # 顶背离：价格创新高，RSI未创新高
        if nav_max_second > nav_max_first and rsi_max_second < rsi_max_first:
            return -1

        return 0

    def _calc_ou_half_life(self, navs: np.ndarray, ma: float) -> float:
        """
        Ornstein-Uhlenbeck过程估计均值回归半衰期
        半衰期 = -ln(2) / ln(beta)，其中beta是偏离的自回归系数

        返回半衰期（天数），越小说明回归越快，越有利于均值回归策略
        如果计算失败或不存在回归特征，返回 float('inf')
        """
        if len(navs) < 30:
            return float('inf')

        # 计算偏离序列
        deviations = navs[-30:] - ma
        if len(deviations) < 3:
            return float('inf')

        # 简单OLS回归: deviation[t] = beta * deviation[t-1] + epsilon
        y = deviations[1:]
        x = deviations[:-1]

        # 避免除零
        x_var = np.var(x)
        if x_var < 1e-12:
            return float('inf')

        beta = np.cov(x, y)[0, 1] / x_var

        # beta >= 1 表示没有回归特征（随机游走或发散）
        if beta >= 1.0 or beta <= 0.0:
            return float('inf')

        half_life = -math.log(2) / math.log(beta)
        return max(half_life, 0.5)  # 最低0.5天

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        """
        生成交易信号: -1（强卖）到 +1（强买），0 = 持有

        信号组成：
        1. 多尺度均值回归信号（核心）
        2. RSI信号 + 背离检测
        3. 布林带反转信号
        4. 布林/Keltner挤压爆发信号
        5. MACD辅助
        6. 趋势动量（低权重）
        7. 市场因子
        8. 波动率调整 & ATR止损保护
        """
        p = self.params
        if i < 65:  # 需要至少65天数据（MA60 + 几天缓冲）
            return 0.0

        navs = df['nav'].values[:i + 1]
        current = navs[-1]
        navs_series = pd.Series(navs)

        # ============================================================
        # 1. 多尺度均值偏离计算（核心信号）
        # ============================================================
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        ma60 = np.mean(navs[-60:])

        # 各尺度偏离百分比
        dev5 = (current - ma5) / ma5 * 100
        dev10 = (current - ma10) / ma10 * 100
        dev20 = (current - ma20) / ma20 * 100
        dev60 = (current - ma60) / ma60 * 100

        deviations = [dev5, dev10, dev20, dev60]
        thresholds = [
            p['ma5_dev_threshold'],
            p['ma10_dev_threshold'],
            p['ma20_dev_threshold'],
            p['ma60_dev_threshold'],
        ]
        weights = p['ma_weights']

        # 非线性回归信号：偏离超过阈值时用 sqrt 计算回归强度
        reversion_signal = 0.0
        for dev, thresh, w in zip(deviations, thresholds, weights):
            if abs(dev) > thresh:
                sign = -1 if dev > 0 else 1  # 偏离为正→回归向下，偏离为负→回归向上
                excess = abs(dev) - thresh
                # sqrt非线性：避免极端偏离时过度反应
                strength = math.sqrt(excess)
                reversion_signal += sign * strength * w

        reversion_signal *= p['reversion_weight']

        # OU半衰期调整：回归越快的品种，信号越可靠
        half_life = self._calc_ou_half_life(navs, ma20)
        if half_life < 5:
            # 快速回归 → 信号增强
            reversion_signal *= 1.3
        elif half_life > 20:
            # 慢速回归 → 信号减弱（可能不是均值回归，而是趋势）
            reversion_signal *= 0.6
        elif half_life == float('inf'):
            # 无回归特征 → 大幅减弱
            reversion_signal *= 0.3

        # ============================================================
        # 2. RSI信号 + 背离检测
        # ============================================================
        rsi_series = calc_rsi(navs_series, 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50
        rsi_values = rsi_series.values

        rsi_factor = 0.0
        # 极端RSI区间：强信号
        if rsi > p['rsi_extreme_high']:
            rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.06
        elif rsi > p['rsi_overbought']:
            rsi_factor = -(rsi - p['rsi_overbought']) * 0.02
        elif rsi < p['rsi_extreme_low']:
            rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.06
        elif rsi < p['rsi_oversold']:
            rsi_factor = (p['rsi_oversold'] - rsi) * 0.02

        # RSI背离检测
        divergence = self._detect_rsi_divergence(
            navs, rsi_values, p['rsi_divergence_lookback']
        )
        divergence_signal = 0.0
        if divergence == 1:
            # 底背离 + RSI在低位 = 最强买入信号
            if rsi < p['rsi_extreme_low']:
                divergence_signal = p['rsi_divergence_weight'] * 1.5  # 极端底背离加成
            else:
                divergence_signal = p['rsi_divergence_weight']
        elif divergence == -1:
            # 顶背离 + RSI在高位 = 最强卖出信号
            if rsi > p['rsi_extreme_high']:
                divergence_signal = -p['rsi_divergence_weight'] * 1.5  # 极端顶背离加成
            else:
                divergence_signal = -p['rsi_divergence_weight']

        # ============================================================
        # 3. 布林带反转信号
        # ============================================================
        _, bb_upper_s, bb_lower_s, pctb_s, width_s = calc_bollinger(navs_series)
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_width = width_s.iloc[-1] if not np.isnan(width_s.iloc[-1]) else 5.0
        bb_upper = bb_upper_s.iloc[-1] if not np.isnan(bb_upper_s.iloc[-1]) else current
        bb_lower = bb_lower_s.iloc[-1] if not np.isnan(bb_lower_s.iloc[-1]) else current

        bb_factor = 0.0
        # %B极端值 → 强反转信号
        if pct_b < 5:
            bb_factor = 0.40  # 极端超卖
        elif pct_b < 20:
            bb_factor = (20 - pct_b) * p['bb_weight']
        elif pct_b > 95:
            bb_factor = -0.40  # 极端超买
        elif pct_b > 80:
            bb_factor = -(pct_b - 80) * p['bb_weight']

        # ============================================================
        # 4. Keltner通道 + 布林挤压检测
        # ============================================================
        kc_ma, kc_upper_s, kc_lower_s = self._calc_keltner(navs_series, period=20)
        kc_upper = kc_upper_s.iloc[-1] if not np.isnan(kc_upper_s.iloc[-1]) else current * 1.05
        kc_lower = kc_lower_s.iloc[-1] if not np.isnan(kc_lower_s.iloc[-1]) else current * 0.95

        squeeze_signal = 0.0
        is_squeeze = self._detect_squeeze(bb_upper, bb_lower, kc_upper, kc_lower)

        if is_squeeze or bb_width < p['bb_squeeze_threshold']:
            # 挤压状态：波动率极低，即将爆发
            # 爆发方向跟随MACD
            dif_s, dea_s, hist_s = calc_macd(navs_series)
            hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
            dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0

            if hist > 0:
                squeeze_signal = 0.25  # MACD正 → 向上爆发
            elif hist < 0:
                squeeze_signal = -0.25  # MACD负 → 向下爆发
            # 挤压强度随带宽收窄增强
            if bb_width < p['bb_squeeze_threshold'] and bb_width > 0:
                squeeze_signal *= (p['bb_squeeze_threshold'] / bb_width)
                squeeze_signal = max(-0.5, min(0.5, squeeze_signal))

        # ============================================================
        # 5. MACD辅助信号
        # ============================================================
        dif_s, dea_s, hist_s = calc_macd(navs_series)
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0

        macd_factor = 0.0
        if dif > dea and hist > 0:
            macd_factor = p['macd_weight']
        elif dif < dea and hist < 0:
            macd_factor = -p['macd_weight']
        # 金叉/死叉瞬间信号加强
        if len(hist_s) >= 2:
            prev_hist = hist_s.iloc[-2] if not np.isnan(hist_s.iloc[-2]) else 0
            if prev_hist <= 0 < hist:  # 金叉
                macd_factor += 0.08
            elif prev_hist >= 0 > hist:  # 死叉
                macd_factor -= 0.08

        # ============================================================
        # 6. 趋势动量（低权重，均值回归策略不追趋势）
        # ============================================================
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.2, 0.3, 0.5, 0.7, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0

        # 连涨连跌检测
        streak = 0
        for j in range(len(changes) - 1, -1, -1):
            if changes[j] > 0 and streak >= 0:
                streak += 1
            elif changes[j] < 0 and streak <= 0:
                streak -= 1
            else:
                break

        trend_factor = weighted_mom * p['trend_weight']
        if abs(streak) >= 5:
            trend_factor *= p['streak_decay_5']
        elif abs(streak) >= 3:
            trend_factor *= p['streak_decay_3']

        # ============================================================
        # 7. 市场因子
        # ============================================================
        market_factor = 0.0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

        # ============================================================
        # 8. 波动率调整 & ATR止损保护
        # ============================================================
        daily_returns = navs_series.pct_change().dropna()
        vol_20d = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15

        # 高波动环境：趋势信号衰减，回归信号增强
        if vol_20d > p['vol_threshold']:
            vol_adj = p['vol_adj']
            trend_factor *= vol_adj
            macd_factor *= vol_adj
            # 高波动时均值回归更有效（反转概率更高）
            reversion_signal *= (2 - vol_adj)
        else:
            vol_adj = 1.0

        # ATR止损保护：偏离超过 max_deviation_atr 倍ATR时，不再逆势加仓
        atr_series = calc_atr(navs_series, 14)
        atr = atr_series.iloc[-1] if not np.isnan(atr_series.iloc[-1]) else 0
        if atr > 0:
            atr_deviation = abs(current - ma20) / atr
            if atr_deviation > p['max_deviation_atr']:
                # 偏离过大，趋势可能已经确立，回归信号截断
                if (current > ma20 and reversion_signal < 0) or \
                   (current < ma20 and reversion_signal > 0):
                    # 回归方向与偏离相反 → 这是正常的逆势信号，但要截断
                    reversion_signal *= 0.2  # 大幅减弱，不完全清零
                    bb_factor *= 0.3
                    divergence_signal *= 0.5

        # ============================================================
        # 合成最终信号
        # ============================================================
        raw = (
            reversion_signal      # 核心：多尺度均值回归
            + rsi_factor           # RSI超买超卖
            + divergence_signal    # RSI背离
            + bb_factor            # 布林带反转
            + squeeze_signal       # 布林/Keltner挤压爆发
            + macd_factor          # MACD辅助
            + trend_factor         # 趋势动量（低权重）
            + market_factor        # 市场因子
        )

        # 归一化到 [-1, +1]
        return max(-1.0, min(1.0, raw / 2.0))
