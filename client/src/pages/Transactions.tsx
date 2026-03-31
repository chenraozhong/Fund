import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Transaction, Fund } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

const emptyForm = { fund_id: 0, date: '', type: 'buy' as const, asset: '', shares: 0, price: 0, notes: '', inputMode: 'amount' as 'shares' | 'amount', inputValue: 0 }

const typeConfig = {
  buy:      { label: '买入',  bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200', icon: '↑' },
  sell:     { label: '卖出',  bg: 'bg-red-50',      text: 'text-red-700',     border: 'border-red-200',     icon: '↓' },
  dividend: { label: '分红',  bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',   icon: '$' },
}

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
  const [navLoading, setNavLoading] = useState(false)
  const [navHint, setNavHint] = useState('')

  const autoFetchNav = async (fundId: number, date: string, type: string) => {
    if (type === 'dividend' || !fundId || !date) { setNavHint(''); return }
    const fund = funds.find(f => f.id === fundId)
    if (!fund?.code) { setNavHint(''); return }
    setNavLoading(true)
    setNavHint('')
    try {
      const result = await api.getNavByDate(fund.code, date)
      setForm(f => ({ ...f, price: result.nav }))
      setNavHint(result.note ? `${result.date} 净值 ${result.nav}（${result.note}）` : `${result.date} 净值 ${result.nav}`)
    } catch {
      setNavHint('未查到该日期净值，请手动输入')
    } finally {
      setNavLoading(false)
    }
  }

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

  const totalAmount = txs.reduce((s, tx) => s + (tx.type === 'dividend' ? tx.price : tx.shares * tx.price), 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.fund_id || !form.date) {
      setError('请选择基金和日期。')
      return
    }
    const selectedFund = funds.find(f => f.id === form.fund_id)
    const asset = selectedFund?.name || form.asset

    let submitShares = form.shares
    let submitPrice = form.price

    if (form.type === 'dividend') {
      submitShares = 0
      submitPrice = form.inputValue || form.price
    } else if (form.inputMode === 'amount') {
      if (form.price <= 0) { setError('净值未获取到，无法计算份额'); return }
      submitShares = Math.round((form.inputValue / form.price) * 10000) / 10000
      submitPrice = form.price
    } else {
      submitShares = form.inputValue || form.shares
      submitPrice = form.price
    }

    try {
      const payload = { fund_id: form.fund_id, date: form.date, type: form.type, asset, shares: submitShares, price: submitPrice, notes: form.notes }
      if (editId) {
        await api.updateTransaction(editId, payload)
      } else {
        await api.createTransaction(payload)
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
    setForm({ fund_id: tx.fund_id, date: tx.date, type: tx.type, asset: tx.asset, shares: tx.shares, price: tx.price, notes: tx.notes || '', inputMode: 'shares', inputValue: tx.type === 'dividend' ? tx.price : tx.shares })
    setEditId(tx.id)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async () => {
    if (deleteId) {
      await api.deleteTransaction(deleteId)
      setDeleteId(null)
      load()
    }
  }

  const hasFilters = filterFund || filterType || filterFrom || filterTo
  const clearFilters = () => { setFilterFund(''); setFilterType(''); setFilterFrom(''); setFilterTo('') }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">交易记录</h1>
          <p className="text-sm text-gray-500 mt-1">
            共 {txs.length} 条记录 &middot; 总金额 {fmt(totalAmount)}
          </p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm) }}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          添加交易
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
          <span className="text-sm font-medium text-gray-700">筛选</span>
          {hasFilters && (
            <button onClick={clearFilters} className="ml-auto text-xs text-blue-600 hover:text-blue-800 font-medium">
              清除全部
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <select value={filterFund} onChange={e => setFilterFund(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none">
            <option value="">全部基金</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none">
            <option value="">全部类型</option>
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
            <option value="dividend">分红</option>
          </select>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">起始</label>
            <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">截止</label>
            <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
          </div>
        </div>
      </div>

      {/* Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-blue-200 shadow-sm p-6 space-y-5 ring-1 ring-blue-100">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">{editId ? '编辑' : '新增'}交易</h2>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">基金</label>
              <select value={form.fund_id} onChange={e => { const fid = Number(e.target.value); setForm({ ...form, fund_id: fid }); if (form.date) autoFetchNav(fid, form.date, form.type) }} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" required>
                <option value={0}>选择基金</option>
                {funds.map(f => <option key={f.id} value={f.id}>{f.name}{f.code ? ` (${f.code})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">日期 {navLoading && <span className="text-blue-500 text-xs ml-1">查询净值中...</span>}</label>
              <input type="date" value={form.date} onChange={e => { setForm({ ...form, date: e.target.value }); autoFetchNav(form.fund_id, e.target.value, form.type) }} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" required />
              {navHint && <p className="text-xs text-blue-600 mt-1">{navHint}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">类型</label>
              <div className="flex gap-1.5">
                {(['buy', 'sell', 'dividend'] as const).map(t => {
                  const cfg = typeConfig[t]
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setForm({ ...form, type: t })}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        form.type === t
                          ? `${cfg.bg} ${cfg.text} ${cfg.border}`
                          : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {cfg.icon} {cfg.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {form.type !== 'dividend' ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">输入方式</label>
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => setForm({ ...form, inputMode: 'amount', inputValue: 0 })}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${form.inputMode === 'amount' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>按金额</button>
                    <button type="button" onClick={() => setForm({ ...form, inputMode: 'shares', inputValue: 0 })}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${form.inputMode === 'shares' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>按份额</button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{form.inputMode === 'amount' ? '金额' : '份额'}</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-400 text-sm">{form.inputMode === 'amount' ? '¥' : '份'}</span>
                    <input type="number" step="any" value={form.inputValue || ''} onChange={e => setForm({ ...form, inputValue: Number(e.target.value) })} placeholder="0" className="w-full border border-gray-300 rounded-lg pl-8 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                  </div>
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">金额</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-gray-400 text-sm">¥</span>
                  <input type="number" step="any" value={form.inputValue || ''} onChange={e => setForm({ ...form, inputValue: Number(e.target.value) })} placeholder="0.00" className="w-full border border-gray-300 rounded-lg pl-7 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </div>
              </div>
            )}
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">备注（可选）</label>
              <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="添加备注..." className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
            </div>
          </div>

          {/* Live preview */}
          {form.fund_id > 0 && form.inputValue > 0 && (() => {
            const pFund = funds.find(f => f.id === form.fund_id)
            return (
              <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
                {form.type === 'dividend' ? (
                  <>预览：<strong>分红</strong> <strong className="font-mono">{pFund?.name}</strong> 金额 <strong>{fmt(form.inputValue)}</strong></>
                ) : form.price > 0 ? (
                  <>
                    预览：<strong>{typeConfig[form.type].label}</strong> <strong className="font-mono">{pFund?.name}</strong>
                    {' '}净值 {form.price.toFixed(4)} &middot;{' '}
                    {form.inputMode === 'amount'
                      ? <>金额 {fmt(form.inputValue)} = <strong>{(form.inputValue / form.price).toFixed(4)} 份</strong></>
                      : <>{form.inputValue} 份 = <strong>{fmt(form.inputValue * form.price)}</strong></>
                    }
                  </>
                ) : (
                  <span className="text-amber-600">等待获取净值...</span>
                )}
              </div>
            )
          })()}

          <div className="flex gap-3 pt-2">
            <button type="submit" className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors">
              {editId ? '更新交易' : '添加交易'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors">
              取消
            </button>
          </div>
        </form>
      )}

      {/* Transaction List */}
      {txs.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无交易记录</h3>
          <p className="text-gray-500 text-sm">
            {hasFilters ? '试试调整筛选条件。' : '添加第一条交易记录开始使用吧。'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {txs.map(tx => {
            const cfg = typeConfig[tx.type]
            const total = tx.type === 'dividend' ? tx.price : tx.shares * tx.price
            return (
              <div key={tx.id} className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-4">
                <div className="flex items-center gap-4">
                  {/* Type icon */}
                  <div className={`w-10 h-10 rounded-lg ${cfg.bg} ${cfg.text} flex items-center justify-center text-lg font-bold shrink-0`}>
                    {cfg.icon}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 font-mono">{tx.asset}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
                        {cfg.label}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tx.fund_color }} />
                        {tx.fund_name}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                      <span>{formatDate(tx.date)}</span>
                      {tx.type !== 'dividend' && (
                        <span>{tx.shares} 份 @ {fmt(tx.price)}</span>
                      )}
                      {tx.notes && (
                        <span className="truncate max-w-[200px] text-gray-400" title={tx.notes}>&middot; {tx.notes}</span>
                      )}
                    </div>
                  </div>

                  {/* Amount */}
                  <div className="text-right shrink-0">
                    <div className={`text-lg font-bold ${tx.type === 'sell' ? 'text-red-600' : 'text-gray-900'}`}>
                      {tx.type === 'sell' ? '-' : ''}{fmt(total)}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => startEdit(tx)} className="p-2 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button onClick={() => setDeleteId(tx.id)} className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="删除">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="删除交易"
        message="确定要删除这条交易记录吗？此操作不可撤销。"
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  )
}
