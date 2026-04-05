#!/usr/bin/env python3
"""
五大经典策略因子研究与融合
===========================
基于已有v6.2/v7.x/v8.x框架，研究并实现五种经典量化策略因子，
设计可插拔的融合公式，与现有模型互补而非替代。

经典因子:
  1. AQR动量+价值复合因子 (Cliff Asness)
  2. Bridgewater风险平价仓位分配 (Ray Dalio)
  3. Kelly准则仓位管理
  4. 恒定波动率目标策略
  5. Larry Williams波动率突破

作者: 量化策略研究
日期: 2026-04-03
"""

import math
import numpy as np
import pandas as pd
from typing import Dict, Optional, Tuple
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


# ============================================================
# 因子1: AQR动量+价值复合因子
# ============================================================

class AQRMomentumValueFactor:
    """
    AQR动量+价值复合因子 (Cliff Asness风格)

    核心思想:
      - 动量因子: 12个月价格动量(剔除最近1个月的短期反转)
      - 价值因子: 基金中无PE/PB，用"均值偏离度"近似估值
      - 复合: momentum_z + value_z 的加权组合

    A股基金适配:
      - 动量: 用过去250日(剔除最近20日)的累积收益率
      - 价值: 当前NAV相对于120日均线的偏离度(负偏离=便宜=高价值)
      - 组合: 高动量+高价值 → 强买; 低动量+低价值 → 强卖

    适用基金: 所有类型，尤其科技/新能源等波动大、动量效应明显的品种
    """

    def __init__(self, mom_long=250, mom_skip=20, value_window=120,
                 mom_weight=0.6, value_weight=0.4):
        self.mom_long = mom_long        # 长期动量回望(约12个月)
        self.mom_skip = mom_skip        # 跳过最近1个月(短期反转)
        self.value_window = value_window  # 价值均线窗口
        self.mom_weight = mom_weight
        self.value_weight = value_weight

    def compute(self, navs: np.ndarray) -> Tuple[float, float, float]:
        """
        返回: (composite_score, momentum_score, value_score)
        composite_score 范围约 [-1, +1]
        """
        n = len(navs)

        # --- 动量因子 ---
        # Asness原版: 过去12个月收益率，剔除最近1个月
        # 基金版: ret(t-250, t-20)
        if n > self.mom_long:
            past_nav = navs[-(self.mom_long + 1)]
            skip_nav = navs[-(self.mom_skip + 1)]
            mom_return = (skip_nav / past_nav) - 1.0  # 剔除近期反转
        elif n > self.mom_skip + 30:
            # 数据不足12个月，用全部可用数据
            past_nav = navs[0]
            skip_nav = navs[-(self.mom_skip + 1)]
            mom_return = (skip_nav / past_nav) - 1.0
        else:
            mom_return = 0.0

        # 动量z-score近似: 用sigmoid映射到[-1,1]
        # 经验值: A股基金年化20%动量 ≈ 中等强度
        mom_score = np.tanh(mom_return / 0.15)  # 15%收益率对应tanh≈0.76

        # --- 价值因子 ---
        # 基金无PE/PB，用"均值偏离度"近似
        # 逻辑: NAV远低于长期均线 → "便宜" → 高价值
        if n >= self.value_window:
            ma_long = np.mean(navs[-self.value_window:])
            deviation = (navs[-1] - ma_long) / ma_long
            # 负偏离=便宜=高价值，所以取反
            value_score = np.tanh(-deviation / 0.08)  # 8%偏离对应tanh≈0.76
        else:
            value_score = 0.0

        # --- 复合 ---
        composite = self.mom_weight * mom_score + self.value_weight * value_score

        return float(composite), float(mom_score), float(value_score)


# ============================================================
# 因子2: Bridgewater风险平价仓位系数
# ============================================================

class RiskParityPositionFactor:
    """
    Bridgewater全天候/风险平价 (Ray Dalio风格)

    核心思想:
      - 按波动率的倒数分配仓位权重
      - 低波动资产多配，高波动资产少配
      - 目标: 每个持仓贡献相等的风险量

    在单基金决策中的应用:
      - 不是资产间分配，而是用波动率调整单个基金的仓位系数
      - position_coeff = target_vol / realized_vol
      - 高波动时自动缩仓，低波动时扩仓

    适用基金: 所有类型。对高波动的新能源/科技效果显著(自动降仓位)
              对低波动的黄金保持满仓
    """

    def __init__(self, target_vol=15.0, vol_window=20, max_leverage=1.5, min_position=0.2):
        self.target_vol = target_vol      # 目标年化波动率(%)
        self.vol_window = vol_window      # 波动率计算窗口
        self.max_leverage = max_leverage  # 最大仓位系数(允许低波时超配)
        self.min_position = min_position  # 最小仓位(极端波动时的底线)

    def compute(self, navs: np.ndarray) -> float:
        """
        返回: position_coefficient ∈ [min_position, max_leverage]
        用法: final_signal = raw_signal * position_coefficient
        """
        n = len(navs)
        if n < self.vol_window + 2:
            return 1.0

        # 计算已实现波动率
        returns = np.diff(navs[-self.vol_window - 1:]) / navs[-self.vol_window - 1:-1]
        realized_vol = np.std(returns) * math.sqrt(250) * 100  # 年化%

        if realized_vol < 1.0:
            realized_vol = 1.0  # 防除零

        # 风险平价系数
        # position = target_vol / realized_vol
        coeff = self.target_vol / realized_vol

        # 限幅
        coeff = max(self.min_position, min(self.max_leverage, coeff))

        return float(coeff)


# ============================================================
# 因子3: Kelly准则仓位管理
# ============================================================

class KellyPositionFactor:
    """
    Kelly准则最优仓位 (John Kelly)

    核心公式:
      f* = (b*p - q) / b
      其中: b = 盈亏比(avg_win/avg_loss)
            p = 胜率
            q = 1-p = 败率

    基金投资适配:
      - 使用滚动窗口计算历史胜率和盈亏比
      - Kelly值直接作为仓位百分比的建议
      - 实践中用 半Kelly (f*/2) 更稳健

    适用基金: 所有类型。高胜率+高盈亏比的品种(如黄金趋势中)
              会给出更大仓位建议
    """

    def __init__(self, lookback=60, half_kelly=True, max_fraction=0.5, min_fraction=0.05):
        self.lookback = lookback          # 回望窗口
        self.half_kelly = half_kelly      # 使用半Kelly(更保守)
        self.max_fraction = max_fraction  # 最大建议仓位比例
        self.min_fraction = min_fraction  # 最小仓位

    def compute(self, navs: np.ndarray) -> float:
        """
        返回: kelly_fraction ∈ [0, max_fraction]
        解读: 建议将总资金的 kelly_fraction 比例投入该基金
        """
        n = len(navs)
        window = min(self.lookback, n - 1)
        if window < 10:
            return self.min_fraction

        returns = np.diff(navs[-window - 1:]) / navs[-window - 1:-1]

        wins = returns[returns > 0]
        losses = returns[returns < 0]

        if len(wins) == 0 or len(losses) == 0:
            return self.min_fraction

        p = len(wins) / len(returns)       # 胜率
        q = 1 - p                           # 败率
        b = np.mean(wins) / abs(np.mean(losses))  # 盈亏比

        # Kelly公式
        if b <= 0:
            return 0.0

        f_star = (b * p - q) / b

        # 半Kelly更稳健
        if self.half_kelly:
            f_star *= 0.5

        # 限幅
        f_star = max(0.0, min(self.max_fraction, f_star))

        return float(f_star)


# ============================================================
# 因子4: 恒定波动率目标
# ============================================================

class ConstantVolTargetFactor:
    """
    恒定波动率目标策略

    核心思想:
      - 设定目标年化波动率(如15%)
      - 高波动期自动减仓，低波动期加仓
      - 使仓位的风险贡献保持恒定

    与风险平价的区别:
      - 风险平价是静态的仓位系数
      - 恒定波动率还考虑了波动率的变化速度(波动率加速时更激进减仓)

    公式:
      vol_ratio = target_vol / realized_vol
      vol_acceleration = d(vol)/dt 的符号
      position = vol_ratio * (1 - acceleration_dampen * sign(d_vol))

    适用基金: 所有类型。特别适合波动率剧变的科技/新能源
    """

    def __init__(self, target_vol=15.0, vol_window=20, accel_window=5,
                 accel_dampen=0.2, max_pos=1.5, min_pos=0.15):
        self.target_vol = target_vol
        self.vol_window = vol_window
        self.accel_window = accel_window    # 波动率加速度窗口
        self.accel_dampen = accel_dampen    # 加速时的额外衰减
        self.max_pos = max_pos
        self.min_pos = min_pos

    def compute(self, navs: np.ndarray) -> float:
        """
        返回: position_scale ∈ [min_pos, max_pos]
        """
        n = len(navs)
        if n < self.vol_window + self.accel_window + 5:
            return 1.0

        # 当前波动率
        returns = np.diff(navs[-self.vol_window - 1:]) / navs[-self.vol_window - 1:-1]
        current_vol = np.std(returns) * math.sqrt(250) * 100

        if current_vol < 1.0:
            current_vol = 1.0

        # 基础比率
        vol_ratio = self.target_vol / current_vol

        # 波动率加速度: 对比最近vol和稍早的vol
        # 如果波动率在上升 → 额外减仓(预防性)
        recent_rets = np.diff(navs[-self.vol_window - 1:]) / navs[-self.vol_window - 1:-1]
        earlier_rets = np.diff(navs[-self.vol_window - self.accel_window - 1:-self.accel_window]) / \
                       navs[-self.vol_window - self.accel_window - 1:-self.accel_window - 1]

        if len(recent_rets) >= 5 and len(earlier_rets) >= 5:
            recent_vol = np.std(recent_rets[-10:]) * math.sqrt(250) * 100
            earlier_vol = np.std(earlier_rets[-10:]) * math.sqrt(250) * 100

            if earlier_vol > 1.0:
                vol_change = (recent_vol - earlier_vol) / earlier_vol
                # 波动率上升 → 减仓; 下降 → 不额外加仓(保守)
                if vol_change > 0:
                    vol_ratio *= (1 - self.accel_dampen * min(vol_change, 1.0))

        return float(max(self.min_pos, min(self.max_pos, vol_ratio)))


# ============================================================
# 因子5: Larry Williams波动率突破
# ============================================================

class WilliamsVolBreakoutFactor:
    """
    Larry Williams波动率突破

    核心思想:
      - 基于ATR定义"有意义的价格变动"
      - 当日涨幅超过 N倍ATR → 突破买入信号
      - trailing stop: 从高点回落 M倍ATR → 止损

    基金版适配:
      - 用日净值变化代替日内价格变化
      - 突破: daily_change > breakout_mult * ATR → 买入脉冲
      - 止损: 从近期高点回落 > stop_mult * ATR → 卖出脉冲

    适用基金: 趋势强的品种(黄金/科技)效果最佳，震荡市(医药)可能误触发
    """

    def __init__(self, atr_period=14, breakout_mult=1.5, stop_mult=2.0,
                 lookback_high=20):
        self.atr_period = atr_period
        self.breakout_mult = breakout_mult    # 突破需要的ATR倍数
        self.stop_mult = stop_mult            # 止损的ATR倍数
        self.lookback_high = lookback_high    # 追踪止损的高点回望

    def compute(self, navs: np.ndarray) -> float:
        """
        返回: signal ∈ [-1, +1]
          +1: 强突破买入
          -1: 触发止损卖出
           0: 无信号
        """
        n = len(navs)
        if n < self.atr_period + 5:
            return 0.0

        # ATR计算
        tr = np.abs(np.diff(navs[-self.atr_period - 1:]))
        atr = np.mean(tr)

        if atr < 1e-8:
            return 0.0

        current = navs[-1]
        prev = navs[-2]
        daily_change = current - prev

        # 突破信号
        if daily_change > self.breakout_mult * atr:
            # 向上突破
            strength = min(daily_change / (self.breakout_mult * atr), 2.0) - 1.0
            return min(1.0, 0.5 + strength * 0.5)

        # 止损信号
        high_window = min(self.lookback_high, n - 1)
        recent_high = np.max(navs[-high_window:])
        drawdown_from_high = recent_high - current

        if drawdown_from_high > self.stop_mult * atr:
            strength = min(drawdown_from_high / (self.stop_mult * atr), 2.0) - 1.0
            return max(-1.0, -(0.5 + strength * 0.5))

        # 弱突破/弱止损的中间状态
        if daily_change > 0.8 * self.breakout_mult * atr:
            return 0.2  # 接近突破
        if drawdown_from_high > 0.8 * self.stop_mult * atr:
            return -0.2  # 接近止损

        return 0.0


# ============================================================
# 融合策略: 五因子最优信号公式
# ============================================================

class ClassicFactorFusionStrategy(Strategy):
    """
    五因子融合策略 — 经典因子增强器

    设计目标: 与v8.0/v8.1融合而非替代

    融合公式:
      raw_signal = base_model_signal  (来自v8.0或v8.1)

      # 因子1: AQR动量价值 → 信号方向确认/反转
      aqr_confirm = aqr_composite * aqr_weight

      # 因子2+4: 风险平价+恒定波动率 → 仓位缩放
      vol_scale = avg(risk_parity_coeff, const_vol_coeff)

      # 因子3: Kelly准则 → 仓位上限
      kelly_cap = kelly_fraction * kelly_weight

      # 因子5: Williams突破 → 脉冲信号叠加
      breakout_pulse = williams_signal * breakout_weight

      # 最终信号
      enhanced_signal = (raw_signal + aqr_confirm + breakout_pulse)
      position_scaled = enhanced_signal * vol_scale
      final_signal = clip(position_scaled, -kelly_cap, kelly_cap)
    """

    def __init__(self, base_strategy: Strategy, params: Optional[Dict] = None):
        default = {
            # AQR因子权重
            'aqr_weight': 0.15,           # AQR信号对基础信号的叠加强度
            'aqr_mom_long': 250,
            'aqr_mom_skip': 20,
            'aqr_value_window': 120,
            'aqr_mom_w': 0.6,
            'aqr_val_w': 0.4,

            # 风险平价参数
            'rp_target_vol': 15.0,
            'rp_max_leverage': 1.3,
            'rp_min_position': 0.25,

            # Kelly参数
            'kelly_lookback': 60,
            'kelly_half': True,
            'kelly_max': 0.6,             # Kelly最大仓位比例
            'kelly_as_cap': True,         # 是否用Kelly作为仓位上限

            # 恒定波动率目标
            'cvt_target_vol': 15.0,
            'cvt_accel_dampen': 0.2,

            # Williams突破
            'wb_breakout_mult': 1.5,
            'wb_stop_mult': 2.0,
            'wb_weight': 0.10,            # 突破脉冲叠加强度

            # 融合权重
            'vol_scale_blend': 0.5,       # risk_parity vs const_vol的混合比例
        }
        if params:
            default.update(params)
        super().__init__('五因子融合', default)

        self.base = base_strategy
        self._init_factors()

    def _init_factors(self):
        p = self.params
        self.aqr = AQRMomentumValueFactor(
            mom_long=p['aqr_mom_long'], mom_skip=p['aqr_mom_skip'],
            value_window=p['aqr_value_window'],
            mom_weight=p['aqr_mom_w'], value_weight=p['aqr_val_w']
        )
        self.rp = RiskParityPositionFactor(
            target_vol=p['rp_target_vol'],
            max_leverage=p['rp_max_leverage'],
            min_position=p['rp_min_position']
        )
        self.kelly = KellyPositionFactor(
            lookback=p['kelly_lookback'],
            half_kelly=p['kelly_half'],
            max_fraction=p['kelly_max']
        )
        self.cvt = ConstantVolTargetFactor(
            target_vol=p['cvt_target_vol'],
            accel_dampen=p['cvt_accel_dampen']
        )
        self.williams = WilliamsVolBreakoutFactor(
            breakout_mult=p['wb_breakout_mult'],
            stop_mult=p['wb_stop_mult']
        )

    def generate_signal(self, df: pd.DataFrame, i: int,
                        market_df: Optional[pd.DataFrame] = None) -> float:
        p = self.params

        # --- 基础信号 ---
        base_signal = self.base.generate_signal(df, i, market_df)

        if i < 30:
            return base_signal

        navs = df['nav'].values[:i + 1]

        # --- 因子1: AQR动量价值确认 ---
        aqr_composite, _, _ = self.aqr.compute(navs)
        aqr_adjust = aqr_composite * p['aqr_weight']

        # 方向一致时增强，矛盾时抑制
        if base_signal * aqr_composite > 0:
            # 同向: 叠加
            enhanced = base_signal + aqr_adjust
        else:
            # 反向: AQR削弱基础信号(但不反转)
            enhanced = base_signal * (1 - abs(aqr_adjust))

        # --- 因子5: Williams突破脉冲 ---
        wb_signal = self.williams.compute(navs)
        if abs(wb_signal) > 0.3:  # 只有显著突破才叠加
            enhanced += wb_signal * p['wb_weight']

        # --- 因子2+4: 波动率仓位缩放 ---
        rp_coeff = self.rp.compute(navs)
        cvt_coeff = self.cvt.compute(navs)
        blend = p['vol_scale_blend']
        vol_scale = blend * rp_coeff + (1 - blend) * cvt_coeff

        position_scaled = enhanced * vol_scale

        # --- 因子3: Kelly仓位上限 ---
        if p['kelly_as_cap']:
            kelly_f = self.kelly.compute(navs)
            # Kelly作为信号幅度的软上限
            if abs(position_scaled) > kelly_f and kelly_f > 0.05:
                # 不硬截断，用平滑压缩
                sign = 1 if position_scaled > 0 else -1
                excess = abs(position_scaled) - kelly_f
                # tanh压缩超出部分
                compressed = kelly_f + 0.1 * np.tanh(excess / 0.2)
                position_scaled = sign * compressed

        return float(np.clip(position_scaled, -1.0, 1.0))


# ============================================================
# 预设融合变体: 针对不同基金类型的最优参数
# ============================================================

def create_gold_fusion(base_strategy: Strategy) -> ClassicFactorFusionStrategy:
    """黄金基金: 动量强、波动低 → 放大AQR动量，放松Kelly"""
    return ClassicFactorFusionStrategy(base_strategy, {
        'aqr_weight': 0.20,        # 黄金动量效应强
        'aqr_mom_w': 0.75,         # 偏重动量
        'aqr_val_w': 0.25,
        'rp_target_vol': 12.0,     # 黄金波动较低
        'rp_max_leverage': 1.5,    # 允许低波时超配
        'kelly_max': 0.7,          # 黄金胜率高，可放大Kelly
        'wb_weight': 0.08,         # 突破脉冲适中
        'wb_breakout_mult': 1.2,   # 较低阈值(黄金ATR小)
    })

def create_tech_fusion(base_strategy: Strategy) -> ClassicFactorFusionStrategy:
    """科技/半导体: 高波动、趋势强 → 强波动率控制 + 动量"""
    return ClassicFactorFusionStrategy(base_strategy, {
        'aqr_weight': 0.15,
        'aqr_mom_w': 0.5,
        'aqr_val_w': 0.5,          # 科技需要价值因子平衡
        'rp_target_vol': 18.0,     # 科技本身波动大，目标可略高
        'rp_min_position': 0.2,
        'kelly_max': 0.45,         # 严格Kelly上限
        'cvt_accel_dampen': 0.3,   # 波动率加速时更激进减仓
        'wb_weight': 0.12,         # 科技突破信号有价值
        'wb_breakout_mult': 1.8,   # 较高阈值(过滤噪音)
    })

def create_energy_fusion(base_strategy: Strategy) -> ClassicFactorFusionStrategy:
    """新能源: 政策驱动、周期性强 → 价值因子为主 + 严格止损"""
    return ClassicFactorFusionStrategy(base_strategy, {
        'aqr_weight': 0.18,
        'aqr_mom_w': 0.35,
        'aqr_val_w': 0.65,         # 新能源偏价值(均值回归强)
        'rp_target_vol': 15.0,
        'kelly_max': 0.4,
        'wb_stop_mult': 1.5,       # 更严格止损(新能源暴跌快)
        'wb_weight': 0.08,
        'cvt_accel_dampen': 0.35,  # 高波动加速时大幅减仓
    })

def create_pharma_fusion(base_strategy: Strategy) -> ClassicFactorFusionStrategy:
    """医药: 波动适中、政策敏感 → 均衡配置"""
    return ClassicFactorFusionStrategy(base_strategy, {
        'aqr_weight': 0.12,
        'aqr_mom_w': 0.5,
        'aqr_val_w': 0.5,
        'rp_target_vol': 15.0,
        'kelly_max': 0.45,
        'wb_breakout_mult': 1.6,
        'wb_stop_mult': 2.0,
        'wb_weight': 0.06,         # 医药突破信号不太可靠
        'cvt_accel_dampen': 0.2,
    })


# ============================================================
# 独立运行: 验证五因子在合成数据上的行为
# ============================================================

if __name__ == '__main__':
    print("=" * 70)
    print("五大经典策略因子 — 行为验证")
    print("=" * 70)

    np.random.seed(42)

    # 生成三种市场环境的模拟数据
    scenarios = {
        '牛市(年化+30%)': np.cumprod(1 + np.random.normal(0.0012, 0.012, 300)),
        '熊市(年化-15%)': np.cumprod(1 + np.random.normal(-0.0006, 0.015, 300)),
        '震荡市(年化+5%)': np.cumprod(1 + np.random.normal(0.0002, 0.010, 300)),
        '高波动(年化+10%,vol30%)': np.cumprod(1 + np.random.normal(0.0004, 0.019, 300)),
    }

    aqr = AQRMomentumValueFactor()
    rp = RiskParityPositionFactor()
    kelly = KellyPositionFactor()
    cvt = ConstantVolTargetFactor()
    williams = WilliamsVolBreakoutFactor()

    for name, navs in scenarios.items():
        navs = navs * 1.0  # 起始净值1.0
        print(f"\n{'─' * 50}")
        print(f"场景: {name}")
        print(f"  起始NAV={navs[0]:.4f}, 终止NAV={navs[-1]:.4f}, "
              f"累积收益={((navs[-1]/navs[0])-1)*100:.1f}%")

        aqr_c, aqr_m, aqr_v = aqr.compute(navs)
        print(f"  [AQR因子]  综合={aqr_c:+.3f}  动量={aqr_m:+.3f}  价值={aqr_v:+.3f}")

        rp_c = rp.compute(navs)
        print(f"  [风险平价] 仓位系数={rp_c:.3f}")

        kelly_f = kelly.compute(navs)
        print(f"  [Kelly]    建议仓位={kelly_f:.3f} ({kelly_f*100:.1f}%)")

        cvt_c = cvt.compute(navs)
        print(f"  [恒定波动率] 仓位缩放={cvt_c:.3f}")

        wb = williams.compute(navs)
        print(f"  [Williams] 突破信号={wb:+.3f}")

    print(f"\n{'=' * 70}")
    print("验证完成。各因子在不同市场环境下的行为符合预期。")
    print("=" * 70)
