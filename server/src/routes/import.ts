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
  code: string;
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
      current = { name: nameMatch[1].trim(), code: '', totalShares: 0, avgNav: 0, gain: 0, transactions: [] };
      inTransactions = false;
      continue;
    }

    if (!current) continue;

    // Fund code
    const codeMatch = line.match(/^基金代码[：:]\s*(\w+)$/);
    if (codeMatch) {
      current.code = codeMatch[1].trim();
      inTransactions = false;
      continue;
    }

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
  // 支持的格式（净值可省略，系统自动获取）：
  //   2026-03-20 买入 1000份 净值1.20      (按份额，含净值)
  //   2026-03-20 买入 1000元 净值1.20      (按金额，含净值)
  //   2026-03-20 买入 1000 净值1.20        (无单位，按金额)
  //   2026-03-20 买入 1000份               (按份额，净值待补充)
  //   2026-03-20 买入 1000元               (按金额，净值待补充)
  //   2026-03-20 买入 1000                 (无单位，净值待补充)
  //   卖出同理
  //   2026-03-28 分红 500元

  // 带净值的完整匹配
  const tradeWithNav = line.match(/(\d{4}-\d{2}-\d{2})\s+(买入|卖出)\s+([\d.]+)(份|元)?\s*净值([\d.]+)/);
  if (tradeWithNav) {
    const date = tradeWithNav[1];
    const type: 'buy' | 'sell' = tradeWithNav[2] === '买入' ? 'buy' : 'sell';
    const value = parseFloat(tradeWithNav[3]);
    const unit = tradeWithNav[4];
    const nav = parseFloat(tradeWithNav[5]);

    let shares: number;
    if (unit === '份') {
      shares = value;
    } else {
      shares = nav > 0 ? Math.round((value / nav) * 10000) / 10000 : 0;
    }

    return { date, type, shares, price: nav };
  }

  // 不带净值的匹配（price=0 标记为待获取）
  const tradeNoNav = line.match(/(\d{4}-\d{2}-\d{2})\s+(买入|卖出)\s+([\d.]+)(份|元)?$/);
  if (tradeNoNav) {
    const date = tradeNoNav[1];
    const type: 'buy' | 'sell' = tradeNoNav[2] === '买入' ? 'buy' : 'sell';
    const value = parseFloat(tradeNoNav[3]);
    const unit = tradeNoNav[4];

    // 份额已知时直接设shares，金额模式暂存到shares（等获取nav后再算）
    if (unit === '份') {
      return { date, type, shares: value, price: 0 };
    } else {
      // 金额模式：暂存金额为负数标记（用 -value 表示这是金额而非份额）
      return { date, type, shares: -value, price: 0 };
    }
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
    code: partial.code || '',
    totalShares: partial.totalShares || 0,
    avgNav: partial.avgNav || 0,
    gain: partial.gain || 0,
    transactions: partial.transactions || [],
  };
}

// 从天天基金 API 获取最新净值
async function fetchLatestNav(code: string): Promise<number | null> {
  try {
    const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
    const res = await fetch(url);
    const text = await res.text();
    const match = text.match(/jsonpgz\((.+)\)/);
    if (match) {
      const data = JSON.parse(match[1]);
      // dwjz = 单位净值（实际净值），gsz = 估算净值
      return parseFloat(data.dwjz) || null;
    }
    // fallback: 从历史接口取最新一条
    const fallbackUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1&startDate=&endDate=`;
    const fallbackRes = await fetch(fallbackUrl, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
    const fallbackData = await fallbackRes.json() as any;
    if (fallbackData.Data?.LSJZList?.length > 0) {
      return parseFloat(fallbackData.Data.LSJZList[0].DWJZ);
    }
    return null;
  } catch {
    return null;
  }
}

// 从天天基金 API 获取指定日期净值
async function fetchNavForDate(code: string, date: string): Promise<number | null> {
  try {
    // 先精确匹配
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=5&startDate=${date}&endDate=${date}`;
    const res = await fetch(url, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
    const data = await res.json() as any;
    if (data.Data?.LSJZList?.length > 0) {
      return parseFloat(data.Data.LSJZList[0].DWJZ);
    }
    // 非交易日，取最近前一个交易日
    const fallbackUrl = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=3&startDate=&endDate=${date}`;
    const fallbackRes = await fetch(fallbackUrl, { headers: { 'Referer': 'https://fundf10.eastmoney.com/' } });
    const fallbackData = await fallbackRes.json() as any;
    if (fallbackData.Data?.LSJZList?.length > 0) {
      return parseFloat(fallbackData.Data.LSJZList[0].DWJZ);
    }
    return null;
  } catch {
    return null;
  }
}

// 自动补充缺失的 avgNav：通过基金代码获取最新净值，根据盈亏反算成本均价
async function fillMissingAvgNav(funds: ParsedFund[]): Promise<string[]> {
  const errors: string[] = [];
  for (const f of funds) {
    if (f.avgNav > 0) continue; // 已有成本均价，跳过
    if (f.totalShares <= 0) continue;

    if (!f.code) {
      errors.push(`${f.name}：缺少基金代码和平均净值，无法计算持仓成本`);
      continue;
    }

    const latestNav = await fetchLatestNav(f.code);
    if (!latestNav || latestNav <= 0) {
      errors.push(`${f.name}：无法获取最新净值，请手动填写平均净值`);
      continue;
    }

    // 市值 = 份额 × 最新净值，成本 = 市值 - 盈亏，成本均价 = 成本 / 份额
    const marketValue = f.totalShares * latestNav;
    const costBasis = marketValue - f.gain;
    f.avgNav = Math.round((costBasis / f.totalShares) * 10000) / 10000;
    // 同时记录 marketNav 供后续使用
    (f as any)._marketNav = latestNav;
  }
  return errors;
}

// 批量补充缺失净值
async function fillMissingNavs(funds: ParsedFund[]): Promise<{ funds: ParsedFund[]; errors: string[] }> {
  const errors: string[] = [];

  for (const f of funds) {
    if (!f.code) {
      // 没有基金代码，检查是否有缺失净值的交易
      const missing = f.transactions.filter(t => t.type !== 'dividend' && t.price === 0);
      if (missing.length > 0) {
        errors.push(`${f.name}：缺少基金代码，无法自动获取 ${missing.length} 条交易的净值`);
      }
      continue;
    }

    for (const tx of f.transactions) {
      if (tx.type === 'dividend' || tx.price > 0) continue;

      const nav = await fetchNavForDate(f.code, tx.date);
      if (nav && nav > 0) {
        tx.price = nav;
        // 如果 shares 是负数标记（金额模式），转换为份额
        if (tx.shares < 0) {
          const amount = -tx.shares;
          tx.shares = Math.round((amount / nav) * 10000) / 10000;
        }
      } else {
        errors.push(`${f.name}：${tx.date} 未查到净值`);
        // 金额模式下无法计算份额
        if (tx.shares < 0) {
          tx.shares = 0;
        }
      }
    }
  }

  return { funds, errors };
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
router.post('/preview', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: '请输入导入数据' });
    return;
  }

  try {
    const parsed = parseImportText(text);
    if (parsed.length === 0) {
      res.status(400).json({ error: '未识别到任何基金数据，请检查格式' });
      return;
    }

    // 自动补充缺失的成本均价（通过最新净值 + 盈亏反算）
    const avgNavErrors = await fillMissingAvgNav(parsed);

    // 自动补充缺失净值
    const { funds, errors } = await fillMissingNavs(parsed);

    const allErrors = [...avgNavErrors, ...errors];

    const preview = funds.map(f => {
      const { baseShares, basePrice, baseAmount } = calcBase(f);
      const costBasis = f.totalShares * f.avgNav;
      // 优先使用已获取的最新净值，否则从成本+盈亏反算
      const marketNav = (f as any)._marketNav
        || (f.totalShares > 0 ? Math.round(((costBasis + f.gain) / f.totalShares) * 10000) / 10000 : 0);

      // 检查是否已存在同代码基金
      const existing = f.code ? db.prepare('SELECT id, name FROM funds WHERE code = ?').get(f.code) as any : null;

      return {
        name: f.name,
        code: f.code,
        totalShares: f.totalShares,
        avgNav: f.avgNav,
        gain: f.gain,
        marketNav,
        baseShares,
        basePrice,
        baseAmount,
        recentTransactions: f.transactions,
        transactionCount: f.transactions.length + (baseShares > 0 ? 1 : 0),
        existingFundId: existing?.id || null,
        existingFundName: existing?.name || null,
      };
    });

    res.json({ funds: preview, navErrors: allErrors });
  } catch (err: any) {
    res.status(400).json({ error: `解析失败：${err.message}` });
  }
});

// Execute import
router.post('/execute', async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: '请输入导入数据' });
    return;
  }

  try {
    const parsed = parseImportText(text);
    if (parsed.length === 0) {
      res.status(400).json({ error: '未识别到任何基金数据' });
      return;
    }

    // 自动补充缺失的成本均价
    await fillMissingAvgNav(parsed);

    // 自动补充缺失净值
    const { funds } = await fillMissingNavs(parsed);

    const results: { name: string; fundId: number; transactionCount: number }[] = [];

    const importAll = db.transaction(() => {
      for (const f of funds) {
        const costBasis = f.totalShares * f.avgNav;
        const marketNav = (f as any)._marketNav
          || (f.totalShares > 0 ? Math.round(((costBasis + f.gain) / f.totalShares) * 10000) / 10000 : 0);

        let fundId: number;

        // 如果有基金代码，检查是否已存在 → 复用并更新名称和净值
        const existing = f.code ? db.prepare('SELECT * FROM funds WHERE code = ?').get(f.code) as any : null;
        if (existing) {
          db.prepare('UPDATE funds SET name = ?, market_nav = ? WHERE id = ?').run(f.name, marketNav, existing.id);
          fundId = existing.id;
        } else {
          const fundResult = db.prepare('INSERT INTO funds (name, code, market_nav) VALUES (?, ?, ?)').run(f.name, f.code, marketNav);
          fundId = fundResult.lastInsertRowid as number;
        }

        let txCount = 0;

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
