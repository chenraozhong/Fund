import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { FundDetail as FundDetailType, Position, Transaction, AiAdvice, Trade } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNum(n: number, decimals = 4) {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function pct(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function formatDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' })
}

function renderBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    return part
  })
}

const typeConfig = {
  buy:      { label: '买入',  bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200', icon: '↑' },
  sell:     { label: '卖出',  bg: 'bg-red-50',      text: 'text-red-700',     border: 'border-red-200',     icon: '↓' },
  dividend: { label: '分红',  bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',   icon: '$' },
}

const emptyForm = { fund_id: 0, date: '', type: 'buy' as const, asset: '', shares: 0, price: 0, notes: '' }

export default function FundDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const fundId = Number(id)

  const [data, setData] = useState<FundDetailType | null>(null)
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [advice, setAdvice] = useState<AiAdvice | null>(null)
  const [adviceLoading, setAdviceLoading] = useState(false)
  const [adviceError, setAdviceError] = useState('')
  const [showAdvice, setShowAdvice] = useState(false)
  const [editingStrategy, setEditingStrategy] = useState(false)
  const [strategyForm, setStrategyForm] = useState({ stop_profit_pct: 5, stop_loss_pct: 5, market_nav: 0 })
  const [splitTx, setSplitTx] = useState<Transaction | null>(null)
  const [splitShares, setSplitShares] = useState<number>(0)
  const [splitting, setSplitting] = useState(false)
  const [trades, setTrades] = useState<Trade[]>([])
  const [expandedTrades, setExpandedTrades] = useState<Set<number>>(new Set())
  const [pairing, setPairing] = useState(false)

  const load = () => {
    api.getFundDetail(fundId).then(d => {
      setData(d)
      setForm(f => ({ ...f, fund_id: fundId }))
    })
    api.getTrades(fundId).then(setTrades)
  }
  useEffect(() => { load() }, [fundId])

  const fetchAdvice = async () => {
    setAdviceLoading(true)
    setAdviceError('')
    setShowAdvice(true)
    try {
      const result = await api.getFundAdvice(fundId)
      setAdvice(result)
    } catch (err: any) {
      setAdviceError(err.message)
    } finally {
      setAdviceLoading(false)
    }
  }

  if (!data) return <div className="text-center py-20 text-gray-400">加载中...</div>

  const { fund, positions, transactions } = data

  const totalValue = positions.reduce((s, p) => s + p.current_value, 0)
  const totalCost = positions.reduce((s, p) => s + p.total_cost, 0)
  const totalGain = totalValue - totalCost

  // Group transactions by asset
  const txByAsset: Record<string, Transaction[]> = {}
  for (const tx of transactions) {
    if (!txByAsset[tx.asset]) txByAsset[tx.asset] = []
    txByAsset[tx.asset].push(tx)
  }

  const toggleAsset = (asset: string) => {
    setExpandedAssets(prev => {
      const next = new Set(prev)
      if (next.has(asset)) next.delete(asset)
      else next.add(asset)
      return next
    })
  }

  const expandAll = () => {
    setExpandedAssets(new Set(positions.map(p => p.asset)))
  }

  const collapseAll = () => {
    setExpandedAssets(new Set())
  }

  const toggleSelect = (txId: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(txId)) next.delete(txId)
      else next.add(txId)
      return next
    })
  }

  const selectAllForAsset = (asset: string) => {
    const assetTxs = txByAsset[asset] || []
    const allSelected = assetTxs.every(tx => selected.has(tx.id))
    const next = new Set(selected)
    if (allSelected) {
      assetTxs.forEach(tx => next.delete(tx.id))
    } else {
      assetTxs.forEach(tx => next.add(tx.id))
    }
    setSelected(next)
  }

  // Check if selected items can be merged (same asset, same type)
  const canMerge = () => {
    if (selected.size < 2) return false
    const selectedTxs = transactions.filter(tx => selected.has(tx.id))
    const assets = new Set(selectedTxs.map(tx => tx.asset))
    const types = new Set(selectedTxs.map(tx => tx.type))
    return assets.size === 1 && types.size === 1
  }

  const getSelectionSummary = () => {
    const selectedTxs = transactions.filter(tx => selected.has(tx.id))
    if (selectedTxs.length === 0) return null
    const assets = new Set(selectedTxs.map(tx => tx.asset))
    const types = new Set(selectedTxs.map(tx => tx.type))
    let totalAmount = 0
    let totalShares = 0
    for (const tx of selectedTxs) {
      if (tx.type === 'dividend') {
        totalAmount += tx.price
      } else {
        totalShares += tx.shares
        totalAmount += tx.shares * tx.price
      }
    }
    const isMergeable = assets.size === 1 && types.size === 1
    const avgPrice = isMergeable && selectedTxs[0].type !== 'dividend' && totalShares > 0
      ? totalAmount / totalShares : 0
    return {
      count: selectedTxs.length,
      assets: Array.from(assets),
      types: Array.from(types),
      totalAmount,
      totalShares,
      avgPrice,
      isMergeable,
      asset: selectedTxs[0].asset,
      type: selectedTxs[0].type,
    }
  }

  const handleMerge = async () => {
    if (!canMerge()) return
    setMerging(true)
    try {
      await api.mergeTransactions(Array.from(selected))
      setSelected(new Set())
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setMerging(false)
    }
  }

  const handleBatchDelete = async () => {
    setBatchDeleting(true)
    try {
      for (const txId of selected) {
        await api.deleteTransaction(txId)
      }
      setSelected(new Set())
      setShowBatchDeleteConfirm(false)
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBatchDeleting(false)
    }
  }

  const handleSplit = async () => {
    if (!splitTx || splitShares <= 0) return
    setSplitting(true)
    try {
      await api.splitTransaction(splitTx.id, splitShares)
      setSplitTx(null)
      setSplitShares(0)
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSplitting(false)
    }
  }

  const openSplit = (tx: Transaction) => {
    setSplitTx(tx)
    const maxVal = tx.type === 'dividend' ? tx.price : tx.shares
    setSplitShares(Math.round((maxVal / 2) * 100) / 100)
  }

  const handlePair = async () => {
    if (!pairProfit) return
    setPairing(true)
    try {
      await api.createTrade(pairProfit.buyTx.id, pairProfit.sellTx.id)
      setSelected(new Set())
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setPairing(false)
    }
  }

  const handleUnpair = async (tradeId: number) => {
    try {
      await api.deleteTrade(tradeId)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const toggleTrade = (id: number) => {
    setExpandedTrades(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const totalTradeProfit = trades.reduce((s, t) => s + t.profit, 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.date || !form.asset) {
      setError('请填写日期和资产。')
      return
    }
    try {
      const payload = { ...form, fund_id: fundId }
      if (editId) {
        await api.updateTransaction(editId, payload)
      } else {
        await api.createTransaction(payload)
      }
      setShowForm(false)
      setEditId(null)
      setForm({ ...emptyForm, fund_id: fundId })
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  const startEdit = (tx: Transaction) => {
    setForm({ fund_id: fundId, date: tx.date, type: tx.type, asset: tx.asset, shares: tx.shares, price: tx.price, notes: tx.notes || '' })
    setEditId(tx.id)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async () => {
    if (deleteId) {
      await api.deleteTransaction(deleteId)
      setDeleteId(null)
      setSelected(prev => { const n = new Set(prev); n.delete(deleteId); return n })
      load()
    }
  }

  const selSummary = getSelectionSummary()

  // --- Strategy model ---
  const holdingShares = positions.reduce((s, p) => s + p.holding_shares, 0)
  const costBasis = totalValue - totalGain // 持仓成本 = 市值 - 盈亏... actually use totalCost
  const stopProfit = fund.stop_profit_pct || 5
  const stopLoss = fund.stop_loss_pct || 5
  const mNav = fund.market_nav || 0
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0

  const scenarios = [-5, -3, -2, -1, 1, 2, 3, 5].map(changePct => {
    const newNav = mNav > 0 ? mNav * (1 + changePct / 100) : 0
    const newValue = holdingShares * newNav
    const newGain = newValue - totalCost
    const newGainPct = totalCost > 0 ? (newGain / totalCost) * 100 : 0
    let action = '持有'
    let actionColor = 'text-gray-600'
    if (newGainPct >= stopProfit) { action = '止盈卖出'; actionColor = 'text-green-600' }
    else if (newGainPct <= -stopLoss) { action = '止损卖出'; actionColor = 'text-red-600' }
    else if (changePct < 0 && newGainPct < 0) { action = '观望/补仓'; actionColor = 'text-amber-600' }
    else if (changePct > 0 && newGainPct > 0) { action = '持有观望'; actionColor = 'text-blue-600' }
    return { changePct, newNav, newValue, newGain, newGainPct, action, actionColor }
  })

  const handleSaveStrategy = async () => {
    await api.updateFund(fundId, {
      stop_profit_pct: strategyForm.stop_profit_pct,
      stop_loss_pct: strategyForm.stop_loss_pct,
      market_nav: strategyForm.market_nav || undefined,
    })
    setEditingStrategy(false)
    load()
  }

  // --- Buy-sell pair profit ---
  const getPairProfit = () => {
    if (selected.size !== 2) return null
    const selectedTxs = transactions.filter(tx => selected.has(tx.id))
    if (selectedTxs.length !== 2) return null
    const buyTx = selectedTxs.find(tx => tx.type === 'buy')
    const sellTx = selectedTxs.find(tx => tx.type === 'sell')
    if (!buyTx || !sellTx) return null

    const buyAmount = buyTx.shares * buyTx.price
    const sellAmount = sellTx.shares * sellTx.price
    const priceDiff = sellTx.price - buyTx.price
    const minShares = Math.min(buyTx.shares, sellTx.shares)
    const profit = priceDiff * minShares

    // 判断方向：先买后卖 or 先卖后买
    const buyFirst = buyTx.date <= sellTx.date

    return {
      buyTx, sellTx, buyAmount, sellAmount, priceDiff, minShares, profit, buyFirst,
      amountDiff: sellAmount - buyAmount,
    }
  }

  const pairProfit = getPairProfit()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/funds')} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div className="flex items-center gap-3 flex-1">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-lg font-bold" style={{ backgroundColor: fund.color }}>
            {fund.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{fund.name}</h1>
            <p className="text-sm text-gray-500">
              {positions.length} 个资产 &middot; {transactions.length} 条交易
            </p>
          </div>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm({ ...emptyForm, fund_id: fundId }) }}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          添加交易
        </button>
      </div>

      {/* Fund Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">总市值</div>
          <div className="text-xl font-bold text-gray-900">{fmt(totalValue)}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">总成本</div>
          <div className="text-xl font-bold text-gray-900">{fmt(totalCost)}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">盈亏</div>
          <div className={`text-xl font-bold ${totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {totalGain >= 0 ? '+' : ''}{fmt(totalGain)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">收益率</div>
          <div className={`text-xl font-bold ${totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {pct(totalCost > 0 ? (totalGain / totalCost) * 100 : 0)}
          </div>
        </div>
      </div>

      {/* Strategy Model */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-orange-50 text-orange-600 flex items-center justify-center">
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">策略模型</h3>
              <p className="text-xs text-gray-400">
                止盈 {stopProfit}% / 止损 {stopLoss}%
                {mNav > 0 && <> &middot; 当前净值 {fmt(mNav)}</>}
              </p>
            </div>
          </div>
          <button
            onClick={() => { setEditingStrategy(!editingStrategy); setStrategyForm({ stop_profit_pct: stopProfit, stop_loss_pct: stopLoss, market_nav: mNav }) }}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            {editingStrategy ? '取消' : '设置'}
          </button>
        </div>

        {/* Settings form */}
        {editingStrategy && (
          <div className="px-5 py-4 bg-gray-50 border-b border-gray-100">
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">止盈线 (%)</label>
                <input type="number" step="0.1" value={strategyForm.stop_profit_pct} onChange={e => setStrategyForm({ ...strategyForm, stop_profit_pct: Number(e.target.value) })}
                  className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">止损线 (%)</label>
                <input type="number" step="0.1" value={strategyForm.stop_loss_pct} onChange={e => setStrategyForm({ ...strategyForm, stop_loss_pct: Number(e.target.value) })}
                  className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">当前市场净值</label>
                <input type="number" step="0.0001" value={strategyForm.market_nav || ''} onChange={e => setStrategyForm({ ...strategyForm, market_nav: Number(e.target.value) })}
                  className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none" placeholder="0.0000" />
              </div>
              <button onClick={handleSaveStrategy} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors">
                保存
              </button>
            </div>
          </div>
        )}

        {/* Scenario table */}
        {mNav > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2.5 text-left font-medium">明日涨跌</th>
                  <th className="px-4 py-2.5 text-right font-medium">预估净值</th>
                  <th className="px-4 py-2.5 text-right font-medium">预估市值</th>
                  <th className="px-4 py-2.5 text-right font-medium">预估盈亏</th>
                  <th className="px-4 py-2.5 text-right font-medium">收益率</th>
                  <th className="px-4 py-2.5 text-left font-medium">建议操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {scenarios.map(s => (
                  <tr key={s.changePct} className={`hover:bg-gray-50 ${s.changePct === 0 ? 'bg-blue-50/30' : ''}`}>
                    <td className={`px-4 py-2.5 font-medium ${s.changePct > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {s.changePct > 0 ? '+' : ''}{s.changePct}%
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{s.newNav.toFixed(4)}</td>
                    <td className="px-4 py-2.5 text-right">{fmt(s.newValue)}</td>
                    <td className={`px-4 py-2.5 text-right font-medium ${s.newGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {s.newGain >= 0 ? '+' : ''}{fmt(s.newGain)}
                    </td>
                    <td className={`px-4 py-2.5 text-right ${s.newGainPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {pct(s.newGainPct)}
                    </td>
                    <td className={`px-4 py-2.5 font-medium ${s.actionColor}`}>{s.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
              持仓均价 {fmt(costNav)} &middot; 当前净值 {fmt(mNav)} &middot; 持有 {fmtNum(holdingShares, 2)} 份
            </div>
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            请先设置当前市场净值，才能生成策略建议
          </div>
        )}
      </div>

      {/* AI Advice */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">AI 操作建议</h3>
              <p className="text-xs text-gray-400">基于持仓数据，分析涨跌情况下的操作策略</p>
            </div>
          </div>
          <button
            onClick={fetchAdvice}
            disabled={adviceLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 disabled:opacity-50 transition-colors"
          >
            {adviceLoading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                分析中...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                {advice ? '重新分析' : '获取建议'}
              </>
            )}
          </button>
        </div>

        {showAdvice && (
          <div className="px-5 py-4">
            {adviceLoading && !advice && (
              <div className="flex items-center justify-center py-8 text-gray-400 text-sm">
                <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                AI 正在分析持仓数据，请稍候...
              </div>
            )}
            {adviceError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
                {adviceError}
              </div>
            )}
            {advice && (
              <div>
                <div className="prose prose-sm max-w-none text-gray-700 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-gray-900 [&_h3]:mt-4 [&_h3]:mb-2 [&_ul]:ml-4 [&_li]:mb-1 [&_strong]:text-gray-900">
                  {advice.advice.split('\n').map((line, i) => {
                    if (line.startsWith('### ')) {
                      return <h3 key={i}>{line.replace('### ', '')}</h3>
                    }
                    if (line.startsWith('- ')) {
                      return <li key={i} className="list-disc ml-4">{renderBold(line.slice(2))}</li>
                    }
                    if (line.startsWith('**') && line.endsWith('**')) {
                      return <p key={i} className="font-semibold text-gray-900 mt-2">{line.replace(/\*\*/g, '')}</p>
                    }
                    if (line.trim() === '') return <br key={i} />
                    return <p key={i} className="mb-1">{renderBold(line)}</p>
                  })}
                </div>
                <div className="mt-4 pt-3 border-t border-gray-100 text-xs text-gray-400">
                  生成时间：{new Date(advice.generated_at).toLocaleString('zh-CN')} &middot; 仅供参考，不构成投资建议
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transaction Form */}
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
              <label className="block text-sm font-medium text-gray-700 mb-1.5">日期</label>
              <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">类型</label>
              <div className="flex gap-1.5">
                {(['buy', 'sell', 'dividend'] as const).map(t => {
                  const cfg = typeConfig[t]
                  return (
                    <button key={t} type="button" onClick={() => setForm({ ...form, type: t })}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        form.type === t ? `${cfg.bg} ${cfg.text} ${cfg.border}` : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                      }`}
                    >{cfg.icon} {cfg.label}</button>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">资产 / 代码</label>
              <input value={form.asset} onChange={e => setForm({ ...form, asset: e.target.value.toUpperCase() })} placeholder="例如 VTI" className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" required />
            </div>
            {form.type !== 'dividend' ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">份额</label>
                  <input type="number" step="any" value={form.shares || ''} onChange={e => setForm({ ...form, shares: Number(e.target.value) })} placeholder="0" className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">单价</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-400 text-sm">¥</span>
                    <input type="number" step="any" value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="0.00" className="w-full border border-gray-300 rounded-lg pl-7 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                  </div>
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">金额</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-gray-400 text-sm">¥</span>
                  <input type="number" step="any" value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="0.00" className="w-full border border-gray-300 rounded-lg pl-7 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
                </div>
              </div>
            )}
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">备注（可选）</label>
              <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="添加备注..." className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-sm transition-colors">
              {editId ? '更新' : '添加'}交易
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditId(null) }} className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors">
              取消
            </button>
          </div>
        </form>
      )}

      {/* Action Bar */}
      {selected.size >= 1 && selSummary && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 sticky top-20 z-40 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-blue-900">
                已选择 {selSummary.count} 条交易
                {selSummary.assets.length > 1 && (
                  <span className="ml-1.5 text-xs font-normal text-blue-600">
                    （跨 {selSummary.assets.length} 个资产：{selSummary.assets.join('、')}）
                  </span>
                )}
              </div>
              {selSummary.count >= 2 && selSummary.isMergeable && (
                <div className="text-xs text-blue-700 mt-1">
                  可合并为：<strong className="font-mono">{selSummary.asset}</strong>
                  {selSummary.type !== 'dividend' && (
                    <> &middot; {fmtNum(selSummary.totalShares, 2)} 份 @ {fmt(selSummary.avgPrice)}/份</>
                  )}
                  {' '}&middot; 总计 {fmt(selSummary.totalAmount)}
                </div>
              )}
              {selSummary.count >= 2 && !selSummary.isMergeable && (
                <div className="text-xs text-gray-500 mt-1">
                  合并需要同一资产且同一类型 &middot; 总金额 {fmt(selSummary.totalAmount)}
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setSelected(new Set())}
                className="px-3 py-1.5 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => setShowBatchDeleteConfirm(true)}
                className="px-3 py-1.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
              >
                批量删除
              </button>
              {selSummary.count >= 2 && (
                <button
                  onClick={handleMerge}
                  disabled={!canMerge() || merging}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {merging ? '合并中...' : '合并'}
                </button>
              )}
            </div>
          </div>

          {/* Buy-Sell Pair Profit */}
          {pairProfit && (
            <div className="mt-3 pt-3 border-t border-blue-200">
              <div className="text-sm font-medium text-blue-900 mb-2">买卖配对盈亏计算</div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <div className="text-gray-500 mb-1">{pairProfit.buyFirst ? '买入' : '买回'}（{formatDate(pairProfit.buyTx.date)}）</div>
                  <div className="font-medium text-gray-900">{pairProfit.buyTx.shares} 份 @ {fmt(pairProfit.buyTx.price)}</div>
                  <div className="text-gray-500 mt-0.5">金额 {fmt(pairProfit.buyAmount)}</div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <div className="text-gray-500 mb-1">{pairProfit.buyFirst ? '卖出' : '先卖'}（{formatDate(pairProfit.sellTx.date)}）</div>
                  <div className="font-medium text-gray-900">{pairProfit.sellTx.shares} 份 @ {fmt(pairProfit.sellTx.price)}</div>
                  <div className="text-gray-500 mt-0.5">金额 {fmt(pairProfit.sellAmount)}</div>
                </div>
              </div>
              <div className="mt-3 bg-white rounded-lg p-3 border border-blue-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">
                    {pairProfit.buyFirst
                      ? `卖出盈亏（按 ${fmtNum(pairProfit.minShares, 2)} 份计）`
                      : `买回差价（按 ${fmtNum(pairProfit.minShares, 2)} 份计）`
                    }
                  </span>
                  <span className={`text-base font-bold ${pairProfit.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {pairProfit.profit >= 0 ? '+' : ''}{fmt(pairProfit.profit)}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-gray-400">净值差</span>
                  <span className={`text-xs font-medium ${pairProfit.priceDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {pairProfit.priceDiff >= 0 ? '+' : ''}{pairProfit.priceDiff.toFixed(4)}/份
                  </span>
                </div>
                {Math.abs(pairProfit.buyTx.shares - pairProfit.sellTx.shares) > 0.01 && (
                  <div className="mt-1 text-xs text-amber-600">
                    份额不等（差 {Math.abs(pairProfit.buyTx.shares - pairProfit.sellTx.shares).toFixed(2)} 份），配对后多余部分保留为独立交易
                  </div>
                )}
              </div>
              <button
                onClick={handlePair}
                disabled={pairing}
                className="mt-3 w-full py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {pairing ? '配对中...' : `确认配对（${fmtNum(pairProfit.minShares, 2)} 份）`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Trades (paired buy-sell) */}
      {trades.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              已配对交易
              <span className={`ml-2 text-base font-bold ${totalTradeProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {totalTradeProfit >= 0 ? '+' : ''}{fmt(totalTradeProfit)}
              </span>
            </h2>
            <span className="text-xs text-gray-400">{trades.length} 笔配对</span>
          </div>
          {trades.map(t => {
            const isExp = expandedTrades.has(t.id)
            const buyAmount = t.paired_shares * t.buy_price
            const sellAmount = t.paired_shares * t.sell_price
            return (
              <div key={t.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div
                  onClick={() => toggleTrade(t.id)}
                  className="p-4 cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <svg className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isExp ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-mono font-bold text-gray-900">{t.asset}</span>
                    <span className="text-xs text-gray-400">{fmtNum(t.paired_shares, 2)} 份</span>
                    <span className="text-xs text-gray-400">{formatDate(t.buy_date)} → {formatDate(t.sell_date)}</span>
                    <div className="flex-1" />
                    <span className={`text-base font-bold ${t.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {t.profit >= 0 ? '+' : ''}{fmt(t.profit)}
                    </span>
                  </div>
                </div>
                {isExp && (
                  <div className="border-t border-gray-100 px-5 py-3 bg-gray-50/50 space-y-2">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-white rounded-lg p-3 border border-gray-100">
                        <div className="text-emerald-600 font-medium mb-1">买入</div>
                        <div>{formatDate(t.buy_date)}</div>
                        <div className="font-medium text-gray-900 mt-0.5">{fmtNum(t.paired_shares, 2)} 份 @ {fmt(t.buy_price)}</div>
                        <div className="text-gray-500">金额 {fmt(buyAmount)}</div>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-gray-100">
                        <div className="text-red-600 font-medium mb-1">卖出</div>
                        <div>{formatDate(t.sell_date)}</div>
                        <div className="font-medium text-gray-900 mt-0.5">{fmtNum(t.paired_shares, 2)} 份 @ {fmt(t.sell_price)}</div>
                        <div className="text-gray-500">金额 {fmt(sellAmount)}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs pt-1">
                      <span className="text-gray-400">
                        净值差 {(t.sell_price - t.buy_price) >= 0 ? '+' : ''}{(t.sell_price - t.buy_price).toFixed(4)}/份
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnpair(t.id) }}
                        className="px-2.5 py-1 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                      >
                        取消配对
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Positions */}
      {positions.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无持仓</h3>
          <p className="text-gray-500 text-sm">添加第一条交易记录开始追踪此基金。</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">持仓明细</h2>
            <div className="flex gap-2">
              <button onClick={expandAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">全部展开</button>
              <span className="text-gray-300">|</span>
              <button onClick={collapseAll} className="text-xs text-blue-600 hover:text-blue-800 font-medium">全部折叠</button>
            </div>
          </div>
          {positions.map(pos => {
            const isExpanded = expandedAssets.has(pos.asset)
            const assetTxs = txByAsset[pos.asset] || []
            const allSelected = assetTxs.length > 0 && assetTxs.every(tx => selected.has(tx.id))

            return (
              <div key={pos.asset} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                {/* Position Header - clickable */}
                <div
                  onClick={() => toggleAsset(pos.asset)}
                  className="p-5 cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    {/* Expand arrow */}
                    <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>

                    {/* Asset info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3">
                        <span className="text-lg font-bold font-mono text-gray-900">{pos.asset}</span>
                        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                          {pos.tx_count} 笔
                        </span>
                        {!isExpanded && assetTxs.filter(tx => selected.has(tx.id)).length > 0 && (
                          <span className="text-xs text-blue-600 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                            已选 {assetTxs.filter(tx => selected.has(tx.id)).length}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stats grid */}
                    <div className="hidden sm:grid sm:grid-cols-4 gap-6 text-right">
                      <div>
                        <div className="text-xs text-gray-400 tracking-wide">持有份额</div>
                        <div className="text-sm font-semibold text-gray-900 mt-0.5">{fmtNum(pos.holding_shares, 2)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-400 tracking-wide">单位净值</div>
                        <div className="text-sm font-semibold text-gray-900 mt-0.5">{fmt(pos.nav)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-400 tracking-wide">总成本</div>
                        <div className="text-sm font-semibold text-gray-900 mt-0.5">{fmt(pos.total_cost)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-400 tracking-wide">盈亏</div>
                        <div className={`text-sm font-semibold mt-0.5 ${pos.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {pos.gain >= 0 ? '+' : ''}{fmt(pos.gain)} ({pct(pos.gain_pct)})
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Mobile stats */}
                  <div className="sm:hidden grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-gray-100">
                    <div>
                      <span className="text-xs text-gray-400">持有份额</span>
                      <div className="text-sm font-semibold">{fmtNum(pos.holding_shares, 2)}</div>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">单位净值</span>
                      <div className="text-sm font-semibold">{fmt(pos.nav)}</div>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">总成本</span>
                      <div className="text-sm font-semibold">{fmt(pos.total_cost)}</div>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">盈亏</span>
                      <div className={`text-sm font-semibold ${pos.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pos.gain >= 0 ? '+' : ''}{fmt(pos.gain)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Expanded: Transaction List */}
                {isExpanded && (
                  <div className="border-t border-gray-200">
                    {/* Select all bar */}
                    <div className="px-5 py-2.5 bg-gray-50 flex items-center gap-3 border-b border-gray-100">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => selectAllForAsset(pos.asset)}
                          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs font-medium text-gray-500">全选</span>
                      </label>
                      <span className="text-xs text-gray-400">
                        {assetTxs.filter(tx => selected.has(tx.id)).length > 0 && (
                          <>本组 {assetTxs.filter(tx => selected.has(tx.id)).length}/{assetTxs.length}</>
                        )}
                        {selected.size > 0 && assetTxs.filter(tx => selected.has(tx.id)).length > 0 && selected.size > assetTxs.filter(tx => selected.has(tx.id)).length && (
                          <> &middot; 全部已选 {selected.size}</>
                        )}
                      </span>
                    </div>

                    {/* Transaction rows */}
                    {assetTxs.map(tx => {
                      const cfg = typeConfig[tx.type]
                      const total = tx.type === 'dividend' ? tx.price : tx.shares * tx.price
                      const isSelected = selected.has(tx.id)

                      return (
                        <div key={tx.id} className={`px-5 py-3 flex items-center gap-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors ${isSelected ? 'bg-blue-50/50' : ''}`}>
                          {/* Checkbox */}
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(tx.id)}
                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                          />

                          {/* Type badge */}
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.text} ${cfg.border} shrink-0`}>
                            {cfg.icon} {cfg.label}
                          </span>

                          {/* Date & details */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-gray-900">{formatDate(tx.date)}</div>
                            <div className="text-xs text-gray-500">
                              {tx.type !== 'dividend'
                                ? <>{tx.shares} 份 @ {fmt(tx.price)}</>
                                : <>分红</>
                              }
                              {tx.notes && <span className="ml-2 text-gray-400">&middot; {tx.notes}</span>}
                            </div>
                          </div>

                          {/* Amount */}
                          <div className={`text-sm font-semibold shrink-0 ${tx.type === 'sell' ? 'text-red-600' : 'text-gray-900'}`}>
                            {tx.type === 'sell' ? '-' : ''}{fmt(total)}
                          </div>

                          {/* Actions */}
                          <div className="flex gap-1 shrink-0">
                            <button onClick={(e) => { e.stopPropagation(); openSplit(tx) }} className="p-1.5 rounded-md text-gray-400 hover:text-purple-600 hover:bg-purple-50 transition-colors" title="拆分">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); startEdit(tx) }} className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteId(tx.id) }} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="删除">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
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

      <ConfirmDialog
        open={showBatchDeleteConfirm}
        title="批量删除交易"
        message={`确定要删除选中的 ${selected.size} 条交易记录吗？此操作不可撤销。`}
        confirmText={batchDeleting ? '删除中...' : `删除 ${selected.size} 条`}
        onConfirm={handleBatchDelete}
        onCancel={() => setShowBatchDeleteConfirm(false)}
      />

      {/* Split Dialog */}
      {splitTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSplitTx(null)}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">拆分交易</h3>
            <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${typeConfig[splitTx.type].bg} ${typeConfig[splitTx.type].text} ${typeConfig[splitTx.type].border}`}>
                  {typeConfig[splitTx.type].label}
                </span>
                <span className="font-mono font-medium">{splitTx.asset}</span>
                <span className="text-gray-400">{formatDate(splitTx.date)}</span>
              </div>
              <div className="mt-1.5">
                {splitTx.type === 'dividend'
                  ? <>金额：{fmt(splitTx.price)}</>
                  : <>{splitTx.shares} 份 @ {fmt(splitTx.price)} = {fmt(splitTx.shares * splitTx.price)}</>
                }
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                拆出{splitTx.type === 'dividend' ? '金额' : '份额'}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  step="any"
                  value={splitShares || ''}
                  onChange={e => setSplitShares(Number(e.target.value))}
                  className="flex-1 border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="0"
                  max={splitTx.type === 'dividend' ? splitTx.price : splitTx.shares}
                />
                <span className="text-sm text-gray-400">
                  / {splitTx.type === 'dividend' ? fmt(splitTx.price) : `${splitTx.shares} 份`}
                </span>
              </div>
              {splitShares > 0 && splitTx.type !== 'dividend' && (
                <div className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg p-2.5">
                  拆分后：<strong>{splitShares} 份</strong>（{fmt(splitShares * splitTx.price)}）+ <strong>{Math.round((splitTx.shares - splitShares) * 10000) / 10000} 份</strong>（{fmt((splitTx.shares - splitShares) * splitTx.price)}）
                </div>
              )}
              {splitShares > 0 && splitTx.type === 'dividend' && (
                <div className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg p-2.5">
                  拆分后：<strong>{fmt(splitShares)}</strong> + <strong>{fmt(splitTx.price - splitShares)}</strong>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setSplitTx(null)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                取消
              </button>
              <button
                onClick={handleSplit}
                disabled={splitting || splitShares <= 0 || splitShares >= (splitTx.type === 'dividend' ? splitTx.price : splitTx.shares)}
                className="px-4 py-2 text-sm text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {splitting ? '拆分中...' : '确认拆分'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
