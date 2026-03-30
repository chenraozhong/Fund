import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Fund } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function Funds() {
  const [funds, setFunds] = useState<Fund[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#378ADD')
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const load = () => api.getFunds().then(setFunds)

  useEffect(() => { load() }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Name is required.'); return }
    try {
      if (editId) {
        await api.updateFund(editId, { name, color })
      } else {
        await api.createFund({ name, color })
      }
      setShowForm(false)
      setEditId(null)
      setName('')
      setColor('#378ADD')
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const startEdit = (f: Fund) => {
    setName(f.name)
    setColor(f.color)
    setEditId(f.id)
    setShowForm(true)
  }

  const handleDelete = async () => {
    if (deleteId) {
      await api.deleteFund(deleteId)
      setDeleteId(null)
      load()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Funds</h1>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setName(''); setColor('#378ADD') }}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
        >
          Add Fund
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold">{editId ? 'Edit' : 'Create'} Fund</h2>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-sm text-gray-600 mb-1">Fund Name</label>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full border rounded-md px-3 py-2 text-sm" placeholder="e.g. Retirement" required />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Color</label>
              <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-10 w-14 border rounded-md cursor-pointer" />
            </div>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm">
              {editId ? 'Update' : 'Create'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {funds.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No funds yet. Create one to start tracking your portfolio.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {funds.map(f => (
            <div key={f.id} className="bg-white rounded-lg shadow p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: f.color }} />
                  <h3 className="font-semibold text-gray-900">{f.name}</h3>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => startEdit(f)} className="text-blue-600 hover:text-blue-800 text-xs">Edit</button>
                  <button onClick={() => setDeleteId(f.id)} className="text-red-600 hover:text-red-800 text-xs">Delete</button>
                </div>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Current Value</span>
                  <span className="font-medium">{fmt(f.current_value)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Invested</span>
                  <span>{fmt(f.total_cost)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Gain/Loss</span>
                  <span className={f.gain >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {f.gain >= 0 ? '+' : ''}{fmt(f.gain)} ({f.gain_pct.toFixed(1)}%)
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="Delete Fund"
        message="Are you sure you want to delete this fund? All associated transactions will also be deleted."
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  )
}
