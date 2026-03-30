import db from './db';

// Clear existing data
db.exec('DELETE FROM transactions; DELETE FROM funds;');

// Create funds
const funds = [
  { name: 'Retirement', color: '#378ADD' },
  { name: 'Tech Growth', color: '#10B981' },
  { name: 'Dividend Income', color: '#F59E0B' },
];

const insertFund = db.prepare('INSERT INTO funds (name, color) VALUES (?, ?)');
const fundIds: number[] = [];
for (const f of funds) {
  const result = insertFund.run(f.name, f.color);
  fundIds.push(Number(result.lastInsertRowid));
}

// Create transactions spanning last 14 months
const insertTx = db.prepare(
  'INSERT INTO transactions (fund_id, date, type, asset, shares, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

const txs = [
  // Retirement fund
  { fund: 0, date: '2025-01-15', type: 'buy', asset: 'VTI', shares: 20, price: 245.50, notes: 'Initial investment' },
  { fund: 0, date: '2025-04-10', type: 'buy', asset: 'VTI', shares: 10, price: 252.30, notes: 'Monthly DCA' },
  { fund: 0, date: '2025-07-20', type: 'buy', asset: 'BND', shares: 30, price: 72.10, notes: 'Bond allocation' },
  { fund: 0, date: '2025-10-05', type: 'dividend', asset: 'VTI', shares: 0, price: 185.00, notes: 'Q3 dividend' },
  { fund: 0, date: '2026-01-12', type: 'buy', asset: 'VTI', shares: 8, price: 261.00, notes: 'New year DCA' },

  // Tech Growth fund
  { fund: 1, date: '2025-02-01', type: 'buy', asset: 'QQQ', shares: 15, price: 485.20, notes: 'Tech bet' },
  { fund: 1, date: '2025-06-15', type: 'buy', asset: 'AAPL', shares: 25, price: 198.50, notes: 'Apple position' },
  { fund: 1, date: '2025-09-01', type: 'sell', asset: 'QQQ', shares: 5, price: 510.00, notes: 'Took some profit' },
  { fund: 1, date: '2026-02-20', type: 'buy', asset: 'NVDA', shares: 10, price: 890.00, notes: 'AI play' },

  // Dividend Income fund
  { fund: 2, date: '2025-03-01', type: 'buy', asset: 'SCHD', shares: 40, price: 78.90, notes: 'Dividend ETF' },
  { fund: 2, date: '2025-06-30', type: 'dividend', asset: 'SCHD', shares: 0, price: 95.00, notes: 'Q2 distribution' },
  { fund: 2, date: '2025-09-30', type: 'dividend', asset: 'SCHD', shares: 0, price: 98.50, notes: 'Q3 distribution' },
  { fund: 2, date: '2025-12-15', type: 'buy', asset: 'VYM', shares: 20, price: 115.30, notes: 'High yield ETF' },
  { fund: 2, date: '2026-03-15', type: 'dividend', asset: 'SCHD', shares: 0, price: 102.00, notes: 'Q1 distribution' },
];

for (const tx of txs) {
  insertTx.run(fundIds[tx.fund], tx.date, tx.type, tx.asset, tx.shares, tx.price, tx.notes);
}

console.log(`Seeded ${fundIds.length} funds and ${txs.length} transactions.`);
