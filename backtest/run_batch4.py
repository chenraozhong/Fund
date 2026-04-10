#!/usr/bin/env python3 -u
import os,sys,json,math,time as _time
import numpy as np, pandas as pd
import warnings; warnings.filterwarnings('ignore')
for k in ['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']:
    os.environ.pop(k, None)
os.chdir('/Volumes/WD_SN7100_2TB/Code/Fund/backtest')
sys.path.insert(0, '.')

from backtest_engine import fetch_fund_nav_history, fetch_index_history
from visual_arena import run_backtest_enhanced, analyze_performance
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy
from strategy_new_ideas import AsymmetricStrategy, MomGateSensitive, VoteStrategy
from strategy_buyhold import BuyHoldStrategy

print("Fetching market index...", flush=True)
market_df = fetch_index_history('1.000001', 1825)
print(f"Market data: {len(market_df)} days", flush=True)

FUNDS = [
    ('018897','易方达消费电子ETF联接C','消费'),('004753','广发中证传媒ETF联接C','消费'),
    ('012600','招商中证白酒指数C','白酒'),('012414','南方中证消费电子ETF联接E','消费'),
    ('013122','华夏中证大农业联接C','消费'),('012090','富国中证消费50ETF联接C','消费'),
    ('012073','国泰中证动漫游戏联接C','传媒'),('015876','天弘中证食品饮料联接C','消费'),
    ('004224','广发中证军工ETF联接C','军工'),('012683','易方达中证军工ETF联接C','军工'),
    ('012698','天弘中证军工ETF联接C','军工'),('012854','南方中证军工ETF联接C','军工'),
    ('014974','鹏华中证军工龙头ETF联接C','军工'),
    ('050025','博时标普500ETF联接C','美股'),('006479','广发纳斯达克100ETF联接C','美股'),
    ('013125','天弘恒生科技指数C','港股'),('014521','华夏恒生科技ETF联接C','港股'),
    ('012906','华夏纳斯达克100联接C','美股'),
    ('016874','广发远见智选混合C','混合'),('001938','中欧时代先锋C','混合'),
    ('005827','易方达蓝筹精选混合','混合'),
    ('004642','广发中证银行ETF联接C','金融'),('006098','华夏中证银行ETF联接C','金融'),
    ('012816','南方中证房地产ETF联接C','地产'),('012870','富国中证证券公司联接C','券商'),
    ('013092','华泰柏瑞中证全指建材联接C','建材'),
    ('519671','银河沪深300成长C','红利'),
]

from collections import defaultdict
all_r = defaultdict(list)

for code, name, sector in FUNDS:
    _time.sleep(0.3)
    df = fetch_fund_nav_history(code, 1825)
    if df is None or len(df) < 60:
        print(f'SKIP {name}({code}) - insufficient data', flush=True)
        continue

    strats = [BuyHoldStrategy(), LocalV62Strategy(), LocalV73Strategy()]
    a = AsymmetricStrategy(); a.name = 'v8.0非对称'; strats.append(a)
    m = MomGateSensitive(); m.name = 'v8.1动量守门员'; strats.append(m)

    print(f'{name[:20]}({code}) {sector} {len(df)}天', flush=True)
    for s in strats:
        if hasattr(s,'_v62'): s._v62 = LocalV62Strategy()
        if hasattr(s,'_v73'): s._v73 = LocalV73Strategy()
        if hasattr(s,'_bought'): s._bought = False
        r = run_backtest_enhanced(df, s, market_df=market_df, initial_capital=100000)
        p = analyze_performance(r['nav_curve'], r['trades'])
        ret=round(p['total_return'],2); sh=round(p['sharpe'],3); dd=round(p['max_drawdown'],2)
        cal=round(ret/abs(dd),2) if dd!=0 else 0
        all_r[s.name].append({'fund':name,'sector':sector,'r':ret,'sh':sh,'dd':dd,'cal':cal,'days':len(df)})
        print(f'  {s.name:20s} 收益{ret:+6.1f}% 夏普{sh:6.3f} 回撤{dd:6.1f}% 卡{cal:5.2f}', flush=True)

print('\n=== 消费+军工+海外+混合 排行（按卡尔玛）===', flush=True)
for sn, items in sorted(all_r.items(), key=lambda x: -np.mean([i['cal'] for i in x[1]])):
    ar=np.mean([i['r'] for i in items]); add=np.mean([i['dd'] for i in items]); acal=np.mean([i['cal'] for i in items])
    print(f'  {sn:20s} ({len(items)}只) 收益{ar:+6.1f}% 回撤{add:6.1f}% 卡尔玛{acal:5.2f}', flush=True)

print('\n=== 逐基金冠军 ===', flush=True)
fund_names = set(i['fund'] for items in all_r.values() for i in items)
for fname in sorted(fund_names):
    best = max([(sn, i) for sn, items in all_r.items() for i in items if i['fund']==fname], key=lambda x: x[1]['cal'])
    print(f'  {fname[:20]:22s} [{best[1]["sector"]:4s}] 冠军:{best[0]:16s} 卡{best[1]["cal"]:.2f} 收{best[1]["r"]:+.1f}% 撤{best[1]["dd"]:.1f}%', flush=True)

json.dump(dict(all_r), open('batch4_results.json','w'), ensure_ascii=False)
print('\nDone! Results saved to batch4_results.json', flush=True)
