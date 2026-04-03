#!/usr/bin/env python3
"""
宏观防线策略 (Macro Shield Strategy)
=====================================
核心理念：大盘优先过滤 + 波动率状态机 + 回撤熔断 + Beta调整
在市场系统性风险升高时优先保护本金，放弃收益。
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional

from backtest_engine import Strategy, calc_ema, calc_rsi, calc_macd, calc_bollinger, calc_atr


class MacroShieldStrategy(Strategy):
    """宏观防线策略：大盘优先 + 风控熔断 + Beta调整"""

    def __init__(self, params: Optional[Dict] = None):
        default = {
            # 基础因子权重
            'trend_weight': 0.35,
            'reversion_weight': 0.15,
            'market_weight': 0.30,       # 最高大盘权重
            'macd_weight': 0.10,
            'bb_weight': 0.015,
            # RSI阈值（偏保守）
            'rsi_overbought': 58,
            'rsi_oversold': 40,
            'rsi_extreme_high': 72,
            'rsi_extreme_low': 28,
            # 回撤控制器
            'drawdown_warn': 5.0,        # 5% 开始减仓
            'drawdown_stop_buy': 10.0,   # 10% 停止买入
            'drawdown_meltdown': 15.0,   # 15% 熔断清仓
            # 波动率状态机
            'vol_low': 15,
            'vol_mid': 25,
            'vol_high': 35,
            'vol_reduce_mid': 0.7,       # 中波仓位缩减30%
            'vol_reduce_high': 0.5,      # 高波仓位缩减50%
            # Beta相关
            'beta_lookback': 20,
            # 利润锁定
            'profit_lock_threshold': 5.0,  # 累计>5%锁利
            # 季节性
            'seasonal_reduce': 0.85,     # 高波月份缩减15%
            'seasonal_months': [1, 4, 10],
            # 连涨衰减
            'streak_decay_3': 0.55,
            'streak_decay_5': 0.25,
            # 大盘空头乘数
            'market_bear_multiplier': 0.5,
            # MA阈值
            'ma20_threshold': 1.5,
            'ma5_threshold': 1.0,
        }
        if params:
            default.update(params)
        super().__init__('宏观防线', default)
        # 记录累计收益用于利润锁定
        self._initial_nav = {}

    def _calc_beta(self, fund_returns: np.ndarray, market_returns: np.ndarray) -> float:
        """计算个基与大盘的Beta（20日滚动相关性近似）"""
        if len(fund_returns) < 5 or len(market_returns) < 5:
            return 1.0
        n = min(len(fund_returns), len(market_returns))
        fr = fund_returns[-n:]
        mr = market_returns[-n:]
        # Beta = Cov(fund, market) / Var(market)
        cov = np.cov(fr, mr)
        if cov.shape == (2, 2) and cov[1, 1] > 0:
            return float(np.clip(cov[0, 1] / cov[1, 1], 0.3, 3.0))
        return 1.0

    def _detect_market_regime(self, market_df: pd.DataFrame, i: int) -> str:
        """检测大盘状态: bull/bear/neutral"""
        if market_df is None or 'nav' not in market_df.columns or i < 20:
            return 'neutral'
        mkt_navs = market_df['nav'].values[:i + 1]
        if len(mkt_navs) < 20:
            return 'neutral'
        ma5 = np.mean(mkt_navs[-5:])
        ma10 = np.mean(mkt_navs[-10:])
        ma20 = np.mean(mkt_navs[-20:])
        if ma5 > ma10 > ma20:
            return 'bull'
        elif ma5 < ma10 < ma20:
            return 'bear'
        return 'neutral'

    def _market_consecutive_down(self, market_df: pd.DataFrame, i: int) -> int:
        """大盘连跌天数"""
        if market_df is None or 'change_pct' not in market_df.columns:
            return 0
        count = 0
        for j in range(i, max(i - 10, -1), -1):
            if j < len(market_df) and market_df['change_pct'].iloc[j] < 0:
                count += 1
            else:
                break
        return count

    def generate_signal(self, df: pd.DataFrame, i: int, market_df: Optional[pd.DataFrame] = None) -> float:
        p = self.params
        if i < 30:
            return 0.0

        navs = df['nav'].values[:i + 1]
        current = navs[-1]

        # 记录初始净值（用于累计收益计算）
        fund_key = id(df)
        if fund_key not in self._initial_nav:
            self._initial_nav[fund_key] = navs[30]  # 从第30天开始记录
        initial = self._initial_nav[fund_key]
        cumulative_return_pct = (current - initial) / initial * 100

        # ========================================
        # 风控层1: 回撤控制器
        # ========================================
        peak = np.max(navs)
        drawdown_pct = (peak - current) / peak * 100

        if drawdown_pct > p['drawdown_meltdown']:
            return -0.95  # 熔断：强制清仓

        if drawdown_pct > p['drawdown_stop_buy']:
            # 停止买入，只允许卖出
            drawdown_sell = -0.3 - (drawdown_pct - p['drawdown_stop_buy']) * 0.05
            return max(-0.9, drawdown_sell)

        drawdown_factor = 1.0
        if drawdown_pct > p['drawdown_warn']:
            # 5-10%回撤：逐步缩减信号
            drawdown_factor = 1.0 - (drawdown_pct - p['drawdown_warn']) / (p['drawdown_stop_buy'] - p['drawdown_warn']) * 0.5

        # ========================================
        # 风控层2: 波动率状态机
        # ========================================
        daily_returns = pd.Series(navs).pct_change().dropna()
        vol_20d = daily_returns.iloc[-20:].std() * math.sqrt(250) * 100 if len(daily_returns) >= 20 else 15

        if vol_20d > p['vol_high']:
            return -0.6  # 极端波动：强制减仓信号

        vol_multiplier = 1.0
        if vol_20d > p['vol_mid']:
            vol_multiplier = p['vol_reduce_high']
        elif vol_20d > p['vol_low']:
            vol_multiplier = p['vol_reduce_mid']

        # ========================================
        # 风控层3: 大盘过滤
        # ========================================
        market_regime = self._detect_market_regime(market_df, i)
        market_down_days = self._market_consecutive_down(market_df, i)

        market_filter = 1.0
        if market_regime == 'bear':
            market_filter = p['market_bear_multiplier']  # 大盘空头排列，信号减半

        if market_down_days >= 3:
            # 大盘连跌3天以上，只允许卖出
            market_filter = -0.2  # 负值强制偏空

        # ========================================
        # 风控层4: 利润锁定
        # ========================================
        profit_lock_factor = 1.0
        if cumulative_return_pct > p['profit_lock_threshold']:
            # 锁定一半利润：买入信号缩减50%
            profit_lock_factor = 0.5

        # ========================================
        # 风控层5: 季节性避险
        # ========================================
        seasonal_factor = 1.0
        if hasattr(df, 'iloc') and 'date' in df.columns:
            try:
                current_date = pd.to_datetime(df['date'].iloc[i])
                if current_date.month in p.get('seasonal_months', [1, 4, 10]):
                    seasonal_factor = p['seasonal_reduce']
            except Exception:
                pass

        # ========================================
        # 信号生成（保守版）
        # ========================================

        # --- 趋势动量 ---
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay_weights = np.array([0.2, 0.3, 0.5, 0.7, 1.0])
        recent5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay_weights[-len(recent5):]
        weighted_mom = np.dot(recent5, w) / w.sum() if len(recent5) > 0 else 0

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

        # MA趋势评分（空头加权）
        ma5 = np.mean(navs[-5:])
        ma10 = np.mean(navs[-10:])
        ma20 = np.mean(navs[-20:])
        trend_score = 0
        if current > ma5:
            trend_score += 10
        else:
            trend_score -= 15  # 空头加权
        if current > ma10:
            trend_score += 10
        else:
            trend_score -= 15
        if current > ma20:
            trend_score += 15
        else:
            trend_score -= 25  # 空头更重
        trend_factor += trend_score * 0.015

        # --- 均值回归 ---
        dev_ma20 = (current - ma20) / ma20 * 100
        reversion = 0
        if abs(dev_ma20) > p['ma20_threshold']:
            sign = -1 if dev_ma20 > 0 else 1
            reversion += sign * math.sqrt(abs(dev_ma20) - p['ma20_threshold']) * p['reversion_weight']

        dev_ma5 = (current - ma5) / ma5 * 100
        if abs(dev_ma5) > p['ma5_threshold']:
            sign = -1 if dev_ma5 > 0 else 1
            reversion += sign * (abs(dev_ma5) - p['ma5_threshold']) * 0.08

        # --- RSI ---
        rsi_series = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_series.iloc[-1] if not np.isnan(rsi_series.iloc[-1]) else 50
        rsi_factor = 0
        if rsi > p['rsi_extreme_high']:
            rsi_factor = -(rsi - p['rsi_extreme_high']) * 0.10  # 更激进卖出
        elif rsi > p['rsi_overbought']:
            rsi_factor = -(rsi - p['rsi_overbought']) * 0.04
        elif rsi < p['rsi_extreme_low']:
            rsi_factor = (p['rsi_extreme_low'] - rsi) * 0.06  # 谨慎买入
        elif rsi < p['rsi_oversold']:
            rsi_factor = (p['rsi_oversold'] - rsi) * 0.03

        # --- MACD ---
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        macd_factor = 0
        if hist > 0 and dif > dea:
            macd_factor = p['macd_weight']
        elif hist < 0 and dif < dea:
            macd_factor = -p['macd_weight']

        # --- 大盘因子 ---
        market_factor = 0
        if market_df is not None and i < len(market_df):
            mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            market_factor = mkt_change * p['market_weight'] / 100

            # Beta调整：高Beta基金在大盘下跌时放大空头信号
            if len(daily_returns) >= p['beta_lookback'] and 'nav' in market_df.columns:
                mkt_returns = market_df['nav'].pct_change().dropna().values
                fund_rets = daily_returns.values
                beta = self._calc_beta(fund_rets[-p['beta_lookback']:],
                                       mkt_returns[-min(p['beta_lookback'], len(mkt_returns)):])
                if mkt_change < 0 and beta > 1.2:
                    market_factor *= beta  # 高Beta放大下跌信号

            # 大盘MA5下穿MA10 → 额外空头
            if i >= 10 and 'nav' in market_df.columns:
                mkt_navs = market_df['nav'].values[:i + 1]
                if len(mkt_navs) >= 10:
                    mkt_ma5 = np.mean(mkt_navs[-5:])
                    mkt_ma10 = np.mean(mkt_navs[-10:])
                    if mkt_ma5 < mkt_ma10:
                        market_factor -= 0.15

        # --- 布林带 ---
        _, _, _, pctb_s, _ = calc_bollinger(pd.Series(navs))
        pct_b = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_factor = 0
        if pct_b > 95:
            bb_factor = -0.35
        elif pct_b > 80:
            bb_factor = -(pct_b - 80) * p['bb_weight']
        elif pct_b < 5:
            bb_factor = 0.25  # 比激进策略更保守
        elif pct_b < 20:
            bb_factor = (20 - pct_b) * p['bb_weight']

        # ========================================
        # 综合信号 + 多层风控修正
        # ========================================
        raw = trend_factor + reversion + rsi_factor + macd_factor + bb_factor + market_factor

        # 应用风控层
        if market_filter < 0:
            # 大盘连跌强制偏空：正信号清零，负信号保留
            raw = min(raw, market_filter)
        else:
            # 正常大盘过滤
            if raw > 0:
                raw *= market_filter  # 大盘空头时买入信号减半
            # 卖出信号不受大盘过滤影响（该卖就卖）

        raw *= drawdown_factor      # 回撤缩减
        raw *= vol_multiplier       # 波动率缩减
        raw *= seasonal_factor      # 季节性缩减

        # 利润锁定只影响买入信号
        if raw > 0:
            raw *= profit_lock_factor

        signal = max(-1, min(1, raw / 1.5))
        return signal
