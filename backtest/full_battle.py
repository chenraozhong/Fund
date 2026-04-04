#!/usr/bin/env python3
"""
完整对抗回测 — 21只基金 × 8+策略 × 逐笔交易明细HTML报告
"""
import os, sys, json, math, time as _time
from datetime import datetime
from typing import Dict, List
import warnings; warnings.filterwarnings('ignore')
for k in ['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']:
    os.environ.pop(k, None)

import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))

from backtest_engine import fetch_fund_nav_history, fetch_index_history
from visual_arena import run_backtest_enhanced, analyze_performance, DualMomentumStrategy, KaufmanAMAStrategy, TurtleTradingStrategy, TripleScreenStrategy
from strategy_local_v62 import LocalV62Strategy
from strategy_local_v73 import LocalV73Strategy
from strategy_local_v74 import LocalV74Strategy
from strategy_local_v75 import LocalV75Strategy
from strategy_gold import GoldStrategy
from strategy_trend_hunter import TrendHunterStrategy

TEST_FUNDS = [
    ('000217', '华安黄金', '黄金'), ('002611', '博时黄金', '黄金'), ('004253', '国泰黄金', '黄金'),
    ('020982', '华安机器人', 'AI/机器人'), ('023408', '华宝AI ETF', 'AI/机器人'),
    ('019671', '广发港股创新药', '医药'), ('010572', '易方达生物科技LOF', '医药'), ('019325', '易方达生科ETF', '医药'),
    ('008888', '华夏半导体', '半导体'), ('025209', '永赢半导体', '半导体'),
    ('012365', '广发光伏', '新能源'), ('017074', '嘉实清洁能源', '新能源'),
    ('012832', '南方新能源', '新能源'), ('016387', '永赢低碳环保', '新能源'),
    ('010990', '南方有色', '有色'), ('011036', '嘉实稀土', '有色'),
    ('018897', '易方达消费电子', '消费'), ('004753', '广发传媒', '消费'),
    ('022365', '永赢科技', '混合'), ('016874', '广发远见', '混合'), ('024195', '永赢卫星通信', '混合'),
]

STRATEGY_COLORS = {
    'v6.2决策模型': '#e74c3c', 'v7.3决策模型': '#e67e22', 'v7.4决策模型': '#f1c40f',
    'v7.5b决策模型': '#2ecc71', '黄金专属模型': '#FFD700',
    '双动量': '#3498db', '海龟交易': '#9b59b6', '三重滤网': '#1abc9c',
    '趋势猎手': '#e91e63', 'Kaufman自适应': '#795548',
}

def make_strategies(is_gold=False):
    strats = [
        LocalV62Strategy(), LocalV73Strategy(), LocalV74Strategy(), LocalV75Strategy(),
        DualMomentumStrategy(), TurtleTradingStrategy(), KaufmanAMAStrategy(), TrendHunterStrategy(),
    ]
    if is_gold:
        strats.append(GoldStrategy())
    return strats

def run_all():
    print("获取大盘数据...")
    market_df = fetch_index_history('1.000001', 400)
    if market_df is None: print("  大盘数据失败，继续"); market_df = None

    all_data = []  # [{fund, sector, strategy, return, sharpe, max_dd, trades:[...], nav_curve:[...]}]

    for idx, (code, name, sector) in enumerate(TEST_FUNDS):
        print(f"\n[{idx+1}/{len(TEST_FUNDS)}] {name} ({code}) — {sector}")
        df = fetch_fund_nav_history(code, 400)
        if df is None or len(df) < 60:
            print("  数据不足, 跳过"); continue

        dates = [str(d)[:10] for d in df['date']]
        navs = df['nav'].tolist()
        is_gold = sector == '黄金'
        strategies = make_strategies(is_gold)

        for s in strategies:
            # Reset state
            for attr in ['_cb_triggered_day']:
                if hasattr(s, attr): setattr(s, attr, -999)
            for attr in ['_recent_sells', '_recent_buys']:
                if hasattr(s, attr): setattr(s, attr, [])

            result = run_backtest_enhanced(df, s, market_df=market_df, initial_capital=100000)
            perf = analyze_performance(result['nav_curve'], result['trades'])

            all_data.append({
                'fund': name, 'code': code, 'sector': sector,
                'strategy': s.name,
                'return': round(perf['total_return'], 2),
                'sharpe': round(perf['sharpe'], 3),
                'max_dd': round(perf['max_drawdown'], 2),
                'calmar': round(perf['total_return'] / abs(perf['max_drawdown']), 2) if perf['max_drawdown'] != 0 else 0,
                'trades': result['trades'],
                'nav_curve': [round(v, 6) for v in result['nav_curve']],
                'dates': dates,
                'fund_navs': [round(v, 4) for v in navs],
            })

            buys = len([t for t in result['trades'] if t['action']=='buy'])
            sells = len([t for t in result['trades'] if t['action']=='sell'])
            print(f"  {s.name:18s} 收益{perf['total_return']:+6.1f}% 夏普{perf['sharpe']:5.2f} 回撤{perf['max_drawdown']:6.1f}% 买{buys:>2d} 卖{sells:>2d}")

    return all_data

def generate_html(all_data):
    # Pre-compute summary tables
    from collections import defaultdict
    by_strat = defaultdict(list)
    by_fund = defaultdict(list)
    for d in all_data:
        by_strat[d['strategy']].append(d)
        by_fund[d['fund']].append(d)

    strat_summary = []
    for sname, items in sorted(by_strat.items(), key=lambda x: -np.mean([i['return'] for i in x[1]])):
        strat_summary.append({
            'name': sname,
            'funds': len(items),
            'avg_return': round(np.mean([i['return'] for i in items]), 2),
            'avg_sharpe': round(np.mean([i['sharpe'] for i in items]), 3),
            'avg_dd': round(np.mean([i['max_dd'] for i in items]), 2),
            'avg_calmar': round(np.mean([i['calmar'] for i in items]), 2),
            'win_count': sum(1 for i in items if i['return'] > 0),
            'color': STRATEGY_COLORS.get(sname, '#666'),
        })

    fund_summary = []
    for fname, items in by_fund.items():
        best = max(items, key=lambda x: x['sharpe'])
        fund_summary.append({
            'name': fname, 'sector': items[0]['sector'], 'code': items[0]['code'],
            'best_strategy': best['strategy'], 'best_return': best['return'], 'best_sharpe': best['sharpe'],
        })

    # Serialize trades for JS (limit to save size)
    js_data = []
    for d in all_data:
        trades_slim = [{
            'd': t['date'], 'a': t['action'][0], 'n': round(t['nav'], 4),
            's': round(t['shares'], 1), 'm': round(t['amount'], 0), 'g': round(t['signal'], 3)
        } for t in d['trades']]
        js_data.append({
            'f': d['fund'], 'c': d['code'], 'sec': d['sector'], 'st': d['strategy'],
            'r': d['return'], 'sh': d['sharpe'], 'dd': d['max_dd'], 'cal': d['calmar'],
            'tr': trades_slim, 'nc': d['nav_curve'], 'dt': d['dates'], 'fn': d['fund_navs'],
        })

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>v7.5b 全量对抗回测报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:16px}}
.container{{max-width:1400px;margin:0 auto}}
h1{{font-size:28px;font-weight:800;color:#f8fafc;margin-bottom:4px}}
h2{{font-size:18px;font-weight:700;color:#94a3b8;margin:24px 0 12px;border-bottom:1px solid #1e293b;padding-bottom:8px}}
.subtitle{{color:#64748b;font-size:13px;margin-bottom:24px}}
.grid{{display:grid;gap:12px}}.grid-2{{grid-template-columns:1fr 1fr}}.grid-3{{grid-template-columns:1fr 1fr 1fr}}.grid-4{{grid-template-columns:repeat(4,1fr)}}
.card{{background:#1e293b;border-radius:12px;padding:16px;border:1px solid #334155}}
.stat{{text-align:center}}.stat .v{{font-size:28px;font-weight:800}}.stat .l{{font-size:11px;color:#64748b;margin-top:2px}}
.green{{color:#10b981}}.red{{color:#ef4444}}.blue{{color:#3b82f6}}.amber{{color:#f59e0b}}.gold{{color:#fbbf24}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th{{text-align:left;padding:8px;background:#0f172a;color:#64748b;font-weight:600;border-bottom:1px solid #334155;position:sticky;top:0}}
td{{padding:6px 8px;border-bottom:1px solid #1e293b}}
tr:hover td{{background:#334155}}
.badge{{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700}}
.badge-buy{{background:#064e3b;color:#6ee7b7}}.badge-sell{{background:#7f1d1d;color:#fca5a5}}
.tabs{{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}}
.tab{{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:#1e293b;color:#94a3b8;border:1px solid #334155}}
.tab.active{{background:#3b82f6;color:white;border-color:#3b82f6}}
.chart-box{{position:relative;height:300px;margin:8px 0}}
.trade-list{{max-height:400px;overflow-y:auto;font-size:11px;font-family:monospace}}
.trade-row{{display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #1e293b}}
.hidden{{display:none}}
select{{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:6px 12px;border-radius:8px;font-size:12px}}
@media(max-width:768px){{.grid-2,.grid-3,.grid-4{{grid-template-columns:1fr}}.chart-box{{height:200px}}}}
</style></head><body>
<div class="container">
<h1>v7.5b 全量对抗回测报告</h1>
<p class="subtitle">{len(TEST_FUNDS)}只基金 × {len(set(d['strategy'] for d in all_data))}个策略 | 380天历史数据 | {datetime.now().strftime('%Y-%m-%d %H:%M')}</p>

<h2>一、策略排行榜</h2>
<div class="card"><table>
<thead><tr><th>#</th><th>策略</th><th>基金数</th><th>平均收益</th><th>平均夏普</th><th>平均回撤</th><th>卡尔玛</th><th>胜率</th></tr></thead>
<tbody>{''.join(f'''<tr>
<td>{i+1}</td><td style="color:{s['color']};font-weight:700">{s['name']}</td><td>{s['funds']}</td>
<td class="{'green' if s['avg_return']>0 else 'red'}" style="font-weight:700">{s['avg_return']:+.1f}%</td>
<td>{s['avg_sharpe']:.2f}</td><td>{s['avg_dd']:.1f}%</td><td>{s['avg_calmar']:.2f}</td>
<td>{s['win_count']}/{s['funds']}</td></tr>''' for i,s in enumerate(strat_summary))}</tbody></table></div>

<h2>二、逐基金最优策略</h2>
<div class="card"><table>
<thead><tr><th>基金</th><th>板块</th><th>最优策略</th><th>最优收益</th><th>最优夏普</th></tr></thead>
<tbody>{''.join(f'''<tr><td>{f['name']}</td><td>{f['sector']}</td>
<td style="font-weight:700">{f['best_strategy']}</td>
<td class="green" style="font-weight:700">{f['best_return']:+.1f}%</td>
<td>{f['best_sharpe']:.2f}</td></tr>''' for f in sorted(fund_summary, key=lambda x: -x['best_sharpe']))}</tbody></table></div>

<h2>三、逐基金详细对比（含净值曲线+交易明细）</h2>
<div>
  <label>选择基金：</label>
  <select id="fundSelect" onchange="showFund(this.value)">
    {''.join(f'<option value="{f[0]}">{f[1]} ({f[2]})</option>' for f in TEST_FUNDS)}
  </select>
</div>
<div id="fundDetail" class="card" style="margin-top:12px">
  <div class="chart-box"><canvas id="navChart"></canvas></div>
  <div id="stratTabs" class="tabs" style="margin-top:12px"></div>
  <div id="tradeDetail"></div>
</div>

<h2>四、全量数据表</h2>
<div class="card" style="max-height:600px;overflow:auto"><table id="fullTable">
<thead><tr><th>基金</th><th>板块</th><th>策略</th><th>收益%</th><th>夏普</th><th>回撤%</th><th>卡尔玛</th><th>买入</th><th>卖出</th></tr></thead>
<tbody></tbody></table></div>

</div>

<script>
const DATA = {json.dumps(js_data, ensure_ascii=False)};
const COLORS = {json.dumps(STRATEGY_COLORS, ensure_ascii=False)};

// Populate full table
const tbody = document.querySelector('#fullTable tbody');
DATA.forEach(d => {{
  const buys = d.tr.filter(t=>t.a==='b').length;
  const sells = d.tr.filter(t=>t.a==='s').length;
  const rc = d.r >= 0 ? 'green' : 'red';
  tbody.innerHTML += `<tr><td>${{d.f}}</td><td>${{d.sec}}</td>
    <td style="color:${{COLORS[d.st]||'#aaa'}};font-weight:700">${{d.st}}</td>
    <td class="${{rc}}" style="font-weight:700">${{d.r>0?'+':''}}${{d.r.toFixed(1)}}%</td>
    <td>${{d.sh.toFixed(2)}}</td><td>${{d.dd.toFixed(1)}}%</td><td>${{d.cal.toFixed(2)}}</td>
    <td>${{buys}}</td><td>${{sells}}</td></tr>`;
}});

let navChart = null;
function showFund(code) {{
  const items = DATA.filter(d => d.c === code);
  if (!items.length) return;

  // Chart: fund NAV + strategy nav curves
  const dates = items[0].dt;
  const datasets = [{{
    label: items[0].f + ' 净值',
    data: items[0].fn, borderColor: '#475569', borderWidth: 1.5,
    pointRadius: 0, yAxisID: 'y',
  }}];
  items.forEach(d => {{
    // Normalize nav_curve to fund NAV scale
    const scale = d.fn[0];
    datasets.push({{
      label: d.st + ` (${{d.r>0?'+':''}}${{d.r}}%)`,
      data: d.nc.map(v => v * scale),
      borderColor: COLORS[d.st] || '#888', borderWidth: 2,
      pointRadius: 0, yAxisID: 'y',
    }});
  }});

  if (navChart) navChart.destroy();
  navChart = new Chart(document.getElementById('navChart'), {{
    type: 'line',
    data: {{ labels: dates, datasets }},
    options: {{
      responsive: true, maintainAspectRatio: false,
      interaction: {{ mode: 'index', intersect: false }},
      plugins: {{ legend: {{ labels: {{ color: '#94a3b8', font: {{ size: 10 }} }} }} }},
      scales: {{
        x: {{ ticks: {{ color: '#475569', maxTicksLimit: 15, font: {{ size: 9 }} }}, grid: {{ color: '#1e293b' }} }},
        y: {{ ticks: {{ color: '#475569', font: {{ size: 9 }} }}, grid: {{ color: '#1e293b' }} }},
      }}
    }}
  }});

  // Strategy tabs + trade details
  const tabsDiv = document.getElementById('stratTabs');
  const detailDiv = document.getElementById('tradeDetail');
  tabsDiv.innerHTML = '';
  items.forEach((d, idx) => {{
    const buys = d.tr.filter(t=>t.a==='b');
    const sells = d.tr.filter(t=>t.a==='s');
    const tab = document.createElement('div');
    tab.className = 'tab' + (idx===0?' active':'');
    tab.style.borderLeftColor = COLORS[d.st]||'#888';
    tab.style.borderLeftWidth = '3px';
    tab.textContent = `${{d.st}} (${{d.r>0?'+':''}}${{d.r}}%)`;
    tab.onclick = () => {{
      tabsDiv.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      showTrades(d);
    }};
    tabsDiv.appendChild(tab);
  }});
  if (items.length > 0) showTrades(items[0]);
}}

function showTrades(d) {{
  const div = document.getElementById('tradeDetail');
  const buys = d.tr.filter(t=>t.a==='b');
  const sells = d.tr.filter(t=>t.a==='s');
  let html = `<div style="display:flex;gap:16px;margin:8px 0;font-size:12px">
    <span>收益 <b class="${{d.r>=0?'green':'red'}}">${{d.r>0?'+':''}}${{d.r}}%</b></span>
    <span>夏普 <b>${{d.sh.toFixed(2)}}</b></span>
    <span>回撤 <b>${{d.dd.toFixed(1)}}%</b></span>
    <span>买入 <b class="green">${{buys.length}}次</b> ¥${{buys.reduce((s,t)=>s+t.m,0).toLocaleString()}}</span>
    <span>卖出 <b class="red">${{sells.length}}次</b> ¥${{sells.reduce((s,t)=>s+t.m,0).toLocaleString()}}</span>
  </div>`;

  if (d.tr.length === 0) {{
    html += '<div style="text-align:center;color:#64748b;padding:20px">无交易记录</div>';
  }} else {{
    html += '<div class="trade-list"><table style="width:100%"><thead><tr><th>日期</th><th>操作</th><th>净值</th><th>份额</th><th>金额</th><th>信号</th></tr></thead><tbody>';
    d.tr.forEach(t => {{
      const isBuy = t.a === 'b';
      html += `<tr>
        <td>${{t.d}}</td>
        <td><span class="badge ${{isBuy?'badge-buy':'badge-sell'}}">${{isBuy?'买入':'卖出'}}</span></td>
        <td>${{t.n.toFixed(4)}}</td>
        <td style="text-align:right">${{t.s.toFixed(1)}}</td>
        <td style="text-align:right;font-weight:700">¥${{t.m.toLocaleString()}}</td>
        <td style="color:${{t.g>0?'#10b981':'#ef4444'}}">${{t.g>0?'+':''}}${{t.g.toFixed(3)}}</td>
      </tr>`;
    }});
    html += '</tbody></table></div>';
  }}
  div.innerHTML = html;
}}

// Auto-show first fund
showFund('{TEST_FUNDS[0][0]}');
</script></body></html>"""
    return html


def main():
    print("=" * 60)
    print("  完整对抗回测: 21基金 × 8+策略")
    print("=" * 60)

    t0 = _time.time()
    all_data = run_all()

    # Summary
    from collections import defaultdict
    by_strat = defaultdict(list)
    for d in all_data:
        by_strat[d['strategy']].append(d)

    print("\n" + "=" * 60)
    print("  策略排行榜")
    print("=" * 60)
    ranked = sorted(by_strat.items(), key=lambda x: -np.mean([i['sharpe'] for i in x[1]]))
    for i, (sname, items) in enumerate(ranked):
        avg_r = np.mean([d['return'] for d in items])
        avg_s = np.mean([d['sharpe'] for d in items])
        avg_d = np.mean([d['max_dd'] for d in items])
        n = len(items)
        print(f"  #{i+1} {sname:18s} ({n}只) 收益{avg_r:+6.1f}% 夏普{avg_s:5.2f} 回撤{avg_d:6.1f}%")

    # Generate HTML
    print("\n生成HTML报告...")
    html = generate_html(all_data)
    outfile = os.path.join(os.path.dirname(__file__), 'full_battle_report.html')
    with open(outfile, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"报告已保存: {outfile}")
    print(f"总耗时: {_time.time()-t0:.0f}秒")


if __name__ == '__main__':
    main()
