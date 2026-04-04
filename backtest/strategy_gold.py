#!/usr/bin/env python3
"""黄金板块独立决策模型
核心差异（vs通用模型）:
  1. 趋势追踪更强（黄金趋势性强，均值回归弱）
  2. RSI超买不卖（黄金可以长期超买）
  3. 止盈阈值极高（40%+才考虑减仓）
  4. 下跌时更谨慎买入（黄金跌起来也很狠）
  5. 大盘因子反向（A股跌→避险→黄金涨）
"""

import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class GoldStrategy(Strategy):
    """黄金专属决策模型"""
    def __init__(self, params=None):
        default = {
            # 趋势权重更大（黄金趋势性强）
            'trend_weight_trending': 1.0, 'trend_weight_ranging': 0.4, 'trend_weight_volatile': 0.2,
            # 均值回归权重极低（黄金不适合抄底摸顶）
            'reversion_weight_trending': 0.01, 'reversion_weight_ranging': 0.08, 'reversion_weight_volatile': 0.15,
            # RSI: 超买不卖（黄金趋势中RSI>70是常态），超卖区更宽
            'rsi_ob': 85, 'rsi_os': 25, 'rsi_mid_ob': 70, 'rsi_mid_os': 35,
            'macd_signal': 0.28, 'macd_cross': 0.45,
            'bb_extreme': 0.25, 'market_weight': -0.15,  # 负数！大盘跌→黄金利好
            'atr_limit_default': 3.0, 'atr_limit_trending': 4.0,  # 更宽的ATR限幅（黄金波动大）
            # 连涨加速更强（趋势追踪）
            'streak_trending_5': 1.30, 'streak_trending_3': 1.15,
            'streak_other_5': 0.50, 'streak_other_3': 0.85,
            # 硬底线更宽松
            'bb_hard_ceiling': 98, 'ts_hard_floor': -40,
            # 熔断更宽（黄金波动率高，15%回撤正常）
            'review_base': 22, 'reduce_base': 30, 'critical_base': 38,
            'cb_cooldown_days': 5, 'cb_unlock_threshold': 8,
            # 冷却期更短（黄金趋势中需要更快反应）
            'sell_cooldown_window': 3, 'sell_cooldown_max': 2,
            'buy_cooldown_window': 5, 'buy_cooldown_max': 4,
        }
        if params: default.update(params)
        super().__init__('黄金专属模型', default)
        self._cb_triggered_day = -999
        self._recent_sells = []
        self._recent_buys = []

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 35: return 'volatile'  # 黄金波动率门槛更高
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def _count_recent(self, history, i, window):
        return sum(1 for d in history if i - d <= window)

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

        # 黄金趋势加速更强
        if regime == 'trending':
            if abs(streak) >= 5: tf *= p['streak_trending_5']
            elif abs(streak) >= 3: tf *= p['streak_trending_3']
        else:
            if abs(streak) >= 5: tf *= p['streak_other_5']
            elif abs(streak) >= 3: tf *= p['streak_other_3']

        # 均值回归极弱（黄金趋势延续性强）
        dev20 = (current - ma20) / ma20 * 100
        rf = 0
        if abs(dev20) > 3:  # 偏离>3%才有微弱回归
            rf += (-1 if dev20 > 0 else 1) * math.sqrt(abs(dev20) - 3) * rev_w
        # 趋势方向下完全压制回归
        if rf > 0 and tf < -0.3: rf *= 0.1
        if rf < 0 and tf > 0.3: rf *= 0.1

        rsi_s = calc_rsi(pd.Series(navs), 14)
        rsi = rsi_s.iloc[-1] if not np.isnan(rsi_s.iloc[-1]) else 50
        rsif = 0
        # 黄金：RSI>85才算超买（普通基金76），且惩罚轻
        if rsi > p['rsi_ob']: rsif = -(rsi - p['rsi_ob']) * 0.05  # 更轻的惩罚
        elif rsi > p['rsi_mid_ob']: rsif = -(rsi - p['rsi_mid_ob']) * 0.02
        elif rsi < p['rsi_os']: rsif = (p['rsi_os'] - rsi) * 0.06
        elif rsi < p['rsi_mid_os']: rsif = (p['rsi_mid_os'] - rsi) * 0.03

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
        if pctb > 98: bbf = -p['bb_extreme'] * bb_mult  # 更高的超买门槛
        elif pctb > 85: bbf = -(pctb - 85) * 0.015 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 15: bbf = (15 - pctb) * 0.018 * bb_mult

        # 大盘因子反向：A股跌→黄金涨（避险效应）
        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100  # 负权重，A股跌→正信号

        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.7 if vol20 > 28 else (0.9 if vol20 > 18 else 1.0)  # 更宽容的波动率调整
        tf *= va; rf *= (2 - va)

        raw = tf + rf + rsif + mf + bbf + mkf

        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100
        atr_mult = p['atr_limit_trending'] if regime == 'trending' else p['atr_limit_default']
        raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, raw))

        is_trend_mode = (regime == 'trending') and (hist > 0) and (raw > 0.2)

        # sigmoid更宽松（黄金可以在高位继续追）
        if raw > 0 and not is_trend_mode:
            raw *= 1 - _sigmoid(pctb, 90, 0.10)
        if raw > 0 and ts < 0:
            raw *= 1 - _sigmoid(abs(ts), 30, 0.10)

        # 硬底线更宽
        if raw > 0 and pctb > p['bb_hard_ceiling']: raw = 0
        if raw > 0 and ts < p['ts_hard_floor']: raw *= 0.3

        # 亏损观望更宽松
        if 0 < raw < 0.10 and ts < -20: raw = 0

        # 熔断（更宽的阈值）
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        cb_level = 'none'
        if cur_dd > p['critical_base']: cb_level = 'critical'
        elif cur_dd > p['reduce_base']: cb_level = 'reduce'
        elif cur_dd > p['review_base']: cb_level = 'review'

        if cur_dd > p['review_base']:
            self._cb_triggered_day = i

        if raw > 0 and (i - self._cb_triggered_day) < p['cb_cooldown_days']:
            if cur_dd > p['cb_unlock_threshold']:
                raw = 0

        if cb_level == 'critical' and raw > -0.3: raw = -0.5
        elif cb_level == 'reduce' and raw >= 0: raw = -0.2
        elif cb_level == 'review' and raw >= 0 and raw < 0.1 and cur_dd > p['review_base'] + 3:
            raw = -0.1

        signal = max(-1, min(1, raw / 2))

        # 冷却期（更短，高盈利豁免）
        if signal < -0.05:
            cost_approx = navs[30] if len(navs) > 30 else navs[0]
            profit_pct = (current - cost_approx) / cost_approx * 100
            is_critical = cb_level == 'critical'
            if not is_critical and profit_pct <= 30:  # 黄金30%以下才有冷却
                recent = self._count_recent(self._recent_sells, i, p['sell_cooldown_window'])
                if recent >= p['sell_cooldown_max']: signal = 0

        if signal > 0.05:
            recent = self._count_recent(self._recent_buys, i, p['buy_cooldown_window'])
            if recent >= p['buy_cooldown_max']: signal = 0

        if signal < -0.05: self._recent_sells.append(i)
        elif signal > 0.05: self._recent_buys.append(i)

        return signal
