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
      avg_cost: Math.round(avgCost * 100) / 100,
      total_cost: Math.round(totalCost * 100) / 100,
      current_value: Math.round(currentValue * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      gain_pct: totalCost > 0 ? Math.round((gain / totalCost) * 10000) / 100 : 0,
    };
  });

  const totalCost = positionSummary.reduce((s, p) => s + p.total_cost, 0);
  const totalValue = positionSummary.reduce((s, p) => s + p.current_value, 0);

  const prompt = `你是一位专业的基金投资顾问。请根据以下基金持仓和交易数据，分析并给出明天涨跌两种情况下的操作建议。

## 基金信息
- 名称：${fund.name}
- 总成本：¥${totalCost.toFixed(2)}
- 当前市值：¥${totalValue.toFixed(2)}
- 盈亏：¥${(totalValue - totalCost).toFixed(2)}（${totalCost > 0 ? ((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0}%）

## 当前持仓
${positionSummary.length > 0
  ? positionSummary.map(p =>
    `- ${p.asset}：持有 ${p.holding_shares} 份，均价 ¥${p.avg_cost}，成本 ¥${p.total_cost}，盈亏 ¥${p.gain}（${p.gain_pct}%）`
  ).join('\n')
  : '暂无持仓'}

## 最近交易记录
${recentTxs.length > 0
  ? recentTxs.map(tx => {
    const typeLabel = tx.type === 'buy' ? '买入' : tx.type === 'sell' ? '卖出' : '分红';
    const amount = tx.type === 'dividend' ? `¥${tx.price}` : `${tx.shares}份 × ¥${tx.price}`;
    return `- ${tx.date} ${typeLabel} ${tx.asset} ${amount}${tx.notes ? '（' + tx.notes + '）' : ''}`;
  }).join('\n')
  : '暂无交易记录'}

请给出以下分析（使用中文回答）：

### 1. 持仓评估
简要评估当前持仓结构和风险。

### 2. 如果明天上涨
分析在上涨情况下，每个持仓应该如何操作（持有/加仓/减仓/止盈），给出具体建议和理由。

### 3. 如果明天下跌
分析在下跌情况下，每个持仓应该如何操作（持有/加仓/补仓/止损），给出具体建议和理由。

### 4. 总结建议
给出一句话核心建议。

注意：请基于数据给出务实的建议，不要过度推测市场走向。如果数据不足以做出判断，请如实说明。`;

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
