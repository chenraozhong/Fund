#!/usr/bin/env python3
"""
快速体制切换策略 — 多信号融合熊市检测（5-10天识别）
替代MA120的慢均线方案，用技术面+市场微结构多维信号

熊市检测信号（每个信号有独立分数，累加超阈值触发）:
1. 大盘急跌: 上证5日跌>3% (-3分)
2. 死亡交叉: 大盘MA5<MA20 (-2分)
3. 波动率飙升: 大盘20日波动率>25% (-2分)
4. 普跌共振: 当日大盘+基金同时下跌 (-1分/次)
5. 连续阴跌: 大盘连续5天下跌 (-3分)
6. 跌破关键均线: 大盘跌破MA60 (-2分)
7. 基金自身回撤>10% (-2分)

牛市恢复信号:
1. 大盘5日涨>3% (+3分)
2. 金叉: MA5>MA20 (+2分)
3. 波动率回落<18% (+1分)
4. 站上MA60 (+2分)

体制: bear_score <= -6 → 熊市, >= +4 → 牛市, 中间 → 中性
"""
import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class FastRegimeStrategy(Strategy):
    """快速体制切换: 多信号融合熊市检测 + v7.3牛市引擎 + v6.2熊市引擎"""

    def __init__(self, params=None):
        default = {
            # 体制检测阈值
            'bear_threshold': -6,      # 累计分<=-6 → 进入熊市
            'bull_threshold': 4,       # 累计分>=4 → 进入牛市
            'score_decay': 0.85,       # 每天分数衰减（防止旧信号长期影响）

            # v6.2引擎参数(熊市)
            'v62_streak_5': 0.35, 'v62_streak_3': 0.87,
            'v62_bb_ceiling': 92, 'v62_ts_floor': -30,
            'v62_atr_limit': 2.5,

            # v7.3引擎参数(牛市)
            'v73_streak_trending_5': 1.20, 'v73_streak_trending_3': 1.08,
            'v73_streak_other_5': 0.35, 'v73_streak_other_3': 0.80,
            'v73_bb_ceiling': 95, 'v73_ts_floor': -35,
            'v73_atr_limit_trending': 3.5, 'v73_atr_limit_default': 2.5,

            # 共享
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
            'macd_signal': 0.232, 'macd_cross': 0.386,
            'bb_extreme': 0.35, 'market_weight': 0.35,
        }
        if params: default.update(params)
        super().__init__('快速体制切换', default)
        self._regime = 'neutral'
        self._regime_score = 0.0
        self._bear_days = 0

    def _compute_regime_score(self, market_df, i, fund_navs):
        """多信号融合计算体制分数（负=熊市信号，正=牛市信号）"""
        p = self.params
        score = self._regime_score * p['score_decay']  # 衰减旧分数

        has_market = market_df is not None and i < len(market_df) and 'close' in market_df.columns
        if not has_market:
            return score

        closes = market_df['close'].values
        if i < 60:
            return score

        current_mkt = closes[i]
        mkt_changes = market_df['change_pct'].values if 'change_pct' in market_df.columns else np.zeros(len(closes))

        # === 熊市信号 ===

        # 1. 大盘急跌: 5日跌幅
        mkt_5d_ret = (current_mkt / closes[i-5] - 1) * 100 if i >= 5 else 0
        if mkt_5d_ret < -5: score -= 4      # 暴跌
        elif mkt_5d_ret < -3: score -= 3     # 急跌
        elif mkt_5d_ret < -1.5: score -= 1   # 快跌

        # 2. 死亡交叉: MA5 < MA20
        ma5_mkt = np.mean(closes[i-4:i+1])
        ma20_mkt = np.mean(closes[i-19:i+1]) if i >= 19 else ma5_mkt
        if ma5_mkt < ma20_mkt * 0.99: score -= 2   # 明确死叉
        elif ma5_mkt < ma20_mkt: score -= 1         # 弱死叉

        # 3. 波动率飙升
        if i >= 20:
            mkt_ret20 = np.diff(closes[i-20:i+1]) / closes[i-20:i]
            mkt_vol = np.std(mkt_ret20) * math.sqrt(250) * 100
            if mkt_vol > 30: score -= 3
            elif mkt_vol > 25: score -= 2
            elif mkt_vol > 20: score -= 1

        # 4. 连续阴跌
        down_streak = 0
        for j in range(i, max(i-10, 0), -1):
            if mkt_changes[j] < 0:
                down_streak += 1
            else:
                break
        if down_streak >= 7: score -= 4
        elif down_streak >= 5: score -= 3
        elif down_streak >= 3: score -= 1

        # 5. 跌破MA60
        ma60_mkt = np.mean(closes[i-59:i+1]) if i >= 59 else current_mkt
        if current_mkt < ma60_mkt * 0.97: score -= 2
        elif current_mkt < ma60_mkt: score -= 1

        # 6. 基金自身回撤
        if len(fund_navs) > 20:
            fund_peak = np.max(fund_navs[-60:]) if len(fund_navs) > 60 else np.max(fund_navs)
            fund_dd = (fund_peak - fund_navs[-1]) / fund_peak * 100
            if fund_dd > 15: score -= 3
            elif fund_dd > 10: score -= 2
            elif fund_dd > 5: score -= 1

        # === 牛市信号 ===

        # 1. 大盘反弹
        if mkt_5d_ret > 5: score += 4
        elif mkt_5d_ret > 3: score += 3
        elif mkt_5d_ret > 1.5: score += 1

        # 2. 金叉: MA5 > MA20
        if ma5_mkt > ma20_mkt * 1.01: score += 2
        elif ma5_mkt > ma20_mkt: score += 1

        # 3. 波动率回落
        if i >= 20:
            if mkt_vol < 15: score += 2
            elif mkt_vol < 18: score += 1

        # 4. 站上MA60
        if current_mkt > ma60_mkt * 1.02: score += 2
        elif current_mkt > ma60_mkt: score += 1

        # 5. 连续上涨
        up_streak = 0
        for j in range(i, max(i-10, 0), -1):
            if mkt_changes[j] > 0:
                up_streak += 1
            else:
                break
        if up_streak >= 5: score += 3
        elif up_streak >= 3: score += 1

        # 限制范围
        score = max(-15, min(15, score))
        self._regime_score = score

        # 判定体制
        if score <= p['bear_threshold']:
            self._regime = 'bear'
            self._bear_days += 1
        elif score >= p['bull_threshold']:
            self._regime = 'bull'
            self._bear_days = 0
        else:
            self._regime = 'neutral'
            self._bear_days = 0

        return score

    def _detect_fund_regime(self, navs):
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

        # 多信号体制检测
        regime_score = self._compute_regime_score(market_df, i, navs)
        market_regime = self._regime

        # === 核心因子 ===
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

        # 体制切换: 连涨衰减
        if market_regime == 'bull':
            if fund_regime == 'trending':
                if abs(streak) >= 5: tf *= p['v73_streak_trending_5']
                elif abs(streak) >= 3: tf *= p['v73_streak_trending_3']
            else:
                if abs(streak) >= 5: tf *= p['v73_streak_other_5']
                elif abs(streak) >= 3: tf *= p['v73_streak_other_3']
        else:
            if abs(streak) >= 5: tf *= p['v62_streak_5']
            elif abs(streak) >= 3: tf *= p['v62_streak_3']

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
        bb_mult = 1.5 if fund_regime == 'ranging' else 1.0
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bbf = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 20: bbf = (20 - pctb) * 0.020 * bb_mult

        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100
            # 熊市中大盘因子权重翻倍（大盘跌对基金的拖累更大）
            if market_regime == 'bear':
                mkf *= 2.0

        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        tf *= va; rf *= (2 - va)

        raw = tf + rf + rsif + mf + bbf + mkf

        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100

        if market_regime == 'bull':
            atr_mult = p['v73_atr_limit_trending'] if fund_regime == 'trending' else p['v73_atr_limit_default']
        else:
            atr_mult = p['v62_atr_limit']
        raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, raw))

        is_trend_mode = (fund_regime == 'trending') and (hist > 0) and (raw > 0.25)

        # 硬底线
        if market_regime == 'bull':
            if raw > 0 and not is_trend_mode:
                raw *= 1 - _sigmoid(pctb, 85, 0.12)
            if raw > 0 and ts < 0:
                raw *= 1 - _sigmoid(abs(ts), 25, 0.12)
            if raw > 0 and pctb > p['v73_bb_ceiling']: raw = 0
            if raw > 0 and ts < p['v73_ts_floor']: raw *= 0.25
        else:
            if raw > 0 and pctb > p['v62_bb_ceiling']: raw = 0
            if raw > 0 and ts < p['v62_ts_floor']: raw *= 0.25
            # 熊市: 买入信号额外衰减
            if market_regime == 'bear' and raw > 0:
                bear_decay = max(0.3, 1.0 - self._bear_days * 0.05)  # 熊市越久越保守
                raw *= bear_decay

        if 0 < raw < 0.15 and ts < -15: raw = 0

        # 熊市快速止损（不等v6.2的peak drawdown，直接看体制分数）
        peak = np.max(navs)
        cur_dd = (peak - current) / peak * 100

        if market_regime == 'bear':
            if cur_dd > 15 and raw > -0.3: raw = -0.5
            elif cur_dd > 10 and raw >= 0: raw = -0.2
            elif cur_dd > 5 and raw >= 0 and raw < 0.15 and regime_score < -8:
                raw = -0.15  # 分数很低+小回撤→提前减仓
        else:
            if cur_dd > 25 and raw > -0.3: raw = -0.5

        return max(-1, min(1, raw / 2))
