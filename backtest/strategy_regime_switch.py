#!/usr/bin/env python3
"""
自适应体制切换策略 — 牛市用v7.3(高收益) + 熊市用v6.2(快止损)
核心: 用上证指数MA60/MA120判断牛熊，自动切换底层决策引擎

设计原理:
  v6.2优势: 硬阈值止损快，熊市中回撤小（夏普0.435/5年）
  v7.3优势: sigmoid平滑+趋势加速，牛市中收益高（1年回测36.1%）
  切换策略: 取两者之长 — 牛市放开进攻，熊市立即收缩
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class RegimeSwitchStrategy(Strategy):
    """自适应体制切换: 牛市v7.3引擎 + 熊市v6.2引擎 + 过渡期混合"""

    def __init__(self, params=None):
        default = {
            # === 体制检测参数 ===
            'regime_ma_fast': 60,       # 快均线(判断中期趋势)
            'regime_ma_slow': 120,      # 慢均线(判断长期趋势)
            'regime_bull_threshold': 1.02,   # 价格>慢MA×1.02 = 牛市
            'regime_bear_threshold': 0.98,   # 价格<慢MA×0.98 = 熊市
            'regime_switch_confirm': 5,      # 连续N天确认才切换(防假突破)

            # === v6.2引擎参数(熊市用) ===
            'v62_streak_5': 0.35, 'v62_streak_3': 0.87,
            'v62_bb_ceiling': 92, 'v62_ts_floor': -30,
            'v62_atr_limit': 2.5,

            # === v7.3引擎参数(牛市用) ===
            'v73_streak_trending_5': 1.20, 'v73_streak_trending_3': 1.08,
            'v73_streak_other_5': 0.35, 'v73_streak_other_3': 0.80,
            'v73_bb_ceiling': 95, 'v73_ts_floor': -35,
            'v73_atr_limit_trending': 3.5, 'v73_atr_limit_default': 2.5,

            # === 共享参数 ===
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
            'macd_signal': 0.232, 'macd_cross': 0.386,
            'bb_extreme': 0.35, 'market_weight': 0.35,
        }
        if params: default.update(params)
        super().__init__('体制切换(牛v7.3+熊v6.2)', default)
        self._regime = 'neutral'    # bull/bear/neutral
        self._regime_count = 0      # 当前体制连续天数
        self._pending_regime = None
        self._pending_count = 0

    def _detect_market_regime(self, market_df, i):
        """用大盘指数检测牛熊市"""
        p = self.params
        if market_df is None or i < p['regime_ma_slow']:
            return self._regime

        closes = market_df['close'].values if 'close' in market_df.columns else None
        if closes is None: return self._regime
        if i >= len(closes): i = len(closes) - 1

        ma_fast = np.mean(closes[max(0, i-p['regime_ma_fast']+1):i+1])
        ma_slow = np.mean(closes[max(0, i-p['regime_ma_slow']+1):i+1])
        current = closes[i]

        # 判断新体制
        if current > ma_slow * p['regime_bull_threshold'] and ma_fast > ma_slow:
            new_regime = 'bull'
        elif current < ma_slow * p['regime_bear_threshold'] and ma_fast < ma_slow:
            new_regime = 'bear'
        else:
            new_regime = 'neutral'

        # 连续确认才切换（防假突破）
        if new_regime != self._regime:
            if new_regime == self._pending_regime:
                self._pending_count += 1
                if self._pending_count >= p['regime_switch_confirm']:
                    self._regime = new_regime
                    self._regime_count = 0
                    self._pending_regime = None
                    self._pending_count = 0
            else:
                self._pending_regime = new_regime
                self._pending_count = 1
        else:
            self._regime_count += 1
            self._pending_regime = None
            self._pending_count = 0

        return self._regime

    def _detect_fund_regime(self, navs):
        """基金自身的趋势检测"""
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
        fund_regime = self._detect_fund_regime(navs)
        market_regime = self._detect_market_regime(market_df, i)

        # === 核心因子计算（共享）===
        trend_w = p[f'trend_weight_{fund_regime}']
        rev_w = p[f'reversion_weight_{fund_regime}']

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

        # === 体制切换核心: 连涨/连跌衰减参数 ===
        if market_regime == 'bull':
            # 牛市: v7.3参数 — 趋势中加速，让利润奔跑
            if fund_regime == 'trending':
                if abs(streak) >= 5: tf *= p['v73_streak_trending_5']
                elif abs(streak) >= 3: tf *= p['v73_streak_trending_3']
            else:
                if abs(streak) >= 5: tf *= p['v73_streak_other_5']
                elif abs(streak) >= 3: tf *= p['v73_streak_other_3']
        else:
            # 熊市/中性: v6.2参数 — 强衰减，快止损
            if abs(streak) >= 5: tf *= p['v62_streak_5']
            elif abs(streak) >= 3: tf *= p['v62_streak_3']

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
        bb_mult = 1.5 if fund_regime == 'ranging' else 1.0
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bbf = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 20: bbf = (20 - pctb) * 0.020 * bb_mult

        # 大盘因子
        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100

        # 波动率调整
        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        tf *= va; rf *= (2 - va)

        raw = tf + rf + rsif + mf + bbf + mkf

        # ATR限幅
        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100

        if market_regime == 'bull':
            atr_mult = p['v73_atr_limit_trending'] if fund_regime == 'trending' else p['v73_atr_limit_default']
        else:
            atr_mult = p['v62_atr_limit']

        raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, raw))

        is_trend_mode = (fund_regime == 'trending') and (hist > 0) and (raw > 0.25)

        # === 体制切换核心: 硬底线参数 ===
        if market_regime == 'bull':
            # 牛市: v7.3宽松硬底线 + sigmoid平滑
            if raw > 0 and not is_trend_mode:
                raw *= 1 - _sigmoid(pctb, 85, 0.12)
            if raw > 0 and ts < 0:
                raw *= 1 - _sigmoid(abs(ts), 25, 0.12)
            if raw > 0 and pctb > p['v73_bb_ceiling']: raw = 0
            if raw > 0 and ts < p['v73_ts_floor']: raw *= 0.25
        else:
            # 熊市/中性: v6.2严格硬底线
            if raw > 0 and pctb > p['v62_bb_ceiling']: raw = 0
            if raw > 0 and ts < p['v62_ts_floor']: raw *= 0.25
            # 熊市额外: 买入信号整体衰减30%
            if market_regime == 'bear' and raw > 0:
                raw *= 0.7

        # 亏损观望
        if 0 < raw < 0.15 and ts < -15: raw = 0

        # 熔断（熊市更严格）
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        if market_regime == 'bear':
            # 熊市: 更低的熔断阈值
            if cur_dd > 20 and raw > -0.3: raw = -0.5  # critical
            elif cur_dd > 15 and raw >= 0: raw = -0.2   # reduce
            elif cur_dd > 10 and raw >= 0 and raw < 0.15: raw = -0.1  # review
        else:
            # 牛市/中性: 标准阈值
            if cur_dd > 25 and raw > -0.3: raw = -0.5
            elif cur_dd > 20 and raw >= 0: raw = -0.2

        return max(-1, min(1, raw / 2))
