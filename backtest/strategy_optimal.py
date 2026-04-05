#!/usr/bin/env python3
"""
最优解搜索 — 融合多策略信号 + 自适应选择 + 波动率目标仓位管理

核心思路（不是单一策略，而是元策略）:
1. 每只基金同时运行3个子策略，加权投票
2. 权重根据过去60天的滚动表现动态调整（赢家权重增大）
3. 恒定波动率目标: 高波动期自动减仓
4. Kelly准则仓位管理: 根据历史胜率计算最优下注比例
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy


class OptimalStrategy(Strategy):
    """元策略: 多信号加权融合 + 波动率目标 + 动态权重调整"""

    def __init__(self, params=None):
        default = {
            'target_vol': 18,           # 目标年化波动率%
            'vol_lookback': 20,         # 波动率计算窗口
            'weight_lookback': 60,      # 权重调整回看窗口
            'momentum_window': 10,      # 动量过滤窗口
            'momentum_threshold': -1.5, # 动量过滤阈值%
        }
        if params: default.update(params)
        super().__init__('最优融合策略', default)
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()
        # 跟踪子策略的累积收益（用于动态权重）
        self._sub_returns = {'v62': [], 'v73': [], 'mom': []}
        self._last_signals = {'v62': 0, 'v73': 0}

    def _momentum_signal(self, navs, i):
        """纯动量信号: 基于多周期动量的趋势跟踪"""
        if len(navs) < 60: return 0
        current = navs[-1]
        # 多周期动量
        mom5 = (current / navs[-5] - 1) * 100 if len(navs) >= 5 else 0
        mom10 = (current / navs[-10] - 1) * 100 if len(navs) >= 10 else 0
        mom20 = (current / navs[-20] - 1) * 100 if len(navs) >= 20 else 0
        mom60 = (current / navs[-60] - 1) * 100 if len(navs) >= 60 else 0

        # 加权动量复合
        weighted_mom = mom5 * 0.1 + mom10 * 0.2 + mom20 * 0.3 + mom60 * 0.4

        # 归一化到-1~+1
        signal = np.tanh(weighted_mom / 8)

        # RSI过滤
        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
        if rsi > 80 and signal > 0: signal *= 0.3  # 超买衰减
        if rsi < 20 and signal < 0: signal *= 0.3  # 超卖衰减

        return signal

    def _calc_vol_scalar(self, navs):
        """恒定波动率目标: 高波动减仓，低波动加仓"""
        p = self.params
        if len(navs) < p['vol_lookback'] + 1:
            return 1.0
        ret = np.diff(navs[-p['vol_lookback']-1:]) / navs[-p['vol_lookback']-1:-1]
        realized_vol = np.std(ret) * math.sqrt(250) * 100
        if realized_vol < 1: return 1.0
        scalar = p['target_vol'] / realized_vol
        return max(0.3, min(2.0, scalar))  # 限制在0.3x~2.0x

    def _update_weights(self, navs, i):
        """动态调整子策略权重: 近期表现好的权重增大"""
        p = self.params
        lookback = min(p['weight_lookback'], len(self._sub_returns['v62']))
        if lookback < 10:
            return {'v62': 0.4, 'v73': 0.3, 'mom': 0.3}

        # 计算每个子策略近60天的累积信号收益
        weights = {}
        for key in ['v62', 'v73', 'mom']:
            recent = self._sub_returns[key][-lookback:]
            if len(recent) == 0:
                weights[key] = 1.0
            else:
                # 累积收益作为权重（加1防负数）
                cum_ret = sum(recent)
                weights[key] = max(0.1, 1.0 + cum_ret * 10)

        # 归一化
        total = sum(weights.values())
        return {k: v / total for k, v in weights.items()}

    def generate_signal(self, df, i, market_df=None):
        if i < 60: return 0.0

        navs = df['nav'].values[:i+1]
        current = navs[-1]

        # 获取三个子策略信号
        s_v62 = self._v62.generate_signal(df, i, market_df)
        s_v73 = self._v73.generate_signal(df, i, market_df)
        s_mom = self._momentum_signal(navs, i)

        # 记录信号用于计算次日收益（评估子策略表现）
        if len(navs) >= 2:
            daily_ret = (navs[-1] / navs[-2] - 1) * 100
            self._sub_returns['v62'].append(self._last_signals['v62'] * daily_ret)
            self._sub_returns['v73'].append(self._last_signals['v73'] * daily_ret)
            self._sub_returns['mom'].append(s_mom * daily_ret)
        self._last_signals = {'v62': s_v62, 'v73': s_v73}

        # 动态权重
        weights = self._update_weights(navs, i)

        # 加权融合
        raw_signal = (
            s_v62 * weights['v62'] +
            s_v73 * weights['v73'] +
            s_mom * weights['mom']
        )

        # 动量过滤（sigmoid衰减，不是硬禁令）
        p = self.params
        if raw_signal > 0 and i >= p['momentum_window']:
            fund_mom = (navs[-1] / navs[-p['momentum_window']] - 1) * 100
            if fund_mom < p['momentum_threshold']:
                decay = max(0.15, 1 / (1 + math.exp(-0.8 * (abs(fund_mom) - 3))))
                raw_signal *= (1 - decay)

        # 恒定波动率目标: 高波动期缩小信号，低波动期放大信号
        vol_scalar = self._calc_vol_scalar(navs)
        raw_signal *= vol_scalar

        # 卖出取v62和v73中更强的（快止损原则）
        if raw_signal < 0:
            raw_signal = min(s_v62, s_v73, raw_signal)

        return max(-1, min(1, raw_signal))


class OptimalV2Strategy(Strategy):
    """最优解v2: 自适应板块选择 + 恒定波动率 + Kelly仓位"""

    def __init__(self, params=None):
        default = {
            'target_vol': 16,
            'vol_lookback': 20,
            'kelly_lookback': 60,   # Kelly计算回看窗口
            'kelly_fraction': 0.25, # Kelly比例（保守，用1/4 Kelly）
        }
        if params: default.update(params)
        super().__init__('最优v2(Kelly+波动率)', default)
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()
        self._trade_history = []  # 记录交易胜负

    def _kelly_fraction(self, navs, signal_history):
        """Kelly准则: 计算最优下注比例"""
        p = self.params
        if len(signal_history) < 20:
            return 1.0  # 数据不足时不调整

        recent = signal_history[-p['kelly_lookback']:]
        wins = sum(1 for r in recent if r > 0)
        losses = sum(1 for r in recent if r < 0)
        total = wins + losses
        if total < 10: return 1.0

        win_rate = wins / total
        avg_win = np.mean([r for r in recent if r > 0]) if wins > 0 else 0
        avg_loss = abs(np.mean([r for r in recent if r < 0])) if losses > 0 else 1

        if avg_loss == 0: return 1.0
        b = avg_win / avg_loss  # 盈亏比

        # Kelly公式: f = (bp - q) / b
        kelly = (b * win_rate - (1 - win_rate)) / b
        kelly = max(0, min(1, kelly))

        # 使用1/4 Kelly（保守）
        return kelly * p['kelly_fraction'] * 4  # 归一化到0~1

    def generate_signal(self, df, i, market_df=None):
        if i < 60: return 0.0

        navs = df['nav'].values[:i+1]

        # 检测基金特征决定主策略
        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        autocorr = np.corrcoef(ret20[:-1], ret20[1:])[0, 1] if len(ret20) > 10 else 0

        # 自适应选择: 高自相关(趋势性强)用v7.3，低自相关用v6.2
        if autocorr > 0.1:
            # 趋势型: v7.3主导
            primary = self._v73.generate_signal(df, i, market_df)
            secondary = self._v62.generate_signal(df, i, market_df)
            signal = primary * 0.7 + secondary * 0.3
        elif autocorr < -0.1:
            # 均值回归型: v6.2主导
            primary = self._v62.generate_signal(df, i, market_df)
            secondary = self._v73.generate_signal(df, i, market_df)
            signal = primary * 0.7 + secondary * 0.3
        else:
            # 不确定: 等权
            s62 = self._v62.generate_signal(df, i, market_df)
            s73 = self._v73.generate_signal(df, i, market_df)
            signal = (s62 + s73) / 2

        # 恒定波动率目标
        p = self.params
        if vol20 > 1:
            vol_scalar = max(0.3, min(2.0, p['target_vol'] / vol20))
            signal *= vol_scalar

        # Kelly仓位管理（仅影响买入大小）
        if signal > 0 and len(navs) >= 2:
            daily_ret = (navs[-1] / navs[-2] - 1)
            self._trade_history.append(daily_ret)
            kelly = self._kelly_fraction(navs, self._trade_history)
            signal *= kelly

        # 卖出取最快的
        if signal < -0.05:
            s62 = self._v62.generate_signal(df, i, market_df)
            if s62 < signal:
                signal = s62  # v6.2更想卖就用v6.2

        return max(-1, min(1, signal))
