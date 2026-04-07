#!/usr/bin/env python3
"""
自动选择策略 — 根据基金名称匹配最优策略（对齐线上autoSelectModel）

回测验证结果:
- 黄金 → v8.0非对称（卡尔玛8.0+）
- 债券 → v6.2（差异极小，简单即可）
- 半导体/AI/科技/新能源 → v7.3（卡尔玛2.40最高）
- 其他 → v6.2（全品种稳健）
"""
import re
from backtest_engine import Strategy
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy
from strategy_new_ideas import AsymmetricStrategy


class AutoSelectStrategy(Strategy):
    """根据基金名称自动选择最优子策略"""
    def __init__(self, fund_name='', params=None):
        self._fund_name = fund_name
        self._sub = self._select_strategy(fund_name)
        super().__init__(f'自动({self._sub.name[:8]})', params or {})

    def _select_strategy(self, name):
        if re.search(r'黄金|gold', name, re.IGNORECASE):
            s = AsymmetricStrategy()
            s.name = 'v8.0黄金'
            return s
        if re.search(r'债券|短债|纯债|固收', name, re.IGNORECASE):
            return LocalV62Strategy()
        if re.search(r'半导体|芯片|AI|人工智能|机器人|算力|云计算|卫星|通信|科技|新能源|光伏|碳中和|清洁|低碳', name, re.IGNORECASE):
            return LocalV73Strategy()
        return LocalV62Strategy()

    def set_fund_name(self, name):
        self._fund_name = name
        self._sub = self._select_strategy(name)
        self.name = f'自动({self._sub.name[:8]})'

    def generate_signal(self, df, i, market_df=None):
        return self._sub.generate_signal(df, i, market_df)
