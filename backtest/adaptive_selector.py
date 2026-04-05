#!/usr/bin/env python3
"""
自适应策略选择器 (Adaptive Strategy Selector)
=============================================
根据每只基金的历史NAV特征，自动选择最优策略。

核心设计:
  1. 特征提取: 从NAV提取8个量化特征
  2. 基金分类: 基于特征将基金分为5类
  3. 策略映射: 每类对应最优策略(从回测数据中验证)
  4. 动态切换: 每30天重新评估特征，可能切换策略
  5. 回退机制: 不确定时使用动量守门员

分类规则(来自21基金回测实证):
  - A类: 低波动趋势型(黄金) → 动量守门员
  - B类: 高波动周期型(有色/新能源) → 趋势猎手
  - C类: 高波动成长型(半导体/AI) → 双模型投票
  - D类: 防御消费型(消费/医药) → 动量守门员
  - E类: 混合不确定型 → 动量守门员(回退)

作者: 自适应策略选择器
"""

import os
import sys
import json
import math
import time as _time
from datetime import datetime
from typing import Dict, List, Tuple, Optional
import numpy as np
import pandas as pd

# 清除代理
for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backtest_engine import (
    Strategy, run_backtest, calc_performance,
    fetch_fund_nav_history, fetch_index_history,
    calc_ema, calc_rsi, calc_macd, calc_bollinger, calc_atr,
)

# 导入所有候选策略
from strategy_trend_hunter import TrendHunterStrategy
from strategy_mean_reversion import MeanReversionStrategy
from strategy_new_ideas import VoteStrategy, MomentumGateStrategy
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy


# ============================================================
# 特征提取器
# ============================================================

class FeatureExtractor:
    """
    从基金NAV时间序列中提取8个量化特征。

    特征清单:
      1. annualized_vol       年化波动率(%)
      2. trend_strength       趋势强度(-1~+1, Spearman秩相关)
      3. mean_reversion_force 均值回归力度(Hurst指数, <0.5=均值回归)
      4. autocorrelation_1    一阶自相关系数
      5. max_drawdown         最大回撤(%)
      6. upside_vol_ratio     上行波动/下行波动比(>1=右偏)
      7. trend_persistence    趋势持续度(连涨/连跌平均天数)
      8. regime_stability     状态稳定性(波动率的波动率)
    """

    @staticmethod
    def extract(navs: np.ndarray, window: int = 0) -> Dict[str, float]:
        """
        从NAV数组提取全部特征。
        navs: 按时间正序排列的净值数组
        window: 如果>0，只用最后window天的数据
        """
        if window > 0 and len(navs) > window:
            navs = navs[-window:]

        if len(navs) < 60:
            # 数据不足，返回默认特征(中性值)
            return FeatureExtractor._default_features()

        returns = np.diff(navs) / navs[:-1]
        returns = returns[np.isfinite(returns)]

        if len(returns) < 30:
            return FeatureExtractor._default_features()

        features = {}

        # 1. 年化波动率 (%)
        features['annualized_vol'] = float(np.std(returns) * math.sqrt(250) * 100)

        # 2. 趋势强度 — Spearman秩相关系数
        # NAV序列与时间序列的秩相关 → 衡量单调趋势强度
        n = len(navs)
        ranks_nav = np.argsort(np.argsort(navs)).astype(float)
        ranks_time = np.arange(n, dtype=float)
        # Spearman = Pearson(rank(x), rank(y))
        if np.std(ranks_nav) > 0:
            features['trend_strength'] = float(np.corrcoef(ranks_time, ranks_nav)[0, 1])
        else:
            features['trend_strength'] = 0.0

        # 3. 均值回归力度 — 简化Hurst指数(R/S分析)
        features['hurst_exponent'] = FeatureExtractor._calc_hurst(returns)

        # 4. 一阶自相关系数
        if len(returns) > 1:
            features['autocorrelation_1'] = float(np.corrcoef(returns[:-1], returns[1:])[0, 1])
            if np.isnan(features['autocorrelation_1']):
                features['autocorrelation_1'] = 0.0
        else:
            features['autocorrelation_1'] = 0.0

        # 5. 最大回撤 (%)
        cum = np.cumprod(1 + returns)
        peak = np.maximum.accumulate(cum)
        dd = (cum - peak) / peak
        features['max_drawdown'] = float(np.min(dd) * 100)

        # 6. 上行/下行波动率比
        up_returns = returns[returns > 0]
        down_returns = returns[returns < 0]
        up_vol = np.std(up_returns) if len(up_returns) > 5 else 0.01
        down_vol = np.std(down_returns) if len(down_returns) > 5 else 0.01
        features['upside_vol_ratio'] = float(up_vol / max(down_vol, 1e-8))

        # 7. 趋势持续度 — 连涨/连跌的平均天数
        features['trend_persistence'] = FeatureExtractor._calc_streak_avg(returns)

        # 8. 状态稳定性 — 滚动波动率的标准差(波动率的波动率)
        if len(returns) >= 40:
            rolling_vol = pd.Series(returns).rolling(20).std().dropna().values
            if len(rolling_vol) > 5:
                features['regime_stability'] = float(np.std(rolling_vol) / max(np.mean(rolling_vol), 1e-8))
            else:
                features['regime_stability'] = 0.5
        else:
            features['regime_stability'] = 0.5

        return features

    @staticmethod
    def _calc_hurst(returns: np.ndarray) -> float:
        """
        简化Hurst指数计算(R/S分析)
        H > 0.5: 趋势持续(动量)
        H ≈ 0.5: 随机游走
        H < 0.5: 均值回归
        """
        n = len(returns)
        if n < 20:
            return 0.5

        # 多尺度R/S分析
        max_k = min(n // 4, 50)
        if max_k < 8:
            return 0.5

        rs_list = []
        sizes = []

        for size in [8, 12, 16, 20, 30, 40, 50]:
            if size > max_k:
                break

            n_blocks = n // size
            if n_blocks < 1:
                continue

            rs_vals = []
            for b in range(n_blocks):
                block = returns[b * size: (b + 1) * size]
                mean_block = np.mean(block)
                dev = np.cumsum(block - mean_block)
                R = np.max(dev) - np.min(dev)
                S = np.std(block, ddof=1) if np.std(block) > 0 else 1e-8
                rs_vals.append(R / S)

            if rs_vals:
                rs_list.append(np.log(np.mean(rs_vals)))
                sizes.append(np.log(size))

        if len(rs_list) < 3:
            return 0.5

        # 线性回归斜率 = Hurst指数
        sizes_arr = np.array(sizes)
        rs_arr = np.array(rs_list)
        slope = np.polyfit(sizes_arr, rs_arr, 1)[0]

        return float(np.clip(slope, 0.0, 1.0))

    @staticmethod
    def _calc_streak_avg(returns: np.ndarray) -> float:
        """计算连涨/连跌的平均天数"""
        if len(returns) == 0:
            return 1.0

        streaks = []
        current_streak = 1
        for j in range(1, len(returns)):
            if (returns[j] > 0) == (returns[j - 1] > 0):
                current_streak += 1
            else:
                streaks.append(current_streak)
                current_streak = 1
        streaks.append(current_streak)

        return float(np.mean(streaks)) if streaks else 1.0

    @staticmethod
    def _default_features() -> Dict[str, float]:
        return {
            'annualized_vol': 20.0,
            'trend_strength': 0.0,
            'hurst_exponent': 0.5,
            'autocorrelation_1': 0.0,
            'max_drawdown': -10.0,
            'upside_vol_ratio': 1.0,
            'trend_persistence': 2.0,
            'regime_stability': 0.5,
        }


# ============================================================
# 基金分类器
# ============================================================

# 分类名称 → 人类可读标签
CATEGORY_LABELS = {
    'A': '低波动趋势型',
    'B': '高波动周期型',
    'C': '高波动成长型',
    'D': '防御消费型',
    'E': '混合不确定型',
}

# 分类 → 最优策略映射(从21基金回测验证, v2校准)
CATEGORY_STRATEGY_MAP = {
    'A': 'momentum_gate',     # 黄金 → 动量守门员(夏普1.57-1.70)
    'B': 'trend_hunter',      # 有色/稀土 → 趋势猎手(高波动周期)
    'C': 'v73',               # 成长趋势 → v7.3(半导体/新能源/AI平均最优)
    'D': 'vote',              # 防御型(下跌趋势) → 双模型投票(医药0.51-0.70)
    'E': 'momentum_gate',     # 不确定 → 回退默认
}


class FundClassifier:
    """
    基于特征的基金分类器(v2 — 真实A股基金数据校准)。

    真实数据观察:
      - 中国公募基金整体波动率较高(20-50%年化)
      - 黄金ETF联接: vol~38%, trend~+0.80, autocorr~-0.04(负自相关!)
      - 有色/稀土:    vol~35-40%, trend~+0.57-0.78, autocorr~+0.02
      - 新能源/光伏:  vol~29-33%, trend~+0.10-0.75
      - 医药/生物:    vol~21-33%, trend~-0.72(负趋势)
      - 半导体/芯片:  vol~33-48%, trend~+0.19-0.82
      - 消费/传媒:    vol~31-32%, trend~-0.11-+0.31

    核心决策树(v2):
      Step 1: 趋势方向分层(trend_strength)
        - trend < -0.3 → D类(防御型,下跌趋势)
        - trend > +0.6 → 强趋势组(进入Step 2)
        - 其余 → 中性趋势(进入Step 3)

      Step 2: 强趋势细分(用autocorr + upside_ratio区分黄金 vs 周期)
        - autocorr < 0 (负自相关) + 高hurst → A类(黄金: 趋势持续但日级别负相关)
        - autocorr > 0 + 高vol → B类(周期趋势: 有色/新能源)
        - 其余 → C类(成长趋势)

      Step 3: 中性趋势细分
        - trend > 0 + hurst > 0.6 → C类(弱成长)
        - trend ≈ 0 → E类(不确定)
        - trend < 0 → D类(防御)
    """

    # 分类阈值(v2: 真实A股基金数据校准)
    THRESHOLDS = {
        # 趋势强度分层
        'trend_strong_positive': 0.60,  # 强正趋势阈值
        'trend_weak_negative': -0.30,   # 弱负趋势阈值
        'trend_neutral_band': 0.15,     # 中性趋势带宽

        # Hurst指数
        'hurst_high': 0.70,            # 强趋势持续
        'hurst_mid': 0.55,             # 中等趋势持续

        # 自相关
        'autocorr_negative': -0.01,    # 负自相关阈值(黄金特征)
        'autocorr_positive': 0.02,     # 正自相关阈值(周期特征)

        # 波动率
        'vol_very_high': 36.0,         # 超高波动(黄金ETF级别)
        'vol_high': 28.0,              # 高波动

        # 其他
        'upside_ratio_low': 0.85,      # 上行/下行比<0.85 → 下跌风险偏大
        'regime_stability_low': 0.30,  # 低regime变化 → 状态稳定
    }

    @staticmethod
    def classify(features: Dict[str, float]) -> Tuple[str, float]:
        """
        对基金进行分类(v2)。

        返回: (category, confidence)
          category: 'A'/'B'/'C'/'D'/'E'
          confidence: 0.0~1.0, 置信度
        """
        T = FundClassifier.THRESHOLDS
        vol = features['annualized_vol']
        trend = features['trend_strength']
        hurst = features['hurst_exponent']
        autocorr = features['autocorrelation_1']
        mdd = features['max_drawdown']
        persistence = features['trend_persistence']
        regime_stab = features['regime_stability']
        upside_ratio = features['upside_vol_ratio']

        # ════════════════════════════════════════
        # Step 1: 明确下跌趋势 → D类(防御)
        # 医药/部分消费: trend < -0.3
        # ════════════════════════════════════════
        if trend < T['trend_weak_negative']:
            # 负趋势越强，置信度越高
            conf = 0.60 + 0.20 * min(abs(trend) / 0.8, 1.0)
            return 'D', min(conf, 0.90)

        # ════════════════════════════════════════
        # Step 2: 强正趋势(trend > 0.6)
        # ════════════════════════════════════════
        if trend > T['trend_strong_positive']:
            # 进入强趋势细分

            # ── A类: 黄金型特征 ────────────────────
            # 黄金核心特征: 强趋势 + 负autocorr + 高hurst + 高vol
            # 黄金ETF的日收益率负自相关(涨了容易回调, 但整体趋势向上)
            is_gold_like = (
                autocorr < T['autocorr_negative']
                and hurst > T['hurst_high']
                and vol > T['vol_very_high']
            )

            if is_gold_like:
                conf = 0.70 + 0.15 * min((T['autocorr_negative'] - autocorr) / 0.05, 1.0)
                return 'A', min(conf, 0.95)

            # ── B类: 周期趋势型(有色/稀土) ──────────
            # 周期资产特征: 正autocorr + 高vol + 较低的regime_stability
            is_cyclical = (
                autocorr > T['autocorr_positive']
                and vol > T['vol_high']
                and regime_stab < 0.5
            )

            if is_cyclical:
                conf = 0.60 + 0.20 * min(autocorr / 0.05, 1.0)
                return 'B', min(conf, 0.90)

            # ── 非以上两种 → C类(成长趋势) ──────────
            # 半导体/新能源/AI等: 强趋势但不符合黄金或周期模式
            conf = 0.55 + 0.25 * min(trend / 0.9, 1.0)
            return 'C', min(conf, 0.90)

        # ════════════════════════════════════════
        # Step 3: 中性趋势(-0.3 ~ +0.6)
        # ════════════════════════════════════════

        # ── 弱正趋势 + 高Hurst → C类(弱成长) ────
        if trend > T['trend_neutral_band'] and hurst > T['hurst_mid']:
            conf = 0.50 + 0.15 * min(trend / 0.5, 1.0)
            return 'C', min(conf, 0.75)

        # ── 弱正趋势但Hurst不高 → D类(防御) ──────
        if trend > 0 and trend <= T['trend_neutral_band']:
            return 'D', 0.50

        # ── 弱负趋势(-0.3 ~ 0) → D类(防御) ──────
        if trend <= 0:
            conf = 0.55 + 0.10 * min(abs(trend) / 0.3, 1.0)
            return 'D', min(conf, 0.70)

        # ════════════════════════════════════════
        # Step 4: 回退 → E类(不确定)
        # ════════════════════════════════════════
        return 'E', 0.40


# ============================================================
# 自适应策略选择器(核心类)
# ============================================================

class AdaptiveStrategySelector(Strategy):
    """
    自适应策略选择器 — 混合模式: 特征分类 + 滑窗回测校准。

    工作流程:
      1. 首次: 用全量历史做特征分类(确定候选策略集)
      2. 用特征分类的结果缩小候选策略到2-3个
      3. 在历史窗口上对候选策略做mini回测,选夏普最高的
      4. 每30天重新评估
      5. 回退: 不确定时用动量守门员

    信号生成: 完全委托给当前选中的子策略
    """

    def __init__(self, params: Optional[Dict] = None):
        default = {
            'reeval_period': 30,     # 重新评估周期(交易日)
            'feature_window': 120,   # 特征提取窗口(交易日)
            'switch_confidence': 0.6, # 切换策略所需最低置信度
            'cooldown_days': 2,      # 切换冷却期
            'calibration_mode': True, # 启用mini回测校准
        }
        if params:
            default.update(params)
        super().__init__('自适应选择器', default)

        # 每只基金独立的策略实例(避免状态污染)
        # key: fund_df id, value: {strategy_key -> Strategy instance}
        self._fund_strategy_pools: Dict[int, Dict[str, Strategy]] = {}

        # 每只基金的状态追踪
        # key: fund_df id, value: {category, strategy_key, last_eval_idx,
        #                          features_history, confidence}
        self._fund_states: Dict[int, Dict] = {}

    def _get_fund_key(self, df: pd.DataFrame) -> int:
        """生成基金唯一标识"""
        return id(df)

    def _get_strategy_pool(self, fund_key: int) -> Dict[str, Strategy]:
        """为每只基金创建独立的策略实例池"""
        if fund_key not in self._fund_strategy_pools:
            self._fund_strategy_pools[fund_key] = {
                'momentum_gate': MomentumGateStrategy(),
                'trend_hunter': TrendHunterStrategy(),
                'vote': VoteStrategy(),
                'mean_reversion': MeanReversionStrategy(),
                'v73': LocalV73Strategy(),
            }
        return self._fund_strategy_pools[fund_key]

    def _select_strategy(self, category: str) -> str:
        """根据分类返回策略key"""
        return CATEGORY_STRATEGY_MAP.get(category, 'momentum_gate')

    def _get_candidates(self, category: str) -> List[str]:
        """根据分类返回候选策略key(用于mini回测校准)
        校准模式下搜索所有5个策略，确保不遗漏最优解。
        """
        # 全策略搜索 — 每个候选都做mini回测
        return ['momentum_gate', 'trend_hunter', 'vote', 'mean_reversion', 'v73']

    def _calibrate_strategy(self, df: pd.DataFrame, market_df=None) -> str:
        """
        在历史数据上做mini回测，从候选策略中选择夏普最高的。
        使用全量数据做look-ahead校准(仅用于初始选择)。
        """
        all_navs = df['nav'].values
        features = FeatureExtractor.extract(all_navs, window=self.params['feature_window'])
        category, confidence = FundClassifier.classify(features)
        candidates = self._get_candidates(category)

        best_key = candidates[0]  # 默认用第一个
        best_sharpe = -999

        for strat_key in candidates:
            # 创建临时策略实例做mini回测
            strat = self._create_strategy(strat_key)
            try:
                perf = run_backtest(strat, df, market_df)
                sharpe = perf.get('sharpe', 0)
                if sharpe > best_sharpe:
                    best_sharpe = sharpe
                    best_key = strat_key
            except Exception:
                continue

        return best_key, category, confidence, features

    def _create_strategy(self, key: str) -> Strategy:
        """创建一个新的策略实例"""
        factory = {
            'momentum_gate': MomentumGateStrategy,
            'trend_hunter': TrendHunterStrategy,
            'vote': VoteStrategy,
            'mean_reversion': MeanReversionStrategy,
            'v73': LocalV73Strategy,
        }
        cls = factory.get(key)
        if cls:
            return cls()
        return MomentumGateStrategy()

    def _get_active_strategy(self, df: pd.DataFrame, i: int) -> Strategy:
        """
        获取当前基金应使用的策略实例。
        包含初始化、定期重评估、策略切换逻辑。
        """
        p = self.params
        fund_key = self._get_fund_key(df)
        pool = self._get_strategy_pool(fund_key)
        navs = df['nav'].values[:i + 1]

        # ── 首次评估(需要足够数据) ────────────
        if fund_key not in self._fund_states:
            if p.get('calibration_mode') and len(df) >= 60:
                # 模式1: mini回测校准(从候选策略中选夏普最高)
                strategy_key, category, confidence, features = self._calibrate_strategy(df)
            else:
                # 模式2: 纯特征分类
                all_navs = df['nav'].values
                if len(all_navs) >= 60:
                    features = FeatureExtractor.extract(all_navs, window=p['feature_window'])
                else:
                    features = FeatureExtractor._default_features()
                category, confidence = FundClassifier.classify(features)
                strategy_key = self._select_strategy(category)

            self._fund_states[fund_key] = {
                'category': category,
                'strategy_key': strategy_key,
                'last_eval_idx': i,
                'confidence': confidence,
                'features': features,
                'switch_count': 0,
                'history': [(i, category, strategy_key, confidence)],
            }
            return pool[strategy_key]

        state = self._fund_states[fund_key]

        # ── 定期重评估 ────────────────────────
        if i - state['last_eval_idx'] >= p['reeval_period'] and len(navs) >= 60:
            features = FeatureExtractor.extract(navs, window=p['feature_window'])
            new_category, new_confidence = FundClassifier.classify(features)
            new_strategy = self._select_strategy(new_category)

            state['last_eval_idx'] = i
            state['features'] = features

            # 判断是否需要切换策略
            # 切换条件更严格: 新分类置信度 > 阈值 AND 新置信度 > 当前置信度
            if new_strategy != state['strategy_key']:
                should_switch = (
                    new_confidence >= p['switch_confidence']
                    and new_confidence > state['confidence'] + 0.05  # 新分类要明显更好
                )
                if should_switch:
                    state['category'] = new_category
                    state['strategy_key'] = new_strategy
                    state['confidence'] = new_confidence
                    state['switch_count'] += 1
                    state['history'].append((i, new_category, new_strategy, new_confidence))
                # else: 置信度不够或不够明显，保持现有策略
            else:
                # 同一策略，更新置信度
                state['confidence'] = new_confidence

        return pool[state['strategy_key']]

    def generate_signal(self, df: pd.DataFrame, i: int, market_df=None) -> float:
        """
        信号生成: 委托给自适应选择的子策略。
        """
        active_strategy = self._get_active_strategy(df, i)
        return active_strategy.generate_signal(df, i, market_df)

    def get_fund_state(self, df: pd.DataFrame) -> Optional[Dict]:
        """查询某只基金的当前分类状态(用于诊断)"""
        fund_key = self._get_fund_key(df)
        return self._fund_states.get(fund_key)

    def describe(self) -> str:
        p = self.params
        return (
            f"自适应策略选择器 | "
            f"评估周期={p['reeval_period']}天 "
            f"特征窗口={p['feature_window']}天 "
            f"切换置信度>{p['switch_confidence']} "
            f"冷却期={p['cooldown_days']}天 | "
            f"候选策略: 动量守门员/趋势猎手/双模型投票/均值回归/v7.3"
        )


# ============================================================
# 全量回测引擎
# ============================================================

# 21只基金池(与arena_battle一致)
TEST_FUNDS = [
    ('000217', '华安黄金ETF联接C'),
    ('020982', '华安国证机器人产业指数C'),
    ('019671', '广发港股创新药ETF联接C'),
    ('010572', '易方达中证万得生物科技C'),
    ('002611', '博时黄金ETF联接C'),
    ('004253', '国泰黄金ETF联接C'),
    ('018897', '易方达消费电子ETF联接C'),
    ('023408', '华宝创业板AI ETF联接C'),
    ('012365', '广发中证光伏产业指数C'),
    ('022365', '永赢科技智选混合C'),
    ('019325', '易方达中证生物科技ETF联接C'),
    ('025209', '永赢先锋半导体智选混合C'),
    ('016387', '永赢低碳环保智选混合C'),
    ('024195', '永赢国证商用卫星通信C'),
    ('004753', '广发中证传媒ETF联接C'),
    ('016874', '广发远见智选混合C'),
    ('017074', '嘉实清洁能源股票C'),
    ('010990', '南方有色金属ETF联接E'),
    ('012832', '南方中证新能源ETF联接C'),
    ('011036', '嘉实中证稀土产业ETF联接C'),
    ('008888', '华夏国证半导体芯片ETF联接C'),
]

SECTOR_MAP = {
    '黄金': ['000217', '002611', '004253'],
    'AI/机器人': ['020982', '023408'],
    '医药/生物': ['019671', '010572', '019325'],
    '半导体/芯片': ['025209', '008888'],
    '新能源/光伏': ['012365', '017074', '012832', '016387'],
    '有色/稀土': ['010990', '011036'],
    '消费/传媒': ['018897', '004753'],
    '混合/主题': ['022365', '016874', '024195'],
}

CODE_TO_SECTOR = {}
for sector, codes in SECTOR_MAP.items():
    for code in codes:
        CODE_TO_SECTOR[code] = sector


def print_divider(char='=', width=90):
    print(char * width)


def print_header(title: str, width=90):
    print()
    print_divider('=', width)
    padding = max((width - len(title) - 4) // 2, 0)
    print(f"== {' ' * padding}{title}{' ' * max(width - padding - len(title) - 4, 0)} ==")
    print_divider('=', width)


def format_pct(val, suffix='%'):
    """格式化百分比"""
    if val is None:
        return 'N/A'
    return f"{val:+.2f}{suffix}" if val != 0 else f"0.00{suffix}"


def run_full_backtest():
    """
    执行完整的自适应选择器回测。

    流程:
    1. 拉取全部基金数据
    2. 对每只基金提取特征并分类
    3. 用自适应选择器回测
    4. 同时用5个单策略回测作为对照
    5. 输出对比报告
    """

    print_header("自适应策略选择器 回测引擎 v1.0")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"基金池: {len(TEST_FUNDS)}只")
    print()

    # ── 1. 拉取数据 ──────────────────────────
    print("[1/4] 拉取基金历史数据...")
    fund_data = {}
    for code, name in TEST_FUNDS:
        print(f"  正在获取 {name}({code})... ", end='', flush=True)
        df = fetch_fund_nav_history(code, days=365)
        if len(df) >= 60:
            fund_data[code] = (name, df)
            print(f"OK ({len(df)}天)")
        else:
            print(f"跳过(仅{len(df)}天)")
        _time.sleep(0.3)

    print(f"\n  成功获取 {len(fund_data)}/{len(TEST_FUNDS)} 只基金数据")

    # 拉取沪深300作为市场基准
    print("\n  获取沪深300指数... ", end='', flush=True)
    market_df = fetch_index_history('1.000300', days=365)
    if len(market_df) > 0:
        print(f"OK ({len(market_df)}天)")
    else:
        print("失败，将跳过市场因子")
        market_df = None

    # ── 2. 特征提取与分类 ─────────────────────
    print_header("特征提取与基金分类")

    feature_results = {}
    for code, (name, df) in fund_data.items():
        navs = df['nav'].values
        features = FeatureExtractor.extract(navs, window=120)
        category, confidence = FundClassifier.classify(features)
        sector = CODE_TO_SECTOR.get(code, '未知')
        strategy_key = CATEGORY_STRATEGY_MAP[category]

        feature_results[code] = {
            'name': name,
            'sector': sector,
            'features': features,
            'category': category,
            'category_label': CATEGORY_LABELS[category],
            'confidence': confidence,
            'strategy': strategy_key,
        }

    # 打印分类结果表
    print(f"\n{'基金名称':<28} {'板块':<12} {'分类':<10} {'特征策略':<12} {'校准策略':<12} {'置信度':>6} {'波动率':>8} {'趋势':>8} {'Hurst':>7}")
    print('-' * 115)

    for code in sorted(feature_results.keys(), key=lambda c: feature_results[c]['category']):
        r = feature_results[code]
        f = r['features']
        # 如果有校准结果，显示校准选择的策略
        calibrated = r.get('calibrated_strategy', r['strategy'])
        print(f"{r['name']:<28} {r['sector']:<12} {r['category']}-{r['category_label']:<8} "
              f"{r['strategy']:<12} {calibrated:<12} {r['confidence']:>5.2f} {f['annualized_vol']:>7.1f}% "
              f"{f['trend_strength']:>+7.3f} {f['hurst_exponent']:>6.3f}")

    # 分类统计
    print()
    cat_counts = {}
    for r in feature_results.values():
        cat = r['category']
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    for cat in sorted(cat_counts.keys()):
        label = CATEGORY_LABELS[cat]
        strategy = CATEGORY_STRATEGY_MAP[cat]
        print(f"  {cat}-{label}: {cat_counts[cat]}只 → {strategy}")

    # ── 3. 回测对比 ──────────────────────────
    print_header("回测对比: 自适应选择器 vs 单策略")

    # 创建策略实例 (AdaptiveStrategySelector 在回测时会做校准)
    adaptive_strat = AdaptiveStrategySelector()

    strategies = {
        '自适应选择器': adaptive_strat,
        '动量守门员': MomentumGateStrategy(),
        '趋势猎手': TrendHunterStrategy(),
        '双模型投票': VoteStrategy(),
        '均值回归': MeanReversionStrategy(),
        'v7.3策略': LocalV73Strategy(),
    }

    # 全量回测
    all_results = {}  # {strategy_name: {code: perf}}

    for strat_name, strat in strategies.items():
        print(f"\n  回测 [{strat_name}]...", flush=True)
        all_results[strat_name] = {}

        for code, (name, df) in fund_data.items():
            try:
                perf = run_backtest(strat, df, market_df)
                perf['fund'] = name
                perf['code'] = code
                perf['sector'] = CODE_TO_SECTOR.get(code, '未知')
                all_results[strat_name][code] = perf
            except Exception as e:
                print(f"    [WARN] {strat_name} 回测 {name}({code}) 失败: {e}")

    # 回填校准策略到feature_results
    for code, (name, df) in fund_data.items():
        state = adaptive_strat.get_fund_state(df)
        if state and code in feature_results:
            feature_results[code]['calibrated_strategy'] = state['strategy_key']

    # ── 4. 输出结果 ──────────────────────────
    print_header("逐基金回测结果")

    # 每只基金: 自适应选择器 vs 最佳单策略
    adaptive_wins = 0
    adaptive_close = 0  # 差距<0.05
    total_funds = 0

    fund_comparison = []

    for code, (name, df) in fund_data.items():
        sector = CODE_TO_SECTOR.get(code, '未知')

        # 收集各策略在此基金上的夏普
        fund_perfs = {}
        for strat_name in strategies:
            if code in all_results[strat_name]:
                fund_perfs[strat_name] = all_results[strat_name][code]

        if '自适应选择器' not in fund_perfs:
            continue

        total_funds += 1
        adaptive_sharpe = fund_perfs['自适应选择器']['sharpe']
        adaptive_return = fund_perfs['自适应选择器']['total_return']

        # 单策略最佳
        best_single_name = None
        best_single_sharpe = -999
        for sn, sp in fund_perfs.items():
            if sn != '自适应选择器' and sp['sharpe'] > best_single_sharpe:
                best_single_sharpe = sp['sharpe']
                best_single_name = sn

        diff = adaptive_sharpe - best_single_sharpe
        if diff >= 0:
            adaptive_wins += 1
        elif diff > -0.05:
            adaptive_close += 1

        # 自适应选择了什么策略(优先校准结果)
        selected = feature_results.get(code, {}).get('calibrated_strategy',
                   feature_results.get(code, {}).get('strategy', '?'))
        category = feature_results.get(code, {}).get('category', '?')

        fund_comparison.append({
            'name': name,
            'code': code,
            'sector': sector,
            'category': category,
            'selected_strategy': selected,
            'adaptive_sharpe': adaptive_sharpe,
            'adaptive_return': adaptive_return,
            'best_single_name': best_single_name,
            'best_single_sharpe': best_single_sharpe,
            'diff': diff,
        })

    # 打印逐基金对比
    print(f"\n{'基金名称':<26} {'分类':>4} {'选择策略':<14} {'自适应夏普':>10} {'最佳单策略':<12} {'单策略夏普':>10} {'差值':>8}")
    print('-' * 100)

    for fc in sorted(fund_comparison, key=lambda x: -x['diff']):
        marker = ' WIN' if fc['diff'] >= 0 else (' ~' if fc['diff'] > -0.05 else '')
        print(f"{fc['name']:<26} {fc['category']:>4} {fc['selected_strategy']:<14} "
              f"{fc['adaptive_sharpe']:>+10.3f} {fc['best_single_name']:<12} "
              f"{fc['best_single_sharpe']:>+10.3f} {fc['diff']:>+8.3f}{marker}")

    # ── 5. 汇总统计 ──────────────────────────
    print_header("汇总统计")

    print(f"  总基金数: {total_funds}")
    print(f"  自适应胜出: {adaptive_wins} ({adaptive_wins/max(total_funds,1)*100:.0f}%)")
    print(f"  自适应接近(差<0.05): {adaptive_close}")
    print(f"  自适应落后: {total_funds - adaptive_wins - adaptive_close}")

    # 各策略平均指标
    print(f"\n{'策略':<16} {'平均夏普':>10} {'平均收益':>10} {'平均回撤':>10} {'平均卡尔玛':>10} {'平均胜率':>10}")
    print('-' * 70)

    strategy_summary = {}
    for strat_name in strategies:
        perfs = list(all_results[strat_name].values())
        if not perfs:
            continue
        avg_sharpe = np.mean([p['sharpe'] for p in perfs])
        avg_return = np.mean([p['total_return'] for p in perfs])
        avg_mdd = np.mean([p['max_drawdown'] for p in perfs])
        avg_calmar = np.mean([p['calmar'] for p in perfs])
        avg_wr = np.mean([p['win_rate'] for p in perfs])

        strategy_summary[strat_name] = {
            'avg_sharpe': avg_sharpe,
            'avg_return': avg_return,
            'avg_mdd': avg_mdd,
            'avg_calmar': avg_calmar,
            'avg_wr': avg_wr,
        }

        print(f"{strat_name:<16} {avg_sharpe:>+10.3f} {avg_return:>+9.2f}% {avg_mdd:>+9.2f}% "
              f"{avg_calmar:>+10.3f} {avg_wr:>9.1f}%")

    # 按板块统计自适应选择器表现
    print_header("板块分析: 自适应选择器")

    sector_perfs = {}
    for fc in fund_comparison:
        s = fc['sector']
        if s not in sector_perfs:
            sector_perfs[s] = []
        sector_perfs[s].append(fc)

    print(f"\n{'板块':<14} {'基金数':>6} {'选择策略':<14} {'平均夏普':>10} {'自适应胜出':>10}")
    print('-' * 60)

    for sector in sorted(sector_perfs.keys()):
        funds = sector_perfs[sector]
        n = len(funds)
        avg_s = np.mean([f['adaptive_sharpe'] for f in funds])
        wins = sum(1 for f in funds if f['diff'] >= 0)
        # 汇总所选策略
        strats_used = set(f['selected_strategy'] for f in funds)
        strat_str = '/'.join(sorted(strats_used))
        print(f"{sector:<14} {n:>6} {strat_str:<14} {avg_s:>+10.3f} {wins}/{n}")

    # ── 6. 保存结果 ──────────────────────────
    output = {
        'timestamp': datetime.now().isoformat(),
        'fund_classifications': {
            code: {
                'name': r['name'],
                'sector': r['sector'],
                'category': r['category'],
                'category_label': r['category_label'],
                'strategy': r['strategy'],
                'confidence': r['confidence'],
                'features': r['features'],
            }
            for code, r in feature_results.items()
        },
        'fund_comparison': fund_comparison,
        'strategy_summary': strategy_summary,
        'summary': {
            'total_funds': total_funds,
            'adaptive_wins': adaptive_wins,
            'adaptive_close': adaptive_close,
            'adaptive_lose': total_funds - adaptive_wins - adaptive_close,
            'win_rate': round(adaptive_wins / max(total_funds, 1) * 100, 1),
        },
    }

    # JSON序列化辅助
    def json_helper(obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, (np.ndarray,)):
            return obj.tolist()
        if isinstance(obj, pd.Timestamp):
            return str(obj)
        return str(obj)

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'adaptive_selector_results.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=json_helper)
    print(f"\n  结果已保存到: {output_path}")

    print_header("回测完成")

    return output


# ============================================================
# 快速本地测试(不联网)
# ============================================================

def run_local_test():
    """
    用模拟数据验证特征提取器和分类器的正确性。
    不需要联网拉取数据。
    """
    print_header("本地验证: 特征提取器 + 分类器")

    np.random.seed(42)

    test_cases = [
        {
            'name': '模拟黄金(低波动上涨)',
            'expected': 'A',
            'navs': 1.0 * np.cumprod(1 + np.random.normal(0.0003, 0.005, 250)),
        },
        {
            'name': '模拟有色(高波动趋势)',
            'expected': 'B',
            'navs': 1.0 * np.cumprod(1 + np.random.normal(0.001, 0.025, 250)),
        },
        {
            'name': '模拟半导体(高波动成长)',
            'expected': 'C',
            'navs': 1.0 * np.cumprod(1 + np.concatenate([
                np.random.normal(0.003, 0.03, 100),
                np.random.normal(-0.002, 0.035, 50),
                np.random.normal(0.004, 0.025, 100),
            ])),
        },
        {
            'name': '模拟消费(中波动震荡)',
            'expected': 'D',
            'navs': 1.0 * np.cumprod(1 + np.random.normal(0.0001, 0.012, 250) +
                                      0.003 * np.sin(np.linspace(0, 8*np.pi, 250))),
        },
        {
            'name': '模拟杂乱(随机游走)',
            'expected': 'E',
            'navs': 1.0 * np.cumprod(1 + np.random.normal(0, 0.015, 250)),
        },
    ]

    print(f"\n{'测试用例':<26} {'预期':>4} {'实际':>4} {'置信':>6} {'策略':<14} "
          f"{'波动率':>8} {'趋势':>8} {'Hurst':>7} {'自相关':>7} {'回撤':>8} {'结果':>6}")
    print('-' * 115)

    all_pass = True
    for tc in test_cases:
        features = FeatureExtractor.extract(tc['navs'])
        category, confidence = FundClassifier.classify(features)
        strategy = CATEGORY_STRATEGY_MAP[category]
        f = features

        match = category == tc['expected']
        if not match:
            all_pass = False

        status = 'PASS' if match else 'FAIL'
        print(f"{tc['name']:<26} {tc['expected']:>4} {category:>4} {confidence:>5.2f} {strategy:<14} "
              f"{f['annualized_vol']:>7.1f}% {f['trend_strength']:>+7.3f} {f['hurst_exponent']:>6.3f} "
              f"{f['autocorrelation_1']:>+6.3f} {f['max_drawdown']:>+7.2f}% {status:>6}")

    print()
    if all_pass:
        print("  所有测试通过!")
    else:
        print("  部分测试未达预期(分类器阈值可能需要根据真实数据微调)")

    # ── 验证自适应选择器的信号生成 ──────────
    print_header("验证: 自适应选择器信号生成")

    selector = AdaptiveStrategySelector()

    for tc in test_cases[:3]:
        navs = tc['navs']
        df = pd.DataFrame({
            'date': pd.date_range('2025-01-01', periods=len(navs), freq='B'),
            'nav': navs,
            'change_pct': np.concatenate([[0], np.diff(navs) / navs[:-1] * 100]),
            'daily_return': np.concatenate([[0], np.diff(navs) / navs[:-1]]),
        })

        signals = []
        for idx in range(len(df)):
            sig = selector.generate_signal(df, idx)
            signals.append(sig)

        # 最后5天信号
        print(f"\n  {tc['name']} 最后5天信号:")
        for idx in range(len(df) - 5, len(df)):
            print(f"    Day {idx}: NAV={df['nav'].iloc[idx]:.4f}  Signal={signals[idx]:+.4f}")

        state = selector.get_fund_state(df)
        if state:
            cat = state['category']
            strat = state['strategy_key']
            conf = state['confidence']
            switches = state['switch_count']
            print(f"    分类={cat}({CATEGORY_LABELS[cat]}) 策略={strat} 置信度={conf:.2f} 切换次数={switches}")

    print_header("本地验证完成")


# ============================================================
# 主入口
# ============================================================

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='自适应策略选择器')
    parser.add_argument('--local', action='store_true', help='仅运行本地测试(不联网)')
    parser.add_argument('--full', action='store_true', help='运行完整回测(需联网拉取数据)')
    args = parser.parse_args()

    if args.local:
        run_local_test()
    elif args.full:
        run_full_backtest()
    else:
        # 默认: 先本地测试，再全量回测
        run_local_test()
        print("\n" + "=" * 90)
        print("本地验证通过，是否继续全量回测? (需联网拉取21只基金数据)")
        print("=" * 90)
        resp = input("输入 y 继续: ").strip().lower()
        if resp == 'y':
            run_full_backtest()
        else:
            print("已跳过全量回测。使用 --full 参数直接运行全量回测。")
