#!/usr/bin/env python3
"""
遗传算法参数优化器 — v8.1信号权重搜索
=======================================
- 搜索空间: 25个核心参数
- 适应度: 0.4*Calmar + 0.3*Sharpe + 0.2*Return + 0.1*(1-MaxDD/50)
- 防过拟合: Walk-Forward验证 (3年训练 + 2年测试)
- 遗传算法: 种群50, 代数40, 精英保留+锦标赛选择+均匀交叉+高斯变异

预期运行时间: ~2-4小时 (50种群 x 40代 = 2000次评估, 每次约3-5秒)
快速模式(--fast): 20种群 x 15代 = 300次评估, ~20分钟
"""

import os
import sys
import json
import math
import time
import random
import hashlib
import argparse
from copy import deepcopy
from datetime import datetime
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd

# 清除代理
for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

# 导入回测引擎
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backtest_engine import (
    fetch_fund_nav_history, Strategy, run_backtest,
    calc_rsi, calc_macd, calc_bollinger, calc_atr, calc_performance
)

# ============================================================
# 搜索空间定义
# ============================================================

SEARCH_SPACE = {
    # --- 趋势动量因子权重 ---
    'trend_weight_trending':    (0.40, 1.20),   # v8.1基线: 0.796
    'trend_weight_ranging':     (0.10, 0.60),   # v8.1基线: 0.32
    'trend_weight_volatile':    (0.05, 0.35),   # v8.1基线: 0.14
    # --- 均值回归因子权重 ---
    'reversion_weight_trending':(0.01, 0.12),   # v8.1基线: 0.037
    'reversion_weight_ranging': (0.08, 0.35),   # v8.1基线: 0.18
    'reversion_weight_volatile':(0.12, 0.50),   # v8.1基线: 0.28
    # --- RSI阈值 ---
    'rsi_ob':                   (70, 85),        # 超买 v8.1: 76
    'rsi_os':                   (15, 30),        # 超卖 v8.1: 22
    'rsi_mid_ob':               (55, 70),        # 中间偏买 v8.1: 60
    'rsi_mid_os':               (25, 40),        # 中间偏卖 v8.1: 31
    # --- MACD信号 ---
    'macd_signal':              (0.10, 0.40),    # v8.1: 0.232
    'macd_cross':               (0.20, 0.60),    # v8.1: 0.386
    # --- 布林带 ---
    'bb_extreme':               (0.15, 0.55),    # v8.1: 0.35
    # --- 大盘因子 ---
    'market_weight':            (0.15, 0.55),    # v8.1: 0.35
    # --- 连涨衰减 ---
    'streak_trending_5':        (0.90, 1.30),    # 趋势连涨>=5 v8.1: 1.15
    'streak_trending_3':        (0.90, 1.15),    # v8.1: 1.05
    'streak_other_5':           (0.15, 0.60),    # 非趋势连涨>=5 v8.1: 0.35
    'streak_other_3':           (0.55, 0.95),    # v8.1: 0.80
    # --- ATR限幅 ---
    'atr_limit_default':        (1.5, 4.0),      # v8.1: 2.5
    'atr_limit_trending':       (2.5, 5.0),      # v8.1: 3.5
    # --- 硬底线 ---
    'bb_hard_ceiling':          (88, 98),         # %B归零阈值 v8.1: 95
    'ts_hard_floor':            (-45, -25),       # 趋势崩坏阈值 v8.1: -35
    # --- v8结构参数 ---
    'weekly_confirm_weight':    (0.10, 0.50),    # 周线确认 v8.1: 0.30
    'vol_budget_low':           (10, 20),         # 低波阈值 v8.1: 15
    'vol_budget_mid':           (20, 35),         # 中波阈值 v8.1: 25
}

# v8.1基线参数 (手动调优结果)
BASELINE_PARAMS = {
    'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
    'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
    'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
    'macd_signal': 0.232, 'macd_cross': 0.386,
    'bb_extreme': 0.35, 'market_weight': 0.35,
    'streak_trending_5': 1.15, 'streak_trending_3': 1.05,
    'streak_other_5': 0.35, 'streak_other_3': 0.80,
    'atr_limit_default': 2.5, 'atr_limit_trending': 3.5,
    'bb_hard_ceiling': 95, 'ts_hard_floor': -35,
    'weekly_confirm_weight': 0.30, 'vol_budget_low': 15, 'vol_budget_mid': 25,
    # 非搜索参数 (固定)
    'pos_max_low_vol': 1.0, 'pos_max_mid_vol': 0.65, 'pos_max_high_vol': 0.35,
    'trail_profit_atr': 2.5, 'trail_loss_atr': 1.5,
}

# 固定参数 (不参与搜索)
FIXED_PARAMS = {
    'pos_max_low_vol': 1.0, 'pos_max_mid_vol': 0.65, 'pos_max_high_vol': 0.35,
    'trail_profit_atr': 2.5, 'trail_loss_atr': 1.5,
}

PARAM_NAMES = list(SEARCH_SPACE.keys())
N_PARAMS = len(PARAM_NAMES)


# ============================================================
# 策略类 (参数化v8.0, 用于优化)
# ============================================================

class ParameterizedV8Strategy(Strategy):
    """参数化v8.0策略 — 用于遗传算法搜索"""
    def __init__(self, params: Dict):
        full_params = {**FIXED_PARAMS, **params}
        super().__init__('GA-v8', full_params)

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def _weekly_trend(self, navs):
        if len(navs) < 30: return 0
        weekly = navs[::5]
        if len(weekly) < 6: return 0
        dif, dea, hist = calc_macd(pd.Series(weekly), fast=12, slow=26, signal=9)
        h = hist.iloc[-1] if len(hist) > 0 and not np.isnan(hist.iloc[-1]) else 0
        w5 = np.mean(weekly[-3:]) if len(weekly) >= 3 else weekly[-1]
        w10 = np.mean(weekly[-5:]) if len(weekly) >= 5 else weekly[-1]
        aligned_bull = w5 > w10 and weekly[-1] > w5
        aligned_bear = w5 < w10 and weekly[-1] < w5
        score = 0
        if h > 0: score += 0.5
        elif h < 0: score -= 0.5
        if aligned_bull: score += 0.5
        elif aligned_bear: score -= 0.5
        return max(-1, min(1, score))

    def _dynamic_risk_budget(self, navs):
        p = self.params
        if len(navs) < 21: return 1.0
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100
        if vol <= p['vol_budget_low']:
            return p['pos_max_low_vol']
        elif vol <= p['vol_budget_mid']:
            ratio = (vol - p['vol_budget_low']) / max(p['vol_budget_mid'] - p['vol_budget_low'], 0.01)
            return p['pos_max_low_vol'] - ratio * (p['pos_max_low_vol'] - p['pos_max_mid_vol'])
        else:
            ratio = min((vol - p['vol_budget_mid']) / 15, 1.0)
            return p['pos_max_mid_vol'] - ratio * (p['pos_max_mid_vol'] - p['pos_max_high_vol'])

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        trend_w = p.get(f'trend_weight_{regime}', 0.3)
        rev_w = p.get(f'reversion_weight_{regime}', 0.15)

        # 日线信号
        changes = np.diff(navs[-10:]) / navs[-10:-1] * 100 if len(navs) > 10 else np.array([0])
        decay = np.array([0.15, 0.25, 0.45, 0.75, 1.0])
        r5 = changes[-5:] if len(changes) >= 5 else changes
        w = decay[-len(r5):]
        wmom = np.dot(r5, w) / w.sum() if len(r5) > 0 else 0

        streak = 0
        for j in range(len(changes)-1, -1, -1):
            if changes[j] > 0 and streak >= 0: streak += 1
            elif changes[j] < 0 and streak <= 0: streak -= 1
            else: break

        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ts = (15 if current > ma5 else -15) + (15 if current > ma10 else -15) + (20 if current > ma20 else -20) + (10 if ma5 > ma10 else -10)
        tf = wmom * trend_w + ts * 0.015

        # 连涨处理
        if regime == 'trending':
            if abs(streak) >= 5: tf *= p['streak_trending_5']
            elif abs(streak) >= 3: tf *= p['streak_trending_3']
        else:
            if abs(streak) >= 5: tf *= p['streak_other_5']
            elif abs(streak) >= 3: tf *= p['streak_other_3']

        # 均值回归
        dev20 = (current - ma20) / ma20 * 100
        rf = 0
        if abs(dev20) > 2:
            rf += (-1 if dev20 > 0 else 1) * math.sqrt(abs(dev20) - 2) * rev_w
        if rf > 0 and tf < -0.2 and ts < -15: rf *= 0.3
        elif rf > 0 and tf < 0 and ts < 0: rf *= 0.6
        if rf < 0 and tf > 0.2 and ts > 15: rf *= 0.3
        elif rf < 0 and tf > 0 and ts > 0: rf *= 0.6

        # RSI
        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
        rsif = 0
        if rsi > p['rsi_ob']: rsif = -(rsi - p['rsi_ob']) * 0.08
        elif rsi > p['rsi_mid_ob']: rsif = -(rsi - p['rsi_mid_ob']) * 0.037
        elif rsi < p['rsi_os']: rsif = (p['rsi_os'] - rsi) * 0.08
        elif rsi < p['rsi_mid_os']: rsif = (p['rsi_mid_os'] - rsi) * 0.037

        # MACD
        dif_s, dea_s, hist_s = calc_macd(pd.Series(navs))
        hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
        dif = dif_s.iloc[-1] if not np.isnan(dif_s.iloc[-1]) else 0
        dea = dea_s.iloc[-1] if not np.isnan(dea_s.iloc[-1]) else 0
        mf = p['macd_signal'] if (hist > 0 and dif > dea) else (-p['macd_signal'] if (hist < 0 and dif < dea) else 0)
        if len(navs) >= 2:
            ph = calc_macd(pd.Series(navs[:-1]))[2].iloc[-1]
            if not np.isnan(ph):
                if ph <= 0 and hist > 0: mf += p['macd_cross']
                if ph >= 0 and hist < 0: mf -= p['macd_cross']

        # 布林带
        _, _, _, pctb_s, _ = calc_bollinger(pd.Series(navs))
        pctb = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_mult = 1.5 if regime == 'ranging' else 1.0
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bbf = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 20: bbf = (20 - pctb) * 0.020 * bb_mult

        # 市场
        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100

        # 波动率修正
        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        tf *= va; rf *= (2 - va)

        daily_raw = tf + rf + rsif + mf + bbf + mkf

        # ATR限幅
        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100
        atr_mult = p['atr_limit_trending'] if regime == 'trending' else p['atr_limit_default']
        daily_raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, daily_raw))

        # 多时间尺度融合
        weekly = self._weekly_trend(navs)
        wt_w = p['weekly_confirm_weight']
        if (daily_raw > 0 and weekly > 0) or (daily_raw < 0 and weekly < 0):
            raw = daily_raw * (1 + wt_w * abs(weekly))
        elif (daily_raw > 0 and weekly < 0) or (daily_raw < 0 and weekly > 0):
            raw = daily_raw * (1 - wt_w * abs(weekly))
        else:
            raw = daily_raw

        # sigmoid + 硬底线
        is_trend_mode = (regime == 'trending') and (hist > 0) and (raw > 0.25)
        if raw > 0 and not is_trend_mode:
            bb_reduction = 1 - 1 / (1 + math.exp(-0.12 * (pctb - 85)))
            raw *= bb_reduction
        if raw > 0 and ts < 0:
            trend_reduction = 1 - 1 / (1 + math.exp(-0.12 * (abs(ts) - 25)))
            raw *= trend_reduction

        if raw > 0 and pctb > p['bb_hard_ceiling']:
            raw = 0
        if raw > 0 and ts < p['ts_hard_floor']:
            raw *= 0.25
        if 0 < raw < 0.15 and ts < -15:
            raw = 0

        # 动态风险预算
        risk_budget = self._dynamic_risk_budget(navs)
        raw *= risk_budget

        # 非对称trailing stop
        peak = np.max(navs[-60:]) if len(navs) >= 60 else np.max(navs)
        cur_dd_pct = (peak - current) / peak * 100
        if cur_dd_pct > atr_pct * p['trail_loss_atr'] and raw > 0:
            raw = 0
        elif cur_dd_pct > atr_pct * p['trail_profit_atr'] and raw > -0.3:
            raw = -0.35

        return max(-1, min(1, raw / 2))


# ============================================================
# 适应度函数
# ============================================================

def fitness(params: Dict, fund_datasets: List[Tuple[pd.DataFrame, Optional[pd.DataFrame]]],
            weights: Tuple[float, ...] = (0.4, 0.3, 0.2, 0.1)) -> float:
    """
    适应度 = w1*Calmar + w2*Sharpe + w3*归一化收益 + w4*(1 - MaxDD/50)
    在多只基金上取平均, 避免对单只基金过拟合
    """
    w_calmar, w_sharpe, w_return, w_dd = weights
    strategy = ParameterizedV8Strategy(params)

    scores = []
    for fund_df, market_df in fund_datasets:
        try:
            perf = run_backtest(strategy, fund_df, market_df)
            calmar = max(min(perf.get('calmar', 0), 5.0), -2.0)  # 截断极端值
            sharpe = max(min(perf.get('sharpe', 0), 3.0), -2.0)
            total_ret = max(min(perf.get('total_return', 0) / 100, 2.0), -1.0)  # 百分比转小数,截断
            max_dd = abs(perf.get('max_drawdown', -50))
            dd_score = max(1 - max_dd / 50, 0)

            score = (w_calmar * calmar +
                     w_sharpe * sharpe +
                     w_return * total_ret +
                     w_dd * dd_score)
            scores.append(score)
        except Exception as e:
            scores.append(-5.0)  # 严重惩罚出错的参数

    return np.mean(scores) if scores else -10.0


# ============================================================
# 遗传算法核心
# ============================================================

def encode_params(params: Dict) -> np.ndarray:
    """参数字典 -> 归一化向量 [0,1]^N"""
    vec = np.zeros(N_PARAMS)
    for idx, name in enumerate(PARAM_NAMES):
        lo, hi = SEARCH_SPACE[name]
        val = params.get(name, (lo + hi) / 2)
        vec[idx] = (val - lo) / (hi - lo) if hi > lo else 0.5
    return np.clip(vec, 0, 1)


def decode_params(vec: np.ndarray) -> Dict:
    """归一化向量 -> 参数字典"""
    params = {}
    for idx, name in enumerate(PARAM_NAMES):
        lo, hi = SEARCH_SPACE[name]
        val = lo + vec[idx] * (hi - lo)
        # RSI阈值和硬底线取整
        if name in ('rsi_ob', 'rsi_os', 'rsi_mid_ob', 'rsi_mid_os', 'bb_hard_ceiling', 'ts_hard_floor'):
            val = int(round(val))
        else:
            val = round(val, 4)
        params[name] = val
    return params


def latin_hypercube_sample(n_samples: int) -> List[np.ndarray]:
    """拉丁超立方采样 — 比纯随机有更好的空间覆盖"""
    samples = []
    for dim in range(N_PARAMS):
        perm = np.random.permutation(n_samples)
        cut = (perm + np.random.uniform(size=n_samples)) / n_samples
        samples.append(cut)
    # samples[dim][i] => 第i个样本在第dim维的值
    lhs = np.array(samples).T  # shape: (n_samples, N_PARAMS)
    return [lhs[i] for i in range(n_samples)]


def tournament_select(population: List[np.ndarray], fitnesses: List[float],
                      k: int = 3) -> np.ndarray:
    """锦标赛选择"""
    indices = random.sample(range(len(population)), min(k, len(population)))
    best_idx = max(indices, key=lambda i: fitnesses[i])
    return population[best_idx].copy()


def uniform_crossover(parent1: np.ndarray, parent2: np.ndarray,
                      crossover_rate: float = 0.7) -> Tuple[np.ndarray, np.ndarray]:
    """均匀交叉"""
    if random.random() > crossover_rate:
        return parent1.copy(), parent2.copy()
    mask = np.random.random(N_PARAMS) < 0.5
    child1 = np.where(mask, parent1, parent2)
    child2 = np.where(mask, parent2, parent1)
    return child1, child2


def blx_alpha_crossover(parent1: np.ndarray, parent2: np.ndarray,
                        alpha: float = 0.3) -> Tuple[np.ndarray, np.ndarray]:
    """BLX-alpha交叉 — 允许超出父代范围, 探索更多空间"""
    lo = np.minimum(parent1, parent2)
    hi = np.maximum(parent1, parent2)
    span = hi - lo
    child1 = lo - alpha * span + np.random.random(N_PARAMS) * (1 + 2 * alpha) * span
    child2 = lo - alpha * span + np.random.random(N_PARAMS) * (1 + 2 * alpha) * span
    return np.clip(child1, 0, 1), np.clip(child2, 0, 1)


def gaussian_mutate(individual: np.ndarray, mutation_rate: float = 0.15,
                    sigma: float = 0.08) -> np.ndarray:
    """高斯变异"""
    child = individual.copy()
    for i in range(N_PARAMS):
        if random.random() < mutation_rate:
            child[i] += np.random.normal(0, sigma)
    return np.clip(child, 0, 1)


def adaptive_mutation(individual: np.ndarray, generation: int, max_gen: int,
                      base_rate: float = 0.20, base_sigma: float = 0.10) -> np.ndarray:
    """自适应变异 — 前期大步探索, 后期精细调优"""
    progress = generation / max(max_gen, 1)
    rate = base_rate * (1 - 0.6 * progress)    # 20% -> 8%
    sigma = base_sigma * (1 - 0.7 * progress)  # 10% -> 3%
    return gaussian_mutate(individual, rate, sigma)


# ============================================================
# Walk-Forward 验证
# ============================================================

def split_walk_forward(df: pd.DataFrame, train_ratio: float = 0.6) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """将数据按时间分割为训练集和测试集"""
    split_idx = int(len(df) * train_ratio)
    train = df.iloc[:split_idx].reset_index(drop=True)
    test = df.iloc[split_idx:].reset_index(drop=True)
    return train, test


def walk_forward_fitness(params: Dict,
                         fund_full_datasets: List[Tuple[pd.DataFrame, Optional[pd.DataFrame]]],
                         train_ratio: float = 0.6,
                         oos_penalty: float = 0.4) -> Tuple[float, float, float]:
    """
    Walk-Forward评估:
    1. 在训练集上计算IS (in-sample) fitness
    2. 在测试集上计算OOS (out-of-sample) fitness
    3. 最终分数 = (1-penalty)*IS + penalty*OOS
    4. 如果OOS远差于IS, 额外惩罚(过拟合惩罚)

    Returns: (combined_score, is_score, oos_score)
    """
    is_datasets = []
    oos_datasets = []

    for fund_df, market_df in fund_full_datasets:
        train_fund, test_fund = split_walk_forward(fund_df, train_ratio)
        if market_df is not None and len(market_df) > 0:
            train_mkt, test_mkt = split_walk_forward(market_df, train_ratio)
        else:
            train_mkt, test_mkt = None, None

        if len(train_fund) >= 60:
            is_datasets.append((train_fund, train_mkt))
        if len(test_fund) >= 30:
            oos_datasets.append((test_fund, test_mkt))

    is_score = fitness(params, is_datasets) if is_datasets else -10
    oos_score = fitness(params, oos_datasets) if oos_datasets else -10

    # 过拟合惩罚: IS远好于OOS时额外扣分
    overfit_gap = max(is_score - oos_score, 0)
    overfit_penalty = 0.3 * overfit_gap  # 差距越大惩罚越重

    combined = (1 - oos_penalty) * is_score + oos_penalty * oos_score - overfit_penalty
    return combined, is_score, oos_score


# ============================================================
# 遗传算法主循环
# ============================================================

def run_genetic_algorithm(
    fund_datasets: List[Tuple[pd.DataFrame, Optional[pd.DataFrame]]],
    pop_size: int = 50,
    n_generations: int = 40,
    elite_size: int = 5,
    crossover_rate: float = 0.7,
    use_walk_forward: bool = True,
    train_ratio: float = 0.6,
    verbose: bool = True,
) -> Tuple[Dict, float, List[Dict]]:
    """
    遗传算法主程序

    Returns: (best_params, best_fitness, generation_log)
    """
    # === 初始化种群 ===
    # 策略: LHS采样(70%) + 基线附近变异(20%) + 基线自身(10%)
    population = []

    # LHS采样
    n_lhs = int(pop_size * 0.7)
    lhs_samples = latin_hypercube_sample(n_lhs)
    population.extend(lhs_samples)

    # 基线附近变异
    baseline_vec = encode_params(BASELINE_PARAMS)
    n_near = int(pop_size * 0.2)
    for _ in range(n_near):
        perturbed = baseline_vec + np.random.normal(0, 0.05, N_PARAMS)
        population.append(np.clip(perturbed, 0, 1))

    # 基线自身
    n_base = pop_size - len(population)
    for _ in range(n_base):
        population.append(baseline_vec.copy())

    # 评估缓存 (避免重复计算)
    eval_cache = {}

    def get_cache_key(vec):
        return hashlib.md5(vec.tobytes()).hexdigest()[:16]

    def evaluate(vec):
        key = get_cache_key(vec)
        if key in eval_cache:
            return eval_cache[key]
        params = decode_params(vec)
        if use_walk_forward:
            combined, is_s, oos_s = walk_forward_fitness(params, fund_datasets, train_ratio)
            result = combined
        else:
            result = fitness(params, fund_datasets)
        eval_cache[key] = result
        return result

    # === 进化循环 ===
    gen_log = []
    best_ever_fitness = -999
    best_ever_vec = None
    stagnation = 0

    for gen in range(n_generations):
        t0 = time.time()

        # 评估适应度
        fitnesses = [evaluate(ind) for ind in population]

        # 排序
        sorted_indices = np.argsort(fitnesses)[::-1]
        best_idx = sorted_indices[0]
        gen_best = fitnesses[best_idx]
        gen_mean = np.mean(fitnesses)
        gen_std = np.std(fitnesses)

        # 记录
        best_params = decode_params(population[best_idx])
        elapsed = time.time() - t0

        if gen_best > best_ever_fitness:
            best_ever_fitness = gen_best
            best_ever_vec = population[best_idx].copy()
            stagnation = 0
        else:
            stagnation += 1

        gen_info = {
            'generation': gen,
            'best_fitness': round(gen_best, 4),
            'mean_fitness': round(gen_mean, 4),
            'std_fitness': round(gen_std, 4),
            'best_ever': round(best_ever_fitness, 4),
            'stagnation': stagnation,
            'cache_size': len(eval_cache),
            'elapsed_sec': round(elapsed, 1),
        }
        gen_log.append(gen_info)

        if verbose:
            print(f"  Gen {gen:3d} | best={gen_best:+.4f} mean={gen_mean:+.4f} "
                  f"std={gen_std:.4f} | ever={best_ever_fitness:+.4f} "
                  f"stag={stagnation} | {elapsed:.1f}s | cache={len(eval_cache)}")

        # 早停: 连续8代无改善
        if stagnation >= 8:
            if verbose:
                print(f"  [EARLY STOP] 连续{stagnation}代无改善, 提前终止")
            break

        # === 生成下一代 ===
        new_population = []

        # 精英保留
        for i in range(elite_size):
            new_population.append(population[sorted_indices[i]].copy())

        # 如果停滞, 注入随机个体增加多样性
        if stagnation >= 4:
            n_random = max(3, pop_size // 10)
            random_inds = latin_hypercube_sample(n_random)
            new_population.extend(random_inds)
            if verbose:
                print(f"    [DIVERSITY] 注入{n_random}个随机个体")

        # 交叉 + 变异填充剩余
        while len(new_population) < pop_size:
            p1 = tournament_select(population, fitnesses, k=3)
            p2 = tournament_select(population, fitnesses, k=3)

            # 交替使用两种交叉策略
            if random.random() < 0.5:
                c1, c2 = uniform_crossover(p1, p2, crossover_rate)
            else:
                c1, c2 = blx_alpha_crossover(p1, p2, alpha=0.25)

            c1 = adaptive_mutation(c1, gen, n_generations)
            c2 = adaptive_mutation(c2, gen, n_generations)

            new_population.append(c1)
            if len(new_population) < pop_size:
                new_population.append(c2)

        population = new_population[:pop_size]

    # === 最终结果 ===
    best_params = decode_params(best_ever_vec)
    return best_params, best_ever_fitness, gen_log


# ============================================================
# 详细回测报告
# ============================================================

def detailed_evaluation(params: Dict,
                        fund_datasets: List[Tuple[str, str, pd.DataFrame, Optional[pd.DataFrame]]],
                        train_ratio: float = 0.6) -> Dict:
    """对最优参数进行详细评估, 分别报告IS和OOS"""
    strategy = ParameterizedV8Strategy(params)
    results = {'in_sample': [], 'out_of_sample': [], 'full': []}

    for code, name, fund_df, market_df in fund_datasets:
        # 全量
        perf_full = run_backtest(strategy, fund_df, market_df)
        perf_full['fund'] = name
        perf_full['code'] = code
        results['full'].append(perf_full)

        # 训练/测试分割
        train_fund, test_fund = split_walk_forward(fund_df, train_ratio)
        if market_df is not None and len(market_df) > 0:
            train_mkt, test_mkt = split_walk_forward(market_df, train_ratio)
        else:
            train_mkt, test_mkt = None, None

        if len(train_fund) >= 60:
            perf_is = run_backtest(strategy, train_fund, train_mkt)
            perf_is['fund'] = name
            results['in_sample'].append(perf_is)

        if len(test_fund) >= 30:
            perf_oos = run_backtest(strategy, test_fund, test_mkt)
            perf_oos['fund'] = name
            results['out_of_sample'].append(perf_oos)

    return results


# ============================================================
# 主程序
# ============================================================

def main():
    parser = argparse.ArgumentParser(description='遗传算法参数优化器 v8.1')
    parser.add_argument('--fast', action='store_true', help='快速模式(20种群x15代)')
    parser.add_argument('--pop', type=int, default=50, help='种群大小')
    parser.add_argument('--gen', type=int, default=40, help='代数')
    parser.add_argument('--days', type=int, default=1500, help='历史数据天数(默认1500=约6年)')
    parser.add_argument('--no-wf', action='store_true', help='禁用walk-forward(仅调试)')
    parser.add_argument('--seed', type=int, default=42, help='随机种子')
    parser.add_argument('--funds', type=int, default=8, help='使用基金数(减少可加速)')
    args = parser.parse_args()

    if args.fast:
        args.pop = 20
        args.gen = 15
        args.funds = 5

    np.random.seed(args.seed)
    random.seed(args.seed)

    print("=" * 70)
    print("  遗传算法参数优化器 — v8.1信号权重搜索")
    print(f"  种群={args.pop} 代数={args.gen} 数据天数={args.days}")
    print(f"  搜索参数数={N_PARAMS} Walk-Forward={'ON' if not args.no_wf else 'OFF'}")
    print(f"  预估评估次数: ~{args.pop * args.gen}")
    print("=" * 70)

    # === 1. 获取数据 ===
    print("\n[Phase 1] 获取历史数据...")

    # 选取覆盖不同板块的代表性基金
    ALL_FUNDS = [
        ('000217', '华安黄金ETF联接C'),
        ('020982', '华安机器人产业C'),
        ('019671', '广发港股创新药C'),
        ('010572', '易方达生物科技C'),
        ('002611', '博时黄金ETF联接C'),
        ('018897', '易方达消费电子C'),
        ('023408', '华宝创业板AI C'),
        ('012365', '广发光伏产业C'),
        ('022365', '永赢科技智选C'),
        ('025209', '永赢半导体智选C'),
        ('004753', '广发传媒ETF联接C'),
        ('008888', '华夏半导体芯片C'),
        ('012832', '南方新能源ETF联接C'),
        ('010990', '南方有色金属ETF联接E'),
    ]

    use_funds = ALL_FUNDS[:args.funds]

    # 获取市场基准
    print("  获取沪深300基金作为市场基准...")
    market_df = fetch_fund_nav_history('000051', args.days)
    if len(market_df) > 0:
        market_df['close'] = market_df['nav']
    print(f"  市场基准: {len(market_df)} 天")

    fund_datasets_for_ga = []       # (fund_df, market_df) for GA
    fund_datasets_for_report = []   # (code, name, fund_df, market_df) for report

    for code, name in use_funds:
        print(f"  获取 {name}({code})...")
        df = fetch_fund_nav_history(code, args.days)
        if len(df) >= 120:
            fund_datasets_for_ga.append((df, market_df))
            fund_datasets_for_report.append((code, name, df, market_df))
            print(f"    OK: {len(df)} 天 ({df['date'].iloc[0].strftime('%Y-%m-%d')} ~ {df['date'].iloc[-1].strftime('%Y-%m-%d')})")
        else:
            print(f"    SKIP: 数据不足({len(df)}天)")

    if not fund_datasets_for_ga:
        print("ERROR: 无法获取任何基金数据")
        return

    print(f"\n  共{len(fund_datasets_for_ga)}只基金参与优化")

    # === 2. 基线评估 ===
    print("\n[Phase 2] 评估v8.1基线参数...")
    if not args.no_wf:
        bl_combined, bl_is, bl_oos = walk_forward_fitness(BASELINE_PARAMS, fund_datasets_for_ga)
        print(f"  基线 Walk-Forward: combined={bl_combined:.4f} IS={bl_is:.4f} OOS={bl_oos:.4f}")
    else:
        bl_full = fitness(BASELINE_PARAMS, fund_datasets_for_ga)
        print(f"  基线 Full: fitness={bl_full:.4f}")

    # === 3. 遗传算法 ===
    print(f"\n[Phase 3] 遗传算法搜索 ({args.pop}种群 x {args.gen}代)...")
    t_start = time.time()

    best_params, best_fit, gen_log = run_genetic_algorithm(
        fund_datasets=fund_datasets_for_ga,
        pop_size=args.pop,
        n_generations=args.gen,
        elite_size=max(3, args.pop // 10),
        use_walk_forward=not args.no_wf,
        train_ratio=0.6,
        verbose=True,
    )

    t_elapsed = time.time() - t_start
    print(f"\n  搜索完成! 耗时 {t_elapsed/60:.1f} 分钟")
    print(f"  最优适应度: {best_fit:.4f}")

    # === 4. 详细评估 ===
    print("\n[Phase 4] 最优参数详细回测...")
    report = detailed_evaluation(best_params, fund_datasets_for_report)

    # === 5. 输出结果 ===
    print("\n" + "=" * 70)
    print("  最优参数 vs 基线对比")
    print("=" * 70)

    print("\n参数变化:")
    for name in PARAM_NAMES:
        old = BASELINE_PARAMS.get(name, '?')
        new = best_params.get(name, '?')
        if isinstance(old, float) and isinstance(new, float):
            delta = new - old
            pct = delta / abs(old) * 100 if old != 0 else 0
            marker = "  <<<" if abs(pct) > 20 else ""
            print(f"  {name:30s}: {old:8.4f} -> {new:8.4f} ({delta:+.4f}, {pct:+.1f}%){marker}")
        else:
            print(f"  {name:30s}: {old} -> {new}")

    # 汇总绩效
    for period, label in [('full', '全量'), ('in_sample', '训练集(IS)'), ('out_of_sample', '测试集(OOS)')]:
        perfs = report[period]
        if not perfs:
            continue
        avg_sharpe = np.mean([p['sharpe'] for p in perfs])
        avg_calmar = np.mean([p['calmar'] for p in perfs])
        avg_ret = np.mean([p['total_return'] for p in perfs])
        avg_dd = np.mean([p['max_drawdown'] for p in perfs])
        print(f"\n  [{label}] 平均夏普={avg_sharpe:.3f} 卡尔玛={avg_calmar:.3f} "
              f"收益={avg_ret:.2f}% 回撤={avg_dd:.2f}%")

    # 过拟合检查
    if report['in_sample'] and report['out_of_sample']:
        is_sharpe = np.mean([p['sharpe'] for p in report['in_sample']])
        oos_sharpe = np.mean([p['sharpe'] for p in report['out_of_sample']])
        degradation = (is_sharpe - oos_sharpe) / max(abs(is_sharpe), 0.01) * 100
        print(f"\n  [过拟合检查] IS夏普={is_sharpe:.3f} OOS夏普={oos_sharpe:.3f} "
              f"衰减={degradation:.1f}%")
        if degradation > 30:
            print("  WARNING: OOS衰减>30%, 存在过拟合风险!")
        elif degradation > 15:
            print("  CAUTION: OOS衰减>15%, 轻度过拟合")
        else:
            print("  GOOD: OOS衰减<15%, 泛化性良好")

    # 逐基金明细
    print(f"\n  逐基金全量回测明细:")
    print(f"  {'基金':20s} {'夏普':>8s} {'卡尔玛':>8s} {'收益%':>8s} {'回撤%':>8s} {'胜率%':>8s}")
    print(f"  {'-'*60}")
    for p in report['full']:
        print(f"  {p.get('fund','?'):20s} {p['sharpe']:8.3f} {p['calmar']:8.3f} "
              f"{p['total_return']:8.2f} {p['max_drawdown']:8.2f} {p['win_rate']:8.1f}")

    # === 6. 保存结果 ===
    output = {
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'config': {
            'pop_size': args.pop,
            'n_generations': args.gen,
            'data_days': args.days,
            'n_funds': len(fund_datasets_for_ga),
            'walk_forward': not args.no_wf,
            'train_ratio': 0.6,
            'seed': args.seed,
        },
        'baseline_params': {k: BASELINE_PARAMS[k] for k in PARAM_NAMES},
        'best_params': best_params,
        'best_fitness': best_fit,
        'generation_log': gen_log,
        'detailed_results': {
            period: [
                {k: (v if not isinstance(v, (pd.Timestamp, np.floating)) else str(v))
                 for k, v in p.items()}
                for p in perfs
            ]
            for period, perfs in report.items()
        },
        'elapsed_minutes': round(t_elapsed / 60, 1),
    }

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ga_optimization_results.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n  结果已保存: {output_path}")

    # 生成可直接粘贴的参数代码
    print("\n" + "=" * 70)
    print("  可直接用于 strategy_local_v81.py 的参数:")
    print("=" * 70)
    print("  default = {")
    for name in PARAM_NAMES:
        val = best_params[name]
        comment = f"  # 基线: {BASELINE_PARAMS.get(name, '?')}"
        if isinstance(val, int):
            print(f"      '{name}': {val},{comment}")
        else:
            print(f"      '{name}': {val},{comment}")
    print("  }")


if __name__ == '__main__':
    main()
