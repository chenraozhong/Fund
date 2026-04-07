import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Transaction, Fund } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNav(n: number) {
  return '¥' + n.toFixed(4)
}

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function formatDateFull(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' })
}

const emptyForm = { fund_id: 0, date: '', type: 'buy' as const, asset: '', shares: 0, price: 0, notes: '', inputMode: 'amount' as 'shares' | 'amount', inputValue: 0 }

interface BatchRow {
  fund_id: number; fundName: string; date: string;
  type: 'buy' | 'sell' | 'dividend'; inputMode: 'amount' | 'shares';
  inputValue: number; price: number; notes: string; navLoading: boolean; navHint: string;
}

const typeConfig = {
  buy:      { label: '买入', bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200', icon: '↑', dot: 'bg-emerald-500' },
  sell:     { label: '卖出', bg: 'bg-red-50',      text: 'text-red-700',     border: 'border-red-200',     icon: '↓', dot: 'bg-red-500' },
  dividend: { label: '分红', bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',   icon: '$', dot: 'bg-amber-500' },
}

type TabKey = 'list' | 'analysis'

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
  const [showBatch, setShowBatch] = useState(false)
  const [batchRows, setBatchRows] = useState<BatchRow[]>([])
  const [batchError, setBatchError] = useState('')
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [tradeAnalysis, setTradeAnalysis] = useState<Awaited<ReturnType<typeof api.analyzeTradesForDate>> | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisDate, setAnalysisDate] = useState(new Date().toISOString().slice(0, 10))
  const [activeTab, setActiveTab] = useState<TabKey>('list')
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrResult, setOcrResult] = useState<any>(null)

  const handleOCR = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setOcrLoading(true); setOcrResult(null)
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const base64 = reader.result as string
          const result = await api.recognizeTrades(base64)
          setOcrResult(result)
        } catch (err: any) {
          setOcrResult({ success: false, trades: [], message: err.message })
        } finally {
          setOcrLoading(false)
        }
      }
      reader.readAsDataURL(file)
    } catch { setOcrLoading(false) }
    e.target.value = '' // 清空，允许重复选同一文件
  }

  const applyOcrTrade = (trade: any) => {
    setForm({
      fund_id: trade.matched_fund_id || 0,
      date: trade.date || new Date().toISOString().slice(0, 10),
      type: trade.type || 'buy',
      asset: trade.fund_name || '',
      shares: trade.shares || (trade.amount && trade.nav ? Math.round(trade.amount / trade.nav * 100) / 100 : 0),
      price: trade.nav || 0,
      notes: `截图识别导入`,
      inputMode: 'amount' as const,
    })
    setShowForm(true)
    setEditId(null)
  }

  const autoFetchNav = async (fundId: number, date: string, type: string) => {
    if (type === 'dividend' || !fundId || !date) { setNavHint(''); return }
    const fund = funds.find(f => f.id === fundId)
    if (!fund?.code) { setNavHint(''); return }
    setNavLoading(true); setNavHint('')
    try {
      const result = await api.getNavByDate(fund.code, date)
      setForm(f => ({ ...f, price: result.nav }))
      setNavHint(result.note ? `${result.date} 净值 ${result.nav}（${result.note}）` : `${result.date} 净值 ${result.nav}`)
    } catch { setNavHint('未查到该日期净值，请手动输入') }
    finally { setNavLoading(false) }
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    if (!form.fund_id || !form.date) { setError('请选择基金和日期。'); return }
    const asset = funds.find(f => f.id === form.fund_id)?.name || form.asset
    let submitShares = form.shares, submitPrice = form.price
    if (form.type === 'dividend') { submitShares = 0; submitPrice = form.inputValue || form.price }
    else if (form.inputMode === 'amount') {
      if (form.price <= 0) { setError('净值未获取到，无法计算份额'); return }
      submitShares = Math.round((form.inputValue / form.price) * 10000) / 10000; submitPrice = form.price
    } else { submitShares = form.inputValue || form.shares; submitPrice = form.price }
    try {
      const payload = { fund_id: form.fund_id, date: form.date, type: form.type, asset, shares: submitShares, price: submitPrice, notes: form.notes }
      if (editId) await api.updateTransaction(editId, payload)
      else await api.createTransaction(payload)
      setShowForm(false); setEditId(null); setForm(emptyForm); load()
    } catch (err: any) { setError(err.message) }
  }

  const startEdit = (tx: Transaction) => {
    setForm({ fund_id: tx.fund_id, date: tx.date, type: tx.type, asset: tx.asset, shares: tx.shares, price: tx.price, notes: tx.notes || '', inputMode: 'shares', inputValue: tx.type === 'dividend' ? tx.price : tx.shares })
    setEditId(tx.id); setShowForm(true); setActiveTab('list')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async () => { if (deleteId) { await api.deleteTransaction(deleteId); setDeleteId(null); load() } }

  const loadAnalysis = async (date: string) => {
    setAnalysisLoading(true)
    try { setTradeAnalysis(await api.analyzeTradesForDate(date)) } catch { setTradeAnalysis(null) }
    finally { setAnalysisLoading(false) }
  }

  const hasFilters = filterFund || filterType || filterFrom || filterTo
  const clearFilters = () => { setFilterFund(''); setFilterType(''); setFilterFrom(''); setFilterTo('') }

  const emptyBatchRow = (): BatchRow => ({
    fund_id: 0, fundName: '', date: new Date().toISOString().slice(0, 10),
    type: 'buy', inputMode: 'amount', inputValue: 0, price: 0, notes: '', navLoading: false, navHint: '',
  })
  const addBatchRow = () => setBatchRows(r => [...r, emptyBatchRow()])
  const removeBatchRow = (idx: number) => setBatchRows(r => r.filter((_, i) => i !== idx))
  const updateBatchRow = (idx: number, patch: Partial<BatchRow>) => setBatchRows(r => r.map((row, i) => i === idx ? { ...row, ...patch } : row))
  const batchFetchNav = async (idx: number, fundId: number, date: string) => {
    const fund = funds.find(f => f.id === fundId)
    if (!fund?.code || !date) return
    updateBatchRow(idx, { navLoading: true, navHint: '' })
    try {
      const result = await api.getNavByDate(fund.code, date)
      updateBatchRow(idx, { price: result.nav, navLoading: false, navHint: `${result.date} 净值 ${result.nav}` })
    } catch { updateBatchRow(idx, { navLoading: false, navHint: '未查到净值' }) }
  }
  const handleBatchSubmit = async () => {
    setBatchError('')
    const valid = batchRows.filter(r => r.fund_id > 0 && r.date)
    if (valid.length === 0) { setBatchError('请至少填写一条有效交易'); return }
    const txList = valid.map(r => {
      let shares = 0, price = r.price
      if (r.type === 'dividend') { shares = 0; price = r.inputValue }
      else if (r.inputMode === 'amount' && r.price > 0) { shares = Math.round((r.inputValue / r.price) * 10000) / 10000 }
      else { shares = r.inputValue }
      return { fund_id: r.fund_id, date: r.date, type: r.type, shares, price, notes: r.notes || null }
    })
    setBatchSubmitting(true)
    try {
      const result = await api.batchCreateTransactions(txList)
      if (result.errors?.length > 0) setBatchError(`成功${result.created}条，失败${result.errors.length}条: ${result.errors.map(e => e.error).join('; ')}`)
      else { setShowBatch(false); setBatchRows([]) }
      load()
    } catch (err: any) { setBatchError(err.message) }
    finally { setBatchSubmitting(false) }
  }

  // 按日期分组
  const groupedTxs = txs.reduce<Record<string, Transaction[]>>((groups, tx) => {
    ;(groups[tx.date] || (groups[tx.date] = [])).push(tx)
    return groups
  }, {})
  const sortedDates = Object.keys(groupedTxs).sort((a, b) => b.localeCompare(a))

  // 统计
  const buyTotal = txs.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares * t.price, 0)
  const sellTotal = txs.filter(t => t.type === 'sell').reduce((s, t) => s + t.shares * t.price, 0)
  const divTotal = txs.filter(t => t.type === 'dividend').reduce((s, t) => s + t.price, 0)

  return (
    <div className="space-y-4">
      {/* Header + Tabs */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">交易记录</h1>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
            <span>{txs.length} 条</span>
            {buyTotal > 0 && <span className="text-emerald-600">买 {fmt(buyTotal)}</span>}
            {sellTotal > 0 && <span className="text-red-600">卖 {fmt(sellTotal)}</span>}
            {divTotal > 0 && <span className="text-amber-600">分红 {fmt(divTotal)}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <label className={`inline-flex items-center gap-1.5 px-3 py-2 ${ocrLoading ? 'bg-gray-400' : 'bg-purple-600 hover:bg-purple-700'} text-white rounded-lg text-sm font-medium shadow-sm transition-colors cursor-pointer`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            {ocrLoading ? '识别中...' : '截图识别'}
            <input type="file" accept="image/*" onChange={handleOCR} className="hidden" disabled={ocrLoading} />
          </label>
          <button onClick={() => { setShowBatch(true); setBatchRows([emptyBatchRow(), emptyBatchRow(), emptyBatchRow()]); setBatchError(''); setActiveTab('list') }}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium shadow-sm transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
            批量
          </button>
          <button onClick={() => { setShowForm(true); setEditId(null); setForm(emptyForm); setActiveTab('list') }}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            添加
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200">
        {([['list', '交易列表'], ['analysis', '交易复盘']] as const).map(([key, label]) => (
          <button key={key} onClick={() => { setActiveTab(key); if (key === 'analysis') loadAnalysis(analysisDate) }}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ====== TAB: 交易列表 ====== */}
      {activeTab === 'list' && (
        <>
          {/* Filters - compact */}
          <div className="flex flex-wrap items-center gap-2">
            <select value={filterFund} onChange={e => setFilterFund(e.target.value)} className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部基金</option>
              {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部类型</option>
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
              <option value="dividend">分红</option>
            </select>
            <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" placeholder="起始" />
            <span className="text-gray-300">~</span>
            <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" placeholder="截止" />
            {hasFilters && <button onClick={clearFilters} className="text-xs text-blue-600 hover:text-blue-800 font-medium">清除</button>}
          </div>

          {/* Batch Form */}
          {/* 截图识别结果 */}
          {ocrResult && (
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-purple-700">
                  截图识别结果 — {ocrResult.trades?.length || 0}笔交易
                </h3>
                <button onClick={() => setOcrResult(null)} className="text-purple-400 hover:text-purple-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              {ocrResult.trades?.length > 0 ? (
                <div className="space-y-2">
                  {ocrResult.trades.map((t: any, i: number) => (
                    <div key={i} className="flex items-center justify-between bg-white rounded-lg p-3 border border-purple-100">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                            t.type === 'buy' ? 'bg-emerald-100 text-emerald-700' :
                            t.type === 'sell' ? 'bg-red-100 text-red-700' :
                            'bg-amber-100 text-amber-700'
                          }`}>{t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '分红'}</span>
                          <span className="text-sm font-medium text-gray-900 truncate">{t.fund_name}</span>
                          {t.fund_code && <span className="text-xs text-gray-400">{t.fund_code}</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                          {t.date && <span>{t.date}</span>}
                          {t.amount > 0 && <span className="font-medium">¥{t.amount.toLocaleString()}</span>}
                          {t.shares > 0 && <span>{t.shares}份</span>}
                          {t.nav > 0 && <span>净值{t.nav}</span>}
                          {t.matched_fund_name && <span className="text-purple-600">已匹配: {t.matched_fund_name}</span>}
                          {!t.matched_fund_id && <span className="text-amber-500">未匹配到系统基金</span>}
                        </div>
                      </div>
                      <button onClick={() => applyOcrTrade(t)}
                        className="shrink-0 ml-2 px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-medium hover:bg-purple-700">
                        录入
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-purple-600">{ocrResult.message || '未识别到交易记录'}</p>
              )}
              {ocrResult.raw && !ocrResult.trades?.length && (
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer">查看AI原始返回</summary>
                  <pre className="mt-1 whitespace-pre-wrap bg-white p-2 rounded border">{ocrResult.raw}</pre>
                </details>
              )}
            </div>
          )}

          {showBatch && (
            <div className="bg-white rounded-xl border border-emerald-200 shadow-sm p-5 space-y-3 ring-1 ring-emerald-100">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">批量添加交易</h2>
                <button type="button" onClick={() => { setShowBatch(false); setBatchRows([]) }} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              {batchError && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{batchError}</div>}
              <div className="hidden lg:grid grid-cols-[2fr_1.2fr_0.8fr_0.8fr_1fr_0.6fr_1.5fr_auto] gap-2 text-xs font-medium text-gray-500 px-1">
                <span>基金</span><span>日期</span><span>类型</span><span>方式</span><span>数值</span><span>净值</span><span>备注</span><span></span>
              </div>
              <div className="space-y-2">
                {batchRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-1 lg:grid-cols-[2fr_1.2fr_0.8fr_0.8fr_1fr_0.6fr_1.5fr_auto] gap-2 items-center p-2 bg-gray-50 rounded-lg">
                    <select value={row.fund_id} onChange={e => { const fid = Number(e.target.value); updateBatchRow(idx, { fund_id: fid, fundName: funds.find(f => f.id === fid)?.name || '' }); batchFetchNav(idx, fid, row.date) }}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:ring-2 focus:ring-emerald-500 outline-none">
                      <option value={0}>选择基金</option>
                      {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    <input type="date" value={row.date} onChange={e => { updateBatchRow(idx, { date: e.target.value }); batchFetchNav(idx, row.fund_id, e.target.value) }}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500 outline-none" />
                    <select value={row.type} onChange={e => updateBatchRow(idx, { type: e.target.value as any })}
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:ring-2 focus:ring-emerald-500 outline-none">
                      <option value="buy">买入</option><option value="sell">卖出</option><option value="dividend">分红</option>
                    </select>
                    {row.type !== 'dividend' ? (
                      <select value={row.inputMode} onChange={e => updateBatchRow(idx, { inputMode: e.target.value as any })}
                        className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:ring-2 focus:ring-emerald-500 outline-none">
                        <option value="amount">按金额</option><option value="shares">按份额</option>
                      </select>
                    ) : <span className="text-xs text-gray-400 text-center">-</span>}
                    <div className="relative">
                      <span className="absolute left-2 top-1.5 text-gray-400 text-xs">{row.type === 'dividend' || row.inputMode === 'amount' ? '¥' : '份'}</span>
                      <input type="number" step="any" value={row.inputValue || ''} onChange={e => updateBatchRow(idx, { inputValue: Number(e.target.value) })}
                        placeholder="0" className="w-full border border-gray-300 rounded-lg pl-6 pr-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500 outline-none" />
                    </div>
                    <div className="text-xs text-center">
                      {row.navLoading ? <span className="text-blue-500">...</span> : row.price > 0 ? <span className="text-gray-700 font-mono">{row.price.toFixed(4)}</span> : <span className="text-gray-400">-</span>}
                    </div>
                    <input value={row.notes} onChange={e => updateBatchRow(idx, { notes: e.target.value })} placeholder="备注"
                      className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-emerald-500 outline-none" />
                    <button type="button" onClick={() => removeBatchRow(idx)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50" title="删除">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={addBatchRow} className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">+ 添加一行</button>
                <div className="flex-1" />
                <button type="button" onClick={() => { setShowBatch(false); setBatchRows([]) }} className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">取消</button>
                <button type="button" onClick={handleBatchSubmit} disabled={batchSubmitting}
                  className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium shadow-sm disabled:opacity-50">
                  {batchSubmitting ? '提交中...' : `提交 ${batchRows.filter(r => r.fund_id > 0 && r.inputValue > 0).length} 条`}
                </button>
              </div>
            </div>
          )}

          {/* Single Form */}
          {showForm && (
            <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-blue-200 shadow-sm p-5 space-y-4 ring-1 ring-blue-100">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">{editId ? '编辑' : '新增'}交易</h2>
                <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">基金</label>
                  <select value={form.fund_id} onChange={e => { const fid = Number(e.target.value); setForm({ ...form, fund_id: fid }); if (form.date) autoFetchNav(fid, form.date, form.type) }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" required>
                    <option value={0}>选择基金</option>
                    {funds.map(f => <option key={f.id} value={f.id}>{f.name}{f.code ? ` (${f.code})` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">日期 {navLoading && <span className="text-blue-500 text-xs ml-1">查询净值...</span>}</label>
                  <input type="date" value={form.date} onChange={e => { setForm({ ...form, date: e.target.value }); autoFetchNav(form.fund_id, e.target.value, form.type) }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" required />
                  {navHint && <p className="text-xs text-blue-600 mt-1">{navHint}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">类型</label>
                  <div className="flex gap-1.5">
                    {(['buy', 'sell', 'dividend'] as const).map(t => (
                      <button key={t} type="button" onClick={() => setForm({ ...form, type: t })}
                        className={`flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors ${form.type === t ? `${typeConfig[t].bg} ${typeConfig[t].text} ${typeConfig[t].border}` : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                        {typeConfig[t].icon} {typeConfig[t].label}
                      </button>
                    ))}
                  </div>
                </div>
                {form.type !== 'dividend' ? (<>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">输入方式</label>
                    <div className="flex gap-1.5">
                      {(['amount', 'shares'] as const).map(m => (
                        <button key={m} type="button" onClick={() => setForm({ ...form, inputMode: m, inputValue: 0 })}
                          className={`flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors ${form.inputMode === m ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                          {m === 'amount' ? '按金额' : '按份额'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{form.inputMode === 'amount' ? '金额' : '份额'}</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 text-sm">{form.inputMode === 'amount' ? '¥' : '份'}</span>
                      <input type="number" step="any" value={form.inputValue || ''} onChange={e => setForm({ ...form, inputValue: Number(e.target.value) })}
                        placeholder="0" className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                    </div>
                  </div>
                </>) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">金额</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 text-sm">¥</span>
                      <input type="number" step="any" value={form.inputValue || ''} onChange={e => setForm({ ...form, inputValue: Number(e.target.value) })}
                        placeholder="0.00" className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                    </div>
                  </div>
                )}
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">备注</label>
                  <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="可选"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
              {form.fund_id > 0 && form.inputValue > 0 && form.price > 0 && form.type !== 'dividend' && (
                <div className="bg-gray-50 rounded-lg p-2.5 text-sm text-gray-600">
                  预览：<strong>{typeConfig[form.type].label}</strong> {funds.find(f => f.id === form.fund_id)?.name} 净值 {form.price.toFixed(4)} &middot;{' '}
                  {form.inputMode === 'amount' ? <>金额 {fmt(form.inputValue)} = <strong>{(form.inputValue / form.price).toFixed(4)} 份</strong></> : <>{form.inputValue} 份 = <strong>{fmt(form.inputValue * form.price)}</strong></>}
                </div>
              )}
              <div className="flex gap-3">
                <button type="submit" className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm">{editId ? '更新' : '添加'}</button>
                <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium">取消</button>
              </div>
            </form>
          )}

          {/* Transaction List - grouped by date */}
          {txs.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-200">
              <h3 className="text-base font-semibold text-gray-900 mb-1">暂无交易记录</h3>
              <p className="text-gray-500 text-sm">{hasFilters ? '试试调整筛选条件' : '点击上方按钮添加交易'}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {sortedDates.map(date => {
                const dateTxs = groupedTxs[date]
                const dayBuy = dateTxs.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares * t.price, 0)
                const daySell = dateTxs.filter(t => t.type === 'sell').reduce((s, t) => s + t.shares * t.price, 0)
                return (
                  <div key={date} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    {/* Date header */}
                    <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-700">{formatDateFull(date)}</span>
                        <span className="text-xs text-gray-400">{dateTxs.length} 笔</span>
                      </div>
                      <div className="flex gap-3 text-xs">
                        {dayBuy > 0 && <span className="text-emerald-600">买 {fmt(dayBuy)}</span>}
                        {daySell > 0 && <span className="text-red-600">卖 {fmt(daySell)}</span>}
                      </div>
                    </div>
                    {/* Transactions */}
                    <div className="divide-y divide-gray-50">
                      {dateTxs.map(tx => {
                        const cfg = typeConfig[tx.type]
                        const total = tx.type === 'dividend' ? tx.price : tx.shares * tx.price
                        return (
                          <div key={tx.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50/50 transition-colors group">
                            {/* Type dot */}
                            <div className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
                            {/* Fund name + type */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tx.fund_color }} />
                                <span className="text-sm font-medium text-gray-900 truncate">{tx.fund_name}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>
                              </div>
                            </div>
                            {/* Details */}
                            <div className="hidden sm:block text-xs text-gray-500 text-right shrink-0 w-36">
                              {tx.type !== 'dividend' ? <>{tx.shares.toFixed(2)}份 @ {fmtNav(tx.price)}</> : '现金分红'}
                            </div>
                            {/* Notes */}
                            {tx.notes && <span className="hidden md:block text-xs text-gray-400 truncate max-w-[120px]" title={tx.notes}>{tx.notes}</span>}
                            {/* Amount */}
                            <div className={`text-sm font-semibold tabular-nums shrink-0 w-24 text-right ${tx.type === 'sell' ? 'text-red-600' : tx.type === 'buy' ? 'text-emerald-700' : 'text-amber-700'}`}>
                              {tx.type === 'sell' ? '-' : tx.type === 'buy' ? '+' : ''}{fmt(total)}
                            </div>
                            {/* Actions */}
                            <div className="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => startEdit(tx)} className="p-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50" title="编辑">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                              </button>
                              <button onClick={() => setDeleteId(tx.id)} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" title="删除">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ====== TAB: 交易复盘 ====== */}
      {activeTab === 'analysis' && (
        <div className="space-y-4">
          {/* Date picker + Summary header */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex flex-wrap items-center gap-3">
              <input type="date" value={analysisDate} onChange={e => { setAnalysisDate(e.target.value); loadAnalysis(e.target.value) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none" />
              <button onClick={() => loadAnalysis(analysisDate)} disabled={analysisLoading}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium shadow-sm disabled:opacity-50 inline-flex items-center gap-2">
                {analysisLoading && <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>}
                {analysisLoading ? '正在分析...' : '分析交易'}
              </button>
              {/* 汇总统计 */}
              {tradeAnalysis && tradeAnalysis.summary.total > 0 && (
                <div className="flex items-center gap-4 ml-auto">
                  <div className="flex gap-2 text-sm">
                    {tradeAnalysis.summary.good > 0 && <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-lg font-medium">优良 {tradeAnalysis.summary.good}</span>}
                    {tradeAnalysis.summary.neutral > 0 && <span className="px-2.5 py-1 bg-amber-50 text-amber-700 rounded-lg font-medium">一般 {tradeAnalysis.summary.neutral}</span>}
                    {tradeAnalysis.summary.bad > 0 && <span className="px-2.5 py-1 bg-red-50 text-red-700 rounded-lg font-medium">欠佳 {tradeAnalysis.summary.bad}</span>}
                  </div>
                  <div className="flex items-center gap-2 pl-3 border-l border-gray-200">
                    <div className={`text-2xl font-bold ${tradeAnalysis.summary.avgScore >= 10 ? 'text-emerald-600' : tradeAnalysis.summary.avgScore >= -10 ? 'text-amber-600' : 'text-red-600'}`}>
                      {tradeAnalysis.summary.avgScore}
                    </div>
                    <div className="text-xs text-gray-500 leading-tight"><div>综合</div><div>评分</div></div>
                  </div>
                </div>
              )}
            </div>
            {/* 选中日期的交易汇总 */}
            {tradeAnalysis && tradeAnalysis.summary.total > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600">
                <span>{tradeAnalysis.date} 共 <strong>{tradeAnalysis.summary.total}</strong> 笔交易</span>
                <span>{tradeAnalysis.summary.verdict}</span>
                {(() => {
                  const buys = tradeAnalysis.trades.filter(t => t.type === 'buy')
                  const sells = tradeAnalysis.trades.filter(t => t.type === 'sell')
                  const buyAmt = buys.reduce((s, t) => s + t.amount, 0)
                  const sellAmt = sells.reduce((s, t) => s + t.amount, 0)
                  return (<>
                    {buys.length > 0 && <span className="text-emerald-600">买入 {buys.length} 笔 {fmt(buyAmt)}</span>}
                    {sells.length > 0 && <span className="text-red-600">卖出 {sells.length} 笔 {fmt(sellAmt)}</span>}
                  </>)
                })()}
              </div>
            )}
          </div>

          {analysisLoading && (
            <div className="text-center py-16 text-gray-500">
              <svg className="w-8 h-8 animate-spin mx-auto mb-3 text-purple-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              <div>正在分析 {analysisDate} 的交易...</div>
              <div className="text-xs text-gray-400 mt-1">需获取每只基金的技术面和市场数据，请耐心等待</div>
            </div>
          )}

          {!analysisLoading && tradeAnalysis ? (
            tradeAnalysis.summary.total > 0 ? (
              <>

                {/* Trade cards */}
                <div className="space-y-3">
                  {tradeAnalysis.trades.map(t => {
                    const gradeColors: Record<string, string> = {
                      excellent: 'border-emerald-300 bg-emerald-50', good: 'border-emerald-200 bg-emerald-50/50',
                      neutral: 'border-gray-200 bg-white', poor: 'border-amber-200 bg-amber-50/50', bad: 'border-red-200 bg-red-50/50',
                    }
                    const scoreBg = t.score >= 30 ? 'bg-emerald-600' : t.score >= 10 ? 'bg-emerald-500' : t.score >= -10 ? 'bg-amber-500' : t.score >= -30 ? 'bg-orange-500' : 'bg-red-500'
                    return (
                      <div key={t.id} className={`rounded-xl border p-4 ${gradeColors[t.grade] || gradeColors.neutral}`}>
                        <div className="flex items-center gap-3 mb-2">
                          <div className={`w-11 h-11 rounded-lg ${scoreBg} text-white flex flex-col items-center justify-center shrink-0`}>
                            <span className="text-base font-bold leading-none">{t.score > 0 ? '+' : ''}{t.score}</span>
                            <span className="text-[10px] opacity-80">{t.gradeLabel}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                              <span className="font-semibold text-gray-900 text-sm">{t.fundName}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${t.type === 'buy' ? 'bg-emerald-100 text-emerald-700' : t.type === 'sell' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                {t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '分红'}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {t.type !== 'dividend' && <>{t.shares.toFixed(4)}份 @ ¥{t.price.toFixed(4)} = </>}{fmt(t.amount)}
                            </div>
                          </div>
                          <div className="hidden sm:flex gap-3 text-xs text-gray-500">
                            <div className="text-center"><div className="font-mono font-medium text-gray-700">{t.details.bollinger?.percentB ?? '-'}%</div><div>布林</div></div>
                            <div className="text-center"><div className="font-mono font-medium text-gray-700">{t.details.rsi ?? '-'}</div><div>RSI</div></div>
                            <div className="text-center">
                              <div className="font-mono font-medium text-gray-700">{t.details.forecast?.changePct >= 0 ? '+' : ''}{t.details.forecast?.changePct?.toFixed(2) ?? '-'}%</div>
                              <div>预测</div>
                            </div>
                            {t.details.gainPct !== 0 && (
                              <div className="text-center">
                                <div className={`font-mono font-medium ${t.details.gainPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{t.details.gainPct >= 0 ? '+' : ''}{t.details.gainPct}%</div>
                                <div>盈亏</div>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {t.analysis.map((a, i) => (
                            <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-md bg-white/80 border border-gray-200 text-xs text-gray-600">{a}</span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : <div className="text-center py-12 text-gray-400 text-sm">{tradeAnalysis.date} 没有交易记录</div>
          ) : !analysisLoading ? (
            <div className="text-center py-12 text-gray-400 text-sm">选择日期后点击"分析交易"</div>
          ) : null}

          {/* 选中日期的买卖汇总 */}
          {(() => {
            const dateTxs = txs.filter(t => t.date === analysisDate)
            if (dateTxs.length === 0) return null
            const buys = dateTxs.filter(t => t.type === 'buy')
            const sells = dateTxs.filter(t => t.type === 'sell')
            const divs = dateTxs.filter(t => t.type === 'dividend')
            const buyAmt = buys.reduce((s, t) => s + t.shares * t.price, 0)
            const sellAmt = sells.reduce((s, t) => s + t.shares * t.price, 0)
            const divAmt = divs.reduce((s, t) => s + t.price, 0)
            const netFlow = buyAmt - sellAmt
            // 按基金分组汇总
            const byFund = new Map<string, { name: string; color: string; buy: number; sell: number; div: number }>()
            for (const t of dateTxs) {
              const key = t.fund_name
              const cur = byFund.get(key) || { name: t.fund_name, color: t.fund_color, buy: 0, sell: 0, div: 0 }
              if (t.type === 'buy') cur.buy += t.shares * t.price
              else if (t.type === 'sell') cur.sell += t.shares * t.price
              else cur.div += t.price
              byFund.set(key, cur)
            }
            return (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">{analysisDate} 交易汇总</h3>
                  <span className="text-xs text-gray-400">{dateTxs.length} 笔交易</span>
                </div>
                {/* 总计 */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {buyAmt > 0 && (
                    <div className="bg-emerald-50 rounded-lg p-3">
                      <div className="text-xs text-emerald-600 mb-0.5">买入 {buys.length} 笔</div>
                      <div className="text-lg font-bold text-emerald-700">{fmt(buyAmt)}</div>
                    </div>
                  )}
                  {sellAmt > 0 && (
                    <div className="bg-red-50 rounded-lg p-3">
                      <div className="text-xs text-red-600 mb-0.5">卖出 {sells.length} 笔</div>
                      <div className="text-lg font-bold text-red-700">{fmt(sellAmt)}</div>
                    </div>
                  )}
                  {divAmt > 0 && (
                    <div className="bg-amber-50 rounded-lg p-3">
                      <div className="text-xs text-amber-600 mb-0.5">分红 {divs.length} 笔</div>
                      <div className="text-lg font-bold text-amber-700">{fmt(divAmt)}</div>
                    </div>
                  )}
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-0.5">净流出</div>
                    <div className={`text-lg font-bold ${netFlow > 0 ? 'text-emerald-700' : netFlow < 0 ? 'text-red-700' : 'text-gray-700'}`}>
                      {netFlow > 0 ? '+' : ''}{fmt(netFlow)}
                    </div>
                  </div>
                </div>
                {/* 按基金明细 */}
                <div className="space-y-1.5">
                  {Array.from(byFund.values())
                    .sort((a, b) => (b.buy + b.sell + b.div) - (a.buy + a.sell + a.div))
                    .map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                      <span className="text-gray-700 truncate min-w-0 flex-1">{f.name}</span>
                      {f.buy > 0 && <span className="text-emerald-600 text-xs font-medium shrink-0">买 {fmt(f.buy)}</span>}
                      {f.sell > 0 && <span className="text-red-600 text-xs font-medium shrink-0">卖 {fmt(f.sell)}</span>}
                      {f.div > 0 && <span className="text-amber-600 text-xs font-medium shrink-0">分红 {fmt(f.div)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <ConfirmDialog open={deleteId !== null} title="删除交易" message="确定要删除这条交易记录吗？此操作不可撤销。"
        onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
    </div>
  )
}
