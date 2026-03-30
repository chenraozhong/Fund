# Personal Investment Portfolio Tracker

Build a full-stack personal investment portfolio tracker web application. This is a single-user app for tracking multiple investment funds, logging transactions, and visualizing portfolio performance over time.

## Tech Stack
- **Frontend:** React + TypeScript + Vite
- **Backend:** Node.js + Express + TypeScript
- **Database:** SQLite (via better-sqlite3) for local persistence
- **Charts:** Recharts
- **Styling:** Tailwind CSS

---

## Core Features

### 1. Fund Management
- Create, rename, and delete investment funds (e.g. "Retirement", "Tech Growth", "Dividend Income")
- Each fund has a name, color tag, and creation date
- Display fund cards showing: current value, total invested, gain/loss ($), gain/loss (%)

### 2. Transaction Logging
- Add transactions with: fund, date, type (Buy / Sell / Dividend), asset/ticker, shares, price per share
- Dividend transactions only require an amount (no shares/price)
- Edit and delete transactions
- Filter transactions by fund, type, and date range

### 3. Portfolio Dashboard
- Summary metrics: total portfolio value, total invested, overall gain/loss, number of funds
- Fund breakdown table with per-fund performance
- Allocation pie chart showing % of portfolio per fund

### 4. Performance Chart
- Line chart showing cumulative value of each fund over the last 12 months
- One colored line per fund, with a custom HTML legend
- Hover tooltip showing value per fund at each month

### 5. Data Persistence
- All data stored in a local SQLite database (`portfolio.db`)
- Data survives page refreshes and app restarts

---

## Database Schema
```sql
CREATE TABLE funds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#378ADD',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('buy','sell','dividend')),
  asset TEXT NOT NULL,
  shares REAL DEFAULT 0,
  price REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## REST API Endpoints

### Funds
- `GET    /api/funds`           — list all funds with computed value, cost, gain
- `POST   /api/funds`           — create fund `{ name, color }`
- `PUT    /api/funds/:id`       — update fund name/color
- `DELETE /api/funds/:id`       — delete fund (cascades to transactions)

### Transactions
- `GET    /api/transactions`              — list all, supports `?fundId=&type=&from=&to=`
- `POST   /api/transactions`             — create transaction
- `PUT    /api/transactions/:id`         — update transaction
- `DELETE /api/transactions/:id`         — delete transaction

### Stats
- `GET    /api/stats/summary`            — total value, total cost, gain, fund count, tx count
- `GET    /api/stats/performance`        — monthly cumulative values per fund (last 12 months)
- `GET    /api/stats/allocation`         — per-fund % of total portfolio value

---

## Computed Values (server-side)

For each fund:
- `current_value` = SUM(buy shares × price) - SUM(sell shares × price) + SUM(dividends)
- `total_cost` = SUM(buy shares × price)
- `gain` = current_value - total_cost
- `gain_pct` = (gain / total_cost) × 100

---

## UI Pages / Routes

- `/` — Dashboard (summary metrics, allocation pie, fund cards)
- `/performance` — Performance line chart (12-month history per fund)
- `/transactions` — Full transaction table with filters and add/edit/delete
- `/funds` — Fund management (add, rename, recolor, delete)

---

## UI Requirements

- Responsive layout (works on mobile and desktop)
- Sidebar or top nav with links to all 4 pages
- Color-coded fund dots/badges consistent across all views
- Empty states with helpful prompts when no data exists
- Form validation with clear error messages
- Confirmation dialog before deleting a fund or transaction

---

## Seed Data (optional, for development)

Pre-populate with 3 sample funds and ~10 transactions spanning the last 14 months so charts render immediately on first run.

---

## Project Structure
