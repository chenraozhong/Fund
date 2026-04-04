#!/usr/bin/env python3
"""
版本对抗引擎 — v6.2 vs v7.0 vs v7.1 (+ 经典策略对照)
================================================
可视化HTML报告: 净值曲线/回撤/胜负/逐基金对比
扩大基金池: 21只基金覆盖8板块
"""

import os, sys, json, math, time as _time
from datetime import datetime
from typing import Dict
import warnings
warnings.filterwarnings('ignore')

for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
    os.environ.pop(key, None)

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest_engine import fetch_fund_nav_history, fetch_index_history, calc_performance
from visual_arena import (
    run_backtest_enhanced, analyze_performance, calc_drawdown_series,
    DualMomentumStrategy, KaufmanAMAStrategy,
)
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v70 import LocalV70Strategy
from strategy_local_v71 import LocalV71Strategy
from strategy_local_v72 import LocalV72Strategy
from strategy_local_v80 import LocalV80Strategy
from strategy_local_v73 import LocalV73Strategy
from strategy_local_v74 import LocalV74Strategy
from strategy_local_v75 import LocalV75Strategy

# 扩大基金池: 21只基金覆盖8板块
TEST_FUNDS = [
    ('000217', '华安黄金ETF联接C'),
    ('002611', '博时黄金ETF联接C'),
    ('004253', '国泰黄金ETF联接C'),
    ('020982', '华安国证机器人产业指数C'),
    ('023408', '华宝创业板AI ETF联接C'),
    ('019671', '广发港股创新药ETF联接C'),
    ('010572', '易方达中证万得生物科技C'),
    ('019325', '易方达中证生物科技ETF联接C'),
    ('008888', '华夏国证半导体芯片ETF联接C'),
    ('025209', '永赢先锋半导体智选混合C'),
    ('012365', '广发中证光伏产业指数C'),
    ('017074', '嘉实清洁能源股票C'),
    ('012832', '南方中证新能源ETF联接C'),
    ('016387', '永赢低碳环保智选混合C'),
    ('010990', '南方有色金属ETF联接E'),
    ('011036', '嘉实中证稀土产业ETF联接C'),
    ('018897', '易方达消费电子ETF联接C'),
    ('004753', '广发中证传媒ETF联接C'),
    ('022365', '永赢科技智选混合C'),
    ('016874', '广发远见智选混合C'),
    ('024195', '永赢国证商用卫星通信C'),
]

CODE_TO_SECTOR = {
    '000217': '黄金', '002611': '黄金', '004253': '黄金',
    '020982': 'AI/机器人', '023408': 'AI/机器人',
    '019671': '医药/生物', '010572': '医药/生物', '019325': '医药/生物',
    '008888': '半导体', '025209': '半导体',
    '012365': '新能源/光伏', '017074': '新能源/光伏', '012832': '新能源/光伏', '016387': '新能源/光伏',
    '010990': '有色/稀土', '011036': '有色/稀土',
    '018897': '消费/传媒', '004753': '消费/传媒',
    '022365': '混合/主题', '016874': '混合/主题', '024195': '混合/主题',
}


def generate_version_html(results: Dict, fund_results: Dict) -> str:
    strategies = list(results.keys())
    colors = {
        'v6.2决策模型': '#e74c3c',
        'v7.0决策模型': '#f39c12',
        'v7.1决策模型': '#9b59b6',
        'v7.2决策模型': '#f39c12',
        'v7.3决策模型': '#f39c12',
        'v7.4决策模型': '#1abc9c',
        'v7.5a决策模型': '#2ecc71',
        'v8.0决策模型': '#9b59b6',
        '双动量(Antonacci)': '#7f8c8d',
        '自适应均线(Kaufman)': '#95a5a6',
    }

    rankings = []
    for name, data in results.items():
        p = data['perf_avg']
        score = (p.get('sharpe',0)*30 + p.get('total_return',0)*0.2 +
                 (100+p.get('max_drawdown',0))*0.15 + p.get('calmar',0)*15 +
                 p.get('win_rate',0)*0.1)
        rankings.append({**p, 'name': name, 'score': round(score,2),
                         'color': colors.get(name, '#888')})
    rankings.sort(key=lambda x: x['score'], reverse=True)

    # 逐基金胜负 (v7.3 vs v7.4)
    prev_wins = 0; v74_wins = 0; draws = 0
    fund_comparison = []
    for code, fd in fund_results.items():
        s73 = fd['strategies'].get('v7.3决策模型', {}).get('perf', {})
        s74 = fd['strategies'].get('v7.4决策模型', {}).get('perf', {})
        sh73 = s73.get('sharpe', 0)
        sh74 = s74.get('sharpe', 0)
        if sh74 > sh73 + 0.05: v74_wins += 1; winner = 'v7.4'
        elif sh73 > sh74 + 0.05: prev_wins += 1; winner = 'v7.3'
        else: draws += 1; winner = '平手'
        fund_comparison.append({
            'name': fd['name'], 'code': code,
            'v74_sharpe': sh73, 'v74_sharpe': sh74,
            'v74_return': s73.get('total_return',0), 'v74_return': s74.get('total_return',0),
            'v74_dd': s73.get('max_drawdown',0), 'v74_dd': s74.get('max_drawdown',0),
            'winner': winner,
        })

    avg_curves = {}
    max_len = 0
    for sname, data in results.items():
        curves = [fd['strategies'][sname]['nav_curve'] for fd in fund_results.values()
                  if sname in fd['strategies'] and fd['strategies'][sname]['nav_curve']]
        if not curves: continue
        ml = max(len(c) for c in curves)
        max_len = max(max_len, ml)
        aligned = [c + [c[-1]]*(ml-len(c)) for c in curves]
        avg_curves[sname] = np.mean([a[:ml] for a in aligned], axis=0).tolist()

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>版本对抗: v6.2 vs v7.0 vs v7.1</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:-apple-system,sans-serif;background:#0a0a1a;color:#e0e0e0;}}
.c{{max-width:1400px;margin:0 auto;padding:20px;}}
h1{{text-align:center;font-size:2em;margin:20px 0;background:linear-gradient(90deg,#e74c3c,#1abc9c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}}
h2{{color:#3498db;margin:30px 0 15px;font-size:1.3em;border-left:4px solid #3498db;padding-left:12px;}}
table{{width:100%;border-collapse:collapse;margin:15px 0;}}
th{{background:#1a1a3a;padding:10px 8px;text-align:center;font-size:0.9em;border-bottom:2px solid #3498db;}}
td{{padding:8px;text-align:center;border-bottom:1px solid #2a2a4a;font-size:0.9em;}}
tr:hover{{background:#1a1a3a;}}
.pos{{color:#2ecc71;}}.neg{{color:#e74c3c;}}.draw{{color:#f1c40f;}}
.stats{{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin:20px 0;}}
.sc{{background:#12122a;border-radius:10px;padding:15px;text-align:center;border:1px solid #2a2a4a;}}
.sv{{font-size:2em;font-weight:bold;margin:5px 0;}}.sl{{font-size:0.8em;color:#888;}}
.cb{{background:#12122a;border-radius:12px;padding:20px;border:1px solid #2a2a4a;margin:15px 0;}}
.cb canvas{{width:100%!important;}}
.badge{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.8em;font-weight:bold;}}
.b62{{background:rgba(231,76,60,0.2);color:#e74c3c;}}
.b70{{background:rgba(26,188,156,0.2);color:#1abc9c;}}
.ts{{text-align:center;color:#555;margin-top:30px;font-size:0.8em;}}
</style></head><body><div class="c">
<h1>版本对抗: v6.2 vs v7.0 vs v7.1</h1>
<p style="text-align:center;color:#888;">五派评审+回撤精调 | {len(fund_results)}只基金 | {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>

<div class="stats">
  <div class="sc" style="border-color:#1abc9c;">
    <div class="sl">v7.4 胜</div><div class="sv pos">{v74_wins}</div>
  </div>
  <div class="sc" style="border-color:#e74c3c;">
    <div class="sl">v6.2 胜</div><div class="sv neg">{v62_wins}</div>
  </div>
  <div class="sc" style="border-color:#f1c40f;">
    <div class="sl">平手</div><div class="sv draw">{draws}</div>
  </div>
  <div class="sc">
    <div class="sl">总对局</div><div class="sv" style="color:#3498db;">{len(fund_results)}</div>
  </div>
</div>
"""

    # 排行榜
    html += '<h2>综合排行</h2><table><tr><th>排名</th><th>版本</th><th>综合分</th><th>夏普</th><th>收益率</th><th>最大回撤</th><th>卡尔玛</th><th>日胜率</th></tr>'
    for i, r in enumerate(rankings):
        is_v7 = 'v7.4' in r['name']
        s = f'style="background:rgba(26,188,156,0.08);border:1px solid #1abc9c;"' if is_v7 else ''
        html += f'<tr {s}><td>{i+1}</td><td style="color:{r["color"]};font-weight:bold;">{"⚡ " if is_v7 else ""}{r["name"]}</td>'
        html += f'<td><b>{r["score"]}</b></td>'
        html += f'<td class="{"pos" if r.get("sharpe",0)>0 else "neg"}">{r.get("sharpe",0):.3f}</td>'
        html += f'<td class="{"pos" if r.get("total_return",0)>0 else "neg"}">{r.get("total_return",0):.2f}%</td>'
        html += f'<td class="neg">{r.get("max_drawdown",0):.2f}%</td>'
        html += f'<td class="{"pos" if r.get("calmar",0)>0 else "neg"}">{r.get("calmar",0):.3f}</td>'
        html += f'<td>{r.get("win_rate",0):.1f}%</td></tr>'
    html += '</table>'

    # 逐基金胜负
    html += '<h2>逐基金胜负 (v6.2 vs v7.1)</h2><table><tr><th>基金</th><th>v6.2夏普</th><th>v7.4夏普</th><th>v6.2收益</th><th>v7.4收益</th><th>v6.2回撤</th><th>v7.4回撤</th><th>胜者</th></tr>'
    for fc in fund_comparison:
        w_class = 'pos' if fc['winner']=='v7.1' else ('neg' if fc['winner']=='v6.2' else 'draw')
        html += f'<tr><td style="text-align:left;">{fc["name"]}</td>'
        html += f'<td>{fc["v62_sharpe"]:.3f}</td><td>{fc["v74_sharpe"]:.3f}</td>'
        html += f'<td>{fc["v62_return"]:+.2f}%</td><td>{fc["v74_return"]:+.2f}%</td>'
        html += f'<td>{fc["v62_dd"]:.2f}%</td><td>{fc["v74_dd"]:.2f}%</td>'
        html += f'<td class="{w_class}"><span class="badge {"b70" if fc["winner"]=="v7.4" else "b62" if fc["winner"]=="v6.2" else ""}">{fc["winner"]}</span></td></tr>'
    html += '</table>'

    # 净值+回撤图
    html += f"""
<h2>综合净值曲线</h2>
<div class="cb"><canvas id="navC" height="100"></canvas></div>
<div class="cb"><canvas id="ddC" height="80"></canvas></div>

<script>
const colors={json.dumps(colors)};
const avg={json.dumps(avg_curves)};
function mkDs(data,isNav){{
  return Object.entries(data).map(([n,c])=>{{
    const pts=isNav?c.map((v,i)=>({{x:i,y:v}})):[];
    if(!isNav){{let pk=c[0];c.forEach((v,i)=>{{pk=Math.max(pk,v);pts.push({{x:i,y:(v-pk)/pk*100}});}});}}
    return{{label:n,data:pts,borderColor:colors[n]||'#888',backgroundColor:n.includes('v7.4')?'rgba(26,188,156,0.08)':'transparent',
    borderWidth:n.includes('v7.4')||n.includes('v6.2')?3:1.2,pointRadius:0,tension:0.1,fill:n.includes('v7.4')&&!isNav}};
  }});
}}
const opt=(t)=>({{responsive:true,plugins:{{title:{{display:true,text:t,color:'#e0e0e0',font:{{size:14}}}},legend:{{labels:{{color:'#e0e0e0'}}}}}},
scales:{{x:{{type:'linear',ticks:{{color:'#888'}},grid:{{color:'#1a1a3a'}}}},y:{{ticks:{{color:'#888'}},grid:{{color:'#1a1a3a'}}}}}}}});
new Chart(document.getElementById('navC'),{{type:'line',data:{{datasets:mkDs(avg,true)}},options:opt('综合净值曲线（所有基金平均）')}});
new Chart(document.getElementById('ddC'),{{type:'line',data:{{datasets:mkDs(avg,false)}},options:opt('回撤对比')}});
</script>
<p class="ts">版本对抗引擎 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
</div></body></html>"""
    return html


def main():
    print("=" * 60)
    print("  版本对抗: v6.2 vs v7.0 (+ 经典策略对照)")
    print("=" * 60)

    strategies = [
        LocalV62Strategy(),
        LocalV73Strategy(),
        LocalV74Strategy(),
        LocalV75Strategy(),
        DualMomentumStrategy(),
        KaufmanAMAStrategy(),
    ]

    print(f"\n参赛: {[s.name for s in strategies]}")
    print("\n获取大盘数据...")
    market_df = fetch_index_history('1.000001', 365)
    if market_df.empty:
        print("  [WARN] 大盘数据失败")
        market_df = None
    else:
        print(f"  上证: {len(market_df)}条")

    all_results = {s.name: {'perfs': [], 'perf_avg': {}} for s in strategies}
    fund_results = {}

    for idx, (code, name) in enumerate(TEST_FUNDS):
        print(f"\n[{idx+1}/{len(TEST_FUNDS)}] {name} ({code})")
        df = fetch_fund_nav_history(code, 365)
        if df.empty or len(df) < 60:
            print(f"  [SKIP] 数据不足")
            continue
        print(f"  数据: {len(df)}条")

        fd = {'name': name, 'strategies': {}}
        for s in strategies:
            r = run_backtest_enhanced(df, s, market_df)
            perf = analyze_performance(r['nav_curve'], r['trades'])
            all_results[s.name]['perfs'].append(perf)
            fd['strategies'][s.name] = {'nav_curve': r['nav_curve'], 'perf': perf, 'trades': r['trades']}
            print(f"  {s.name:16s} | 收益{perf['total_return']:+8.2f}% | 夏普{perf['sharpe']:7.3f} | 回撤{perf['max_drawdown']:8.2f}%")
        fund_results[code] = fd

    # 汇总
    print("\n" + "=" * 60)
    for sn, d in all_results.items():
        if not d['perfs']: continue
        avg = {}
        for k in d['perfs'][0]:
            vals = [p.get(k,0) for p in d['perfs'] if isinstance(p.get(k,0),(int,float))]
            avg[k] = round(np.mean(vals),3) if vals else 0
        d['perf_avg'] = avg
        print(f"\n{sn}: 夏普{avg.get('sharpe',0):.3f} | 收益{avg.get('total_return',0):+.2f}% | 回撤{avg.get('max_drawdown',0):.2f}% | 卡尔玛{avg.get('calmar',0):.3f}")

    # HTML
    html = generate_version_html(all_results, fund_results)
    path = os.path.join(os.path.dirname(__file__), 'version_battle_report.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"\n报告: {path}")

    # JSON
    jpath = os.path.join(os.path.dirname(__file__), 'version_battle_results.json')
    with open(jpath, 'w', encoding='utf-8') as f:
        json.dump({k: v['perf_avg'] for k, v in all_results.items()}, f, ensure_ascii=False, indent=2)

    # 胜负
    v62 = all_results.get('v6.2决策模型', {}).get('perf_avg', {})
    v70 = all_results.get('v7.0决策模型', {}).get('perf_avg', {})
    v72 = all_results.get('v7.2决策模型', {}).get('perf_avg', {})
    v73 = all_results.get('v7.3决策模型', {}).get('perf_avg', {})
    versions = [('v6.2', v62), ('v7.2', v72), ('v7.3', v73)]
    print(f"\n{'='*60}")
    for name, vd in versions:
        print(f"  {name}: 夏普{vd.get('sharpe',0):.3f} | 收益{vd.get('total_return',0):+.2f}% | 回撤{vd.get('max_drawdown',0):.2f}% | 卡尔玛{vd.get('calmar',0):.3f}")
    best = max(versions, key=lambda x: x[1].get('calmar', 0))
    print(f"  🏆 卡尔玛最优: {best[0]} ({best[1].get('calmar',0):.3f})")
    best_s = max(versions, key=lambda x: x[1].get('sharpe', 0))
    print(f"  🏆 夏普最优: {best_s[0]} ({best_s[1].get('sharpe',0):.3f})")
    best_r = max(versions, key=lambda x: x[1].get('total_return', 0))
    print(f"  🏆 收益最优: {best_r[0]} ({best_r[1].get('total_return',0):+.2f}%)")
    print("=" * 60)


if __name__ == '__main__':
    main()
