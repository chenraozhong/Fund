#!/usr/bin/env python3
"""
多维共振策略 (Multi-Resonance Strategy)
========================================
核心理念：单一因子信号噪声大，但多因子同时发出信号时方向确定性急剧提升。

5个独立维度评分 × 共振检测 × 跨时间框架确认 × 信号质量评分 → 最终交易信号

维度:
  1. 趋势维 - MA排列 + EMA交叉 + MACD方向
  2. 动量维 - RSI绝对值 + RSI变化率 + 涨跌幅加速度
  3. 波动维 - 布林%B + ATR变化率 + 波动率percentile
  4. 市场维 - 大盘方向 + 大盘vs个基差异
  5. 回归维 - 偏离MA20程度 + 偏离MA60程度
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional

from backtest_engine import Strategy, calc_ema, calc_rsi, calc_macd, calc_bollinger, calc_atr


class MultiResonanceStrategy(Strategy):
    """多维共振策略 — 多因子同向共振时信号确定性大幅提升"""

    def __init__(self, params: Optional[Dict] = None):
        default = {
            # ---------- 维度权重 ----------
            'dim_weights': [0.30, 0.25, 0.15, 0.15, 0.15],  # 趋势/动量/波动/市场/回归

            # ---------- 共振乘数 ----------
            'resonance_4dim': 2.0,    # 4维以上同向
            'resonance_3dim': 1.5,    # 3维同向
            'resonance_2dim': 1.0,    # 2维同向(正常)
            'resonance_conflict': 0.3, # 多空严重分歧

            # ---------- 跨时间框架 ----------
            'tf_short': 3,            # 短期窗口(天)
            'tf_mid': 10,             # 中期窗口(天)
            'tf_long': 30,            # 长期窗口(天)
            'tf_aligned_boost': 1.5,  # 三框架一致时信号放大
            'tf_conflict_decay': 0.4, # 长短期矛盾时信号衰减

            # ---------- 信号质量阈值 ----------
            'quality_threshold_high': 0.2,  # 高质量信号行动阈值
            'quality_threshold_low': 0.5,   # 低质量信号行动阈值

            # ---------- 技术指标参数 ----------
            'rsi_period': 14,
            'rsi_overbought': 65,
            'rsi_oversold': 35,
            'macd_fast': 12,
            'macd_slow': 26,
            'macd_signal': 9,
            'bb_period': 20,
            'bb_mult': 2,
            'vol_threshold': 25,      # 波动率百分位阈值
        }
        if params:
            default.update(params)
        super().__init__('多维共振策略', default)

    # ==============================================================
    # 辅助：安全取值
    # ==============================================================

    @staticmethod
    def _safe(series: pd.Series, idx: int, default: float = 0.0) -> float:
        """安全读取Series某位置的值，越界或NaN时返回默认值"""
        if idx < 0 or idx >= len(series):
            return default
        val = series.iloc[idx]
        if pd.isna(val) or not np.isfinite(val):
            return default
        return float(val)

    @staticmethod
    def _clamp(val: float, lo: float = -100.0, hi: float = 100.0) -> float:
        """限制值在[lo, hi]区间"""
        return max(lo, min(hi, val))

    # ==============================================================
    # 维度1: 趋势维 (-100 ~ +100)
    # ==============================================================

    def _score_trend(self, df: pd.DataFrame, i: int) -> float:
        """
        趋势维评分: MA排列 + EMA交叉 + MACD方向
        - MA排列: MA5 > MA10 > MA20 看涨，反之看跌
        - EMA交叉: EMA5与EMA20的相对位置和变化
        - MACD方向: MACD柱状体的符号和趋势
        """
        navs = df['nav']
        score = 0.0

        # --- MA排列 (权重40%) ---
        if i >= 20:
            ma5 = navs.iloc[max(0, i - 4):i + 1].mean()
            ma10 = navs.iloc[max(0, i - 9):i + 1].mean()
            ma20 = navs.iloc[max(0, i - 19):i + 1].mean()
            # 完美多头排列: MA5 > MA10 > MA20 → +40; 完美空头排列 → -40
            if ma5 > ma10 > ma20:
                # 排列越明显，分越高
                spread = (ma5 - ma20) / ma20 * 100 if ma20 > 0 else 0
                score += min(40, spread * 20)
            elif ma5 < ma10 < ma20:
                spread = (ma20 - ma5) / ma20 * 100 if ma20 > 0 else 0
                score -= min(40, spread * 20)
            else:
                # 纠缠状态，根据MA5与MA20的关系给微弱方向
                if ma20 > 0:
                    diff_pct = (ma5 - ma20) / ma20 * 100
                    score += self._clamp(diff_pct * 10, -15, 15)

        # --- EMA交叉 (权重30%) ---
        if i >= 20:
            ema5 = calc_ema(navs, 5)
            ema20 = calc_ema(navs, 20)
            ema5_now = self._safe(ema5, i)
            ema20_now = self._safe(ema20, i)
            ema5_prev = self._safe(ema5, i - 1)
            ema20_prev = self._safe(ema20, i - 1)
            if ema20_now > 0:
                # 当前距离
                cross_pct = (ema5_now - ema20_now) / ema20_now * 100
                score += self._clamp(cross_pct * 15, -20, 20)
                # 金叉/死叉瞬间额外加分
                if ema5_prev <= ema20_prev and ema5_now > ema20_now:
                    score += 10  # 金叉
                elif ema5_prev >= ema20_prev and ema5_now < ema20_now:
                    score -= 10  # 死叉

        # --- MACD方向 (权重30%) ---
        p = self.params
        if i >= p['macd_slow'] + p['macd_signal']:
            dif, dea, hist = calc_macd(navs, p['macd_fast'], p['macd_slow'], p['macd_signal'])
            hist_now = self._safe(hist, i)
            hist_prev = self._safe(hist, i - 1)
            # MACD柱状体方向
            if hist_now > 0:
                score += 15
            elif hist_now < 0:
                score -= 15
            # MACD柱状体趋势(加速/减速)
            if hist_now > hist_prev:
                score += 15  # 动能增强
            elif hist_now < hist_prev:
                score -= 15  # 动能减弱

        return self._clamp(score)

    # ==============================================================
    # 维度2: 动量维 (-100 ~ +100)
    # ==============================================================

    def _score_momentum(self, df: pd.DataFrame, i: int) -> float:
        """
        动量维评分: RSI绝对值 + RSI变化率 + 涨跌幅加速度
        """
        navs = df['nav']
        p = self.params
        score = 0.0

        # --- RSI绝对值 (权重40%) ---
        if i >= p['rsi_period'] + 1:
            rsi_series = calc_rsi(navs, p['rsi_period'])
            rsi_val = self._safe(rsi_series, i, 50.0)
            rsi_prev = self._safe(rsi_series, i - 1, 50.0)

            # RSI偏离50的程度 → 动量方向
            rsi_deviation = rsi_val - 50  # 范围大约 -50 ~ +50
            score += self._clamp(rsi_deviation * 0.8, -40, 40)

            # --- RSI变化率 (权重30%) ---
            rsi_change = rsi_val - rsi_prev
            score += self._clamp(rsi_change * 3, -30, 30)

            # 超买超卖区域给强信号
            if rsi_val >= p['rsi_overbought']:
                score -= 10  # 超买区警告(反转可能)
            elif rsi_val <= p['rsi_oversold']:
                score += 10  # 超卖区机会(反弹可能)

        # --- 涨跌幅加速度 (权重30%) ---
        if i >= 5:
            # 近3天涨幅 vs 前3天涨幅 → 加速度
            recent_ret = (navs.iloc[i] / navs.iloc[max(0, i - 2)] - 1) * 100
            prev_ret = (navs.iloc[max(0, i - 2)] / navs.iloc[max(0, i - 5)] - 1) * 100
            acceleration = recent_ret - prev_ret
            score += self._clamp(acceleration * 10, -30, 30)

        return self._clamp(score)

    # ==============================================================
    # 维度3: 波动维 (-100 ~ +100)
    # ==============================================================

    def _score_volatility(self, df: pd.DataFrame, i: int) -> float:
        """
        波动维评分: 布林%B + ATR变化率 + 波动率percentile
        - 低波动+触下轨 → 买入信号 (均值回归)
        - 高波动+触上轨 → 卖出信号 (过度拉伸)
        """
        navs = df['nav']
        p = self.params
        score = 0.0

        # --- 布林%B (权重40%) ---
        if i >= p['bb_period']:
            _, _, _, pct_b, width = calc_bollinger(navs, p['bb_period'], p['bb_mult'])
            b_val = self._safe(pct_b, i, 50.0)

            # %B < 0 触下轨(超卖买入), %B > 100 触上轨(超买卖出)
            # 将 %B 从 [0, 100] 映射为 [-40, +40] 的买入信号
            # 越低越看涨(均值回归), 越高越看跌
            b_signal = -(b_val - 50) * 0.8  # 反转逻辑
            score += self._clamp(b_signal, -40, 40)

        # --- ATR变化率 (权重30%) ---
        if i >= 20:
            atr_series = calc_atr(navs, 14)
            atr_now = self._safe(atr_series, i)
            atr_prev = self._safe(atr_series, i - 5, atr_now)
            if atr_prev > 0:
                atr_change = (atr_now - atr_prev) / atr_prev
                # ATR放大 → 波动加剧 → 趋势可能持续(但风险增加)
                # ATR缩小 → 波动收敛 → 可能酝酿突破
                # 这里采用中性处理：ATR急剧放大时减少信号(不确定性高)
                score += self._clamp(-atr_change * 50, -30, 30)

        # --- 波动率percentile (权重30%) ---
        if i >= 60:
            # 计算过去60天的日收益率标准差
            returns_window = navs.iloc[max(0, i - 59):i + 1].pct_change().dropna()
            if len(returns_window) >= 10:
                current_vol = returns_window.std() * math.sqrt(250) * 100  # 年化波动率%
                # 计算该波动率在历史中的百分位
                all_vols = []
                for j in range(60, min(i + 1, len(navs))):
                    w = navs.iloc[max(0, j - 59):j + 1].pct_change().dropna()
                    if len(w) >= 10:
                        all_vols.append(w.std() * math.sqrt(250) * 100)
                if all_vols:
                    percentile = sum(1 for v in all_vols if v <= current_vol) / len(all_vols) * 100
                else:
                    percentile = 50

                # 高波动百分位 → 风险高 → 保守(偏空)
                # 低波动百分位 → 风险低 → 可加仓(偏多)
                vol_signal = -(percentile - 50) * 0.6
                score += self._clamp(vol_signal, -30, 30)

        return self._clamp(score)

    # ==============================================================
    # 维度4: 市场维 (-100 ~ +100)
    # ==============================================================

    def _score_market(self, df: pd.DataFrame, i: int,
                      market_df: Optional[pd.DataFrame] = None) -> float:
        """
        市场维评分: 大盘方向 + 大盘vs个基差异
        - 大盘上涨且个基跑赢大盘 → 强买
        - 大盘下跌且个基也跌 → 强卖
        - 大盘涨但个基跌 → 可能基金自身问题
        """
        if market_df is None or len(market_df) < 20:
            return 0.0  # 无大盘数据时，此维度得分为0(不参与共振)

        navs = df['nav']
        score = 0.0

        # 对齐大盘数据到当前日期
        if 'close' not in market_df.columns:
            return 0.0
        mkt = market_df['close']
        mi = min(i, len(mkt) - 1)  # 大盘数据索引对齐(简单截断)

        # --- 大盘方向 (权重50%) ---
        if mi >= 10:
            mkt_ret_10 = (mkt.iloc[mi] / mkt.iloc[max(0, mi - 9)] - 1) * 100
            # 大盘10天涨幅映射到[-50, +50]
            score += self._clamp(mkt_ret_10 * 10, -50, 50)

        # --- 大盘vs个基差异 (权重50%) ---
        if mi >= 10 and i >= 10:
            fund_ret_10 = (navs.iloc[i] / navs.iloc[max(0, i - 9)] - 1) * 100
            mkt_ret_10 = (mkt.iloc[mi] / mkt.iloc[max(0, mi - 9)] - 1) * 100
            # 个基超额收益
            alpha = fund_ret_10 - mkt_ret_10
            score += self._clamp(alpha * 10, -50, 50)

        return self._clamp(score)

    # ==============================================================
    # 维度5: 回归维 (-100 ~ +100)
    # ==============================================================

    def _score_reversion(self, df: pd.DataFrame, i: int) -> float:
        """
        回归维评分: 偏离MA20程度 + 偏离MA60程度
        - 大幅偏离均线时，价格倾向于回归
        - 偏离越大，回归力越强
        """
        navs = df['nav']
        score = 0.0
        current = navs.iloc[i]

        # --- 偏离MA20 (权重50%) ---
        if i >= 20 and current > 0:
            ma20 = navs.iloc[max(0, i - 19):i + 1].mean()
            if ma20 > 0:
                dev20 = (current - ma20) / ma20 * 100  # 偏离百分比
                # 偏离越大，回归力越强(反向信号)
                # 偏离+3% → 回归信号 -50; 偏离-3% → 回归信号 +50
                score += self._clamp(-dev20 * (50 / 3), -50, 50)

        # --- 偏离MA60 (权重50%) ---
        if i >= 60 and current > 0:
            ma60 = navs.iloc[max(0, i - 59):i + 1].mean()
            if ma60 > 0:
                dev60 = (current - ma60) / ma60 * 100
                score += self._clamp(-dev60 * (50 / 5), -50, 50)

        return self._clamp(score)

    # ==============================================================
    # 共振检测: 统计同向维度数量并返回信念乘数
    # ==============================================================

    def _calc_resonance_multiplier(self, dim_scores: list) -> float:
        """
        共振检测 — 统计5个维度中看多/看空的个数
        返回信念乘数:
          4维以上同向 → 2.0
          3维同向     → 1.5
          2维同向     → 1.0
          分歧        → 0.3
        """
        p = self.params
        bullish = sum(1 for s in dim_scores if s > 5)    # >5才算有效看多
        bearish = sum(1 for s in dim_scores if s < -5)   # <-5才算有效看空
        neutral = len(dim_scores) - bullish - bearish

        # 确定主要方向的维度数
        dominant = max(bullish, bearish)

        if dominant >= 4:
            return p['resonance_4dim']   # 强共振
        elif dominant >= 3:
            return p['resonance_3dim']   # 中共振
        elif dominant >= 2 and neutral >= 2:
            return p['resonance_2dim']   # 普通
        else:
            # 多空分歧严重(如 bullish=2, bearish=2)
            return p['resonance_conflict']

    # ==============================================================
    # 跨时间框架确认
    # ==============================================================

    def _calc_timeframe_factor(self, df: pd.DataFrame, i: int) -> float:
        """
        跨时间框架三重确认:
        - 短期(3天)、中期(10天)、长期(30天)的涨跌方向
        - 三框架一致 → 信号放大 (×1.5)
        - 长短期矛盾 → 信号衰减 (×0.4)
        - 其他情况   → 不变 (×1.0)
        """
        navs = df['nav']
        p = self.params
        tf_s, tf_m, tf_l = p['tf_short'], p['tf_mid'], p['tf_long']

        def direction(lookback: int) -> int:
            """计算某窗口期的方向: +1看涨, -1看跌, 0中性"""
            if i < lookback:
                return 0
            ret = (navs.iloc[i] / navs.iloc[i - lookback] - 1)
            if ret > 0.002:
                return 1
            elif ret < -0.002:
                return -1
            return 0

        d_short = direction(tf_s)
        d_mid = direction(tf_m)
        d_long = direction(tf_l)

        # 三个时间框架方向一致
        if d_short == d_mid == d_long and d_short != 0:
            return p['tf_aligned_boost']

        # 长期与短期矛盾
        if d_short != 0 and d_long != 0 and d_short != d_long:
            return p['tf_conflict_decay']

        # 其他情况
        return 1.0

    # ==============================================================
    # 信号质量评分
    # ==============================================================

    def _calc_signal_quality(self, dim_scores: list) -> float:
        """
        信号质量评分 — 基于各维度得分的一致性
        返回值: 0~1之间，越高表示信号质量越好

        标准差小(信号一致) → 高质量 → 接近1.0
        标准差大(信号分散) → 低质量 → 接近0.0
        """
        if not dim_scores:
            return 0.5

        abs_scores = [abs(s) for s in dim_scores]
        mean_abs = sum(abs_scores) / len(abs_scores)

        # 如果所有维度得分都很小，信号本身就弱，质量定义为中等
        if mean_abs < 5:
            return 0.5

        std = np.std(dim_scores)
        # 标准差范围大约 0 ~ 80, 归一化到 0~1
        # std=0 → 完美一致 → quality=1.0
        # std=80 → 完全分散 → quality≈0.0
        quality = max(0.0, 1.0 - std / 80.0)
        return quality

    def _get_action_threshold(self, quality: float) -> float:
        """
        根据信号质量动态调整行动阈值
        高质量 → 低阈值(更容易行动)
        低质量 → 高阈值(更难行动，避免噪声交易)
        """
        p = self.params
        th_high = p['quality_threshold_high']  # 0.2
        th_low = p['quality_threshold_low']    # 0.5
        # 线性插值: quality=1→th_high, quality=0→th_low
        return th_low + (th_high - th_low) * quality

    # ==============================================================
    # 主入口: generate_signal
    # ==============================================================

    def generate_signal(self, df: pd.DataFrame, i: int,
                        market_df: Optional[pd.DataFrame] = None) -> float:
        """
        生成多维共振交易信号

        Returns: -1.0(强卖) ~ +1.0(强买), 0=不操作
        """
        # 数据不足时不操作
        if i < 30:
            return 0.0

        p = self.params

        # ------ Step1: 5维独立评分 ------
        s_trend = self._score_trend(df, i)
        s_momentum = self._score_momentum(df, i)
        s_volatility = self._score_volatility(df, i)
        s_market = self._score_market(df, i, market_df)
        s_reversion = self._score_reversion(df, i)

        dim_scores = [s_trend, s_momentum, s_volatility, s_market, s_reversion]
        weights = p['dim_weights']

        # ------ Step2: 加权合成基础信号 ------
        # 将各维度归一化到 [-1, +1] 后加权
        normalized = [s / 100.0 for s in dim_scores]
        base_signal = sum(n * w for n, w in zip(normalized, weights))
        # base_signal 范围: [-1, +1]

        # ------ Step3: 共振检测 ------
        resonance_mult = self._calc_resonance_multiplier(dim_scores)
        signal = base_signal * resonance_mult

        # ------ Step4: 跨时间框架确认 ------
        tf_factor = self._calc_timeframe_factor(df, i)
        signal *= tf_factor

        # ------ Step5: 信号质量过滤 ------
        quality = self._calc_signal_quality(dim_scores)
        threshold = self._get_action_threshold(quality)

        if abs(signal) < threshold:
            # 信号不够强，不操作
            return 0.0

        # 高质量信号可以适当放大，低质量信号衰减
        quality_factor = 0.5 + quality * 0.5  # [0.5, 1.0]
        signal *= quality_factor

        # ------ Step6: 最终裁剪到 [-1, +1] ------
        return max(-1.0, min(1.0, signal))
