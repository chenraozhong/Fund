#!/usr/bin/env python3
"""
竞技裁判 - 增强版回测对抗引擎 v2
==========================================
8策略全面对抗 + 锦标赛淘汰 + 交叉验证 + 板块分析 + 决策模型评估
"""

import os
import sys

# 必须在 import urllib 之前清除代理
for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

import json
import math
import copy
import time as _time
from datetime import datetime
from typing import List, Dict, Tuple, Optional
import numpy as np
import pandas as pd

# 导入基础引擎
sys.path.insert(0, os.path.dirname(__file__))
from backtest_engine import (
    Strategy, OriginalStrategy, MacroDefensiveStrategy,
    AggressiveEventStrategy, AdaptiveHybridStrategy,
    run_backtest, calc_performance, mutate_params,
    fetch_fund_nav_history, fetch_index_history,
)

# 尝试导入新策略（可能还未创建完毕）
try:
    from strategy_trend_hunter import TrendHunterStrategy
except ImportError:
    TrendHunterStrategy = None

try:
    from strategy_mean_reversion import MeanReversionStrategy
except ImportError:
    MeanReversionStrategy = None

try:
    from strategy_macro_shield import MacroShieldStrategy
except ImportError:
    MacroShieldStrategy = None

try:
    from strategy_multi_resonance import MultiResonanceStrategy
except ImportError:
    MultiResonanceStrategy = None


# ============================================================
# 常量定义
# ============================================================

TEST_FUNDS = [
    ('000217', '华安黄金ETF联接C'), ('020982', '华安国证机器人产业指数C'),
    ('019671', '广发港股创新药ETF联接C'), ('010572', '易方达中证万得生物科技C'),
    ('002611', '博时黄金ETF联接C'), ('004253', '国泰黄金ETF联接C'),
    ('018897', '易方达消费电子ETF联接C'), ('023408', '华宝创业板AI ETF联接C'),
    ('012365', '广发中证光伏产业指数C'), ('022365', '永赢科技智选混合C'),
    ('019325', '易方达中证生物科技ETF联接C'), ('025209', '永赢先锋半导体智选混合C'),
    ('016387', '永赢低碳环保智选混合C'), ('024195', '永赢国证商用卫星通信C'),
    ('004753', '广发中证传媒ETF联接C'), ('016874', '广发远见智选混合C'),
    ('017074', '嘉实清洁能源股票C'), ('010990', '南方有色金属ETF联接E'),
    ('012832', '南方中证新能源ETF联接C'), ('011036', '嘉实中证稀土产业ETF联接C'),
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

# 反向映射: code -> sector
CODE_TO_SECTOR = {}
for sector, codes in SECTOR_MAP.items():
    for code in codes:
        CODE_TO_SECTOR[code] = sector

# 综合评分权重
SCORE_WEIGHTS = {
    'sharpe': 0.30,
    'total_return': 0.20,
    'max_drawdown': 0.15,  # 取反后越大越好
    'calmar': 0.15,
    'crash_avoidance': 0.10,
    'win_rate': 0.10,
}

# 决策模型四维权重组合
DECISION_WEIGHT_COMBOS = {
    '均衡型': {'技术': 0.30, '基本面': 0.25, '市场': 0.25, '动量': 0.20},
    '技术主导': {'技术': 0.50, '基本面': 0.15, '市场': 0.15, '动量': 0.20},
    '防御优先': {'技术': 0.20, '基本面': 0.20, '市场': 0.40, '动量': 0.20},
    '动量追踪': {'技术': 0.25, '基本面': 0.10, '市场': 0.15, '动量': 0.50},
    '价值回归': {'技术': 0.15, '基本面': 0.45, '市场': 0.20, '动量': 0.20},
}


# ============================================================
# 工具函数
# ============================================================

def print_divider(char='=', width=72):
    print(char * width)


def print_header(title: str, width=72):
    print()
    print_divider('=', width)
    padding = (width - len(title) - 4) // 2
    print(f"{'=' * 2} {' ' * padding}{title}{' ' * (width - padding - len(title) - 4)} {'=' * 2}")
    print_divider('=', width)


def print_table_row(columns: list, widths: list, align: list = None):
    """打印表格行"""
    if align is None:
        align = ['<'] * len(columns)
    parts = []
    for col, w, a in zip(columns, widths, align):
        s = str(col)
        if a == '>':
            parts.append(s.rjust(w))
        elif a == '^':
            parts.append(s.center(w))
        else:
            parts.append(s.ljust(w))
    print('  ' + ' | '.join(parts))


def normalize_metric(values: list, higher_is_better: bool = True) -> list:
    """将指标归一化到 [0, 1] 范围"""
    if not values:
        return []
    min_v = min(values)
    max_v = max(values)
    if max_v == min_v:
        return [0.5] * len(values)
    normalized = [(v - min_v) / (max_v - min_v) for v in values]
    if not higher_is_better:
        normalized = [1.0 - n for n in normalized]
    return normalized


def calc_composite_score(perf: Dict) -> float:
    """计算单基金的综合评分 (用于排名前的原始值累加，最终归一化在外部做)"""
    return {
        'sharpe': perf.get('sharpe', 0),
        'total_return': perf.get('total_return', 0),
        'max_drawdown': perf.get('max_drawdown', 0),
        'calmar': perf.get('calmar', 0),
        'crash_avoidance': perf.get('crash_avoidance', 0),
        'win_rate': perf.get('win_rate', 0),
    }


def calc_strategy_composite(avg_metrics: Dict) -> float:
    """
    根据多维指标计算策略综合得分。
    avg_metrics 包含各指标的平均值，此函数用于单策略打分（绝对值）。
    最终排名时需要跨策略归一化。
    """
    # 简单加权（绝对值），由外部归一化
    score = 0.0
    score += avg_metrics.get('sharpe', 0) * SCORE_WEIGHTS['sharpe'] * 100
    score += avg_metrics.get('total_return', 0) * SCORE_WEIGHTS['total_return']
    # max_drawdown 是负数，取反：回撤越小越好
    score += (-avg_metrics.get('max_drawdown', 0)) * SCORE_WEIGHTS['max_drawdown']
    score += avg_metrics.get('calmar', 0) * SCORE_WEIGHTS['calmar'] * 10
    score += avg_metrics.get('crash_avoidance', 0) * SCORE_WEIGHTS['crash_avoidance'] * 100
    score += avg_metrics.get('win_rate', 0) * SCORE_WEIGHTS['win_rate']
    return round(score, 4)


def json_serializer(obj):
    """JSON序列化辅助"""
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.ndarray,)):
        return obj.tolist()
    if isinstance(obj, pd.Timestamp):
        return str(obj)
    if isinstance(obj, (datetime,)):
        return obj.isoformat()
    return str(obj)


# ============================================================
# 策略实例化工厂
# ============================================================

def create_strategy_instance(strategy_class, params=None, name_override=None):
    """安全创建策略实例"""
    if strategy_class is None:
        return None
    try:
        if params:
            instance = strategy_class(params)
        else:
            instance = strategy_class()
        if name_override:
            instance.name = name_override
        return instance
    except Exception as e:
        print(f"  [警告] 创建策略 {strategy_class.__name__} 失败: {e}")
        return None


def clone_strategy(strategy: Strategy, new_params: Dict, name_suffix: str = '') -> Optional[Strategy]:
    """克隆策略并替换参数"""
    class_map = {
        'OriginalStrategy': OriginalStrategy,
        'MacroDefensiveStrategy': MacroDefensiveStrategy,
        'AggressiveEventStrategy': AggressiveEventStrategy,
        'AdaptiveHybridStrategy': AdaptiveHybridStrategy,
    }
    # 新策略类
    if TrendHunterStrategy is not None:
        class_map['TrendHunterStrategy'] = TrendHunterStrategy
    if MeanReversionStrategy is not None:
        class_map['MeanReversionStrategy'] = MeanReversionStrategy
    if MacroShieldStrategy is not None:
        class_map['MacroShieldStrategy'] = MacroShieldStrategy
    if MultiResonanceStrategy is not None:
        class_map['MultiResonanceStrategy'] = MultiResonanceStrategy

    cls_name = type(strategy).__name__
    cls = class_map.get(cls_name)
    if cls is None:
        # 回退: 用基类包装
        new_strat = copy.deepcopy(strategy)
        new_strat.params = new_params
        new_strat.name = strategy.name + name_suffix
        return new_strat

    new_strat = cls(new_params)
    new_strat.name = strategy.name + name_suffix
    return new_strat


# ============================================================
# 核心: 全面回测一个策略列表
# ============================================================

def backtest_all_strategies(strategies: List[Strategy],
                            fund_data: Dict,
                            market_df: pd.DataFrame,
                            silent: bool = False) -> List[Dict]:
    """
    对所有策略 x 所有基金进行回测，返回每个策略的汇总结果。
    返回: [{strategy_name, strategy_obj, avg_metrics, fund_details, composite_score}, ...]
    """
    results = []
    for strat in strategies:
        fund_perfs = []
        for code, (name, df) in fund_data.items():
            try:
                perf = run_backtest(strat, df, market_df)
                perf['fund'] = name
                perf['code'] = code
                perf['sector'] = CODE_TO_SECTOR.get(code, '未知')
                fund_perfs.append(perf)
            except Exception as e:
                if not silent:
                    print(f"  [警告] {strat.name} 回测 {name}({code}) 失败: {e}")

        if not fund_perfs:
            continue

        avg_metrics = {
            'sharpe': round(np.mean([r['sharpe'] for r in fund_perfs]), 3),
            'total_return': round(np.mean([r['total_return'] for r in fund_perfs]), 2),
            'max_drawdown': round(np.mean([r['max_drawdown'] for r in fund_perfs]), 2),
            'calmar': round(np.mean([r['calmar'] for r in fund_perfs]), 3),
            'crash_avoidance': round(np.mean([r.get('crash_avoidance', 0) for r in fund_perfs]), 3),
            'win_rate': round(np.mean([r['win_rate'] for r in fund_perfs]), 1),
            'annual_return': round(np.mean([r.get('annual_return', 0) for r in fund_perfs]), 2),
        }

        composite = calc_strategy_composite(avg_metrics)

        results.append({
            'strategy_name': strat.name,
            'strategy_obj': strat,
            'avg_metrics': avg_metrics,
            'fund_details': fund_perfs,
            'composite_score': composite,
        })

    # 按综合得分排序
    results.sort(key=lambda x: x['composite_score'], reverse=True)
    return results


# ============================================================
# 单项排名输出
# ============================================================

def print_single_metric_rankings(results: List[Dict]):
    """输出各单项指标排名"""
    metrics_info = [
        ('sharpe', '夏普比率', True),
        ('total_return', '总收益率(%)', True),
        ('max_drawdown', '最大回撤(%)', False),   # 越小越好(越接近0)
        ('calmar', '卡尔玛比率', True),
        ('crash_avoidance', '逃顶能力(%)', True),
        ('win_rate', '胜率(%)', True),
    ]

    print("\n  ── 单项排名 ──")
    for metric_key, metric_name, higher_better in metrics_info:
        ranked = sorted(results,
                        key=lambda x: x['avg_metrics'].get(metric_key, 0),
                        reverse=higher_better)
        top3 = ranked[:3]
        medals = ['[冠]', '[亚]', '[季]']
        items = []
        for i, r in enumerate(top3):
            val = r['avg_metrics'].get(metric_key, 0)
            items.append(f"{medals[i]}{r['strategy_name']}({val})")
        print(f"  {metric_name:12s}: {' > '.join(items)}")


# ============================================================
# 综合排名输出
# ============================================================

def print_composite_rankings(results: List[Dict], title: str = '综合排名'):
    """打印综合排名表"""
    print(f"\n  ── {title} ──")
    widths = [4, 16, 8, 9, 9, 8, 8, 7, 8]
    headers = ['名次', '策略名称', '综合分', '夏普', '收益(%)', '回撤(%)', '卡尔玛', '逃顶', '胜率(%)']
    aligns = ['^', '<', '>', '>', '>', '>', '>', '>', '>']
    print_table_row(headers, widths, aligns)
    print('  ' + '-' * (sum(widths) + 3 * (len(widths) - 1)))

    medals = ['[冠军]', '[亚军]', '[季军]', '[第4]', '[第5]', '[第6]', '[第7]', '[第8]']
    for i, r in enumerate(results):
        m = r['avg_metrics']
        rank_label = medals[i] if i < len(medals) else f'[{i+1}]'
        print_table_row(
            [rank_label, r['strategy_name'],
             f"{r['composite_score']:.2f}",
             f"{m['sharpe']:.3f}",
             f"{m['total_return']:.2f}",
             f"{m['max_drawdown']:.2f}",
             f"{m['calmar']:.3f}",
             f"{m.get('crash_avoidance',0):.3f}",
             f"{m['win_rate']:.1f}"],
            widths, aligns
        )


# ============================================================
# 锦标赛制淘汰
# ============================================================

def run_tournament(strategies: List[Strategy],
                   fund_data: Dict,
                   market_df: pd.DataFrame) -> List[Dict]:
    """
    三轮锦标赛淘汰:
    R1: 8策略全回测，淘汰后4名
    R2: 前4名 x 3变体 = 12个Agent，淘汰至前4
    R3: 前4名 x 5变体(精细) = 20个Agent，选出冠军
    """

    # ── 第1轮 ──
    print_header('第1轮: 8策略全面对抗')
    r1_results = backtest_all_strategies(strategies, fund_data, market_df)
    print_composite_rankings(r1_results, '第1轮排名')
    print_single_metric_rankings(r1_results)

    # 淘汰后半
    half = max(len(r1_results) // 2, 2)
    survivors_r1 = r1_results[:half]
    eliminated_r1 = r1_results[half:]

    print(f"\n  >> 晋级({len(survivors_r1)}): {', '.join(r['strategy_name'] for r in survivors_r1)}")
    print(f"  >> 淘汰({len(eliminated_r1)}): {', '.join(r['strategy_name'] for r in eliminated_r1)}")

    # ── 第2轮: 变异扩充 ──
    print_header('第2轮: 参数变异对抗 (mutation_rate=0.15)')
    r2_strategies = []
    for r in survivors_r1:
        strat = r['strategy_obj']
        r2_strategies.append(strat)  # 保留原版
        for v_idx in range(3):
            mutated_p = mutate_params(strat.params, mutation_rate=0.15)
            variant = clone_strategy(strat, mutated_p, f'_v{v_idx+1}')
            if variant:
                r2_strategies.append(variant)

    print(f"  参赛Agent数: {len(r2_strategies)}")
    r2_results = backtest_all_strategies(r2_strategies, fund_data, market_df, silent=True)
    print_composite_rankings(r2_results[:8], '第2轮排名(前8)')

    survivors_r2 = r2_results[:4]
    print(f"\n  >> 晋级(4): {', '.join(r['strategy_name'] for r in survivors_r2)}")

    # ── 第3轮: 精细变异 ──
    print_header('第3轮: 精细变异决赛 (mutation_rate=0.05)')
    r3_strategies = []
    for r in survivors_r2:
        strat = r['strategy_obj']
        r3_strategies.append(strat)
        for v_idx in range(5):
            mutated_p = mutate_params(strat.params, mutation_rate=0.05)
            variant = clone_strategy(strat, mutated_p, f'_f{v_idx+1}')
            if variant:
                r3_strategies.append(variant)

    print(f"  参赛Agent数: {len(r3_strategies)}")
    r3_results = backtest_all_strategies(r3_strategies, fund_data, market_df, silent=True)
    print_composite_rankings(r3_results[:8], '第3轮决赛排名(前8)')

    champion = r3_results[0] if r3_results else None
    if champion:
        print(f"\n  *** 最终冠军: {champion['strategy_name']} ***")
        m = champion['avg_metrics']
        print(f"      综合分: {champion['composite_score']:.2f}")
        print(f"      夏普: {m['sharpe']:.3f} | 收益: {m['total_return']:.2f}% | 回撤: {m['max_drawdown']:.2f}%")
        print(f"      卡尔玛: {m['calmar']:.3f} | 逃顶: {m.get('crash_avoidance',0):.3f}% | 胜率: {m['win_rate']:.1f}%")

    return r3_results


# ============================================================
# 交叉验证
# ============================================================

def run_cross_validation(strategies: List[Strategy],
                         fund_data: Dict,
                         market_df: pd.DataFrame,
                         n_groups: int = 3) -> Dict:
    """
    交叉验证: 将21只基金分3组，轮流做测试集
    返回每个策略在验证集上的平均绩效
    """
    print_header('交叉验证 (3-Fold)')

    codes = list(fund_data.keys())
    np.random.seed(42)
    np.random.shuffle(codes)

    # 分组
    groups = []
    group_size = len(codes) // n_groups
    for g in range(n_groups):
        start = g * group_size
        end = start + group_size if g < n_groups - 1 else len(codes)
        groups.append(codes[start:end])

    print(f"  基金总数: {len(codes)}, 分为 {n_groups} 组")
    for g_idx, g_codes in enumerate(groups):
        names = [fund_data[c][0] for c in g_codes]
        print(f"  第{g_idx+1}组({len(g_codes)}只): {', '.join(names[:3])}...")

    # 对每个策略做交叉验证
    cv_results = {}
    for strat in strategies:
        fold_scores = []
        for test_idx in range(n_groups):
            # 测试集
            test_codes = groups[test_idx]
            # 训练集(其他组) - 这里用训练集的回测结果来选参数
            train_codes = [c for g_idx, g in enumerate(groups) if g_idx != test_idx for c in g]

            # 在训练集上回测得到基线
            train_data = {c: fund_data[c] for c in train_codes if c in fund_data}
            train_results = []
            for code, (name, df) in train_data.items():
                try:
                    perf = run_backtest(strat, df, market_df)
                    train_results.append(perf)
                except Exception:
                    pass

            # 在测试集上验证
            test_data = {c: fund_data[c] for c in test_codes if c in fund_data}
            test_results = []
            for code, (name, df) in test_data.items():
                try:
                    perf = run_backtest(strat, df, market_df)
                    test_results.append(perf)
                except Exception:
                    pass

            if test_results:
                fold_sharpe = np.mean([r['sharpe'] for r in test_results])
                fold_return = np.mean([r['total_return'] for r in test_results])
                fold_dd = np.mean([r['max_drawdown'] for r in test_results])
                fold_scores.append({
                    'fold': test_idx + 1,
                    'sharpe': fold_sharpe,
                    'total_return': fold_return,
                    'max_drawdown': fold_dd,
                    'n_test': len(test_results),
                })

        if fold_scores:
            avg_cv_sharpe = np.mean([f['sharpe'] for f in fold_scores])
            std_cv_sharpe = np.std([f['sharpe'] for f in fold_scores])
            avg_cv_return = np.mean([f['total_return'] for f in fold_scores])
            avg_cv_dd = np.mean([f['max_drawdown'] for f in fold_scores])

            cv_results[strat.name] = {
                'avg_sharpe': round(avg_cv_sharpe, 3),
                'std_sharpe': round(std_cv_sharpe, 3),
                'avg_return': round(avg_cv_return, 2),
                'avg_drawdown': round(avg_cv_dd, 2),
                'folds': fold_scores,
                'overfit_risk': '高' if std_cv_sharpe > 0.5 else ('中' if std_cv_sharpe > 0.2 else '低'),
            }

    # 输出
    widths = [16, 10, 10, 10, 10, 8]
    headers = ['策略', '平均夏普', '夏普标准差', '平均收益(%)', '平均回撤(%)', '过拟合风险']
    aligns = ['<', '>', '>', '>', '>', '^']
    print()
    print_table_row(headers, widths, aligns)
    print('  ' + '-' * (sum(widths) + 3 * (len(widths) - 1)))

    sorted_cv = sorted(cv_results.items(), key=lambda x: x[1]['avg_sharpe'], reverse=True)
    for name, cv in sorted_cv:
        print_table_row(
            [name, f"{cv['avg_sharpe']:.3f}", f"{cv['std_sharpe']:.3f}",
             f"{cv['avg_return']:.2f}", f"{cv['avg_drawdown']:.2f}", cv['overfit_risk']],
            widths, aligns
        )

    return cv_results


# ============================================================
# 板块分析
# ============================================================

def run_sector_analysis(strategies: List[Strategy],
                        fund_data: Dict,
                        market_df: pd.DataFrame) -> Dict:
    """按板块统计各策略表现"""
    print_header('板块分析')

    sector_perf = {}  # {strategy_name: {sector: {metrics}}}

    for strat in strategies:
        sector_perf[strat.name] = {}
        for sector, codes in SECTOR_MAP.items():
            sector_results = []
            for code in codes:
                if code not in fund_data:
                    continue
                name, df = fund_data[code]
                try:
                    perf = run_backtest(strat, df, market_df)
                    sector_results.append(perf)
                except Exception:
                    pass

            if sector_results:
                sector_perf[strat.name][sector] = {
                    'sharpe': round(np.mean([r['sharpe'] for r in sector_results]), 3),
                    'total_return': round(np.mean([r['total_return'] for r in sector_results]), 2),
                    'max_drawdown': round(np.mean([r['max_drawdown'] for r in sector_results]), 2),
                    'n_funds': len(sector_results),
                }

    # 输出: 每个策略的板块强弱
    sectors = list(SECTOR_MAP.keys())
    for strat_name, sp in sector_perf.items():
        print(f"\n  [{strat_name}] 板块表现:")
        widths_s = [12, 8, 10, 10, 6]
        headers_s = ['板块', '夏普', '收益(%)', '回撤(%)', '基金数']
        aligns_s = ['<', '>', '>', '>', '>']
        print_table_row(headers_s, widths_s, aligns_s)
        print('  ' + '-' * (sum(widths_s) + 3 * (len(widths_s) - 1)))

        sorted_sectors = sorted(sp.items(), key=lambda x: x[1]['sharpe'], reverse=True)
        for sector_name, metrics in sorted_sectors:
            indicator = '[强]' if metrics['sharpe'] > 0.3 else ('[中]' if metrics['sharpe'] > 0 else '[弱]')
            print_table_row(
                [f"{indicator}{sector_name}", f"{metrics['sharpe']:.3f}",
                 f"{metrics['total_return']:.2f}", f"{metrics['max_drawdown']:.2f}",
                 str(metrics['n_funds'])],
                widths_s, aligns_s
            )

        if sorted_sectors:
            best_sector = sorted_sectors[0][0]
            worst_sector = sorted_sectors[-1][0]
            print(f"  >> 最强板块: {best_sector} | 最弱板块: {worst_sector}")

    # 汇总: 各板块的最佳策略
    print(f"\n  ── 各板块最佳策略 ──")
    for sector in sectors:
        best_strat = None
        best_sharpe = -999
        for strat_name, sp in sector_perf.items():
            if sector in sp and sp[sector]['sharpe'] > best_sharpe:
                best_sharpe = sp[sector]['sharpe']
                best_strat = strat_name
        if best_strat:
            print(f"  {sector:12s} -> {best_strat} (夏普={best_sharpe:.3f})")

    return sector_perf


# ============================================================
# 决策模型评估 (模拟四维评分)
# ============================================================

def run_decision_model_eval(strategies: List[Strategy],
                            fund_data: Dict,
                            market_df: pd.DataFrame) -> Dict:
    """
    模拟 strategy.ts 中的四维评分体系:
    技术维(RSI/MACD/布林) / 基本面近似(均线趋势/回撤) / 市场维(大盘) / 动量维(短期涨跌)
    对比不同权重组合的效果
    """
    print_header('决策模型四维评估')

    # 对每只基金, 用不同权重组合模拟决策信号
    combo_results = {}

    for combo_name, weights in DECISION_WEIGHT_COMBOS.items():
        combo_perfs = []
        for code, (name, df) in fund_data.items():
            if len(df) < 60:
                continue

            navs = df['nav'].values
            daily_returns_list = []

            for i in range(30, len(df)):
                nav_slice = navs[:i+1]
                current = nav_slice[-1]

                # 技术维: RSI + MACD简化
                from backtest_engine import calc_rsi, calc_macd, calc_bollinger
                rsi_s = calc_rsi(pd.Series(nav_slice), 14)
                rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
                tech_score = 0
                if rsi < 30:
                    tech_score = 0.6
                elif rsi < 40:
                    tech_score = 0.3
                elif rsi > 70:
                    tech_score = -0.6
                elif rsi > 60:
                    tech_score = -0.3

                dif_s, dea_s, hist_s = calc_macd(pd.Series(nav_slice))
                hist = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
                if hist > 0:
                    tech_score += 0.2
                else:
                    tech_score -= 0.2

                # 基本面近似维: 均线排列 + 偏离
                ma5 = np.mean(nav_slice[-5:])
                ma20 = np.mean(nav_slice[-20:])
                fundamental_score = 0
                dev = (current - ma20) / ma20 * 100
                if current > ma20:
                    fundamental_score += 0.3
                else:
                    fundamental_score -= 0.3
                if abs(dev) > 3:
                    fundamental_score -= 0.2 * np.sign(dev)  # 过度偏离反转

                # 市场维: 大盘趋势
                market_score = 0
                if market_df is not None and i < len(market_df):
                    mkt_change = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
                    market_score = np.clip(mkt_change / 2.0, -1, 1)

                # 动量维: 近5日涨幅
                mom_score = 0
                if len(nav_slice) >= 6:
                    ret_5d = (nav_slice[-1] / nav_slice[-6] - 1) * 100
                    mom_score = np.clip(ret_5d / 3.0, -1, 1)

                # 加权合成
                signal = (tech_score * weights['技术'] +
                          fundamental_score * weights['基本面'] +
                          market_score * weights['市场'] +
                          mom_score * weights['动量'])

                daily_returns_list.append(signal)

            # 将信号转为模拟收益(信号方向 x 实际涨跌)
            actual_returns = df['nav'].pct_change().iloc[30:].values
            if len(daily_returns_list) == len(actual_returns):
                # 策略收益 = 信号仓位 x 实际涨跌
                signal_arr = np.array(daily_returns_list)
                position = np.clip(signal_arr, -1, 1)
                strat_returns = position * actual_returns
                perf = calc_performance(pd.Series(strat_returns))
                perf['fund'] = name
                combo_perfs.append(perf)

        if combo_perfs:
            combo_results[combo_name] = {
                'avg_sharpe': round(np.mean([r['sharpe'] for r in combo_perfs]), 3),
                'avg_return': round(np.mean([r['total_return'] for r in combo_perfs]), 2),
                'avg_drawdown': round(np.mean([r['max_drawdown'] for r in combo_perfs]), 2),
                'weights': weights,
            }

    # 输出
    widths_d = [12, 8, 10, 10, 32]
    headers_d = ['组合名称', '夏普', '收益(%)', '回撤(%)', '权重分配']
    aligns_d = ['<', '>', '>', '>', '<']
    print()
    print_table_row(headers_d, widths_d, aligns_d)
    print('  ' + '-' * (sum(widths_d) + 3 * (len(widths_d) - 1)))

    sorted_combos = sorted(combo_results.items(), key=lambda x: x[1]['avg_sharpe'], reverse=True)
    for combo_name, cr in sorted_combos:
        w_str = ' '.join([f"{k}:{v:.0%}" for k, v in cr['weights'].items()])
        print_table_row(
            [combo_name, f"{cr['avg_sharpe']:.3f}", f"{cr['avg_return']:.2f}",
             f"{cr['avg_drawdown']:.2f}", w_str],
            widths_d, aligns_d
        )

    if sorted_combos:
        best_combo = sorted_combos[0]
        print(f"\n  >> 最优决策权重组合: {best_combo[0]} (夏普={best_combo[1]['avg_sharpe']:.3f})")

    return combo_results


# ============================================================
# 数据获取
# ============================================================

def fetch_all_data() -> Tuple[Dict, pd.DataFrame]:
    """获取所有基金和市场数据"""
    print_header('数据获取')

    # 市场基准
    print("  获取沪深300基金作为市场基准...")
    market_df = fetch_fund_nav_history('000051', 365)
    if len(market_df) > 0:
        market_df['close'] = market_df['nav']
    print(f"  市场基准: {len(market_df)} 天")

    # 基金数据
    fund_data = {}
    success = 0
    fail = 0
    for code, name in TEST_FUNDS:
        print(f"  获取 {name}({code})...", end='')
        df = fetch_fund_nav_history(code, 365)
        if len(df) >= 60:
            fund_data[code] = (name, df)
            print(f" {len(df)}天 [OK]")
            success += 1
        else:
            print(f" {len(df)}天 [数据不足,跳过]")
            fail += 1

    print(f"\n  数据获取完成: 成功 {success} 只, 失败 {fail} 只")
    return fund_data, market_df


# ============================================================
# 构建所有策略
# ============================================================

def build_all_strategies() -> List[Strategy]:
    """构建所有可用策略(原始4个 + 新4个)"""
    strategies = []

    # 原始4个策略
    strategies.append(OriginalStrategy())
    strategies.append(MacroDefensiveStrategy())
    strategies.append(AggressiveEventStrategy())
    strategies.append(AdaptiveHybridStrategy())

    # 新4个策略(如果可用)
    new_strategy_classes = [
        (TrendHunterStrategy, '趋势猎手'),
        (MeanReversionStrategy, '均值回归'),
        (MacroShieldStrategy, '宏观护盾'),
        (MultiResonanceStrategy, '多因子共振'),
    ]

    for cls, fallback_name in new_strategy_classes:
        if cls is not None:
            try:
                instance = cls()
                strategies.append(instance)
                print(f"  [已加载] {instance.name}")
            except Exception as e:
                print(f"  [跳过] {fallback_name}: {e}")
        else:
            print(f"  [跳过] {fallback_name}: 模块未找到")

    return strategies


# ============================================================
# 主函数
# ============================================================

def main():
    start_time = _time.time()

    print_header('竞技裁判 - 增强版回测对抗引擎 v2')
    print(f"  启动时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  基金池: {len(TEST_FUNDS)} 只")
    print(f"  板块数: {len(SECTOR_MAP)} 个")

    # ── 1. 数据获取 ──
    fund_data, market_df = fetch_all_data()
    if not fund_data:
        print("\n  [错误] 无法获取任何基金数据，退出")
        return

    # ── 2. 构建策略 ──
    print_header('策略加载')
    strategies = build_all_strategies()
    print(f"\n  已加载策略: {len(strategies)} 个")
    for s in strategies:
        print(f"    - {s.name}")

    # ── 3. 锦标赛淘汰 ──
    tournament_results = run_tournament(strategies, fund_data, market_df)

    # ── 4. 交叉验证 ──
    # 只对原始策略(非变异)做交叉验证
    cv_results = run_cross_validation(strategies, fund_data, market_df)

    # ── 5. 板块分析 ──
    sector_results = run_sector_analysis(strategies, fund_data, market_df)

    # ── 6. 决策模型评估 ──
    decision_results = run_decision_model_eval(strategies, fund_data, market_df)

    # ── 7. 最终报告 ──
    elapsed = _time.time() - start_time
    print_header('最终报告')

    champion = tournament_results[0] if tournament_results else None
    if champion:
        m = champion['avg_metrics']
        print(f"\n  冠军策略: {champion['strategy_name']}")
        print(f"  综合得分: {champion['composite_score']:.2f}")
        print(f"  夏普比率: {m['sharpe']:.3f}")
        print(f"  总收益率: {m['total_return']:.2f}%")
        print(f"  年化收益: {m.get('annual_return', 0):.2f}%")
        print(f"  最大回撤: {m['max_drawdown']:.2f}%")
        print(f"  卡尔玛比率: {m['calmar']:.3f}")
        print(f"  逃顶能力: {m.get('crash_avoidance', 0):.3f}%")
        print(f"  胜率: {m['win_rate']:.1f}%")

        # 冠军逐基金明细
        print(f"\n  ── 冠军策略逐基金明细 ──")
        widths_f = [18, 9, 8, 9, 8, 10]
        headers_f = ['基金', '收益(%)', '夏普', '回撤(%)', '逃顶', '板块']
        aligns_f = ['<', '>', '>', '>', '>', '<']
        print_table_row(headers_f, widths_f, aligns_f)
        print('  ' + '-' * (sum(widths_f) + 3 * (len(widths_f) - 1)))
        for fd in sorted(champion['fund_details'], key=lambda x: x['sharpe'], reverse=True):
            indicator = '[+]' if fd['sharpe'] > 0 else '[-]'
            print_table_row(
                [f"{indicator}{fd['fund']}", f"{fd['total_return']:.2f}",
                 f"{fd['sharpe']:.3f}", f"{fd['max_drawdown']:.2f}",
                 f"{fd.get('crash_avoidance',0):.3f}",
                 fd.get('sector', '未知')],
                widths_f, aligns_f
            )

        # 冠军参数
        print(f"\n  ── 冠军策略参数 ──")
        champ_params = champion['strategy_obj'].params
        for k, v in sorted(champ_params.items()):
            print(f"    {k}: {v}")

    # 交叉验证汇总
    if cv_results:
        print(f"\n  ── 交叉验证过拟合检测 ──")
        for name, cv in sorted(cv_results.items(), key=lambda x: x[1]['avg_sharpe'], reverse=True):
            risk_label = cv['overfit_risk']
            print(f"    {name:16s} 夏普={cv['avg_sharpe']:.3f} (std={cv['std_sharpe']:.3f}) 过拟合风险={risk_label}")

    print(f"\n  总耗时: {elapsed:.1f} 秒")

    # ── 8. 保存JSON ──
    output = {
        'timestamp': datetime.now().isoformat(),
        'elapsed_seconds': round(elapsed, 1),
        'n_funds': len(fund_data),
        'n_strategies': len(strategies),
        'champion': {
            'name': champion['strategy_name'] if champion else None,
            'composite_score': champion['composite_score'] if champion else None,
            'avg_metrics': champion['avg_metrics'] if champion else None,
            'params': champion['strategy_obj'].params if champion else None,
            'fund_details': champion['fund_details'] if champion else None,
        },
        'tournament_rankings': [
            {
                'rank': i + 1,
                'name': r['strategy_name'],
                'composite_score': r['composite_score'],
                'avg_metrics': r['avg_metrics'],
            }
            for i, r in enumerate(tournament_results[:10])
        ],
        'cross_validation': cv_results,
        'sector_analysis': sector_results,
        'decision_model': decision_results,
        'score_weights': SCORE_WEIGHTS,
    }

    output_path = os.path.join(os.path.dirname(__file__), 'arena_results.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=json_serializer)

    print(f"\n  结果已保存: {output_path}")
    print_divider()
    print("  竞技裁判引擎执行完毕!")
    print_divider()

    return output


if __name__ == '__main__':
    main()
