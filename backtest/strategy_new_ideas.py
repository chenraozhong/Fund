#!/usr/bin/env python3
"""
三个全新思路（不在v6.2/v7.x框架上改参数）

思路1: 双模型投票 — v6.2+v7.3同意才买，任一说卖就卖
思路2: 动量守门员 — 基金自身20日回报>0才允许买入
思路3: 非对称嫁接 — v7.3的买入信号 + v6.2的卖出信号
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy


class VoteStrategy(Strategy):
    """思路1: 双模型投票 — 共识买入，任一卖出"""
    def __init__(self, params=None):
        super().__init__('双模型投票', params or {})
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()

    def generate_signal(self, df, i, market_df=None):
        s62 = self._v62.generate_signal(df, i, market_df)
        s73 = self._v73.generate_signal(df, i, market_df)

        # 买入: 双方都看多才买，取较小值（保守端）
        if s62 > 0.05 and s73 > 0.05:
            return min(s62, s73)

        # 卖出: 任一方看空就卖，取更强的卖出信号
        if s62 < -0.05 or s73 < -0.05:
            return min(s62, s73)  # 更负 = 更强卖出

        return 0.0


class MomentumGateStrategy(Strategy):
    """思路2: 动量守门员 — 20日回报>0才允许买入，否则v6.2正常逻辑"""
    def __init__(self, params=None):
        default = {'mom_window': 20, 'mom_threshold': 0.0}
        if params: default.update(params)
        super().__init__('动量守门员', default)
        self._v62 = LocalV62Strategy()

    def generate_signal(self, df, i, market_df=None):
        signal = self._v62.generate_signal(df, i, market_df)

        if signal > 0.05 and i >= self.params['mom_window']:
            navs = df['nav'].values[:i+1]
            mom = (navs[-1] / navs[-self.params['mom_window']] - 1) * 100
            if mom <= self.params['mom_threshold']:
                return 0.0  # 动量为负，禁止买入

        return signal


class AsymmetricStrategy(Strategy):
    """思路3: 非对称嫁接 — v7.3买入 + v6.2卖出"""
    def __init__(self, params=None):
        super().__init__('非对称(v7.3买+v6.2卖)', params or {})
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()

    def generate_signal(self, df, i, market_df=None):
        s62 = self._v62.generate_signal(df, i, market_df)
        s73 = self._v73.generate_signal(df, i, market_df)

        # 买入用v7.3（趋势捕捉更好）
        if s73 > 0.05:
            return s73

        # 卖出用v6.2（止损更快）
        if s62 < -0.05:
            return s62

        # 都不明确时，取平均
        avg = (s62 + s73) / 2
        if abs(avg) > 0.05:
            return avg

        return 0.0


class MomGateSensitive(Strategy):
    """动量守门员(敏感版): 10日动量+大盘动量双重过滤"""
    def __init__(self, params=None):
        default = {'mom_window': 10, 'mom_threshold': -1.0, 'mkt_mom_window': 10, 'mkt_mom_threshold': -2.0}
        if params: default.update(params)
        super().__init__('动量守门员(敏感)', default)
        self._v62 = LocalV62Strategy()

    def generate_signal(self, df, i, market_df=None):
        signal = self._v62.generate_signal(df, i, market_df)

        if signal > 0.05:
            navs = df['nav'].values[:i+1]
            p = self.params

            # 基金自身动量检查
            if i >= p['mom_window']:
                fund_mom = (navs[-1] / navs[-p['mom_window']] - 1) * 100
                if fund_mom < p['mom_threshold']:
                    return 0.0

            # 大盘动量检查
            if market_df is not None and 'close' in market_df.columns and i >= p['mkt_mom_window'] and i < len(market_df):
                mkt_closes = market_df['close'].values
                mkt_mom = (mkt_closes[i] / mkt_closes[i - p['mkt_mom_window']] - 1) * 100
                if mkt_mom < p['mkt_mom_threshold']:
                    signal *= 0.3  # 大盘动量差时大幅缩减（不完全禁止）

        return signal


class VotePlusMom(Strategy):
    """组合: 双模型投票 + 动量过滤"""
    def __init__(self, params=None):
        default = {'mom_window': 15, 'mom_threshold': -0.5}
        if params: default.update(params)
        super().__init__('投票+动量', default)
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()

    def generate_signal(self, df, i, market_df=None):
        s62 = self._v62.generate_signal(df, i, market_df)
        s73 = self._v73.generate_signal(df, i, market_df)

        # 卖出: 任一方说卖
        if s62 < -0.05 or s73 < -0.05:
            return min(s62, s73)

        # 买入: 双方同意 + 动量过滤
        if s62 > 0.05 and s73 > 0.05:
            navs = df['nav'].values[:i+1]
            p = self.params
            if i >= p['mom_window']:
                mom = (navs[-1] / navs[-p['mom_window']] - 1) * 100
                if mom < p['mom_threshold']:
                    return 0.0
            return min(s62, s73)

        return 0.0
