#!/usr/bin/env python3
"""v7.5b = v7.4 + 6漏洞修复 + 回测驱动参数调优
核心改进:
  1. review/reduce阈值随波动率动态缩放（高波动基金更宽容）
  2. 熔断主动卖出（review+偏空卖20%, reduce卖40%）
  3. 冷却期（critical/高盈利豁免）
  4. capitulation门槛（不再无视compositeScore）
  5. 越跌越买限制（深亏时cap信号强度）
"""

import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class LocalV75Strategy(Strategy):
    """v7.5b: v7.4 + 回测驱动调优"""
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
            # v7.4 熔断
            'cb_cooldown_days': 7, 'cb_unlock_threshold': 10,
            # v7.5b 动态阈值基准（根据波动率缩放）
            'review_base': 18, 'reduce_base': 25, 'critical_base': 30,
            # 冷却期
            'sell_cooldown_window': 5, 'sell_cooldown_max': 2,
            'buy_cooldown_window': 7, 'buy_cooldown_max': 3,
        }
        if params: default.update(params)
        super().__init__('v7.5b决策模型', default)
        self._cb_triggered_day = -999
        self._recent_sells = []
        self._recent_buys = []

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def _get_vol_scaled_thresholds(self, navs):
        """根据波动率动态调整熔断阈值: 高波动→更宽容"""
        p = self.params
        ret = np.diff(navs[-61:]) / navs[-61:-1] if len(navs) > 61 else np.diff(navs) / navs[:-1]
        vol60 = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 20
        # 波动率缩放因子: vol<15→×0.85, vol=20→×1.0, vol=30→×1.25, vol>40→×1.5
        scale = max(0.85, min(1.5, 0.5 + vol60 / 40))
        return (p['review_base'] * scale, p['reduce_base'] * scale, p['critical_base'] * scale)

    def _count_recent(self, history, i, window):
        return sum(1 for d in history if i - d <= window)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        # === 核心预测信号（同v7.4）===
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

        # sigmoid + 硬底线
        if raw > 0 and not is_trend_mode:
            raw *= 1 - _sigmoid(pctb, 85, 0.12)
        if raw > 0 and ts < 0:
            raw *= 1 - _sigmoid(abs(ts), 25, 0.12)
        if raw > 0 and pctb > p['bb_hard_ceiling']: raw = 0
        if raw > 0 and ts < p['ts_hard_floor']: raw *= 0.25
        if 0 < raw < 0.15 and ts < -15: raw = 0

        # === 动态熔断（v7.5b核心改进）===
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100
        review_th, reduce_th, critical_th = self._get_vol_scaled_thresholds(navs)

        cb_level = 'none'
        if cur_dd > critical_th: cb_level = 'critical'
        elif cur_dd > reduce_th: cb_level = 'reduce'
        elif cur_dd > review_th: cb_level = 'review'

        # 熔断记忆
        if cur_dd > review_th:
            self._cb_triggered_day = i

        # 冷却期（缩短到7天，解锁阈值放宽到10%）
        if raw > 0 and (i - self._cb_triggered_day) < p['cb_cooldown_days']:
            if cur_dd > p['cb_unlock_threshold']:
                raw = 0

        # P0-3: 熔断主动卖出
        if cb_level == 'critical' and raw > -0.3:
            raw = -0.5
        elif cb_level == 'reduce' and raw >= 0:
            raw = -0.2  # reduce主动卖出
        elif cb_level == 'review' and raw >= 0 and raw < 0.15:
            # review: 仅在信号弱+亏损>阈值+2%时卖出
            if cur_dd > review_th + 2 or (tf + rf + rsif) < -0.1:
                raw = -0.12

        # P0-1: capitulation门槛
        is_capitulation = cur_dd > 10 and rsi < 35
        if raw > 0 and is_capitulation and raw < 0.25:
            raw = 0  # 信号不够强不抄底

        # P1: 越跌越买限制（仅在极深亏损时）
        if raw > 0 and cur_dd > 20:
            raw = min(raw, 0.2)

        signal = max(-1, min(1, raw / 2))

        # P1: 冷却期（critical和高收益豁免）
        if signal < -0.05:
            is_critical = cb_level == 'critical'
            # 计算当前是否高收益（用第30天价格近似成本）
            cost_approx = navs[30] if len(navs) > 30 else navs[0]
            profit_pct = (current - cost_approx) / cost_approx * 100
            if not is_critical and profit_pct <= 20:
                recent_sells = self._count_recent(self._recent_sells, i, p['sell_cooldown_window'])
                if recent_sells >= p['sell_cooldown_max']:
                    signal = 0

        if signal > 0.05:
            recent_buys = self._count_recent(self._recent_buys, i, p['buy_cooldown_window'])
            if recent_buys >= p['buy_cooldown_max']:
                signal = 0

        if signal < -0.05:
            self._recent_sells.append(i)
        elif signal > 0.05:
            self._recent_buys.append(i)

        return signal
