#!/usr/bin/env python3
"""
趋势猎手策略 (Trend Hunter Strategy)
========================================
纯趋势跟踪策略变体 — 不做均值回归，不怕追涨，
用双EMA交叉+MACD加速度+ATR移动止损来捕捉并跟踪趋势。

核心理念：
  "趋势是你的朋友，直到它结束。"
  - 趋势确认后重仓跟随，不过早止盈
  - 恐慌性下跌(capitulation)是唯一的逆势买入信号
  - 用ATR trailing stop保护利润，而非固定止盈

作者: 自动策略生成器
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional

from backtest_engine import (
    Strategy,
    calc_ema,
    calc_rsi,
    calc_macd,
    calc_bollinger,
    calc_atr,
)


class TrendHunterStrategy(Strategy):
    """
    趋势猎手策略
    ============
    双EMA交叉系统 + MACD动量加速器 + ATR移动止损

    设计哲学：
      1. 趋势市中最大化收益（高trend_weight, 低reversion_weight）
      2. 不怕追涨 — 布林上轨突破视为趋势延续信号
      3. 连涨不急卖 — streak_decay_5=0.60 保留60%信号强度
      4. 恐慌才抄底 — RSI<28 + 回撤>10% 才触发capitulation买入
      5. ATR trailing stop — 2.5倍ATR作为移动止损线
    """

    def __init__(self, params: Optional[Dict] = None):
        default = {
            # === EMA交叉系统 ===
            'ema_fast': 8,           # 快速EMA周期
            'ema_mid': 21,           # 中速EMA周期
            'ema_slow': 55,          # 慢速EMA周期（长期趋势过滤器）

            # === MACD动量加速器 ===
            'macd_fast': 12,         # MACD快线
            'macd_slow': 26,         # MACD慢线
            'macd_signal': 9,        # MACD信号线

            # === ATR移动止损 ===
            'atr_trailing_mult': 2.5,  # ATR倍数（越大越宽松）

            # === 信号权重 ===
            'trend_weight': 0.92,    # 趋势权重（比v4.2的0.87更激进）
            'reversion_weight': 0.02,  # 均值回归权重（几乎忽略）
            'market_weight': 0.08,   # 大盘因子权重（弱化，专注个基）

            # === RSI参数 ===
            'rsi_overbought': 72,    # 超买阈值（不急于卖出）
            'rsi_oversold': 28,      # 超卖阈值（恐慌才买）

            # === 连涨/连跌衰减 ===
            'streak_decay_5': 0.60,  # 连涨5天保留60%信号
            'streak_decay_3': 0.90,  # 连涨3天保留90%信号

            # === 布林突破 ===
            'breakout_bb_pct': 92,   # 突破布林92%位继续追涨

            # === 恐慌抄底(Capitulation) ===
            'capitulation_rsi': 28,  # RSI低于此值视为恐慌
            'capitulation_dd': 10,   # 回撤超过10%视为恐慌

            # === 波动率调整 ===
            'vol_threshold': 28,     # 高波动率阈值
            'vol_adj': 0.75,         # 高波动时信号衰减系数

            # === MACD加速度权重 ===
            'macd_accel_weight': 0.20,  # MACD二阶导数权重
            'macd_jerk_weight': 0.08,   # MACD三阶导数（加加速度）权重
            'macd_cross_boost': 0.35,   # 金叉/死叉额外信号加成

            # === EMA交叉权重 ===
            'ema_cross_weight': 0.30,   # EMA交叉信号权重
            'ema_filter_weight': 0.15,  # EMA(55)长期过滤器权重

            # === ADX替代指标（用MA排列判断趋势强度）===
            'adx_trend_bonus': 0.20,    # 完全多头/空头排列的额外信号加成
        }
        if params:
            default.update(params)
        super().__init__('趋势猎手', default)

        # === ATR trailing stop 状态 ===
        # 记录每只基金的历史最高价和trailing stop水平
        # key: fund_id (通过df的hash或name识别), value: {'peak': float, 'stop': float}
        self._trailing_stops: Dict[int, Dict[str, float]] = {}

    def _get_trailing_key(self, df: pd.DataFrame) -> int:
        """为每个DataFrame生成唯一key，用于追踪trailing stop状态"""
        return id(df)

    def _update_trailing_stop(self, key: int, current_nav: float, atr_value: float) -> float:
        """
        更新ATR移动止损线
        - 价格创新高时，止损线上移 = 新高 - atr_trailing_mult * ATR
        - 价格未创新高时，止损线不动（只上不下）
        返回当前止损线水平
        """
        mult = self.params['atr_trailing_mult']

        if key not in self._trailing_stops:
            # 首次初始化
            self._trailing_stops[key] = {
                'peak': current_nav,
                'stop': current_nav - mult * atr_value if atr_value > 0 else 0,
            }
        else:
            state = self._trailing_stops[key]
            if current_nav > state['peak']:
                # 创新高，上移止损线
                state['peak'] = current_nav
                new_stop = current_nav - mult * atr_value if atr_value > 0 else state['stop']
                state['stop'] = max(state['stop'], new_stop)  # 止损线只上不下

        return self._trailing_stops[key]['stop']

    def _detect_ema_cross(self, ema_fast_vals, ema_mid_vals, i: int) -> int:
        """
        检测EMA交叉信号
        返回:
          +1 = 金叉（快线从下穿上中线）
          -1 = 死叉（快线从上穿下中线）
           0 = 无交叉
        """
        if i < 1:
            return 0

        # 当前和前一天的位置关系
        curr_above = ema_fast_vals[i] > ema_mid_vals[i]
        prev_above = ema_fast_vals[i - 1] > ema_mid_vals[i - 1]

        if curr_above and not prev_above:
            return 1   # 金叉：快线上穿中线
        elif not curr_above and prev_above:
            return -1  # 死叉：快线下穿中线
        else:
            return 0

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        """
        生成交易信号: -1(强卖) 到 +1(强买), 0=持有

        信号合成逻辑：
          1. EMA交叉系统 → 趋势方向
          2. MACD加速度 → 动量强度和变化率
          3. ATR trailing stop → 趋势保护
          4. 布林突破 → 追涨确认
          5. Capitulation → 恐慌抄底
          6. 市场因子 → 弱化的大盘参考
        """
        p = self.params

        # 需要足够的历史数据来计算EMA(55)
        if i < 60:
            return 0.0

        navs = df['nav'].values[:i + 1]
        nav_series = pd.Series(navs)
        current = navs[-1]

        # ============================================================
        # 第一层：恐慌抄底检测（Capitulation Detection）
        # 极端事件优先判断 — RSI极低 + 大回撤 = 恐慌性抛售
        # ============================================================
        peak_60d = np.max(navs[-60:]) if len(navs) >= 60 else np.max(navs)
        drawdown_pct = (peak_60d - current) / peak_60d * 100

        rsi_series = calc_rsi(nav_series, 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50

        if drawdown_pct > p['capitulation_dd'] and rsi < p['capitulation_rsi']:
            # 恐慌时贪婪 — 连跌3天以上且RSI极低 → 强买
            return 0.85

        # ============================================================
        # 第二层：EMA交叉系统（双EMA + 长期过滤器）
        # EMA(8)/EMA(21)交叉确认方向，EMA(55)过滤假信号
        # ============================================================
        ema_fast_s = calc_ema(nav_series, p['ema_fast'])
        ema_mid_s = calc_ema(nav_series, p['ema_mid'])
        ema_slow_s = calc_ema(nav_series, p['ema_slow'])

        ema_fast_val = ema_fast_s.iloc[-1]
        ema_mid_val = ema_mid_s.iloc[-1]
        ema_slow_val = ema_slow_s.iloc[-1]

        # EMA交叉检测 — 比较当前和前一天的EMA(8)与EMA(21)位置关系
        ema_cross = self._detect_ema_cross(
            ema_fast_s.values, ema_mid_s.values, len(ema_fast_s) - 1
        )

        # EMA交叉信号
        ema_signal = 0.0
        if ema_cross == 1:
            # 金叉 — 快线上穿中线
            ema_signal = p['ema_cross_weight']
        elif ema_cross == -1:
            # 死叉 — 快线下穿中线
            ema_signal = -p['ema_cross_weight']

        # EMA(55)长期趋势过滤器
        # 价格在EMA(55)上方 → 多头环境，增强买入信号
        # 价格在EMA(55)下方 → 空头环境，增强卖出信号
        ema_filter = 0.0
        if current > ema_slow_val:
            ema_filter = p['ema_filter_weight']
        else:
            ema_filter = -p['ema_filter_weight']

        # 如果金叉发生在EMA(55)下方，信号减半（假金叉风险）
        if ema_cross == 1 and current < ema_slow_val:
            ema_signal *= 0.5
        # 如果死叉发生在EMA(55)上方，信号也减半（可能只是回调）
        elif ema_cross == -1 and current > ema_slow_val:
            ema_signal *= 0.5

        # ============================================================
        # 第三层：MACD动量加速器
        # 不只看金叉死叉，更看histogram的加速度（二阶导数）
        # 以及加速度的变化率（三阶导数/jerk）
        # ============================================================
        dif_s, dea_s, hist_s = calc_macd(nav_series, p['macd_fast'], p['macd_slow'], p['macd_signal'])

        hist_current = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif_current = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea_current = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0

        macd_signal_val = 0.0

        # 基础MACD方向
        if hist_current > 0 and dif_current > dea_current:
            macd_signal_val = 0.15
        elif hist_current < 0 and dif_current < dea_current:
            macd_signal_val = -0.15

        # MACD金叉/死叉检测
        if i >= 2:
            hist_prev1 = hist_s.iloc[-2] if not np.isnan(hist_s.iloc[-2]) else 0
            if hist_prev1 <= 0 and hist_current > 0:
                macd_signal_val += p['macd_cross_boost']   # 金叉加成
            elif hist_prev1 >= 0 and hist_current < 0:
                macd_signal_val -= p['macd_cross_boost']   # 死叉减成

        # MACD加速度（二阶导数）：histogram的变化速度
        # 加速度 > 0 → 多头动量增强 / 空头动量减弱
        # 加速度 < 0 → 多头动量减弱 / 空头动量增强
        macd_accel = 0.0
        if i >= 2:
            hist_prev1 = hist_s.iloc[-2] if not np.isnan(hist_s.iloc[-2]) else 0
            macd_accel = hist_current - hist_prev1

        # MACD jerk（三阶导数）：加速度的变化率
        # 用于检测动量转折的早期信号
        macd_jerk = 0.0
        if i >= 3:
            hist_prev2 = hist_s.iloc[-3] if not np.isnan(hist_s.iloc[-3]) else 0
            hist_prev1 = hist_s.iloc[-2] if not np.isnan(hist_s.iloc[-2]) else 0
            accel_prev = hist_prev1 - hist_prev2
            accel_curr = hist_current - hist_prev1
            macd_jerk = accel_curr - accel_prev

        # 归一化加速度信号（用ATR来归一化，避免不同价位的基金信号幅度不同）
        atr_s = calc_atr(nav_series, 14)
        atr_val = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_val = max(atr_val, 0.001)  # 防除零

        # 加速度信号：加速度越大，趋势越强
        accel_normalized = macd_accel / atr_val
        accel_signal = np.clip(accel_normalized * p['macd_accel_weight'], -0.3, 0.3)

        # Jerk信号：jerk方向变化预示动量转折
        jerk_normalized = macd_jerk / atr_val
        jerk_signal = np.clip(jerk_normalized * p['macd_jerk_weight'], -0.15, 0.15)

        # MACD发散/收敛检测
        # DIF和DEA之间的距离在扩大（发散） → 趋势加速
        # DIF和DEA之间的距离在缩小（收敛） → 趋势减速
        macd_divergence = 0.0
        if i >= 5:
            dif_prev5 = dif_s.iloc[-5] if not np.isnan(dif_s.iloc[-5]) else 0
            dea_prev5 = dea_s.iloc[-5] if not np.isnan(dea_s.iloc[-5]) else 0
            spread_now = abs(dif_current - dea_current)
            spread_prev = abs(dif_prev5 - dea_prev5)
            if spread_now > spread_prev * 1.2:
                # 发散 — 趋势加速，维持方向
                macd_divergence = 0.10 if dif_current > dea_current else -0.10
            elif spread_now < spread_prev * 0.7:
                # 收敛 — 趋势减速，减弱信号
                macd_divergence = -0.05 if dif_current > dea_current else 0.05

        # ============================================================
        # 第四层：ADX替代 — MA排列判断趋势强度
        # 基金没有成交量数据，用均线排列和动量方向替代ADX的DI+/DI-
        # ============================================================
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])

        # 完全多头排列: EMA(8) > EMA(21) > EMA(55) 且 MA5 > MA10 > MA20
        fully_bullish = (ema_fast_val > ema_mid_val > ema_slow_val) and (ma5 > ma10 > ma20)
        # 完全空头排列: EMA(8) < EMA(21) < EMA(55) 且 MA5 < MA10 < MA20
        fully_bearish = (ema_fast_val < ema_mid_val < ema_slow_val) and (ma5 < ma10 < ma20)

        adx_signal = 0.0
        if fully_bullish:
            adx_signal = p['adx_trend_bonus']    # 强多头环境加成
        elif fully_bearish:
            adx_signal = -p['adx_trend_bonus']   # 强空头环境加成

        # ============================================================
        # 第五层：趋势动量（加权近期涨跌幅）
        # ============================================================
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        # 时间衰减权重 — 最近的权重最大
        decay_weights = np.array([0.10, 0.20, 0.40, 0.75, 1.00])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0

        # 连涨/连跌计数
        streak = 0
        for j in range(len(changes) - 1, -1, -1):
            if changes[j] > 0 and streak >= 0:
                streak += 1
            elif changes[j] < 0 and streak <= 0:
                streak -= 1
            else:
                break

        # 趋势因子 — 核心信号
        trend_factor = weighted_mom * p['trend_weight']

        # 连涨/连跌衰减处理（趋势猎手的核心差异化）
        # 连涨5天以上：不急于卖出，趋势延续概率>55%
        # 保留60%信号强度，而非像原始策略那样大幅衰减
        if abs(streak) >= 5:
            trend_factor *= p['streak_decay_5']  # 0.60 — 仍保留大部分信号
        elif abs(streak) >= 3:
            trend_factor *= p['streak_decay_3']  # 0.90 — 几乎不衰减

        # MA趋势评分（趋势猎手版本：上涨加权更大）
        trend_score = 0
        if current > ma5:
            trend_score += 20   # 站上5日线（多头加权）
        else:
            trend_score -= 10
        if current > ma10:
            trend_score += 15
        else:
            trend_score -= 12
        if current > ma20:
            trend_score += 18
        else:
            trend_score -= 18
        if ma5 > ma10:
            trend_score += 12   # 短期均线在中期上方
        else:
            trend_score -= 8

        trend_factor += trend_score * 0.018

        # ============================================================
        # 第六层：均值回归（极低权重 — 趋势猎手几乎忽略）
        # ============================================================
        dev_ma20 = (current - ma20) / ma20 * 100
        reversion = 0.0
        if abs(dev_ma20) > 3.0:
            # 只有偏离超过3%才考虑微弱的均值回归
            sign = -1 if dev_ma20 > 0 else 1
            reversion = sign * math.sqrt(abs(dev_ma20) - 3.0) * p['reversion_weight']

        # ============================================================
        # 第七层：布林带突破追涨
        # 趋势猎手不在布林上轨反转做空，而是追涨
        # ============================================================
        _, _, _, pctb_s, _ = calc_bollinger(nav_series)
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50

        bb_signal = 0.0
        if pct_b > p['breakout_bb_pct']:
            # 突破布林92%位 → 追涨（趋势延续）
            # 涨幅放大替代成交量确认：当日涨幅 > 0.5% 视为"放量突破"
            daily_change = changes[-1] if len(changes) > 0 else 0
            if daily_change > 0.5:
                bb_signal = 0.25  # 放量突破上轨 → 强追涨
            else:
                bb_signal = 0.12  # 缩量突破 → 弱追涨（可能假突破）
        elif pct_b < 8:
            # 极度超卖 — 但趋势猎手不轻易抄底，除非有capitulation确认
            bb_signal = 0.08
        elif pct_b < 20:
            bb_signal = (20 - pct_b) * 0.005  # 微弱买入信号

        # ============================================================
        # 第八层：RSI信号（趋势猎手版本 — 阈值更极端）
        # ============================================================
        rsi_factor = 0.0
        if rsi > 85:
            # 极端超买 — 即使趋势猎手也需要警惕
            rsi_factor = -(rsi - 85) * 0.05
        elif rsi > p['rsi_overbought']:  # 72
            # 普通超买 — 趋势猎手只给微弱卖出信号
            rsi_factor = -(rsi - p['rsi_overbought']) * 0.015
        elif rsi < p['rsi_oversold']:  # 28
            # 超卖 — 可能是抄底机会
            rsi_factor = (p['rsi_oversold'] - rsi) * 0.04

        # ============================================================
        # 第九层：ATR Trailing Stop
        # 趋势中不过早止盈，用2.5倍ATR作为移动止损
        # ============================================================
        trailing_key = self._get_trailing_key(df)
        trailing_stop = self._update_trailing_stop(trailing_key, current, atr_val)

        atr_stop_signal = 0.0
        if current < trailing_stop and trailing_stop > 0:
            # 价格跌破移动止损线 → 趋势可能结束，发出卖出信号
            stop_breach_pct = (trailing_stop - current) / trailing_stop * 100
            atr_stop_signal = -min(0.6, stop_breach_pct * 0.15)  # 跌破越多，卖出越强

        # ============================================================
        # 第十层：市场因子（弱化 — 专注个基趋势）
        # ============================================================
        market_factor = 0.0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

        # ============================================================
        # 第十一层：波动率调整
        # 高波动环境下适当降低信号强度，但不过度压制
        # ============================================================
        daily_returns = nav_series.pct_change().dropna()
        vol_20d = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15

        vol_adj_factor = 1.0
        if vol_20d > p['vol_threshold']:  # 28
            vol_adj_factor = p['vol_adj']  # 0.75

        # ============================================================
        # 信号合成
        # ============================================================

        # 趋势类信号（受波动率调整）
        trend_signals = (
            trend_factor
            + ema_signal
            + ema_filter
            + adx_signal
            + accel_signal
            + jerk_signal
            + macd_divergence
        ) * vol_adj_factor

        # 动量类信号
        momentum_signals = macd_signal_val

        # 战术类信号（不受波动率压制）
        tactical_signals = (
            bb_signal
            + rsi_factor
            + reversion
            + atr_stop_signal
            + market_factor
        )

        raw = trend_signals + momentum_signals + tactical_signals

        # 归一化到 [-1, 1]
        # 除以2.5使信号分布合理（不会过于集中在极端值）
        normalized = raw / 2.5

        return max(-1.0, min(1.0, normalized))

    def describe(self) -> str:
        """策略描述（中文）"""
        p = self.params
        return (
            f"趋势猎手策略 | "
            f"EMA({p['ema_fast']}/{p['ema_mid']}/{p['ema_slow']}) "
            f"MACD({p['macd_fast']}/{p['macd_slow']}/{p['macd_signal']}) "
            f"ATR止损x{p['atr_trailing_mult']} | "
            f"趋势权重={p['trend_weight']} "
            f"回归权重={p['reversion_weight']} "
            f"连涨5日衰减={p['streak_decay_5']} "
            f"追涨阈值=BB>{p['breakout_bb_pct']}% "
            f"恐慌抄底=RSI<{p['capitulation_rsi']}+DD>{p['capitulation_dd']}%"
        )
