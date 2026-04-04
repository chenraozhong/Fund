#!/usr/bin/env python3
"""
通宵迭代引擎 — 持续优化决策模型直到全面超越v6.2
目标: 夏普>1.58, 收益>33.8%, 回撤<7.5% (v6.2基准)

Phase 1: 5年数据基准 + 牛熊市检测
Phase 2: v6.2失策分析
Phase 3: 迭代改进
Phase 4: 黄金优化
Phase 5: 最终报告
"""
import os, sys, json, math, time as _time
from datetime import datetime
from typing import Dict, List, Tuple
from collections import defaultdict
import warnings; warnings.filterwarnings('ignore')
for k in ['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']:
    os.environ.pop(k, None)

import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))

from backtest_engine import fetch_fund_nav_history, fetch_index_history, calc_rsi, calc_macd, calc_bollinger, calc_atr
from visual_arena import run_backtest_enhanced, analyze_performance

# =================================================================
# 基金池（按数据长度分组）
# =================================================================
ALL_FUNDS = [
    ('000217','华安黄金','黄金',1840), ('002611','博时黄金','黄金',1840), ('004253','国泰黄金','黄金',1840),
    ('004753','广发传媒','消费',1840),
    ('008888','华夏半导体','半导体',1417), ('010572','易方达生科LOF','医药',1294), ('010990','南方有色','有色',1282),
    ('012365','广发光伏','新能源',1150), ('011036','嘉实稀土','有色',1131), ('012832','南方新能源','新能源',1112),
    ('016387','永赢低碳环保','新能源',838), ('017074','嘉实清洁能源','新能源',788), ('016874','广发远见','混合',785),
    ('019671','广发港股创新药','医药',588), ('019325','易方达生科ETF','医药',608), ('018897','易方达消费电子','消费',596),
    ('020982','华安机器人','AI',485), ('022365','永赢科技','混合',345), ('023408','华宝AI ETF','AI',277),
    ('024195','永赢卫星通信','混合',177), ('025209','永赢半导体','半导体',132),
]

# 用3年+数据的13只基金做核心回测（短数据基金的回测结果不可靠）
CORE_FUNDS = [(c,n,s,d) for c,n,s,d in ALL_FUNDS if d >= 700]

LOG = []

def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line)
    LOG.append(line)

# =================================================================
# Phase 1: 数据获取 + 牛熊市检测
# =================================================================
def fetch_all_data():
    """获取所有基金和指数的历史数据"""
    log("Phase 1: 获取数据...")
    fund_data = {}
    for code, name, sector, expected_days in CORE_FUNDS:
        df = fetch_fund_nav_history(code, 1825)
        if df is not None and len(df) >= 200:
            fund_data[code] = {'name': name, 'sector': sector, 'df': df, 'days': len(df)}
            log(f"  {name:16s} ({code}) {len(df)}天")
        _time.sleep(0.2)

    # 上证指数
    _time.sleep(0.5)
    market_df = fetch_index_history('1.000001', 1825)
    if market_df is not None:
        log(f"  上证指数            {len(market_df)}天")
    else:
        log("  上证指数获取失败，尝试备用...")
        _time.sleep(1)
        market_df = fetch_index_history('1.000001', 1825)
        if market_df is not None:
            log(f"  上证指数(重试成功)   {len(market_df)}天")

    return fund_data, market_df

def detect_market_regimes(market_df):
    """基于上证指数检测牛熊市区间"""
    if market_df is None or len(market_df) < 120:
        return []

    closes = market_df['close'].values if 'close' in market_df.columns else market_df['nav'].values
    dates = [str(d)[:10] for d in market_df['date']]

    # 用120日均线判断牛熊
    regimes = []
    ma120 = pd.Series(closes).rolling(120).mean().values

    current_regime = None
    regime_start = 0

    for i in range(120, len(closes)):
        if closes[i] > ma120[i] * 1.02:
            regime = 'bull'
        elif closes[i] < ma120[i] * 0.98:
            regime = 'bear'
        else:
            regime = 'neutral'

        if regime != current_regime:
            if current_regime is not None:
                regimes.append({
                    'type': current_regime,
                    'start': dates[regime_start],
                    'end': dates[i-1],
                    'days': i - regime_start,
                    'return': (closes[i-1] / closes[regime_start] - 1) * 100,
                })
            current_regime = regime
            regime_start = i

    # 最后一段
    if current_regime and regime_start < len(closes) - 1:
        regimes.append({
            'type': current_regime,
            'start': dates[regime_start],
            'end': dates[-1],
            'days': len(closes) - regime_start,
            'return': (closes[-1] / closes[regime_start] - 1) * 100,
        })

    return regimes

# =================================================================
# Phase 2: 策略回测 + 失策分析
# =================================================================
def run_strategy_backtest(strategy, fund_data, market_df):
    """在所有核心基金上回测一个策略"""
    results = []
    for code, info in fund_data.items():
        # Reset strategy state
        for attr in ['_cb_triggered_day']:
            if hasattr(strategy, attr): setattr(strategy, attr, -999)
        for attr in ['_recent_sells', '_recent_buys']:
            if hasattr(strategy, attr): setattr(strategy, attr, [])

        result = run_backtest_enhanced(info['df'], strategy, market_df=market_df, initial_capital=100000)
        perf = analyze_performance(result['nav_curve'], result['trades'])

        results.append({
            'code': code, 'name': info['name'], 'sector': info['sector'],
            'return': round(perf['total_return'], 2),
            'sharpe': round(perf['sharpe'], 3),
            'max_dd': round(perf['max_drawdown'], 2),
            'trades': result['trades'],
            'nav_curve': result['nav_curve'],
        })

    avg_ret = np.mean([r['return'] for r in results])
    avg_sharpe = np.mean([r['sharpe'] for r in results])
    avg_dd = np.mean([r['max_dd'] for r in results])

    return {
        'avg_return': round(avg_ret, 2),
        'avg_sharpe': round(avg_sharpe, 3),
        'avg_dd': round(avg_dd, 2),
        'calmar': round(avg_ret / abs(avg_dd), 2) if avg_dd != 0 else 0,
        'fund_results': results,
    }

def analyze_failures(results, strategy_name):
    """分析失策交易：大跌中不卖、大涨中不买"""
    failures = []
    for fr in results['fund_results']:
        df_trades = fr['trades']
        nav_curve = fr['nav_curve']

        # 找最大回撤区间
        peak = 0; max_dd = 0; dd_start = 0; dd_end = 0; peak_idx = 0
        for i, v in enumerate(nav_curve):
            if v > peak:
                peak = v; peak_idx = i
            dd = (peak - v) / peak * 100
            if dd > max_dd:
                max_dd = dd; dd_start = peak_idx; dd_end = i

        # 回撤区间内的交易
        dd_buys = [t for t in df_trades if dd_start <= t.get('day', 0) <= dd_end and t['action'] == 'buy']
        dd_sells = [t for t in df_trades if dd_start <= t.get('day', 0) <= dd_end and t['action'] == 'sell']

        if max_dd > 5:
            failures.append({
                'fund': fr['name'], 'max_dd': round(max_dd, 1),
                'dd_buys': len(dd_buys), 'dd_sells': len(dd_sells),
                'issue': 'bought_during_crash' if len(dd_buys) > len(dd_sells) else 'held_during_crash' if len(dd_sells) == 0 else 'ok',
            })

    return failures

# =================================================================
# Phase 3: 策略迭代工厂
# =================================================================
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v74 import LocalV74Strategy
from strategy_local_v75 import LocalV75Strategy
from strategy_gold import GoldStrategy

class IterativeStrategy:
    """可参数化的迭代策略，用于快速试验不同参数组合"""
    def __init__(self, name, base_params, modifications=None):
        self.name = name
        params = dict(base_params)
        if modifications:
            params.update(modifications)
        # Create a v7.5b strategy with custom params
        self._inner = LocalV75Strategy(params)
        self._inner.name = name

    def generate_signal(self, df, i, market_df=None):
        return self._inner.generate_signal(df, i, market_df)

# v7.5b的基础参数
V75B_BASE = {
    'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
    'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
    'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
    'macd_signal': 0.232, 'macd_cross': 0.386,
    'bb_extreme': 0.35, 'market_weight': 0.35,
    'atr_limit_default': 2.5, 'atr_limit_trending': 3.5,
    'streak_trending_5': 1.20, 'streak_trending_3': 1.08,
    'streak_other_5': 0.35, 'streak_other_3': 0.80,
    'bb_hard_ceiling': 95, 'ts_hard_floor': -35,
    'cb_cooldown_days': 7, 'cb_unlock_threshold': 10,
    'review_base': 18, 'reduce_base': 25, 'critical_base': 30,
    'sell_cooldown_window': 5, 'sell_cooldown_max': 2,
    'buy_cooldown_window': 7, 'buy_cooldown_max': 3,
}

def generate_iteration_candidates(iteration, prev_failures):
    """基于上一轮失败分析生成新的参数候选"""
    candidates = []

    if iteration == 1:
        # 第1轮: 探索关键参数维度
        candidates.append(('v7.6a-宽熔断', {'review_base': 22, 'reduce_base': 28, 'critical_base': 35}))
        candidates.append(('v7.6b-强趋势', {'streak_trending_5': 1.35, 'streak_trending_3': 1.15, 'trend_weight_trending': 0.9}))
        candidates.append(('v7.6c-短冷却', {'sell_cooldown_window': 3, 'buy_cooldown_window': 5, 'buy_cooldown_max': 4}))
        candidates.append(('v7.6d-混合', {'review_base': 20, 'streak_trending_5': 1.25, 'sell_cooldown_window': 3, 'buy_cooldown_max': 4}))
    elif iteration == 2:
        # 第2轮: 基于第1轮最佳结果微调
        candidates.append(('v7.7a-激进趋势', {'streak_trending_5': 1.40, 'streak_trending_3': 1.20, 'trend_weight_trending': 1.0, 'review_base': 20}))
        candidates.append(('v7.7b-v6.2回归', {'streak_other_5': 0.30, 'streak_other_3': 0.85, 'bb_hard_ceiling': 92, 'ts_hard_floor': -30, 'review_base': 20}))
        candidates.append(('v7.7c-低回撤', {'review_base': 16, 'reduce_base': 22, 'bb_hard_ceiling': 90, 'atr_limit_default': 2.0}))
        candidates.append(('v7.7d-平衡', {'review_base': 20, 'reduce_base': 26, 'streak_trending_5': 1.30, 'streak_other_5': 0.30, 'sell_cooldown_window': 3}))
    elif iteration == 3:
        # 第3轮: 精细调优
        candidates.append(('v7.8a-极致低回撤', {'review_base': 15, 'reduce_base': 20, 'bb_hard_ceiling': 88, 'ts_hard_floor': -28, 'atr_limit_default': 1.8, 'streak_other_5': 0.25}))
        candidates.append(('v7.8b-v6.2+防御', {'review_base': 18, 'reduce_base': 24, 'streak_other_5': 0.30, 'streak_other_3': 0.85, 'bb_hard_ceiling': 92, 'sell_cooldown_window': 4, 'buy_cooldown_max': 4}))
        candidates.append(('v7.8c-趋势跟踪', {'trend_weight_trending': 1.0, 'streak_trending_5': 1.35, 'reversion_weight_trending': 0.02, 'review_base': 22, 'sell_cooldown_window': 3}))
    else:
        # 后续轮: 随机微扰
        import random
        for k in range(4):
            mods = {}
            for param in ['review_base', 'streak_trending_5', 'streak_other_5', 'sell_cooldown_window', 'bb_hard_ceiling']:
                base = V75B_BASE.get(param, 1.0)
                mods[param] = base * (1 + random.uniform(-0.15, 0.15))
            candidates.append((f'v7.{8+iteration}_{chr(97+k)}-随机', mods))

    return candidates

# =================================================================
# Main iteration loop
# =================================================================
def main():
    log("=" * 60)
    log("  通宵迭代引擎启动")
    log("=" * 60)

    t0 = _time.time()

    # Phase 1
    fund_data, market_df = fetch_all_data()
    log(f"可用基金: {len(fund_data)}只")

    if market_df is not None:
        regimes = detect_market_regimes(market_df)
        log(f"\n=== 牛熊市区间 ===")
        for r in regimes:
            emoji = '🐂' if r['type']=='bull' else ('🐻' if r['type']=='bear' else '➡️')
            log(f"  {emoji} {r['type']:8s} {r['start']}~{r['end']} ({r['days']}天) {r['return']:+.1f}%")

    # Phase 2: v6.2 基准
    log("\n" + "=" * 60)
    log("  Phase 2: v6.2 基准回测")
    log("=" * 60)

    v62 = LocalV62Strategy()
    v62_result = run_strategy_backtest(v62, fund_data, market_df)
    log(f"v6.2基准: 收益{v62_result['avg_return']:+.1f}% 夏普{v62_result['avg_sharpe']:.3f} 回撤{v62_result['avg_dd']:.1f}%")

    v62_failures = analyze_failures(v62_result, 'v6.2')
    crash_buys = [f for f in v62_failures if f['issue'] == 'bought_during_crash']
    if crash_buys:
        log(f"v6.2失策: {len(crash_buys)}只基金在回撤中买入")
        for f in crash_buys[:5]:
            log(f"  {f['fund']:16s} 回撤{f['max_dd']:.1f}%期间 买{f['dd_buys']}次 卖{f['dd_sells']}次")

    # Also run v7.4 and v7.5b baselines
    v74 = LocalV74Strategy()
    v74_result = run_strategy_backtest(v74, fund_data, market_df)
    log(f"v7.4基准: 收益{v74_result['avg_return']:+.1f}% 夏普{v74_result['avg_sharpe']:.3f} 回撤{v74_result['avg_dd']:.1f}%")

    v75b = LocalV75Strategy()
    v75b_result = run_strategy_backtest(v75b, fund_data, market_df)
    log(f"v7.5b基准: 收益{v75b_result['avg_return']:+.1f}% 夏普{v75b_result['avg_sharpe']:.3f} 回撤{v75b_result['avg_dd']:.1f}%")

    # Phase 3: Iteration
    log("\n" + "=" * 60)
    log("  Phase 3: 迭代优化")
    log("=" * 60)

    target_sharpe = v62_result['avg_sharpe']
    target_return = v62_result['avg_return']
    target_dd = v62_result['avg_dd']
    log(f"目标: 夏普>{target_sharpe:.3f} 收益>{target_return:.1f}% 回撤>{target_dd:.1f}%")

    best_result = None
    best_name = 'v7.5b'
    best_sharpe = v75b_result['avg_sharpe']
    all_iterations = [{
        'name': 'v6.2', **{k: v62_result[k] for k in ['avg_return','avg_sharpe','avg_dd','calmar']},
    }, {
        'name': 'v7.4', **{k: v74_result[k] for k in ['avg_return','avg_sharpe','avg_dd','calmar']},
    }, {
        'name': 'v7.5b', **{k: v75b_result[k] for k in ['avg_return','avg_sharpe','avg_dd','calmar']},
    }]

    prev_failures = v75b_failures = analyze_failures(v75b_result, 'v7.5b')

    for iteration in range(1, 6):  # 最多5轮迭代
        log(f"\n--- 迭代第{iteration}轮 ---")
        candidates = generate_iteration_candidates(iteration, prev_failures)

        round_best = None
        round_best_sharpe = -999

        for cand_name, mods in candidates:
            strat = LocalV75Strategy(mods)
            strat.name = cand_name

            result = run_strategy_backtest(strat, fund_data, market_df)

            beaten_sharpe = result['avg_sharpe'] > target_sharpe
            beaten_return = result['avg_return'] > target_return
            beaten_dd = abs(result['avg_dd']) < abs(target_dd)
            beaten_all = beaten_sharpe and beaten_return and beaten_dd

            status = '★全面超越★' if beaten_all else (
                '↑夏普超越' if beaten_sharpe else '→'
            )

            log(f"  {cand_name:20s} 收益{result['avg_return']:+6.1f}% 夏普{result['avg_sharpe']:.3f} 回撤{result['avg_dd']:6.1f}% {status}")

            all_iterations.append({
                'name': cand_name,
                **{k: result[k] for k in ['avg_return','avg_sharpe','avg_dd','calmar']},
            })

            if result['avg_sharpe'] > round_best_sharpe:
                round_best_sharpe = result['avg_sharpe']
                round_best = (cand_name, result, mods)

            if beaten_all:
                log(f"\n  🎯 {cand_name} 全面超越v6.2！")
                best_result = result
                best_name = cand_name

        if round_best:
            log(f"  本轮最佳: {round_best[0]} 夏普{round_best[1]['avg_sharpe']:.3f}")
            if round_best[1]['avg_sharpe'] > best_sharpe:
                best_sharpe = round_best[1]['avg_sharpe']
                best_result = round_best[1]
                best_name = round_best[0]
                prev_failures = analyze_failures(round_best[1], round_best[0])

        if best_result and best_result['avg_sharpe'] > target_sharpe and best_result['avg_return'] > target_return:
            log(f"\n已找到全面超越v6.2的模型，停止迭代")
            break

    # Phase 4: Gold optimization
    log("\n" + "=" * 60)
    log("  Phase 4: 黄金专属优化")
    log("=" * 60)

    gold_data = {c: d for c, d in fund_data.items() if d['sector'] == '黄金'}
    if gold_data:
        gold_strat = GoldStrategy()
        gold_result = run_strategy_backtest(gold_strat, gold_data, market_df)
        log(f"黄金专属: 收益{gold_result['avg_return']:+.1f}% 夏普{gold_result['avg_sharpe']:.3f} 回撤{gold_result['avg_dd']:.1f}%")

        # 对比通用策略在黄金上的表现
        v62_gold = run_strategy_backtest(LocalV62Strategy(), gold_data, market_df)
        log(f"v6.2(黄金): 收益{v62_gold['avg_return']:+.1f}% 夏普{v62_gold['avg_sharpe']:.3f} 回撤{v62_gold['avg_dd']:.1f}%")

    # Phase 5: Summary
    log("\n" + "=" * 60)
    log("  Phase 5: 最终总结")
    log("=" * 60)

    log(f"\n迭代历史:")
    for it in all_iterations:
        beaten = it['avg_sharpe'] > target_sharpe and it['avg_return'] > target_return and abs(it['avg_dd']) < abs(target_dd)
        tag = ' ★' if beaten else ''
        log(f"  {it['name']:24s} 收益{it['avg_return']:+6.1f}% 夏普{it['avg_sharpe']:.3f} 回撤{it['avg_dd']:6.1f}% 卡尔玛{it['calmar']:.2f}{tag}")

    log(f"\n最终最佳: {best_name}")
    if best_result:
        log(f"  收益{best_result['avg_return']:+.1f}% 夏普{best_result['avg_sharpe']:.3f} 回撤{best_result['avg_dd']:.1f}%")

        beaten_sharpe = best_result['avg_sharpe'] > target_sharpe
        beaten_return = best_result['avg_return'] > target_return
        beaten_dd = abs(best_result['avg_dd']) < abs(target_dd)
        log(f"  vs v6.2: 夏普{'✓' if beaten_sharpe else '✗'} 收益{'✓' if beaten_return else '✗'} 回撤{'✓' if beaten_dd else '✗'}")

    elapsed = _time.time() - t0
    log(f"\n总耗时: {elapsed/60:.1f}分钟")

    # Save log
    with open(os.path.join(os.path.dirname(__file__), 'overnight_log.txt'), 'w') as f:
        f.write('\n'.join(LOG))
    log("日志已保存: overnight_log.txt")

    # Save results as JSON
    with open(os.path.join(os.path.dirname(__file__), 'overnight_results.json'), 'w') as f:
        json.dump({
            'iterations': all_iterations,
            'best': best_name,
            'target': {'sharpe': target_sharpe, 'return': target_return, 'dd': target_dd},
            'timestamp': datetime.now().isoformat(),
        }, f, ensure_ascii=False, indent=2)

if __name__ == '__main__':
    main()
