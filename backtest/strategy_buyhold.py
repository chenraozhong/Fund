#!/usr/bin/env python3
"""买入持有策略 — 第一天全仓买入，之后不再交易"""
from backtest_engine import Strategy

class BuyHoldStrategy(Strategy):
    def __init__(self):
        super().__init__('买入持有(不交易)', {})
        self._bought = False

    def generate_signal(self, df, i, market_df=None):
        if i == 30 and not self._bought:
            self._bought = True
            return 1.0  # 全仓买入信号
        return 0.0  # 之后不再交易
