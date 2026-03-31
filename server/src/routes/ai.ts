import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

// 支持三方 AI 服务（兼容 Anthropic API 协议）
// 环境变量：
//   ANTHROPIC_API_KEY  — API 密钥（必填）
//   ANTHROPIC_BASE_URL — 自定义 API 地址（可选，默认 https://api.anthropic.com）
//   AI_MODEL           — 模型名称（可选，默认 claude-sonnet-4-20250514）
const AI_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-20250514';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';

console.log(`AI config: model=${AI_MODEL}, baseURL=${AI_BASE_URL}, key=${AI_KEY ? AI_KEY.slice(0, 8) + '...' : '(not set)'}`);

async function callAI(prompt: string): Promise<string> {
  const url = `${AI_BASE_URL}/v1/messages`;

  const body = {
    model: AI_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      // 同时发送两种认证头，兼容官方和第三方
      'x-api-key': AI_KEY,
      'Authorization': `Bearer ${AI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`AI API error: ${response.status} ${response.statusText}`, errBody);
    const err: any = new Error(`${response.status} ${response.statusText}`);
    err.status = response.status;
    err.body = errBody;
    throw err;
  }

  const data = await response.json() as any;

  // 兼容不同返回格式
  if (data.content && Array.isArray(data.content)) {
    return data.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');
  }

  // 有些服务直接返回 { text: "..." } 或 { message: "..." }
  if (data.text) return data.text;
  if (data.message) return typeof data.message === 'string' ? data.message : JSON.stringify(data.message);

  return JSON.stringify(data);
}

router.get('/funds/:id/advice', async (req: Request, res: Response) => {
  const { id } = req.params;

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) {
    res.status(404).json({ error: 'Fund not found' });
    return;
  }

  // Get positions
  const positions = db.prepare(`
    SELECT
      asset,
      SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END) as buy_shares,
      SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END) as sell_shares,
      SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END) as buy_cost,
      SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END) as sell_revenue,
      SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END) as dividends,
      COUNT(*) as tx_count
    FROM transactions
    WHERE fund_id = ?
    GROUP BY asset
    ORDER BY buy_cost DESC
  `).all(id) as any[];

  // Get recent transactions (last 20)
  const recentTxs = db.prepare(`
    SELECT date, type, asset, shares, price, notes
    FROM transactions
    WHERE fund_id = ?
    ORDER BY date DESC, created_at DESC
    LIMIT 20
  `).all(id) as any[];

  // Build position summary
  const positionSummary = positions.map(p => {
    const holdingShares = p.buy_shares - p.sell_shares;
    const totalCost = p.buy_cost;
    const avgCost = p.buy_shares > 0 ? p.buy_cost / p.buy_shares : 0;
    const currentValue = p.buy_cost - p.sell_revenue + p.dividends;
    const gain = currentValue - totalCost;
    return {
      asset: p.asset,
      holding_shares: Math.round(holdingShares * 100) / 100,
      avg_cost: Math.round(avgCost * 10000) / 10000,
      total_cost: Math.round(totalCost * 100) / 100,
      current_value: Math.round(currentValue * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      gain_pct: totalCost > 0 ? Math.round((gain / totalCost) * 10000) / 100 : 0,
    };
  });

  const totalCost = positionSummary.reduce((s, p) => s + p.total_cost, 0);
  const totalValue = positionSummary.reduce((s, p) => s + p.current_value, 0);
  const holdingShares = positionSummary.reduce((s, p) => s + p.holding_shares, 0);
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0;
  const mNav = fund.market_nav || 0;
  const marketValue = mNav > 0 ? holdingShares * mNav : totalValue;
  const gain = marketValue - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost * 100) : 0;

  // 获取近期净值趋势（如果有基金代码）
  let navTrendText = '无历史净值数据（无基金代码）';
  if (fund.code) {
    try {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fund.code}&pageIndex=1&pageSize=20&startDate=&endDate=`;
      const navRes = await fetch(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
      const navData = await navRes.json() as any;
      if (navData.Data?.LSJZList?.length > 0) {
        const navList = navData.Data.LSJZList.map((item: any) => ({
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          change: item.JZZZL ? parseFloat(item.JZZZL) : null,
        })).reverse();

        const navValues = navList.map((n: any) => n.nav);
        const ma5 = navValues.slice(-5).reduce((a: number, b: number) => a + b, 0) / Math.min(navValues.length, 5);
        const ma10 = navValues.slice(-10).reduce((a: number, b: number) => a + b, 0) / Math.min(navValues.length, 10);
        const latest = navValues[navValues.length - 1];
        const change5d = navValues.length >= 6 ? ((latest - navValues[navValues.length - 6]) / navValues[navValues.length - 6] * 100) : 0;

        navTrendText = `最新净值：${latest.toFixed(4)}
MA5（5日均线）：${ma5.toFixed(4)} | MA10（10日均线）：${ma10.toFixed(4)}
近5日涨跌：${change5d >= 0 ? '+' : ''}${change5d.toFixed(2)}%
均线状态：${latest > ma5 && ma5 > ma10 ? '多头排列（上涨趋势）' : latest < ma5 && ma5 < ma10 ? '空头排列（下跌趋势）' : '交叉震荡'}
近20日净值：
${navList.slice(-10).map((n: any) => `  ${n.date}: ${n.nav.toFixed(4)}${n.change !== null ? ` (${n.change >= 0 ? '+' : ''}${n.change}%)` : ''}`).join('\n')}`;
      }
    } catch { /* 获取失败用默认文案 */ }
  }

  const prompt = `你是一位专业的中国基金投资顾问，擅长中国公募基金（包括ETF联接基金、指数基金、混合基金）的投资策略分析。

## 基金信息
- 名称：${fund.name}${fund.code ? `（代码：${fund.code}）` : ''}
- 当前净值：${mNav > 0 ? `¥${mNav.toFixed(4)}` : '未设置'}
- 持仓均价：¥${costNav.toFixed(4)}
- 持有份额：${holdingShares.toFixed(2)} 份
- 总成本：¥${totalCost.toFixed(2)}
- 当前市值：¥${marketValue.toFixed(2)}
- 浮动盈亏：¥${gain.toFixed(2)}（${gainPct.toFixed(2)}%）
- 止盈线：${fund.stop_profit_pct || 5}% | 止损线：${fund.stop_loss_pct || 5}%

## 净值趋势
${navTrendText}

## 当前持仓明细
${positionSummary.length > 0
  ? positionSummary.map(p =>
    `- ${p.asset}：${p.holding_shares}份 × ¥${p.avg_cost} = ¥${p.total_cost}，盈亏 ¥${p.gain}（${p.gain_pct}%）`
  ).join('\n')
  : '暂无持仓'}

## 最近交易记录
${recentTxs.length > 0
  ? recentTxs.slice(0, 15).map(tx => {
    const typeLabel = tx.type === 'buy' ? '买入' : tx.type === 'sell' ? '卖出' : '分红';
    const amount = tx.type === 'dividend' ? `¥${tx.price}` : `${tx.shares}份 × ¥${tx.price} = ¥${(tx.shares * tx.price).toFixed(2)}`;
    return `- ${tx.date} ${typeLabel} ${amount}${tx.notes ? '（' + tx.notes + '）' : ''}`;
  }).join('\n')
  : '暂无交易记录'}

请按以下结构给出**明天的具体操作建议**（中文回答，简洁实用）：

### 持仓诊断
- 用1-2句话评估当前持仓状态（是否健康、风险点在哪）
- 判断当前是盈利兑现期、成本摊低期、还是正常持有期

### 明日如果上涨（+1%~+3%）
- **具体操作**：持有/减仓/止盈？操作多少份额或金额？
- **理由**：基于净值趋势和盈亏状态说明

### 明日如果下跌（-1%~-3%）
- **具体操作**：持有/加仓/补仓/止损？操作多少份额或金额？
- **理由**：什么价位适合加仓？加仓多少合适？

### 本周操作要点
- 给出2-3条具体的操作要点（含价位、金额）
- 如有定投建议，给出具体金额和频率

要求：
1. 建议必须具体到金额或份额，不要空话
2. 结合净值均线趋势判断，不要只看盈亏
3. 风险提示要具体（比如"距止损线还有X%"而不是"注意风险"）
4. 如果数据不足，如实说明并给出保守建议`;

  if (!AI_KEY) {
    res.status(500).json({ error: '未配置 ANTHROPIC_API_KEY 环境变量，无法使用 AI 功能。' });
    return;
  }

  try {
    const text = await callAI(prompt);

    res.json({
      advice: text,
      generated_at: new Date().toISOString(),
      fund_name: fund.name,
      positions_count: positions.length,
      total_cost: totalCost,
      total_value: totalValue,
    });
  } catch (err: any) {
    if (err.status === 401) {
      res.status(500).json({ error: `API 认证失败（401）：请检查 API Key 是否正确。请求地址：${AI_BASE_URL}/v1/messages` });
    } else if (err.status === 404) {
      res.status(500).json({ error: `API 接口未找到（404）：请检查地址是否正确。请求地址：${AI_BASE_URL}/v1/messages，模型：${AI_MODEL}` });
    } else {
      res.status(500).json({ error: `AI 分析失败（${err.status || 'unknown'}）：${err.message}` });
    }
  }
});

export default router;
