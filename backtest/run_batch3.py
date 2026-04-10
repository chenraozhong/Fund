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
from strategy_trend_hunter import TrendHunterStrategy

print("Fetching market index...", flush=True)
market_df = fetch_index_history('1.000001', 1825)
print(f"Market data: {len(market_df) if market_df is not None else 0} days", flush=True)

FUNDS = [
    ('012365','广发中证光伏产业指数C','新能源'),('017074','嘉实清洁能源股票C','新能源'),
    ('012832','南方中证新能源ETF联接C','新能源'),('016387','永赢低碳环保智选C','新能源'),
    ('013046','天弘中证光伏产业联接C','新能源'),('012049','国泰中证新能源汽车联接C','新能源'),
    ('013812','富国中证新能源汽车联接C','新能源'),('015689','华夏中证新能源联接C','新能源'),
    ('010990','南方有色金属ETF联接E','有色'),('011036','嘉实中证稀土产业ETF联接C','有色'),
    ('014266','华夏中证有色金属联接C','有色'),('013219','广发中证铜ETF联接C','有色'),
    ('012860','国泰中证煤炭ETF联接C','资源'),
    ('019671','广发港股创新药ETF联接C','医药'),('010572','易方达中证万得生物科技C','医药'),
    ('019325','易方达中证生物科技ETF联接C','医药'),('012848','广发中证医疗ETF联接C','医药'),
    ('013011','华宝中证医疗ETF联接C','医药'),('012781','天弘中证生物科技联接C','医药'),
    ('017229','招商国证生物医药指数C','医药'),('014872','鹏华中证中药联接C','中药'),
]

from collections import defaultdict
all_r = defaultdict(list)

for code, name, sector in FUNDS:
    _time.sleep(0.3)
    try:
        df = fetch_fund_nav_history(code, 1825)
        if df is None or len(df) < 60:
            print(f'SKIP {name}({code}) - insufficient data', flush=True)
            continue

        strats = [BuyHoldStrategy(), LocalV62Strategy(), LocalV73Strategy()]
        a = AsymmetricStrategy(); a.name = 'v8.0非对称'; strats.append(a)
        m = MomGateSensitive(); m.name = 'v8.1动量守门员'; strats.append(m)
        strats.append(TrendHunterStrategy())

        print(f'{name[:20]}({code}) {sector} {len(df)}天', flush=True)
        for s in strats:
            try:
                if hasattr(s,'_v62'): s._v62 = LocalV62Strategy()
                if hasattr(s,'_v73'): s._v73 = LocalV73Strategy()
                if hasattr(s,'_bought'): s._bought = False
                r = run_backtest_enhanced(df, s, market_df=market_df, initial_capital=100000)
                p = analyze_performance(r['nav_curve'], r['trades'])
                ret=round(p['total_return'],2); sh=round(p['sharpe'],3); dd=round(p['max_drawdown'],2)
                cal=round(ret/abs(dd),2) if dd!=0 else 0
                all_r[s.name].append({'fund':name,'sector':sector,'r':ret,'sh':sh,'dd':dd,'cal':cal,'days':len(df)})
                print(f'  {s.name:20s} 收益{ret:+6.1f}% 夏普{sh:6.3f} 回撤{dd:6.1f}% 卡{cal:5.2f}', flush=True)
            except Exception as e:
                print(f'  {s.name:20s} ERROR: {e}', flush=True)
    except Exception as e:
        print(f'ERROR on {name}({code}): {e}', flush=True)

print('\n=== 新能源+有色+医药 排行（按卡尔玛）===', flush=True)
for sn, items in sorted(all_r.items(), key=lambda x: -np.mean([i['cal'] for i in x[1]])):
    ar=np.mean([i['r'] for i in items]); add=np.mean([i['dd'] for i in items]); acal=np.mean([i['cal'] for i in items])
    print(f'  {sn:20s} ({len(items)}只) 收益{ar:+6.1f}% 回撤{add:6.1f}% 卡尔玛{acal:5.2f}', flush=True)

print('\n=== 逐基金冠军 ===', flush=True)
fund_names = set(i['fund'] for items in all_r.values() for i in items)
for fname in sorted(fund_names):
    best = max([(sn, i) for sn, items in all_r.items() for i in items if i['fund']==fname], key=lambda x: x[1]['cal'])
    print(f'  {fname[:20]:22s} [{best[1]["sector"]:4s}] 冠军:{best[0]:16s} 卡{best[1]["cal"]:.2f} 收{best[1]["r"]:+.1f}% 撤{best[1]["dd"]:.1f}%', flush=True)

json.dump(dict(all_r), open('batch3_results.json','w'), ensure_ascii=False)
print('\nDone! Results saved to batch3_results.json', flush=True)
