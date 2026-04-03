#!/usr/bin/env python3
"""
双动量策略 (Gary Antonacci's Dual Momentum)
=============================================
基于 Gary Antonacci 的双动量理论，为中国公募基金回测设计。

核心逻辑：
  1. 绝对动量 (Absolute Momentum)：基金自身收益 vs 无风险利率
  2. 相对动量 (Relative Momentum)：基金动量 vs 市场基准动量
  3. 综合信号：双正→强买，单正→中性买，绝对负→减仓/卖出
  4. 多周期加权动量评分
  5. 高波动率市场环境下信号衰减

参考文献：
  Antonacci, G. (2014). Dual Momentum Investing: An Innovative Strategy
  for Higher Returns with Lower Risk.
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional

# 从回测引擎导入策略基类
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from backtest_engine import Strategy


class DualMomentumStrategy(Strategy):
    """
    双动量策略 (Dual Momentum Strategy)

    Gary Antonacci 的双动量框架，结合绝对动量与相对动量两个维度：

    - 绝对动量：判断基金本身是否值得持有（vs 无风险利率）
    - 相对动量：判断基金是否优于大盘（vs 市场指数）

    只有两个维度同时为正，才发出强买信号；
    绝对动量转负时，无论相对表现如何，都执行防御性减仓。
    """

    def __init__(self, params: Optional[Dict] = None):
        # ── 默认参数 ──────────────────────────────────────────
        default = {
            # 多周期回望窗口（交易日）
            'lookback_short': 20,   # 约 1 个月
            'lookback_mid':   60,   # 约 3 个月
            'lookback_long':  120,  # 约 6 个月

            # 各周期权重（合计必须为 1.0）
            'weight_short': 0.3,
            'weight_mid':   0.4,
            'weight_long':  0.3,

            # 无风险年化收益率（参考银行活期/货币基金）
            'rf_annual': 0.02,

            # 波动率过滤（年化波动率 %）
            'vol_threshold': 30.0,  # 超过此阈值认为高波动市场
            'vol_dampen':    0.4,   # 高波动时信号衰减比例

            # 信号触发阈值（允许轻微误差）
            'abs_threshold': 0.0,   # 绝对动量最低要求（超过无风险利率的额外收益）
            'rel_threshold': 0.0,   # 相对动量最低要求（超出市场的额外收益）
        }
        if params:
            default.update(params)
        super().__init__('双动量策略(Dual Momentum)', default)

    # ────────────────────────────────────────────────────────────
    # 核心信号生成接口
    # ────────────────────────────────────────────────────────────

    def generate_signal(
        self,
        df: pd.DataFrame,
        i: int,
        market_df: Optional[pd.DataFrame] = None,
    ) -> float:
        """
        生成双动量交易信号。

        参数：
            df        : 基金历史数据，含 date / nav / change_pct / daily_return
            i         : 当前时间步索引
            market_df : 市场基准历史数据（同结构），可为 None

        返回：
            float，范围 [-1, +1]
              +1  强买
              +0.8 双动量均正的次级强买
              +0.3 仅绝对动量为正
               0  中性
              -0.5 仅绝对动量为负（温和防御）
              -1  绝对动量深度为负（强势防御）
        """
        p = self.params

        # ── 数据不足时返回中性信号 ──────────────────────────
        min_required = p['lookback_short'] + 1
        if i < min_required:
            return 0.0

        # ── 截取当前可用的历史切片 ──────────────────────────
        slice_df = df.iloc[: i + 1]

        # ── 1. 计算多周期加权动量评分 ───────────────────────
        fund_momentum = self._weighted_momentum(slice_df['nav'])

        # ── 2. 绝对动量：基金动量 vs 无风险利率（日化）───────
        rf_daily = self._annual_to_period_return(p['rf_annual'], 1)
        # 将无风险利率折算成与动量评分同等量纲的比较基准
        # 取 lookback_mid 天对应的无风险累积收益作为基准线
        rf_benchmark = self._annual_to_period_return(
            p['rf_annual'], p['lookback_mid']
        )
        # 绝对动量超额收益（基金动量 - 无风险基准）
        abs_excess = fund_momentum - rf_benchmark

        # ── 3. 相对动量：基金动量 vs 市场基准动量 ────────────
        has_market = (
            market_df is not None
            and len(market_df) > 0
            and i < len(market_df)
        )
        if has_market:
            market_slice = market_df.iloc[: i + 1]
            # 市场基准列：优先 nav，否则用 close
            if 'nav' in market_slice.columns:
                mkt_series = market_slice['nav']
            elif 'close' in market_slice.columns:
                mkt_series = market_slice['close']
            else:
                mkt_series = None

            if mkt_series is not None and len(mkt_series) >= min_required:
                market_momentum = self._weighted_momentum(mkt_series)
                rel_excess = fund_momentum - market_momentum
            else:
                # 市场数据不足，仅用绝对动量
                rel_excess = None
        else:
            rel_excess = None

        # ── 4. 波动率过滤 ─────────────────────────────────────
        vol_annualized = self._annualized_vol(slice_df['daily_return'])
        is_high_vol = vol_annualized > p['vol_threshold']

        # ── 5. 合成最终信号 ───────────────────────────────────
        signal = self._combine_signals(
            abs_excess=abs_excess,
            rel_excess=rel_excess,
            is_high_vol=is_high_vol,
        )

        return float(np.clip(signal, -1.0, 1.0))

    # ────────────────────────────────────────────────────────────
    # 内部计算方法
    # ────────────────────────────────────────────────────────────

    def _weighted_momentum(self, nav_series: pd.Series) -> float:
        """
        多周期加权动量评分。

        分别计算短期(1个月)、中期(3个月)、长期(6个月)的价格动量，
        再按权重加权平均，得到综合动量分数（以收益率形式表示）。

        Antonacci 原版使用 12 个月单周期动量，但对中国基金而言
        多周期加权更能平滑噪声、捕捉更稳定的趋势。
        """
        p = self.params
        n = len(nav_series)

        periods = [
            (p['lookback_short'], p['weight_short']),
            (p['lookback_mid'],   p['weight_mid']),
            (p['lookback_long'],  p['weight_long']),
        ]

        weighted_score = 0.0
        total_weight = 0.0

        for lookback, weight in periods:
            if n > lookback:
                current_nav = nav_series.iloc[-1]
                past_nav    = nav_series.iloc[-(lookback + 1)]
                if past_nav > 0:
                    # 该周期的价格动量（累积收益率）
                    period_return = (current_nav / past_nav) - 1.0
                    weighted_score += period_return * weight
                    total_weight   += weight

        if total_weight == 0:
            return 0.0

        # 归一化：确保即使部分周期数据不足时权重仍有效
        return weighted_score / total_weight

    def _annual_to_period_return(self, annual_rate: float, days: int) -> float:
        """
        将年化收益率折算为指定天数的累积收益率。

        公式：(1 + r_annual)^(days/250) - 1
        使用 250 个交易日作为一年的基准。
        """
        return (1 + annual_rate) ** (days / 250.0) - 1.0

    def _annualized_vol(self, daily_return: pd.Series, window: int = 20) -> float:
        """
        计算年化波动率（%）。

        取最近 window 天的日收益率标准差，乘以 sqrt(250) 年化，
        结果以百分比表示（如 25.0 代表 25%）。
        """
        if len(daily_return) < 5:
            return 0.0
        recent = daily_return.dropna().iloc[-window:]
        if len(recent) < 3:
            return 0.0
        vol_daily = recent.std()
        vol_annual_pct = vol_daily * math.sqrt(250) * 100.0
        return vol_annual_pct

    def _combine_signals(
        self,
        abs_excess: float,
        rel_excess: Optional[float],
        is_high_vol: bool,
    ) -> float:
        """
        综合绝对动量与相对动量，输出最终交易信号。

        决策矩阵：
        ┌──────────────┬──────────────┬──────────────────────┐
        │ 绝对动量      │ 相对动量      │ 信号                  │
        ├──────────────┼──────────────┼──────────────────────┤
        │ 正            │ 正（基金>市场）│ 强买 +0.8 ~ +1.0     │
        │ 正            │ 负（基金<市场）│ 温和买入 +0.3         │
        │ 正            │ 不可用        │ 温和买入 +0.4         │
        │ 负（浅）       │ 任意          │ 减仓 -0.5             │
        │ 负（深）       │ 任意          │ 强势防御 -0.8 ~ -1.0  │
        └──────────────┴──────────────┴──────────────────────┘

        高波动率环境下，所有信号乘以 (1 - vol_dampen) 进行衰减。
        """
        p = self.params
        abs_thr = p['abs_threshold']
        rel_thr = p['rel_threshold']

        abs_positive = abs_excess > abs_thr

        if abs_positive:
            # ── 绝对动量为正：基金值得持有 ──────────────────
            if rel_excess is None:
                # 无市场基准数据：仅靠绝对动量给出保守买入信号
                signal = 0.4
            elif rel_excess > rel_thr:
                # 相对动量亦正：基金跑赢市场，双动量共振→强买
                # 根据相对超额幅度调整强度，最高 +1.0
                rel_strength = min(rel_excess / 0.05, 1.0)  # 以5%相对超额为满格
                signal = 0.8 + 0.2 * rel_strength
            else:
                # 相对动量为负：基金跑输市场，降低仓位
                signal = 0.3
        else:
            # ── 绝对动量为负：基金跑输无风险利率 → 防御 ────
            # 根据负值深度区分温和减仓与强势清仓
            # abs_excess < 0，越负越深，信号越强烈（越负）
            depth = abs(abs_excess)
            if depth < 0.02:
                # 浅度负向（略低于无风险利率）：温和减仓
                signal = -0.5
            elif depth < 0.05:
                # 中度负向：较强减仓
                signal = -0.7
            else:
                # 深度负向（动量显著为负）：强势清仓
                depth_strength = min(depth / 0.10, 1.0)  # 以10%亏损为满格
                signal = -(0.8 + 0.2 * depth_strength)

        # ── 高波动率衰减（不改变方向，只降低幅度）────────────
        # 在极端市场环境中减少频繁交易，避免追涨杀跌
        if is_high_vol:
            dampen = 1.0 - p['vol_dampen']
            signal *= dampen

        return signal

    def describe(self) -> str:
        """返回策略描述字符串，用于日志输出。"""
        p = self.params
        return (
            f"{self.name} | "
            f"回望窗口: {p['lookback_short']}/{p['lookback_mid']}/{p['lookback_long']}日 | "
            f"权重: {p['weight_short']:.0%}/{p['weight_mid']:.0%}/{p['weight_long']:.0%} | "
            f"无风险利率: {p['rf_annual']:.1%} | "
            f"波动率阈值: {p['vol_threshold']}% (衰减{p['vol_dampen']:.0%})"
        )


# ============================================================
# 快速验证（直接运行此文件时执行）
# ============================================================

if __name__ == '__main__':
    print("=== 双动量策略 (Dual Momentum) 快速验证 ===\n")

    # 构造模拟基金净值数据（200天，含上涨趋势）
    np.random.seed(42)
    n = 200
    nav_returns = np.random.normal(0.0008, 0.012, n)  # 日均+0.08%，波动1.2%
    nav_values  = 1.0 * np.cumprod(1 + nav_returns)

    fund_df = pd.DataFrame({
        'date':         pd.date_range('2024-01-01', periods=n, freq='B'),
        'nav':          nav_values,
        'change_pct':   nav_returns * 100,
        'daily_return': nav_returns,
    })

    # 构造模拟市场基准（涨幅略低于基金）
    mkt_returns = np.random.normal(0.0004, 0.015, n)
    mkt_values  = 1.0 * np.cumprod(1 + mkt_returns)
    market_df = pd.DataFrame({
        'date':         pd.date_range('2024-01-01', periods=n, freq='B'),
        'nav':          mkt_values,
        'change_pct':   mkt_returns * 100,
        'daily_return': mkt_returns,
    })

    strategy = DualMomentumStrategy()
    print(strategy.describe())
    print()

    # 打印最后 5 天的信号
    print("最近 5 个交易日信号：")
    print(f"{'日期':<12} {'基金净值':>8} {'信号':>8}")
    print("-" * 32)
    for idx in range(n - 5, n):
        sig = strategy.generate_signal(fund_df, idx, market_df)
        date_str = str(fund_df.iloc[idx]['date'].date())
        nav_val  = fund_df.iloc[idx]['nav']
        print(f"{date_str:<12} {nav_val:>8.4f} {sig:>+8.4f}")

    print("\n✓ 策略类加载并运行正常。")
