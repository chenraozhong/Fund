import { useEffect, useState, useMemo } from 'react'
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

const typeConfig = {
  buy:      { label: '买入',  bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200', icon: '↑' },
  sell:     { label: '卖出',  bg: 'bg-red-50',      text: 'text-red-700',     border: 'border-red-200',     icon: '↓' },
  dividend: { label: '分红',  bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',   icon: '$' },
}

type SortKey = 'name' | 'value' | 'gain' | 'gain_pct' | 'cost'
type ViewMode = 'list' | 'card'

export default function Funds() {
  const navigate = useNavigate()
  const [funds, setFunds] = useState<Fund[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#378ADD')
  const [code, setCode] = useState('')
  const [codeVerify, setCodeVerify] = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')

  // 搜索、排序、视图
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortAsc, setSortAsc] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('funds_view') as ViewMode) || 'list' } catch { return 'list' }
  })

  // 回收站
  const [showTrash, setShowTrash] = useState(false)
  const [trashFunds, setTrashFunds] = useState<any[]>([])
  const [permanentDeleteId, setPermanentDeleteId] = useState<number | null>(null)

  const loadTrash = () => api.getTrashFunds().then(setTrashFunds)

  // 添加交易相关状态
  const [txFundId, setTxFundId] = useState<number | null>(null)
  const [txForm, setTxForm] = useState({ date: '', type: 'buy' as 'buy' | 'sell' | 'dividend', inputMode: 'amount' as 'shares' | 'amount', value: 0, price: 0, notes: '' })
  const [txNavLoading, setTxNavLoading] = useState(false)
  const [txNavHint, setTxNavHint] = useState('')
  const [txError, setTxError] = useState('')

  // 实时估值
  const [estimates, setEstimates] = useState<Record<number, { gsz: number; gszzl: number; gztime: string }>>({})
  const [estLoading, setEstLoading] = useState(false)

  const load = () => api.getFunds().then(setFunds)
  useEffect(() => { load() }, [])

  const loadEstimates = async () => {
    setEstLoading(true)
    try {
      const data = await api.getEstimateAll()
      setEstimates(data)
    } catch { /* ignore */ }
    finally { setEstLoading(false) }
  }

  // 页面加载时自动获取一次估值
  useEffect(() => { if (funds.length > 0) loadEstimates() }, [funds.length > 0])

  useEffect(() => {
    try { localStorage.setItem('funds_view', viewMode) } catch {}
  }, [viewMode])

  const txAutoFetchNav = async (fundId: number, date: string, type: string) => {
    if (type === 'dividend' || !fundId || !date) { setTxNavHint(''); return }
    const fund = funds.find(f => f.id === fundId)
    if (!fund?.code) { setTxNavHint('该基金无代码，无法自动获取净值'); return }
    setTxNavLoading(true)
    setTxNavHint('')
    try {
      const result = await api.getNavByDate(fund.code, date)
      setTxForm(f => ({ ...f, price: result.nav }))
      setTxNavHint(result.note ? `${result.date} 净值 ${result.nav}（${result.note}）` : `${result.date} 净值 ${result.nav}`)
    } catch {
      setTxNavHint('未查到该日期净值')
    } finally {
      setTxNavLoading(false)
    }
  }

  const openTxForm = (fund: Fund) => {
    setTxFundId(fund.id)
    setTxForm({ date: new Date().toISOString().slice(0, 10), type: 'buy', inputMode: 'amount', value: 0, price: 0, notes: '' })
    setTxNavHint('')
    setTxError('')
    if (fund.code) {
      const today = new Date().toISOString().slice(0, 10)
      setTimeout(() => txAutoFetchNav(fund.id, today, 'buy'), 0)
    }
  }

  const handleTxSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTxError('')
    const fund = funds.find(f => f.id === txFundId)
    if (!fund || !txForm.date) { setTxError('请填写日期'); return }

    let shares = 0, price = txForm.price
    if (txForm.type === 'dividend') {
      price = txForm.value
    } else if (txForm.inputMode === 'shares') {
      shares = txForm.value
    } else {
      if (price <= 0) { setTxError('净值未获取到，无法计算份额'); return }
      shares = Math.round((txForm.value / price) * 10000) / 10000
    }

    try {
      await api.createTransaction({ fund_id: fund.id, date: txForm.date, type: txForm.type, asset: fund.name, shares, price, notes: txForm.notes || '' })
      setTxFundId(null)
      load()
    } catch (err: any) {
      setTxError(err.message)
    }
  }

  const totalValue = funds.reduce((s, f) => s + f.current_value, 0)

  // 过滤 + 排序
  const filtered = useMemo(() => {
    let list = funds
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(f => f.name.toLowerCase().includes(q) || (f.code && f.code.includes(q)))
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name, 'zh-CN'); break
        case 'value': cmp = a.current_value - b.current_value; break
        case 'gain': cmp = a.gain - b.gain; break
        case 'gain_pct': cmp = a.gain_pct - b.gain_pct; break
        case 'cost': cmp = a.total_cost - b.total_cost; break
      }
      return sortAsc ? cmp : -cmp
    })
    return sorted
  }, [funds, search, sortKey, sortAsc])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('请输入基金名称。'); return }
    try {
      if (editId) {
        await api.updateFund(editId, { name, color, code })
      } else {
        await api.createFund({ name, color, code })
      }
      setShowForm(false)
      setEditId(null)
      setName('')
      setColor('#378ADD')
      setCode('')
      setCodeVerify(null)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const startEdit = (f: Fund) => {
    setName(f.name)
    setColor(f.color)
    setCode(f.code || '')
    setCodeVerify(null)
    setEditId(f.id)
    setShowForm(true)
  }

  const verifyCode = async () => {
    if (!code.trim()) return
    setCodeLoading(true)
    setCodeVerify(null)
    try {
      const result = await api.getLatestNav(code.trim())
      setCodeVerify(`${result.name}（最新净值: ${result.nav}，${result.date}）`)
      if (!name.trim()) setName(result.name)
    } catch {
      setCodeVerify('未找到该基金代码')
    } finally {
      setCodeLoading(false)
    }
  }

  const handleDelete = async () => {
    if (deleteId) {
      await api.deleteFund(deleteId)
      setDeleteId(null)
      load()
    }
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(false) }
  }

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <span className="text-gray-300 ml-0.5">↕</span>
    return <span className="text-blue-500 ml-0.5">{sortAsc ? '↑' : '↓'}</span>
  }

  // 内嵌交易表单组件
  const renderTxForm = (f: Fund) => {
    if (txFundId !== f.id) return null
    return (
      <form onSubmit={handleTxSubmit} className="mt-3 pt-3 border-t border-gray-100 space-y-3">
        {txError && <div className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{txError}</div>}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">日期 {txNavLoading && <span className="text-blue-500">查询中...</span>}</label>
            <input type="date" value={txForm.date} onChange={e => { setTxForm({ ...txForm, date: e.target.value }); txAutoFetchNav(f.id, e.target.value, txForm.type) }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" required />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">类型</label>
            <div className="flex gap-1">
              {(['buy', 'sell', 'dividend'] as const).map(t => {
                const cfg = typeConfig[t]
                return (
                  <button key={t} type="button" onClick={() => { setTxForm({ ...txForm, type: t }); if (t !== 'dividend' && txForm.date) txAutoFetchNav(f.id, txForm.date, t) }}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${
                      txForm.type === t ? `${cfg.bg} ${cfg.text} ${cfg.border}` : 'bg-white text-gray-400 border-gray-200'
                    }`}>{cfg.label}</button>
                )
              })}
            </div>
          </div>
        </div>
        {txNavHint && <p className="text-xs text-blue-600">{txNavHint}</p>}
        {txForm.type !== 'dividend' ? (
          <div className="space-y-2">
            <div className="flex gap-1">
              <button type="button" onClick={() => setTxForm({ ...txForm, inputMode: 'amount' })}
                className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${txForm.inputMode === 'amount' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-400 border-gray-200'}`}>按金额</button>
              <button type="button" onClick={() => setTxForm({ ...txForm, inputMode: 'shares' })}
                className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${txForm.inputMode === 'shares' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-400 border-gray-200'}`}>按份额</button>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-2 text-gray-400 text-sm">{txForm.inputMode === 'amount' ? '¥' : '份'}</span>
              <input type="number" step="any" value={txForm.value || ''} onChange={e => setTxForm({ ...txForm, value: Number(e.target.value) })}
                placeholder={txForm.inputMode === 'amount' ? '输入金额' : '输入份额'}
                className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            {txForm.value > 0 && txForm.price > 0 && (
              <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">
                净值 {txForm.price.toFixed(4)} &middot;
                {txForm.inputMode === 'amount'
                  ? <>份额 {(txForm.value / txForm.price).toFixed(4)} &middot; 金额 {fmt(txForm.value)}</>
                  : <>份额 {txForm.value} &middot; 金额 {fmt(txForm.value * txForm.price)}</>
                }
              </div>
            )}
          </div>
        ) : (
          <div className="relative">
            <span className="absolute left-3 top-2 text-gray-400 text-sm">¥</span>
            <input type="number" step="any" value={txForm.value || ''} onChange={e => setTxForm({ ...txForm, value: Number(e.target.value) })}
              placeholder="分红金额"
              className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        )}
        <div className="flex gap-2">
          <button type="submit" className="flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors">
            确认
          </button>
          <button type="button" onClick={() => setTxFundId(null)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors">
            取消
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">基金管理</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            共 {funds.length} 个基金{search && filtered.length !== funds.length ? `（显示 ${filtered.length}）` : ''} &middot; 总市值 {fmt(totalValue)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadEstimates}
            disabled={estLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 text-sm font-medium transition-colors disabled:opacity-50"
            title="刷新实时估值"
          >
            <svg className={`w-4 h-4 ${estLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {estLoading ? '估值中...' : '实时估值'}
          </button>
          <button
            onClick={() => { setShowForm(true); setEditId(null); setName(''); setColor('#378ADD'); setCode(''); setCodeVerify(null) }}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新建基金
          </button>
        </div>
      </div>

      {/* 搜索 + 排序 + 视图切换 */}
      {funds.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          {/* 搜索框 */}
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索基金名称或代码..."
              className="w-full border border-gray-200 rounded-lg pl-9 pr-8 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          {/* 排序 */}
          <div className="flex items-center gap-1 text-xs">
            <span className="text-gray-400 mr-1 hidden sm:inline">排序</span>
            {([
              ['value', '市值'],
              ['gain_pct', '收益率'],
              ['gain', '盈亏'],
              ['cost', '投入'],
              ['name', '名称'],
            ] as [SortKey, string][]).map(([key, label]) => (
              <button key={key} onClick={() => toggleSort(key)}
                className={`px-2 py-1.5 rounded-md font-medium transition-colors ${
                  sortKey === key ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-100'
                }`}>
                {label}{sortIcon(key)}
              </button>
            ))}
          </div>
          {/* 视图切换 */}
          <div className="flex border border-gray-200 rounded-lg overflow-hidden">
            <button onClick={() => setViewMode('list')}
              className={`px-2.5 py-1.5 transition-colors ${viewMode === 'list' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50'}`}
              title="列表视图">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <button onClick={() => setViewMode('card')}
              className={`px-2.5 py-1.5 transition-colors ${viewMode === 'card' ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50'}`}
              title="卡片视图">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" /></svg>
            </button>
          </div>
        </div>
      )}

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
          <div className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="flex-1 w-full">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">基金代码</label>
                <div className="flex gap-2">
                  <input value={code} onChange={e => { setCode(e.target.value); setCodeVerify(null) }} className="flex-1 border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow" placeholder="例如：012414" />
                  <button type="button" onClick={verifyCode} disabled={codeLoading || !code.trim()} className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors disabled:opacity-50">
                    {codeLoading ? '查询中...' : '验证'}
                  </button>
                </div>
                {codeVerify && (
                  <p className={`text-xs mt-1.5 ${codeVerify.includes('未找到') ? 'text-red-500' : 'text-green-600'}`}>{codeVerify}</p>
                )}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="flex-1 w-full">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">基金名称</label>
                <input value={name} onChange={e => setName(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow" placeholder="例如：稳健理财（验证代码可自动填入）" required />
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
          </div>
        </form>
      )}

      {/* Fund List / Cards */}
      {funds.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无基金</h3>
          <p className="text-gray-500 text-sm">创建你的第一个基金，开始追踪投资组合。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <p className="text-gray-400 text-sm">未找到匹配「{search}」的基金</p>
        </div>
      ) : viewMode === 'list' ? (
        /* ==================== 列表视图 ==================== */
        <div className="space-y-2">
          {filtered.map(f => {
            const alloc = totalValue > 0 ? (f.current_value / totalValue) * 100 : 0
            const costNav = f.holding_shares > 0 ? f.total_cost / f.holding_shares : 0
            const est = estimates[f.id]
            return (
              <div key={f.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer group" onClick={() => navigate(`/funds/${f.id}`)}>
                  {/* 色条 */}
                  <div className="w-1.5 h-12 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                  {/* 基金信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-sm text-gray-900 truncate">{f.name}</span>
                      {f.code && <span className="text-[11px] text-gray-400 shrink-0">{f.code}</span>}
                      <span className="text-[10px] text-gray-400 shrink-0">{alloc.toFixed(1)}%</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                      {est ? (<>
                        <span className="font-mono">{est.gsz.toFixed(4)}</span>
                        <span className={`font-medium ${est.gszzl >= 0 ? 'text-red-500' : 'text-green-600'}`}>{est.gszzl >= 0 ? '+' : ''}{est.gszzl.toFixed(2)}%</span>
                        <span className="text-[10px] text-gray-400">{est.gztime?.slice(11, 16)}</span>
                      </>) : f.market_nav > 0 ? (
                        <span className="font-mono">{f.market_nav.toFixed(4)}</span>
                      ) : null}
                      {costNav > 0 && <span className="text-gray-400">成本 {costNav.toFixed(4)}</span>}
                    </div>
                  </div>
                  {/* 市值 */}
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-gray-900">{fmt(f.current_value)}</div>
                    <div className={`text-xs font-medium ${f.gain >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {f.gain >= 0 ? '+' : ''}{fmt(f.gain)}
                    </div>
                  </div>
                  {/* 收益率 */}
                  <div className="shrink-0">
                    <span className={`inline-block px-2.5 py-1 rounded-lg text-xs font-bold ${
                      f.gain_pct >= 5 ? 'bg-emerald-100 text-emerald-700' :
                      f.gain_pct >= 0 ? 'bg-emerald-50 text-emerald-600' :
                      f.gain_pct >= -5 ? 'bg-red-50 text-red-600' :
                      'bg-red-100 text-red-700'
                    }`}>{pct(f.gain_pct)}</span>
                  </div>
                  {/* 操作按钮 */}
                  <div className="flex gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                    <button onClick={() => openTxForm(f)}
                      className="px-2.5 py-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors">交易</button>
                    <button onClick={() => startEdit(f)}
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                    </button>
                    <button onClick={() => setDeleteId(f.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </div>
                {/* 内嵌交易表单 */}
                {txFundId === f.id && (
                  <div className="px-4 pb-4 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                    {renderTxForm(f)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* ==================== 卡片视图 ==================== */
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map(f => {
            const alloc = totalValue > 0 ? (f.current_value / totalValue) * 100 : 0
            return (
              <div key={f.id} className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                <div className="h-1.5" style={{ backgroundColor: f.color }} />
                <div className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => navigate(`/funds/${f.id}`)}>
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: f.color }}>
                        {f.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">{f.name}</h3>
                        <span className="text-xs text-gray-400">{f.code ? f.code + ' · ' : ''}占比 {alloc.toFixed(1)}%</span>
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

                  <div className="mb-4">
                    <div className="text-2xl font-bold text-gray-900">{fmt(f.current_value)}</div>
                    <div className={`text-sm font-medium mt-0.5 ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {f.gain >= 0 ? '+' : ''}{fmt(f.gain)} ({pct(f.gain_pct)})
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500" style={{ backgroundColor: f.color, width: `${Math.min(alloc, 100)}%`, opacity: 0.8 }} />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 pt-3 border-t border-gray-100">
                    <div>
                      <div className="text-xs text-gray-400 uppercase tracking-wide">已投入</div>
                      <div className="text-sm font-medium text-gray-700 mt-0.5">{fmt(f.total_cost)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 uppercase tracking-wide">成本净值</div>
                      <div className="text-sm font-medium text-gray-700 mt-0.5">
                        {f.holding_shares > 0 ? (f.total_cost / f.holding_shares).toFixed(4) : '-'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 uppercase tracking-wide">收益率</div>
                      <div className={`text-sm font-medium mt-0.5 ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pct(f.gain_pct)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button onClick={() => openTxForm(f)}
                      className="flex-1 py-2 text-sm font-medium text-emerald-600 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors flex items-center justify-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                      添加交易
                    </button>
                    <button onClick={() => navigate(`/funds/${f.id}`)}
                      className="flex-1 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors flex items-center justify-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                      管理
                    </button>
                  </div>

                  {renderTxForm(f)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="删除基金"
        message="基金将移入回收站，可随时恢复。"
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />

      <ConfirmDialog
        open={permanentDeleteId !== null}
        title="永久删除"
        message="永久删除后无法恢复，所有交易记录将一并删除。确定继续？"
        confirmText="永久删除"
        confirmColor="bg-red-600 hover:bg-red-700"
        onConfirm={async () => {
          if (permanentDeleteId) {
            await api.permanentDeleteFund(permanentDeleteId)
            setPermanentDeleteId(null)
            loadTrash()
          }
        }}
        onCancel={() => setPermanentDeleteId(null)}
      />

      {/* 回收站 */}
      <div className="mt-4">
        <button
          onClick={() => { setShowTrash(!showTrash); if (!showTrash) loadTrash() }}
          className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1.5 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          回收站 {showTrash ? '(收起)' : ''}
        </button>

        {showTrash && (
          <div className="mt-3 space-y-2">
            {trashFunds.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">回收站为空</p>
            ) : (
              trashFunds.map((f: any) => (
                <div key={f.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold opacity-60" style={{ backgroundColor: f.color }}>
                      {f.name.charAt(0)}
                    </div>
                    <div>
                      <span className="text-sm font-medium text-gray-600">{f.name}</span>
                      {f.code && <span className="text-xs text-gray-400 ml-1">({f.code})</span>}
                      <div className="text-xs text-gray-400">
                        {f.tx_count} 条交易 &middot; 删除于 {new Date(f.deleted_at).toLocaleString('zh-CN')}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => { await api.restoreFund(f.id); loadTrash(); load() }}
                      className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                    >恢复</button>
                    <button
                      onClick={() => setPermanentDeleteId(f.id)}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                    >永久删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
