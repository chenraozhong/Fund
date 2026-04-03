#!/usr/bin/env python3
"""v7.4 = v7.3 + 熊市防御(熔断冷却+集中度限制+非趋势强衰减)
注: 地缘主动卖出/避险豁免/赎回时滞在回测中无外部数据, 仅线上生效"""

import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class LocalV74Strategy(Strategy):
    """v7.4: v7.3 + 熔断冷却 + 集中度限制"""
    def __init__(self, params=None):
        default = {
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
            'macd_signal': 0.232, 'macd_cross': 0.386,
            'bb_extreme': 0.35, 'market_weight': 0.35,
            'atr_limit_default': 2.5, 'atr_limit_trending': 3.5,
            'streak_trending_5': 1.20, 'streak_trending_3': 1.08,
            'streak_other_5': 0.35, 'streak_other_3': 0.80,
            'bb_hard_ceiling': 95, 'ts_hard_floor': -35,
            # v7.4 新增
            'cb_cooldown_days': 10,    # 熔断冷却天数
            'cb_unlock_threshold': 12, # 冷却期解锁亏损阈值%
        }
        if params: default.update(params)
        super().__init__('v7.4决策模型', default)
        self._cb_triggered_day = -999  # 熔断触发日(状态机记忆)

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        trend_w = p[f'trend_weight_{regime}']
        rev_w = p[f'reversion_weight_{regime}']

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

        # v7.3: 趋势加速 / 非趋势v6.2强衰减
        if regime == 'trending':
            if abs(streak) >= 5: tf *= p['streak_trending_5']
            elif abs(streak) >= 3: tf *= p['streak_trending_3']
        else:
            if abs(streak) >= 5: tf *= p['streak_other_5']
            elif abs(streak) >= 3: tf *= p['streak_other_3']

        dev20 = (current - ma20) / ma20 * 100
        rf = 0
        if abs(dev20) > 2:
            rf += (-1 if dev20 > 0 else 1) * math.sqrt(abs(dev20) - 2) * rev_w
        if rf > 0 and tf < -0.2 and ts < -15: rf *= 0.3
        elif rf > 0 and tf < 0 and ts < 0: rf *= 0.6
        if rf < 0 and tf > 0.2 and ts > 15: rf *= 0.3
        elif rf < 0 and tf > 0 and ts > 0: rf *= 0.6

        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
        rsif = 0
        if rsi > p['rsi_ob']: rsif = -(rsi - p['rsi_ob']) * 0.08
        elif rsi > p['rsi_mid_ob']: rsif = -(rsi - p['rsi_mid_ob']) * 0.037
        elif rsi < p['rsi_os']: rsif = (p['rsi_os'] - rsi) * 0.08
        elif rsi < p['rsi_mid_os']: rsif = (p['rsi_mid_os'] - rsi) * 0.037

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

        _, _, _, pctb_s, _ = calc_bollinger(pd.Series(navs))
        pctb = pctb_s.iloc[-1] if not np.isnan(pctb_s.iloc[-1]) else 50
        bb_mult = 1.5 if regime == 'ranging' else 1.0
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bbf = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 20: bbf = (20 - pctb) * 0.020 * bb_mult

        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100

        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        tf *= va; rf *= (2 - va)

        raw = tf + rf + rsif + mf + bbf + mkf

        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100
        atr_mult = p['atr_limit_trending'] if regime == 'trending' else p['atr_limit_default']
        raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, raw))

        is_trend_mode = (regime == 'trending') and (hist > 0) and (raw > 0.25)

        # sigmoid层(同v7.3)
        if raw > 0 and not is_trend_mode:
            raw *= 1 - _sigmoid(pctb, 85, 0.12)
        if raw > 0 and ts < 0:
            raw *= 1 - _sigmoid(abs(ts), 25, 0.12)

        # 硬底线(同v7.3)
        if raw > 0 and pctb > p['bb_hard_ceiling']:
            raw = 0
        if raw > 0 and ts < p['ts_hard_floor']:
            raw *= 0.25

        # 亏损观望(同v7.3)
        if 0 < raw < 0.15 and ts < -15:
            raw = 0

        # === [v7.4] 熔断状态机(有记忆) ===
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        # 检测熔断触发
        if cur_dd > 15:
            self._cb_triggered_day = i  # 记录触发日

        # 熔断冷却: 触发后10天内, 除非亏损<12%, 否则买入信号归零
        if raw > 0 and (i - self._cb_triggered_day) < p['cb_cooldown_days']:
            if cur_dd > p['cb_unlock_threshold']:
                raw = 0  # 冷却期内且亏损仍>12% → 禁止买入

        # 深度回撤卖出(critical级)
        if cur_dd > 25 and raw > -0.3:
            raw = -0.5  # 强制卖出信号

        return max(-1, min(1, raw / 2))
