import { Router, Request, Response } from 'express';
import db from '../db';
import { fetchFundamental, fetchSectorNews, inferSectorKeyword } from '../datasource';

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

/** 调用AI识别图片内容 */
async function callAIWithImage(prompt: string, imageBase64: string, mediaType: string = 'image/png'): Promise<string> {
  const url = `${AI_BASE_URL}/v1/messages`;

  const body = {
    model: AI_MODEL,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': AI_KEY,
      'Authorization': `Bearer ${AI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`AI API error: ${response.status} ${errBody.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  if (data.content && Array.isArray(data.content)) {
    return data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  }
  return data.text || JSON.stringify(data);
}

/** 识别交易：支持截图(image)或粘贴文字(text) */
router.post('/recognize-trades', async (req: Request, res: Response) => {
  try {
    const { image, text } = req.body;
    if (!image && !text) { res.status(400).json({ error: '请上传截图或粘贴交易文字' }); return; }
    if (!AI_KEY) { res.status(503).json({ error: 'AI服务未配置' }); return; }

    let aiResult: string;

    if (text) {
      // 文字模式：用户粘贴了支付宝交易文字
      aiResult = await callAI(`以下是从支付宝复制的基金交易记录文字，请提取所有交易信息。${prompt}\n\n原始文字：\n${text}`);
    } else {
      // 图片模式
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = image.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';

    const prompt = `这是一张支付宝基金交易记录的截图。请仔细识别每一笔交易。

支付宝交易记录的典型格式：
- 每笔交易通常包含：基金名称、交易类型（买入/卖出/赎回/分红/转入/转出）、金额、日期、状态
- 买入/申购显示为负数金额（如 -1,000.00）表示支出
- 卖出/赎回显示为正数金额（如 +1,000.00）表示收入
- 分红到账也显示正数
- 日期格式可能是 MM-DD 或 YYYY-MM-DD 或 "昨天"/"今天"等

请提取所有交易，返回JSON数组。每笔交易格式：
[
  {
    "fund_name": "完整基金名称",
    "fund_code": "6位数字代码(如果截图中有显示)",
    "type": "buy/sell/dividend",
    "amount": 金额的绝对值(纯数字,不含符号和逗号),
    "shares": 份额(纯数字,如果有显示),
    "nav": 净值(纯数字,如果有显示),
    "date": "YYYY-MM-DD(如果只有月日请补充2026年)",
    "status": "状态文字"
  }
]

重要规则：
- 支出/买入/申购/转入 → type="buy"
- 收入/卖出/赎回/转出 → type="sell"
- 分红/红利再投 → type="dividend"
- 金额统一取绝对值（去掉正负号）
- 如果截图中有多笔交易，全部提取
- 只返回JSON数组，不要任何解释文字`;

      aiResult = await callAIWithImage(prompt, base64Data, mediaType);
    }

    // 尝试解析JSON
    let trades: any[] = [];
    try {
      // 提取JSON部分（AI可能返回带markdown代码块的格式）
      const jsonMatch = aiResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        trades = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // 解析失败返回原始文本
      res.json({ success: true, trades: [], raw: aiResult, message: '识别完成但JSON解析失败，请查看原始结果' });
      return;
    }

    // 匹配系统中已有的基金
    for (const t of trades) {
      if (t.fund_code) {
        const existing = db.prepare('SELECT id, name FROM funds WHERE code = ?').get(t.fund_code) as any;
        if (existing) {
          t.matched_fund_id = existing.id;
          t.matched_fund_name = existing.name;
        }
      } else if (t.fund_name) {
        const existing = db.prepare('SELECT id, name, code FROM funds WHERE name LIKE ?').get(`%${t.fund_name.slice(0, 6)}%`) as any;
        if (existing) {
          t.matched_fund_id = existing.id;
          t.matched_fund_name = existing.name;
          t.fund_code = existing.code;
        }
      }
    }

    res.json({ success: true, trades, raw: aiResult });
  } catch (err: any) {
    res.status(500).json({ error: '识别失败: ' + err.message });
  }
});

router.get('/funds/:id/research', async (req: Request, res: Response) => {
  const { id } = req.params;

  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(id) as any;
  if (!fund) { res.status(404).json({ error: '基金不存在' }); return; }

  // 持仓数据
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) as holding_shares,
      COALESCE(SUM(CASE WHEN type = 'buy' THEN shares * price ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'sell' THEN shares * price ELSE 0 END), 0) +
      COALESCE(SUM(CASE WHEN type = 'dividend' THEN price ELSE 0 END), 0) as cost_basis
    FROM transactions WHERE fund_id = ?
  `).get(id) as any;

  const holdingShares = row.holding_shares;
  const totalCost = row.cost_basis;
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0;
  const mNav = fund.market_nav || 0;
  const gain = mNav > 0 ? (mNav - costNav) / costNav * 100 : 0;

  // 获取基本面数据
  let fundamental = null;
  if (fund.code) {
    fundamental = await fetchFundamental(fund.code);
  }

  const sectorKeyword = inferSectorKeyword(fund.name);

  // 获取行业新闻
  const news = await fetchSectorNews(sectorKeyword, 8);

  // 组装原始数据（不管有没有AI，都返回）
  const rawData = {
    fundamental,
    news,
    sectorKeyword,
    position: {
      holdingShares: Math.round(holdingShares * 100) / 100,
      costNav: Math.round(costNav * 10000) / 10000,
      marketNav: mNav,
      gainPct: Math.round(gain * 100) / 100,
    },
  };

  // 如果没有AI Key，只返回原始数据
  if (!AI_KEY) {
    res.json({ ...rawData, analysis: null, error: '未配置AI，仅返回原始数据' });
    return;
  }

  // AI 综合分析
  const newsText = news.length > 0
    ? news.map((n, i) => `${i + 1}. [${n.date}] ${n.title}（${n.source}）`).join('\n')
    : '暂无相关新闻';

  const fundInfo = fundamental
    ? `基金经理：${fundamental.manager}（任职${fundamental.managerDays}，任期回报${fundamental.managerReturn}）
费率：${fundamental.rate}
规模：${fundamental.scale}
资产配置：${fundamental.assetAlloc}
持有人结构：${fundamental.holderStructure}
业绩评价：${fundamental.performance}
重仓持股：${fundamental.topHoldings}`
    : '无基金代码，未获取基本面数据';

  const prompt = `你是一位专业的中国基金投资分析师。请基于以下数据，给出消息面和基本面的综合分析。

## 基金信息
- 名称：${fund.name}${fund.code ? `（${fund.code}）` : ''}
- 当前净值：${mNav > 0 ? mNav.toFixed(4) : '未知'}
- 成本净值：${costNav.toFixed(4)}
- 浮动盈亏：${gain.toFixed(2)}%
- 持仓份额：${holdingShares.toFixed(2)}份
- 板块：${sectorKeyword}

## 基本面数据
${fundInfo}

## 近期行业新闻（${sectorKeyword}相关）
${newsText}

请按以下结构分析（中文，简明扼要，每部分2-3句话）：

### 基本面评估
- 基金经理能力和任期稳定性
- 基金规模是否合适（太大影响灵活性，太小有清盘风险）
- 费率和持有人结构分析
- 资产配置和重仓股评价

### 消息面分析
- 当前行业/板块的核心消息和事件
- 这些消息对基金净值的短期影响（利多/利空/中性）
- 需要关注的风险点

### 综合研判
- 基本面+消息面结合，对该基金的中短期展望
- 对我持仓的具体建议（加仓/持有/减仓），结合当前${gain >= 0 ? '盈利' : '亏损'}状态

要求：
1. 结论明确，不要模棱两可
2. 消息面要结合具体新闻标题引用
3. 如果数据不足如实说明`;

  try {
    const analysis = await callAI(prompt);
    res.json({ ...rawData, analysis, generated_at: new Date().toISOString() });
  } catch (err: any) {
    res.json({ ...rawData, analysis: null, error: `AI分析失败: ${err.message}` });
  }
});

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
- 止盈线：${fund.stop_profit_pct || 20}% | 止损线：${fund.stop_loss_pct || 15}%

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
