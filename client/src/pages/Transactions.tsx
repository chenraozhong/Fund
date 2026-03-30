import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Transaction, Fund } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

const emptyForm = { fund_id: 0, date: '', type: 'buy' as const, asset: '', shares: 0, price: 0, notes: '' }

export default function Transactions() {
  const [txs, setTxs] = useState<Transaction[]>([])
  const [funds, setFunds] = useState<Fund[]>([])
  const [filterFund, setFilterFund] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const load = () => {
    const params: Record<string, string> = {}
    if (filterFund) params.fundId = filterFund
    if (filterType) params.type = filterType
    if (filterFrom) params.from = filterFrom
    if (filterTo) params.to = filterTo
    api.getTransactions(params).then(setTxs)
  }

  useEffect(() => { api.getFunds().then(setFunds) }, [])
  useEffect(load, [filterFund, filterType, filterFrom, filterTo])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.fund_id || !form.date || !form.asset) {
      setError('Fund, date, and asset are required.')
      return
    }
    try {
      if (editId) {
        await api.updateTransaction(editId, form)
      } else {
        await api.createTransaction(form)
      }
      setShowForm(false)
      setEditId(null)
      setForm(emptyForm)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const startEdit = (tx: Transaction) => {
    setForm({ fund_id: tx.fund_id, date: tx.date, type: tx.type, asset: tx.asset, shares: tx.shares, price: tx.price, notes: tx.notes || '' })
    setEditId(tx.id)
    setShowForm(true)
  }

  const handleDelete = async () => {
    if (deleteId) {
      await api.deleteTransaction(deleteId)
      setDeleteId(null)
      load()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm) }}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
        >
          Add Transaction
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={filterFund} onChange={e => setFilterFund(e.target.value)} className="border rounded-md px-3 py-1.5 text-sm bg-white">
          <option value="">All Funds</option>
          {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border rounded-md px-3 py-1.5 text-sm bg-white">
          <option value="">All Types</option>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
          <option value="dividend">Dividend</option>
        </select>
        <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="border rounded-md px-3 py-1.5 text-sm" placeholder="From" />
        <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="border rounded-md px-3 py-1.5 text-sm" placeholder="To" />
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold">{editId ? 'Edit' : 'Add'} Transaction</h2>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <select value={form.fund_id} onChange={e => setForm({ ...form, fund_id: Number(e.target.value) })} className="border rounded-md px-3 py-2 text-sm" required>
              <option value={0}>Select Fund</option>
              {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="border rounded-md px-3 py-2 text-sm" required />
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value as any })} className="border rounded-md px-3 py-2 text-sm">
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
              <option value="dividend">Dividend</option>
            </select>
            <input value={form.asset} onChange={e => setForm({ ...form, asset: e.target.value })} placeholder="Asset / Ticker" className="border rounded-md px-3 py-2 text-sm" required />
            {form.type !== 'dividend' ? (
              <>
                <input type="number" step="any" value={form.shares || ''} onChange={e => setForm({ ...form, shares: Number(e.target.value) })} placeholder="Shares" className="border rounded-md px-3 py-2 text-sm" />
                <input type="number" step="any" value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="Price per share" className="border rounded-md px-3 py-2 text-sm" />
              </>
            ) : (
              <input type="number" step="any" value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="Amount" className="border rounded-md px-3 py-2 text-sm" />
            )}
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Notes" className="border rounded-md px-3 py-2 text-sm col-span-2 md:col-span-3" />
          </div>
          <div className="flex gap-3">
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm">
              {editId ? 'Update' : 'Add'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {txs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No transactions found. Add one to get started.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Date</th>
                <th className="text-left px-4 py-3">Fund</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Asset</th>
                <th className="text-right px-4 py-3">Shares</th>
                <th className="text-right px-4 py-3">Price</th>
                <th className="text-right px-4 py-3">Total</th>
                <th className="text-left px-4 py-3">Notes</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {txs.map(tx => (
                <tr key={tx.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{tx.date}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tx.fund_color }} />
                      {tx.fund_name}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      tx.type === 'buy' ? 'bg-green-100 text-green-700' :
                      tx.type === 'sell' ? 'bg-red-100 text-red-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {tx.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{tx.asset}</td>
                  <td className="px-4 py-3 text-right">{tx.type === 'dividend' ? '—' : tx.shares}</td>
                  <td className="px-4 py-3 text-right">{tx.type === 'dividend' ? fmt(tx.price) : fmt(tx.price)}</td>
                  <td className="px-4 py-3 text-right font-medium">{tx.type === 'dividend' ? fmt(tx.price) : fmt(tx.shares * tx.price)}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">{tx.notes}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button onClick={() => startEdit(tx)} className="text-blue-600 hover:text-blue-800 text-xs">Edit</button>
                      <button onClick={() => setDeleteId(tx.id)} className="text-red-600 hover:text-red-800 text-xs">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="Delete Transaction"
        message="Are you sure you want to delete this transaction? This cannot be undone."
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  )
}
