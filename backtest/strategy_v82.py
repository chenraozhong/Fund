#!/usr/bin/env python3
"""
v8.2 = v6.2核心 + 仅2层精选防御（tiered熔断 + 简单动量过滤）

设计原则：
- v6.2赢在简单，对齐版42基金卡尔玛2.09
- v8.1防御有效(回撤-11%)但收益损失太大(+12% vs +23%)
- v8.2目标：保住v6.2 80%+的收益，获得v8.1 50%+的回撤改善

只保留2层防御：
1. tiered熔断(20/25/30%) — 阈值放宽，只在真正危险时介入
2. 简单动量过滤 — 5日动量<-3%时不买（不用sigmoid，硬阈值但宽松）

砍掉的防御层：
- FOMC日历（假阳性太多）
- VIX检查（数据不稳定）
- sigmoid动量衰减（过于保守）
- 大盘当日跌幅缩减（频繁误触发）
- 冷却期（限制了正常交易频率）
- 深亏cap（熔断已覆盖）
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


class V82Strategy(Strategy):
    """v8.2: v6.2 + 2层精选防御"""
    def __init__(self, params=None):
        default = {
            # 完全继承v6.2参数
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 77, 'rsi_os': 21, 'rsi_mid_ob': 62, 'rsi_mid_os': 37,
            'macd_signal': 0.21, 'macd_cross': 0.36,
            'bb_extreme': 0.35, 'market_weight': 0.35,
            'atr_limit': 2.5,
            'streak_5': 0.35, 'streak_3': 0.87,
            'bb_hard_ceiling': 92, 'ts_hard_floor': -30,
            # v8.2防御参数（比v8.1宽松很多）
            'cb_reduce': 20, 'cb_critical': 25,  # 只有reduce和critical，没有review
            'mom_window': 5, 'mom_threshold': -3.0,  # 5日跌>3%才禁买（v8.1是10日>1%）
        }
        if params: default.update(params)
        super().__init__('v8.2精简防御', default)

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

        # === v6.2完整信号计算（一字不改）===
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

        # v6.2硬底线
        if raw > 0 and pctb > p['bb_hard_ceiling']: raw = 0
        if raw > 0 and ts < p['ts_hard_floor']: raw *= 0.25
        if 0 < raw < 0.15 and ts < -15: raw = 0

        # === 仅2层防御 ===

        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        # 防御1: tiered熔断（只有reduce和critical，没有review）
        if cur_dd > p['cb_critical'] and raw > -0.3:
            raw = -0.5  # critical: 强制卖出
        elif cur_dd > p['cb_reduce'] and raw >= 0:
            raw = -0.15  # reduce: 轻度减仓（v8.1是-0.2，这里更轻）

        # 防御2: 简单动量过滤（5日跌>3%不买，不用sigmoid）
        if raw > 0 and i >= p['mom_window']:
            fund_mom = (navs[-1] / navs[-p['mom_window']] - 1) * 100
            if fund_mom < p['mom_threshold']:
                raw = 0  # 硬禁但阈值宽松(-3%而非-1%)

        # v6.2深度回撤卖出
        if cur_dd > 25 and raw > -0.3:
            raw = -0.5

        return max(-1, min(1, raw / 2))
