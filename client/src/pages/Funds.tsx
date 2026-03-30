import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Fund } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function pct(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'
}

export default function Funds() {
  const navigate = useNavigate()
  const [funds, setFunds] = useState<Fund[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#378ADD')
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const load = () => api.getFunds().then(setFunds)
  useEffect(() => { load() }, [])

  const totalValue = funds.reduce((s, f) => s + f.current_value, 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('请输入基金名称。'); return }
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">基金管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            共 {funds.length} 个基金 &middot; 总市值 {fmt(totalValue)}
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setName(''); setColor('#378ADD') }}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          新建基金
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-semibold text-gray-900">{editId ? '编辑' : '新建'}基金</h2>
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
              {error}
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-4 items-end">
            <div className="flex-1 w-full">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">基金名称</label>
              <input value={name} onChange={e => setName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow" placeholder="例如：稳健理财" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">颜色</label>
              <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-[42px] w-16 border border-gray-300 rounded-lg cursor-pointer p-1" />
            </div>
            <div className="flex gap-2">
              <button type="submit" className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors">
                {editId ? '保存' : '创建'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors">
                取消
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Fund Cards */}
      {funds.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无基金</h3>
          <p className="text-gray-500 text-sm">创建你的第一个基金，开始追踪投资组合。</p>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {funds.map(f => {
            const alloc = totalValue > 0 ? (f.current_value / totalValue) * 100 : 0
            return (
              <div key={f.id} className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                {/* Color bar at top */}
                <div className="h-1.5" style={{ backgroundColor: f.color }} />
                <div className="p-5">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: f.color }}>
                        {f.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">{f.name}</h3>
                        <span className="text-xs text-gray-400">占比 {alloc.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => startEdit(f)} className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                      </button>
                      <button onClick={() => setDeleteId(f.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="删除">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </div>

                  {/* Value */}
                  <div className="mb-4">
                    <div className="text-2xl font-bold text-gray-900">{fmt(f.current_value)}</div>
                    <div className={`text-sm font-medium mt-0.5 ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {f.gain >= 0 ? '+' : ''}{fmt(f.gain)} ({pct(f.gain_pct)})
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="mb-4">
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          backgroundColor: f.color,
                          width: `${Math.min(alloc, 100)}%`,
                          opacity: 0.8,
                        }}
                      />
                    </div>
                  </div>

                  {/* Details */}
                  <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-100">
                    <div>
                      <div className="text-xs text-gray-400 uppercase tracking-wide">已投入</div>
                      <div className="text-sm font-medium text-gray-700 mt-0.5">{fmt(f.total_cost)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 uppercase tracking-wide">收益率</div>
                      <div className={`text-sm font-medium mt-0.5 ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pct(f.gain_pct)}
                      </div>
                    </div>
                  </div>

                  {/* Manage button */}
                  <button
                    onClick={() => navigate(`/funds/${f.id}`)}
                    className="mt-4 w-full py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                    管理
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="删除基金"
        message="确定要删除这个基金吗？所有关联的交易记录也会被一并删除。"
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  )
}
