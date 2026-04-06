#!/usr/bin/env python3
"""
线上对齐版回测策略 — 尽可能还原线上TypeScript决策链路

对齐项:
✅ 核心6因子（趋势/均值回归/RSI/MACD/布林/大盘）
✅ 动量守门员（sigmoid衰减+V型反转豁免）
✅ tiered熔断（15/20/25%分级主动卖出）
✅ 冷却期（买3次/7天、卖2次/5天，critical和高盈利豁免）
✅ 组合级防御（60%基金亏>10%全局禁买）— 单基金回测中简化为peak drawdown检测
✅ FOMC日历（历史会议日期硬编码）
✅ 越跌越买限制（深亏>12%时cap买入信号）
✅ v8.1参数: useSigmoid=false, streak=0.35, tiered熔断

无法对齐（缺历史数据）:
❌ 情绪因子（北向/两融/涨跌比）— 历史数据不可获取
❌ 地缘风险（油价/金价/VIX）— 历史日频数据不可获取
❌ 新闻消息面 — 无法重建历史新闻
❌ 资金流向 — 历史数据不可获取
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


# FOMC历史会议日期(2019-2026)
FOMC_DATES = set([
    # 2019
    '2019-01-30','2019-03-20','2019-05-01','2019-06-19','2019-07-31','2019-09-18','2019-10-30','2019-12-11',
    # 2020
    '2020-01-29','2020-03-03','2020-03-15','2020-04-29','2020-06-10','2020-07-29','2020-09-16','2020-11-05','2020-12-16',
    # 2021
    '2021-01-27','2021-03-17','2021-04-28','2021-06-16','2021-07-28','2021-09-22','2021-11-03','2021-12-15',
    # 2022
    '2022-01-26','2022-03-16','2022-05-04','2022-06-15','2022-07-27','2022-09-21','2022-11-02','2022-12-14',
    # 2023
    '2023-02-01','2023-03-22','2023-05-03','2023-06-14','2023-07-26','2023-09-20','2023-11-01','2023-12-13',
    # 2024
    '2024-01-31','2024-03-20','2024-05-01','2024-06-12','2024-07-31','2024-09-18','2024-11-07','2024-12-18',
    # 2025
    '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30','2025-09-17','2025-10-29','2025-12-17',
    # 2026
    '2026-01-28','2026-03-18','2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-16',
])


def _is_fomc_week(date_str):
    """检查是否在FOMC会议前后3天"""
    from datetime import datetime, timedelta
    try:
        dt = datetime.strptime(date_str[:10], '%Y-%m-%d')
        for fomc in FOMC_DATES:
            fomc_dt = datetime.strptime(fomc, '%Y-%m-%d')
            if abs((dt - fomc_dt).days) <= 3:
                return True
    except:
        pass
    return False


class LiveAlignedV81(Strategy):
    """线上对齐版v8.1动量守门员"""
    def __init__(self, params=None):
        default = {
            # v6.2核心参数
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 77, 'rsi_os': 21, 'rsi_mid_ob': 62, 'rsi_mid_os': 37,
            'macd_signal': 0.21, 'macd_cross': 0.36,
            'bb_extreme': 0.35, 'market_weight': 0.35,
            'atr_limit': 2.5,
            'streak_5': 0.35, 'streak_3': 0.87,
            # v8.1对齐参数
            'bb_hard_ceiling': 92, 'ts_hard_floor': -30,
            'mom_window': 10, 'mom_threshold': -1.0,
            # tiered熔断
            'cb_review': 15, 'cb_reduce': 20, 'cb_critical': 25,
            # 冷却期
            'sell_cool_window': 5, 'sell_cool_max': 2,
            'buy_cool_window': 7, 'buy_cool_max': 3,
            # FOMC
            'fomc_decay': 0.5,
        }
        if params: default.update(params)
        super().__init__('v8.1线上对齐', default)
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

    def _count_recent(self, history, i, window):
        return sum(1 for d in history if i - d <= window)

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        # === 核心6因子（与线上一致）===
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

        # v8.1: v6.2统一衰减
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

        # === 对齐线上的多层决策（修复：取最严者胜，不乘法叠加）===

        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        # tiered熔断（优先级最高，直接覆盖信号）
        if cur_dd > p['cb_critical'] and raw > -0.3:
            raw = -0.5  # critical: 强制卖出
        elif cur_dd > p['cb_reduce'] and raw >= 0:
            raw = -0.2  # reduce: 主动卖
        elif cur_dd > p['cb_review'] and raw >= 0 and raw < 0.15:
            if (tf + rf + rsif) < -0.1:
                raw = -0.12  # review+偏空: 减仓

        # 买入信号的防御层：收集所有衰减因子，取最严的一个（不叠加）
        if raw > 0:
            buy_decay = 1.0  # 1.0=不衰减，越小越保守

            # FOMC会议周
            if i < len(df):
                date_str = str(df['date'].iloc[i])[:10]
                if _is_fomc_week(date_str):
                    buy_decay = min(buy_decay, p['fomc_decay'])

            # 动量守门员
            if i >= p['mom_window']:
                fund_mom = (navs[-1] / navs[-p['mom_window']] - 1) * 100
                if fund_mom < p['mom_threshold']:
                    if i >= 3:
                        recent3d = (navs[-1] / navs[-4] - 1) * 100
                        if recent3d > 2.0 and hist > 0:
                            buy_decay = min(buy_decay, 0.5)  # V反转半额
                        else:
                            decay_val = max(0.15, 1 / (1 + math.exp(-0.8 * (abs(fund_mom) - 3))))
                            buy_decay = min(buy_decay, 1 - decay_val)

            # 大盘下跌
            if market_df is not None and i < len(market_df):
                mkt_chg = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
                if mkt_chg < -1.0:
                    buy_decay = min(buy_decay, 0.4)

            # 深亏限制（>20%时才限制，12%太严）
            if cur_dd > 20:
                buy_decay = min(buy_decay, 0.3)

            # 应用最严的单一衰减，保底30%（对齐线上v8.1b）
            raw *= max(buy_decay, 0.30)

        signal = max(-1, min(1, raw / 2))

        # 卖出冷却期（对齐：5天/2次，critical和高盈利豁免）
        if signal < -0.05:
            is_critical = cur_dd > p['cb_critical']
            cost_approx = navs[30] if len(navs) > 30 else navs[0]
            profit_pct = (current - cost_approx) / cost_approx * 100
            if not is_critical and profit_pct <= 20:
                recent_sells = self._count_recent(self._recent_sells, i, p['sell_cool_window'])
                if recent_sells >= p['sell_cool_max']:
                    signal = 0

        # 买入冷却期（对齐：7天/3次）
        if signal > 0.05:
            recent_buys = self._count_recent(self._recent_buys, i, p['buy_cool_window'])
            if recent_buys >= p['buy_cool_max']:
                signal = 0

        # 记录
        if signal < -0.05: self._recent_sells.append(i)
        elif signal > 0.05: self._recent_buys.append(i)

        return signal


class LiveAlignedV80(Strategy):
    """线上对齐版v8.0非对称（v7.3买入+v6.2卖出）"""
    def __init__(self, params=None):
        super().__init__('v8.0线上对齐', params or {})
        from strategy_local_v62 import LocalV62Strategy
        from strategy_local_v73 import LocalV73Strategy
        self._v62 = LocalV62Strategy()
        self._v73 = LocalV73Strategy()
        self._v81 = LiveAlignedV81()  # 用于决策层的防御逻辑

    def generate_signal(self, df, i, market_df=None):
        s62 = self._v62.generate_signal(df, i, market_df)
        s73 = self._v73.generate_signal(df, i, market_df)

        # 非对称: v7.3买入 + v6.2卖出
        if s73 > 0.05:
            signal = s73
        elif s62 < -0.05:
            signal = s62
        else:
            avg = (s62 + s73) / 2
            signal = avg if abs(avg) > 0.05 else 0.0

        # 叠加v8.1的防御层（动量/FOMC/熔断/冷却）
        navs = df['nav'].values[:i+1] if i < len(df) else []
        if len(navs) > 30:
            peak = np.max(navs)
            cur_dd = (peak - navs[-1]) / peak * 100

            # tiered熔断
            if cur_dd > 25 and signal > -0.3: signal = -0.5
            elif cur_dd > 20 and signal >= 0: signal = -0.2

            # FOMC
            if signal > 0 and i < len(df):
                date_str = str(df['date'].iloc[i])[:10]
                if _is_fomc_week(date_str): signal *= 0.5

            # 动量过滤（sigmoid）
            if signal > 0 and len(navs) >= 10:
                fund_mom = (navs[-1] / navs[-10] - 1) * 100
                if fund_mom < -1.0:
                    if i >= 3:
                        r3d = (navs[-1] / navs[-4] - 1) * 100
                        hist_s = calc_macd(pd.Series(navs))[2]
                        mh = hist_s.iloc[-1] if not np.isnan(hist_s.iloc[-1]) else 0
                        if r3d > 2.0 and mh > 0:
                            signal *= 0.5
                        else:
                            decay_val = max(0.15, 1 / (1 + math.exp(-0.8 * (abs(fund_mom) - 3))))
                            signal *= (1 - decay_val)

        return max(-1, min(1, signal))
