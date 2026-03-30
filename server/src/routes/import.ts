import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

interface ParsedTx {
  date: string;
  type: 'buy' | 'sell' | 'dividend';
  shares: number;
  price: number;
}

interface ParsedFund {
  name: string;
  totalShares: number;
  avgNav: number;
  gain: number;
  transactions: ParsedTx[];
}

function parseImportText(text: string): ParsedFund[] {
  const funds: ParsedFund[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let current: Partial<ParsedFund> | null = null;
  let inTransactions = false;

  for (const line of lines) {
    // Fund name
    const nameMatch = line.match(/^基金名称[：:]\s*(.+)$/);
    if (nameMatch) {
      if (current && current.name) {
        funds.push(finalizeFund(current));
      }
      current = { name: nameMatch[1].trim(), totalShares: 0, avgNav: 0, gain: 0, transactions: [] };
      inTransactions = false;
      continue;
    }

    if (!current) continue;

    // Total shares
    const sharesMatch = line.match(/^持仓总份额[：:]\s*([\d.]+)$/);
    if (sharesMatch) {
      current.totalShares = parseFloat(sharesMatch[1]);
      inTransactions = false;
      continue;
    }

    // Average NAV
    const navMatch = line.match(/^平均净值[：:]\s*([\d.]+)$/);
    if (navMatch) {
      current.avgNav = parseFloat(navMatch[1]);
      inTransactions = false;
      continue;
    }

    // Gain/Loss
    const gainMatch = line.match(/^盈亏[：:]\s*([+-]?[\d.]+)$/);
    if (gainMatch) {
      current.gain = parseFloat(gainMatch[1]);
      inTransactions = false;
      continue;
    }

    // Transaction header
    if (line.match(/^最近交易[：:]/)) {
      inTransactions = true;
      continue;
    }

    // Transaction line
    if (inTransactions) {
      const tx = parseTransactionLine(line);
      if (tx) {
        if (!current.transactions) current.transactions = [];
        current.transactions.push(tx);
      }
    }
  }

  // Push the last fund
  if (current && current.name) {
    funds.push(finalizeFund(current));
  }

  return funds;
}

function parseTransactionLine(line: string): ParsedTx | null {
  // 支持的格式：
  //   2026-03-20 买入 1000份 净值1.20      (按份额)
  //   2026-03-20 买入 1000元 净值1.20      (按金额)
  //   2026-03-20 买入 1000 净值1.20        (无单位，按金额)
  //   卖出同理
  //   2026-03-28 分红 500元

  // 通用匹配：日期 + 买入/卖出 + 数值[份|元|无] + 净值xxx
  const tradeMatch = line.match(/(\d{4}-\d{2}-\d{2})\s+(买入|卖出)\s+([\d.]+)(份|元)?\s*净值([\d.]+)/);
  if (tradeMatch) {
    const date = tradeMatch[1];
    const type: 'buy' | 'sell' = tradeMatch[2] === '买入' ? 'buy' : 'sell';
    const value = parseFloat(tradeMatch[3]);
    const unit = tradeMatch[4]; // '份', '元', or undefined
    const nav = parseFloat(tradeMatch[5]);

    let shares: number;
    if (unit === '份') {
      shares = value;
    } else {
      // '元' 或无单位 → 按金额，份额 = 金额 / 净值
      shares = nav > 0 ? Math.round((value / nav) * 10000) / 10000 : 0;
    }

    return { date, type, shares, price: nav };
  }

  // 分红
  const dividendMatch = line.match(/(\d{4}-\d{2}-\d{2})\s+分红\s+([\d.]+)元?/);
  if (dividendMatch) {
    return { date: dividendMatch[1], type: 'dividend', shares: 0, price: parseFloat(dividendMatch[2]) };
  }

  return null;
}

function finalizeFund(partial: Partial<ParsedFund>): ParsedFund {
  return {
    name: partial.name || '',
    totalShares: partial.totalShares || 0,
    avgNav: partial.avgNav || 0,
    gain: partial.gain || 0,
    transactions: partial.transactions || [],
  };
}

/**
 * 根据当前持仓现状和最近交易，反推历史底仓。
 *
 * 当前现状：totalShares 份，平均成本 avgNav（即持仓成本/持仓份额）
 * 系统公式：current_value = sum(buy_amount) - sum(sell_amount)
 *          cost_per_share = current_value / holding_shares
 *
 * 所以：
 *   base_shares = totalShares + recent_sell_shares - recent_buy_shares
 *   base_amount = totalShares × avgNav - recent_buy_amount + recent_sell_amount
 *   base_price  = base_amount / base_shares
 */
function calcBase(f: ParsedFund) {
  const recentBuyShares = f.transactions.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares, 0);
  const recentSellShares = f.transactions.filter(t => t.type === 'sell').reduce((s, t) => s + t.shares, 0);
  const recentBuyAmount = f.transactions.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares * t.price, 0);
  const recentSellAmount = f.transactions.filter(t => t.type === 'sell').reduce((s, t) => s + t.shares * t.price, 0);

  const targetCostBasis = f.totalShares * f.avgNav; // 当前持仓总成本
  const baseShares = f.totalShares + recentSellShares - recentBuyShares;
  const baseAmount = targetCostBasis - recentBuyAmount + recentSellAmount;
  const basePrice = baseShares > 0 ? Math.round((baseAmount / baseShares) * 10000) / 10000 : 0;

  return {
    baseShares: Math.round(baseShares * 10000) / 10000,
    basePrice,
    baseAmount: Math.round(baseAmount * 100) / 100,
  };
}

// Preview: parse and return what would be imported
router.post('/preview', (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: '请输入导入数据' });
    return;
  }

  try {
    const funds = parseImportText(text);
    if (funds.length === 0) {
      res.status(400).json({ error: '未识别到任何基金数据，请检查格式' });
      return;
    }

    const preview = funds.map(f => {
      const { baseShares, basePrice, baseAmount } = calcBase(f);
      const costBasis = f.totalShares * f.avgNav;
      const marketValue = costBasis + f.gain;
      const marketNav = f.totalShares > 0 ? Math.round((marketValue / f.totalShares) * 10000) / 10000 : 0;

      return {
        name: f.name,
        totalShares: f.totalShares,
        avgNav: f.avgNav,
        gain: f.gain,
        marketNav,
        baseShares,
        basePrice,
        baseAmount,
        recentTransactions: f.transactions,
        transactionCount: f.transactions.length + (baseShares > 0 ? 1 : 0),
      };
    });

    res.json({ funds: preview });
  } catch (err: any) {
    res.status(400).json({ error: `解析失败：${err.message}` });
  }
});

// Execute import
router.post('/execute', (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: '请输入导入数据' });
    return;
  }

  try {
    const funds = parseImportText(text);
    if (funds.length === 0) {
      res.status(400).json({ error: '未识别到任何基金数据' });
      return;
    }

    const results: { name: string; fundId: number; transactionCount: number }[] = [];

    const importAll = db.transaction(() => {
      for (const f of funds) {
        // Create fund with market_nav derived from gain
        // 市值 = 持仓成本 + 盈亏, 市场净值 = 市值 / 总份额
        const costBasis = f.totalShares * f.avgNav;
        const marketValue = costBasis + f.gain;
        const marketNav = f.totalShares > 0 ? Math.round((marketValue / f.totalShares) * 10000) / 10000 : 0;

        const fundResult = db.prepare('INSERT INTO funds (name, market_nav) VALUES (?, ?)').run(f.name, marketNav);
        const fundId = fundResult.lastInsertRowid as number;

        let txCount = 0;

        // Calculate and insert base position
        const { baseShares, basePrice } = calcBase(f);

        if (baseShares > 0 && basePrice > 0) {
          const earliestDate = f.transactions.length > 0
            ? f.transactions.reduce((min, t) => t.date < min ? t.date : min, f.transactions[0].date)
            : new Date().toISOString().slice(0, 10);

          const baseDate = new Date(earliestDate + 'T00:00:00');
          baseDate.setDate(baseDate.getDate() - 1);
          const baseDateStr = baseDate.toISOString().slice(0, 10);

          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(fundId, baseDateStr, 'buy', f.name, baseShares, basePrice, '历史持仓（导入）');
          txCount++;
        }

        // Insert recent transactions
        for (const tx of f.transactions) {
          db.prepare(
            'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(fundId, tx.date, tx.type, f.name, tx.shares, tx.price, null);
          txCount++;
        }

        results.push({ name: f.name, fundId, transactionCount: txCount });
      }
    });

    importAll();
    res.json({ success: true, imported: results });
  } catch (err: any) {
    res.status(500).json({ error: `导入失败：${err.message}` });
  }
});

export default router;
