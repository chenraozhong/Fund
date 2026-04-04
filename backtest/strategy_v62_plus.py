#!/usr/bin/env python3
"""
v6.2+ = v6.2基础 + 3个精准补丁（不改核心逻辑）

补丁1: 大盘急跌保护 — 大盘5日跌>3%时禁止买入（避免2022/03接飞刀）
补丁2: 波动率膨胀保护 — 20日波动率>28%时买入信号减半（高波动=高风险）
补丁3: 连续阴跌保护 — 大盘连跌5天+时卖出信号增强（不要死扛）

核心思路: v6.2赢在简单+快速止损，只在明确有害场景打补丁
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


class V62PlusStrategy(Strategy):
    """v6.2+: 三补丁精准改进"""

    def __init__(self, params=None):
        default = {
            # v6.2原始参数（完全保留）
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 77, 'rsi_os': 21, 'rsi_mid_ob': 62, 'rsi_mid_os': 37,
            'macd_signal': 0.21, 'macd_cross': 0.36,
            'bb_extreme': 0.35, 'market_weight': 0.13,
            'vol_factor': 0.63,
            'atr_limit': 2.5,
            'streak_5': 0.35, 'streak_3': 0.87,
            # 补丁参数
            'patch_mkt_drop_5d': -3.0,      # 补丁1: 大盘5日跌幅阈值
            'patch_vol_threshold': 28,       # 补丁2: 波动率膨胀阈值
            'patch_vol_buy_decay': 0.5,      # 补丁2: 高波动时买入衰减
            'patch_down_streak': 5,          # 补丁3: 连跌天数阈值
            'patch_down_sell_boost': 1.5,    # 补丁3: 连跌时卖出增强
        }
        if params: default.update(params)
        super().__init__('v6.2+三补丁', default)

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5 = np.mean(navs[-5:]); ma10 = np.mean(navs[-10:]); ma20 = np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def _get_market_signals(self, market_df, i):
        """提取大盘信号用于3个补丁"""
        signals = {'mkt_5d_ret': 0, 'mkt_vol20': 15, 'mkt_down_streak': 0, 'mkt_change': 0}
        if market_df is None or i >= len(market_df) or 'close' not in market_df.columns:
            return signals

        closes = market_df['close'].values
        changes = market_df['change_pct'].values if 'change_pct' in market_df.columns else np.zeros(len(closes))

        if i >= 5:
            signals['mkt_5d_ret'] = (closes[i] / closes[i-5] - 1) * 100
        if i >= 20:
            ret20 = np.diff(closes[i-20:i+1]) / closes[i-20:i]
            signals['mkt_vol20'] = np.std(ret20) * math.sqrt(250) * 100

        streak = 0
        for j in range(i, max(i-15, 0), -1):
            if changes[j] < 0: streak += 1
            else: break
        signals['mkt_down_streak'] = streak
        signals['mkt_change'] = changes[i] if i < len(changes) else 0

        return signals

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        # === v6.2 原始信号计算（完全不改）===
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

        # v6.2: 统一衰减（不区分趋势/非趋势）
        if abs(streak) >= 5: tf *= p['streak_5']
        elif abs(streak) >= 3: tf *= p['streak_3']

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
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme']
        elif pctb > 80: bbf = -(pctb - 80) * 0.020
        elif pctb < 5: bbf = p['bb_extreme']
        elif pctb < 20: bbf = (20 - pctb) * 0.020

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
        raw = max(-atr_pct * p['atr_limit'], min(atr_pct * p['atr_limit'], raw))

        # v6.2 硬底线
        if raw > 0 and pctb > 92: raw = 0
        if raw > 0 and ts < -30: raw *= 0.25
        if 0 < raw < 0.15 and ts < -15: raw = 0

        # v6.2 深度回撤卖出
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100
        if cur_dd > 25 and raw > -0.3: raw = -0.5

        # === 以上是v6.2原始逻辑，以下是3个精准补丁 ===

        mkt = self._get_market_signals(market_df, i)

        # 补丁1: 大盘急跌保护 — 大盘5日跌>3%时禁止买入
        if raw > 0 and mkt['mkt_5d_ret'] < p['patch_mkt_drop_5d']:
            raw = 0  # 不买！等大盘企稳

        # 补丁2: 波动率膨胀保护 — 高波动时买入减半
        if raw > 0 and mkt['mkt_vol20'] > p['patch_vol_threshold']:
            raw *= p['patch_vol_buy_decay']

        # 补丁3: 连续阴跌保护 — 大盘连跌5+天时增强卖出
        if raw < 0 and mkt['mkt_down_streak'] >= p['patch_down_streak']:
            raw *= p['patch_down_sell_boost']

        return max(-1, min(1, raw / 2))
