#!/usr/bin/env python3
"""
本地v8.0决策模型 — 结构性升级版
=================================
突破效率前沿的四大结构改变:
1. 混合架构: sigmoid平滑 + 硬底线保护
2. 动态风险预算: 波动率→仓位上限
3. 多时间尺度融合: 周线趋势确认+日线择时
4. 非对称trailing stop: 盈利宽容/亏损收紧
"""

import math
import numpy as np
import pandas as pd
from backtest_engine import Strategy, calc_rsi, calc_macd, calc_bollinger, calc_atr


def _sigmoid(x, center, steepness=0.15):
    return 1 / (1 + math.exp(-steepness * (x - center)))


class LocalV80Strategy(Strategy):
    """v8.0: 结构性突破 — 混合架构+动态风险+多时间尺度+非对称止损"""
    def __init__(self, params=None):
        default = {
            # 预测层 (继承v7.2)
            'trend_weight_trending': 0.796, 'trend_weight_ranging': 0.32, 'trend_weight_volatile': 0.14,
            'reversion_weight_trending': 0.037, 'reversion_weight_ranging': 0.18, 'reversion_weight_volatile': 0.28,
            'rsi_ob': 76, 'rsi_os': 22, 'rsi_mid_ob': 60, 'rsi_mid_os': 31,
            'macd_signal': 0.232, 'macd_cross': 0.386,
            'bb_extreme': 0.35, 'market_weight': 0.35,
            'atr_limit_default': 2.5, 'atr_limit_trending': 3.5,
            # v8 结构改动
            # 1. 混合架构: sigmoid + 硬底线
            'bb_hard_ceiling': 95,       # %B>95 硬归零(v6.2=85, v7.2=sigmoid only)
            'ts_hard_floor': -35,        # trendScore<-35 硬×0.25
            'streak_trending_5': 1.15,   # 趋势连涨: 温和加速(v7.2=1.20)
            'streak_trending_3': 1.05,
            'streak_other_5': 0.35,      # 非趋势: 恢复v6.2强衰减(v7.2=0.55)
            'streak_other_3': 0.80,
            # 2. 动态风险预算
            'vol_budget_low': 15,        # 低波阈值
            'vol_budget_mid': 25,        # 中波阈值
            'pos_max_low_vol': 1.0,      # 低波最大仓位系数
            'pos_max_mid_vol': 0.65,     # 中波
            'pos_max_high_vol': 0.35,    # 高波
            # 3. 多时间尺度
            'weekly_confirm_weight': 0.3, # 周线确认权重
            # 4. 非对称trailing stop
            'trail_profit_atr': 2.5,     # 盈利时trailing宽度(ATR倍数)
            'trail_loss_atr': 1.5,       # 亏损时trailing宽度
        }
        if params: default.update(params)
        super().__init__('v8.0决策模型', default)

    def _detect_regime(self, navs):
        if len(navs) < 30: return 'ranging'
        ma5, ma10, ma20 = np.mean(navs[-5:]), np.mean(navs[-10:]), np.mean(navs[-20:])
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100 if len(ret) > 5 else 15
        if vol > 30: return 'volatile'
        if (ma5 > ma10 > ma20) or (ma5 < ma10 < ma20): return 'trending'
        return 'ranging'

    def _weekly_trend(self, navs):
        """[v8新增] 周线级趋势确认: 每5天采样模拟周K"""
        if len(navs) < 30: return 0
        weekly = navs[::5]
        if len(weekly) < 6: return 0
        # 周线MACD
        dif, dea, hist = calc_macd(pd.Series(weekly), fast=12, slow=26, signal=9)
        h = hist.iloc[-1] if len(hist) > 0 and not np.isnan(hist.iloc[-1]) else 0
        # 周线均线排列
        w5 = np.mean(weekly[-3:]) if len(weekly) >= 3 else weekly[-1]
        w10 = np.mean(weekly[-5:]) if len(weekly) >= 5 else weekly[-1]
        aligned_bull = w5 > w10 and weekly[-1] > w5
        aligned_bear = w5 < w10 and weekly[-1] < w5
        score = 0
        if h > 0: score += 0.5
        elif h < 0: score -= 0.5
        if aligned_bull: score += 0.5
        elif aligned_bear: score -= 0.5
        return max(-1, min(1, score))

    def _dynamic_risk_budget(self, navs):
        """[v8新增] 动态风险预算: 波动率→仓位系数"""
        p = self.params
        if len(navs) < 21: return 1.0
        ret = np.diff(navs[-21:]) / navs[-21:-1]
        vol = np.std(ret) * math.sqrt(250) * 100
        if vol <= p['vol_budget_low']:
            return p['pos_max_low_vol']
        elif vol <= p['vol_budget_mid']:
            # 线性插值
            ratio = (vol - p['vol_budget_low']) / (p['vol_budget_mid'] - p['vol_budget_low'])
            return p['pos_max_low_vol'] - ratio * (p['pos_max_low_vol'] - p['pos_max_mid_vol'])
        else:
            ratio = min((vol - p['vol_budget_mid']) / 15, 1.0)
            return p['pos_max_mid_vol'] - ratio * (p['pos_max_mid_vol'] - p['pos_max_high_vol'])

    def generate_signal(self, df, i, market_df=None):
        p = self.params
        if i < 30: return 0.0
        navs = df['nav'].values[:i+1]
        current = navs[-1]
        regime = self._detect_regime(navs)

        trend_w = p[f'trend_weight_{regime}']
        rev_w = p[f'reversion_weight_{regime}']

        # === 日线信号(继承v7.2核心) ===
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

        # [v8 混合架构] 连涨处理: 趋势温和加速, 非趋势恢复v6.2强衰减
        if regime == 'trending':
            if abs(streak) >= 5: tf *= p['streak_trending_5']
            elif abs(streak) >= 3: tf *= p['streak_trending_3']
        else:
            if abs(streak) >= 5: tf *= p['streak_other_5']   # 恢复v6.2的0.35!
            elif abs(streak) >= 3: tf *= p['streak_other_3']

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
        bb_mult = 1.5 if regime == 'ranging' else 1.0
        bbf = 0
        if pctb > 95: bbf = -p['bb_extreme'] * bb_mult
        elif pctb > 80: bbf = -(pctb - 80) * 0.020 * bb_mult
        elif pctb < 5: bbf = p['bb_extreme'] * bb_mult
        elif pctb < 20: bbf = (20 - pctb) * 0.020 * bb_mult

        # 市场
        mkf = 0
        if market_df is not None and i < len(market_df):
            mc = market_df['change_pct'].iloc[i] if 'change_pct' in market_df.columns else 0
            mkf = mc * p['market_weight'] / 100

        # 波动率修正
        ret20 = np.diff(navs[-21:]) / navs[-21:-1] if len(navs) > 21 else np.array([0])
        vol20 = np.std(ret20) * math.sqrt(250) * 100 if len(ret20) > 5 else 15
        va = 0.626 if vol20 > 24 else (0.85 if vol20 > 15 else 1.0)
        tf *= va; rf *= (2 - va)

        # 日线原始信号
        daily_raw = tf + rf + rsif + mf + bbf + mkf

        # ATR限幅
        atr_s = calc_atr(pd.Series(navs), 14)
        atr = atr_s.iloc[-1] if not np.isnan(atr_s.iloc[-1]) else 0.01
        atr_pct = atr / current * 100
        atr_mult = p['atr_limit_trending'] if regime == 'trending' else p['atr_limit_default']
        daily_raw = max(-atr_pct * atr_mult, min(atr_pct * atr_mult, daily_raw))

        # === [v8 结构1] 多时间尺度融合 ===
        weekly = self._weekly_trend(navs)
        wt_w = p['weekly_confirm_weight']

        if (daily_raw > 0 and weekly > 0) or (daily_raw < 0 and weekly < 0):
            # 日线+周线一致 → 信号加强
            raw = daily_raw * (1 + wt_w * abs(weekly))
        elif (daily_raw > 0 and weekly < 0) or (daily_raw < 0 and weekly > 0):
            # 日线+周线矛盾 → 信号大幅减弱
            raw = daily_raw * (1 - wt_w * abs(weekly))
        else:
            raw = daily_raw

        # === [v8 结构2] 混合架构: sigmoid平滑 + 硬底线 ===

        # 趋势模式判定(继承v7.2: compositeScore>15模拟)
        is_trend_mode = (regime == 'trending') and (hist > 0) and (raw > 0.25)

        # sigmoid层: 布林高位平滑衰减(趋势模式豁免)
        if raw > 0 and not is_trend_mode:
            bb_reduction = 1 - _sigmoid(pctb, 85, 0.12)
            raw *= bb_reduction

        # sigmoid层: 趋势崩坏衰减
        if raw > 0 and ts < 0:
            trend_reduction = 1 - _sigmoid(abs(ts), 25, 0.12)
            raw *= trend_reduction

        # 硬底线层(无论什么模式都生效 — 绝对保护):
        if raw > 0 and pctb > p['bb_hard_ceiling']:
            raw = 0  # %B>95 硬归零
        if raw > 0 and ts < p['ts_hard_floor']:
            raw *= 0.25  # 趋势严重崩坏 硬×0.25

        # 亏损观望(继承v7.2)
        if 0 < raw < 0.15 and ts < -15:
            raw = 0

        # === [v8 结构3] 动态风险预算 ===
        risk_budget = self._dynamic_risk_budget(navs)
        raw *= risk_budget  # 高波时自动缩减信号强度

        # === [v8 结构4] 非对称trailing stop(在回测引擎中通过信号模拟) ===
        # 如果处于回撤中且超过trailing阈值 → 信号翻转为卖出
        peak = np.max(navs[-60:]) if len(navs) >= 60 else np.max(navs)
        cur_dd_pct = (peak - current) / peak * 100

        if cur_dd_pct > atr_pct * p['trail_loss_atr'] and raw > 0:
            # 回撤超过1.5ATR且信号看多 → 冲突, 缩减为0
            raw = 0
        elif cur_dd_pct > atr_pct * p['trail_profit_atr'] and raw > -0.3:
            # 回撤超过2.5ATR → 触发保护性卖出信号
            raw = -0.35

        return max(-1, min(1, raw / 2))
