import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { api } from '../api'
import type { FundDetail as FundDetailType, Position, Transaction, AiAdvice, Trade, StrategyResult, DailySnapshot, ForecastResult } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNav(n: number) {
  return '¥' + n.toFixed(4)
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

const emptyForm = { fund_id: 0, date: '', type: 'buy' as const, asset: '', shares: 0, price: 0, notes: '', inputMode: 'amount' as 'shares' | 'amount', inputValue: 0 }

function CostImpactPanel({ transactions, txDates, holdingShares, totalCost, costNav, snapshots }: {
  transactions: Transaction[]; txDates: string[]; holdingShares: number; totalCost: number; costNav: number; snapshots: DailySnapshot[]
}) {
  const [selectedDate, setSelectedDate] = useState(txDates[0] || '')

  const dateTxs = transactions.filter(t => t.date === selectedDate)
  if (dateTxs.length === 0) return null

  // 从当前持仓反推选中日期交易前的状态
  // 需要撤销"选中日期及之后"的所有交易
  const laterTxs = transactions.filter(t => t.date >= selectedDate).sort((a, b) => b.id - a.id)
  let preAllShares = holdingShares, preAllCost = totalCost
  for (const tx of laterTxs) {
    if (tx.type === 'buy') { preAllShares -= tx.shares; preAllCost -= tx.shares * tx.price }
    else if (tx.type === 'sell') { preAllShares += tx.shares; preAllCost += tx.shares * tx.price }
    else if (tx.type === 'dividend') { preAllCost += tx.price }
  }
  // preAll 现在是选中日期之前的状态，再加回选中日期之前的交易
  // 实际上只需要撤销选中日期当天的交易
  const onlyDateTxs = transactions.filter(t => t.date === selectedDate)
  // 加回选中日期之后（不含当天）的交易，得到"选中日期交易前"的状态
  const afterDateTxs = transactions.filter(t => t.date > selectedDate).sort((a, b) => a.id - b.id)
  let preDateShares = preAllShares, preDateCost = preAllCost
  for (const tx of afterDateTxs) {
    if (tx.type === 'buy') { preDateShares += tx.shares; preDateCost += tx.shares * tx.price }
    else if (tx.type === 'sell') { preDateShares -= tx.shares; preDateCost -= tx.shares * tx.price }
    else if (tx.type === 'dividend') { preDateCost -= tx.price }
  }

  const preDateCostNav = preDateShares > 0 ? preDateCost / preDateShares : 0

  // 逐笔模拟
  type TxImpact = { tx: Transaction; costNavBefore: number; costNavAfter: number; costNavDelta: number; sharesAfter: number; costAfter: number }
  const impacts: TxImpact[] = []
  let runShares = preDateShares, runCost = preDateCost
  for (const tx of onlyDateTxs.sort((a, b) => a.id - b.id)) {
    const costNavBefore = runShares > 0 ? runCost / runShares : 0
    if (tx.type === 'buy') { runShares += tx.shares; runCost += tx.shares * tx.price }
    else if (tx.type === 'sell') { runShares -= tx.shares; runCost -= tx.shares * tx.price }
    else if (tx.type === 'dividend') { runCost -= tx.price }
    const costNavAfter = runShares > 0 ? runCost / runShares : 0
    impacts.push({ tx, costNavBefore, costNavAfter, costNavDelta: costNavAfter - costNavBefore, sharesAfter: runShares, costAfter: runCost })
  }

  const postDateCostNav = runShares > 0 ? runCost / runShares : 0
  const totalChange = postDateCostNav - preDateCostNav
  const totalChangePct = preDateCostNav > 0 ? (totalChange / preDateCostNav) * 100 : 0

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">交易成本影响分析</h3>
            <p className="text-xs text-gray-400">
              {onlyDateTxs.length} 笔交易，成本净值
              <span className={`font-bold ml-1 ${totalChange < -0.00005 ? 'text-emerald-600' : totalChange > 0.00005 ? 'text-red-600' : 'text-gray-500'}`}>
                {totalChange < -0.00005 ? '降低' : totalChange > 0.00005 ? '上升' : '不变'}
                {Math.abs(totalChange) >= 0.00005 && ` ${Math.abs(totalChange).toFixed(4)} (${totalChangePct >= 0 ? '+' : ''}${totalChangePct.toFixed(2)}%)`}
              </span>
            </p>
          </div>
        </div>
        {/* 日期选择 */}
        <div className="flex items-center gap-1.5">
          {txDates.slice(0, 5).map(d => (
            <button key={d} onClick={() => setSelectedDate(d)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                selectedDate === d ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {d.slice(5)}
            </button>
          ))}
          {txDates.length > 5 && (
            <select value={txDates.slice(0, 5).includes(selectedDate) ? '' : selectedDate}
              onChange={e => e.target.value && setSelectedDate(e.target.value)}
              className="text-xs border border-gray-300 rounded-lg px-1.5 py-1 bg-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">更多...</option>
              {txDates.slice(5).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* 交易前后对比 */}
      <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg">
        <div className="text-center flex-1">
          <div className="text-[11px] text-gray-400">交易前</div>
          <div className="text-lg font-bold text-gray-700 font-mono">{preDateCostNav > 0 ? preDateCostNav.toFixed(4) : '-'}</div>
          <div className="text-[11px] text-gray-400">{preDateShares.toFixed(2)}份 · ¥{preDateCost.toFixed(2)}</div>
        </div>
        <div className="shrink-0">
          <div className={`w-16 text-center py-1.5 rounded-lg text-sm font-bold ${
            totalChange < -0.00005 ? 'bg-emerald-100 text-emerald-700' :
            totalChange > 0.00005 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
          }`}>
            {totalChange < -0.00005 ? '↓' : totalChange > 0.00005 ? '↑' : '→'}
            {Math.abs(totalChange) >= 0.00005 ? Math.abs(totalChange).toFixed(4) : '0'}
          </div>
        </div>
        <div className="text-center flex-1">
          <div className="text-[11px] text-gray-400">交易后</div>
          <div className="text-lg font-bold text-gray-900 font-mono">{postDateCostNav > 0 ? postDateCostNav.toFixed(4) : '-'}</div>
          <div className="text-[11px] text-gray-400">{runShares.toFixed(2)}份 · ¥{runCost.toFixed(2)}</div>
        </div>
      </div>

      {/* 逐笔影响明细 */}
      <div className="space-y-2">
        {impacts.map((imp, i) => {
          const txAmt = imp.tx.type === 'dividend' ? imp.tx.price : imp.tx.shares * imp.tx.price
          const cfg = typeConfig[imp.tx.type]
          const dotColor = cfg.bg === 'bg-emerald-50' ? 'bg-emerald-500' : cfg.bg === 'bg-red-50' ? 'bg-red-500' : 'bg-amber-500'
          return (
            <div key={i} className="flex items-center gap-3 p-2.5 bg-gray-50/70 rounded-lg text-sm">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
              <div className="flex-1 min-w-0">
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>
                <span className="text-xs text-gray-600 ml-1.5">
                  {imp.tx.type !== 'dividend'
                    ? <>{imp.tx.shares.toFixed(2)}份 @ ¥{imp.tx.price.toFixed(4)} = ¥{txAmt.toFixed(2)}</>
                    : <>¥{txAmt.toFixed(2)}</>
                  }
                </span>
              </div>
              <div className="shrink-0 text-right">
                {Math.abs(imp.costNavDelta) >= 0.00005 ? (
                  <span className={`text-xs font-bold font-mono ${imp.costNavDelta < 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {imp.costNavDelta < 0 ? '↓' : '↑'}{Math.abs(imp.costNavDelta).toFixed(4)}
                  </span>
                ) : (
                  <span className="text-xs text-gray-400">-</span>
                )}
              </div>
              <div className="shrink-0 w-20 text-right">
                <span className="text-xs text-gray-500 font-mono">{imp.costNavAfter.toFixed(4)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function FundDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const fundId = Number(id)

  const [data, setData] = useState<FundDetailType | null>(null)
  const [expandedAssets] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [merging, setMerging] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [research, setResearch] = useState<any>(null)
  const [researchLoading, setResearchLoading] = useState(false)
  const [researchError, setResearchError] = useState('')
  const [splitTx, setSplitTx] = useState<Transaction | null>(null)
  const [splitShares, setSplitShares] = useState<number>(0)
  const [splitting, setSplitting] = useState(false)
  const [trades, setTrades] = useState<Trade[]>([])
  const [expandedTrades, setExpandedTrades] = useState<Set<number>>(new Set())
  const [pairing, setPairing] = useState(false)
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustForm, setAdjustForm] = useState({ shares: 0, nav: 0 })
  const [adjustMode, setAdjustMode] = useState<'transaction' | 'fix_base' | 'gain'>('transaction')
  const [gainForm, setGainForm] = useState(0)
  const [navLoading, setNavLoading] = useState(false)
  const [navHint, setNavHint] = useState('')
  const [quickNav, setQuickNav] = useState('')
  const [quickLoading, setQuickLoading] = useState(false)
  const [latestNavInfo, setLatestNavInfo] = useState<{ nav: number; prevNav: number; date: string; estimatedNav: number | null; estimateTime: string | null } | null>(null)
  const [swingResult, setSwingResult] = useState<any>(null)
  const [decision, setDecision] = useState<any>(null)
  const [modelList, setModelList] = useState<{ id: string; label: string; description: string }[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [forecast, setForecast] = useState<ForecastResult | null>(null)
  const [forecastLoading, setForecastLoading] = useState(false)
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([])
  const [editingBase, setEditingBase] = useState(false)
  const [baseForm, setBaseForm] = useState(30)

  const load = () => {
    api.getFundDetail(fundId).then(d => {
      setData(d)
      setForm(f => ({ ...f, fund_id: fundId }))
      // 自动获取实时估值并填入快捷净值
      if (d.fund.code) {
        api.getLatestNav(d.fund.code).then(nav => {
          setLatestNavInfo({ nav: nav.nav, prevNav: (nav as any).prev_nav || 0, date: nav.date, estimatedNav: nav.estimated_nav, estimateTime: nav.estimate_time })
          if (nav.estimated_nav && nav.estimated_nav > 0) {
            setQuickNav(nav.estimated_nav.toFixed(4))
          }
        }).catch(() => {})
      }
    })
    api.getTrades(fundId).then(setTrades)
    api.getSnapshots(fundId, 90).then(setSnapshots).catch(() => {})
    setForecastLoading(true)
    api.getForecast(fundId).then(setForecast).catch(() => {}).finally(() => setForecastLoading(false))
  }
  useEffect(() => { load() }, [fundId])
  useEffect(() => {
    api.getModels().then(r => { setModelList(r.models); if (!selectedModel) setSelectedModel(r.default) }).catch(() => {})
  }, [])

  const fetchQuickAdvice = async () => {
    const nav = parseFloat(quickNav)
    if (!nav || nav <= 0) return
    setQuickLoading(true)
    try {
      const [swing, dec] = await Promise.all([
        api.getSwingAdvice(fundId, nav),
        api.getDecision(fundId, nav, selectedModel || undefined),
      ])
      setSwingResult(swing)
      setDecision(dec)
    } catch { /* ignore */ }
    finally { setQuickLoading(false) }
  }

  const fetchResearch = async () => {
    setResearchLoading(true)
    setResearchError('')
    try {
      const result = await api.getFundResearch(fundId)
      setResearch(result)
    } catch (err: any) {
      setResearchError(err.message)
    } finally {
      setResearchLoading(false)
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
    if (!pairInfo) return
    setPairing(true)
    try {
      await api.createTrade(pairInfo.buyIds, pairInfo.sellIds)
      setSelected(new Set())
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setPairing(false)
    }
  }

  const handleAdjust = async () => {
    try {
      if (adjustMode === 'gain') {
        await api.updateFundGain(fundId, gainForm)
      } else {
        await api.adjustHolding(fundId, adjustForm.shares, adjustForm.nav, adjustMode)
      }
      setShowAdjust(false)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  // 检查是否有历史持仓记录（用于判断是否可用 fix_base 模式）
  const hasBase = transactions.some(t => t.notes?.includes('历史持仓'))

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

  const autoFetchNav = async (date: string) => {
    if (!fund.code || !date) { setNavHint(''); return }
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!form.date) {
      setError('请填写日期。')
      return
    }
    const asset = fund.name

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
      const payload = { fund_id: fundId, date: form.date, type: form.type, asset, shares: submitShares, price: submitPrice, notes: form.notes }
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
    setForm({ fund_id: fundId, date: tx.date, type: tx.type, asset: tx.asset, shares: tx.shares, price: tx.price, notes: tx.notes || '', inputMode: 'shares', inputValue: tx.type === 'dividend' ? tx.price : tx.shares })
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

  const holdingShares = positions.reduce((s, p) => s + p.holding_shares, 0)
  const stopProfit = fund.stop_profit_pct || 20
  const stopLoss = fund.stop_loss_pct || 15
  const mNav = fund.market_nav || 0
  const costNav = holdingShares > 0 ? totalCost / holdingShares : 0

  // --- Buy-sell pair profit (multi) ---
  const getPairInfo = () => {
    if (selected.size < 2) return null
    const selectedTxs = transactions.filter(tx => selected.has(tx.id))
    const buys = selectedTxs.filter(tx => tx.type === 'buy')
    const sells = selectedTxs.filter(tx => tx.type === 'sell')
    if (buys.length === 0 || sells.length === 0) return null

    let totalBuyShares = 0, totalBuyCost = 0
    for (const tx of buys) { totalBuyShares += tx.shares; totalBuyCost += tx.shares * tx.price }
    const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0

    let totalSellShares = 0, totalSellRevenue = 0
    for (const tx of sells) { totalSellShares += tx.shares; totalSellRevenue += tx.shares * tx.price }
    const avgSellPrice = totalSellShares > 0 ? totalSellRevenue / totalSellShares : 0

    const pairedShares = Math.min(totalBuyShares, totalSellShares)
    const profit = (avgSellPrice - avgBuyPrice) * pairedShares
    const priceDiff = avgSellPrice - avgBuyPrice
    const remainder = Math.abs(totalBuyShares - totalSellShares)

    return {
      buys, sells, totalBuyShares, totalBuyCost, avgBuyPrice,
      totalSellShares, totalSellRevenue, avgSellPrice,
      pairedShares, profit, priceDiff, remainder,
      buyIds: buys.map(t => t.id), sellIds: sells.map(t => t.id),
    }
  }

  const pairInfo = getPairInfo()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 sm:gap-4">
          <button onClick={() => navigate('/funds')} className="p-1.5 sm:p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-white text-base sm:text-lg font-bold shrink-0" style={{ backgroundColor: fund.color }}>
              {fund.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 sm:gap-3">
                <h1 className="text-lg sm:text-2xl font-bold text-gray-900 truncate">{fund.name}</h1>
                {fund.code && <span className="text-xs sm:text-sm text-gray-400 shrink-0">{fund.code}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 mt-0.5 sm:mt-1 text-xs sm:text-sm">
                <span className="text-gray-500">
                  <span className="font-semibold text-gray-700">{holdingShares.toFixed(2)}</span> 份
                </span>
                <span className="text-gray-300 hidden sm:inline">|</span>
                {latestNavInfo ? (
                  <span className="text-gray-500">
                    <span className="hidden sm:inline">净值 </span><span className="font-semibold text-gray-700 font-mono">{latestNavInfo.nav.toFixed(4)}</span>
                    <span className="text-gray-400 ml-1 hidden sm:inline">({latestNavInfo.date})</span>
                    {latestNavInfo.estimatedNav && latestNavInfo.estimatedNav > 0 && (
                      <>
                        <span className="text-gray-300 mx-1">→</span>
                        <span className="font-mono font-semibold text-indigo-600">估 {latestNavInfo.estimatedNav.toFixed(4)}</span>
                        {latestNavInfo.estimateTime && <span className="text-gray-400 ml-1 text-[11px] hidden sm:inline">{latestNavInfo.estimateTime}</span>}
                      </>
                    )}
                  </span>
                ) : mNav > 0 ? (
                  <span className="text-gray-500">净值 <span className="font-semibold text-gray-700 font-mono">{mNav.toFixed(4)}</span></span>
                ) : null}
                <span className="text-gray-400 text-[11px] hidden sm:inline">止盈{stopProfit}% / 止损{stopLoss}%</span>
              </div>
            </div>
          </div>
        </div>
        {/* Action buttons - separate row on mobile */}
        <div className="flex items-center gap-2 overflow-x-auto pl-0 sm:pl-0">
          {/* 底仓设置 */}
          <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg shrink-0">
            <svg className="w-3.5 h-3.5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            <span className="text-xs text-amber-700 font-medium">底仓</span>
            <select
              value={fund.base_position_pct ?? 30}
              onChange={async (e) => {
                await api.updateFund(fundId, { base_position_pct: Number(e.target.value) })
                load()
              }}
              className="text-xs font-bold text-amber-800 bg-transparent border-none outline-none cursor-pointer py-0.5"
            >
              {[0, 10, 20, 30, 40, 50, 60, 70, 80].map(v => (
                <option key={v} value={v}>{v}%</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => { setShowAdjust(true); setAdjustMode('gain'); setGainForm(Math.round(totalGain * 100) / 100); setAdjustForm({ shares: holdingShares, nav: costNav }) }}
            className="inline-flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-2 sm:py-2.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 text-xs sm:text-sm font-medium transition-colors shrink-0"
          >
            <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            调整持仓
          </button>
          <button
            onClick={() => { setShowForm(true); setEditId(null); setForm({ ...emptyForm, fund_id: fundId }) }}
            className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs sm:text-sm font-medium shadow-sm transition-colors shrink-0"
          >
            <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            添加交易
          </button>
        </div>
      </div>

      {/* Fund Summary Cards */}
      {(() => {
        // 当日收益计算
        // prevNav = 估值接口的dwjz，始终是上一交易日官方净值（最可靠的基准）
        // 今日净值已出(officialIsToday) → 用官方净值；否则用估值
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const prevNavVal = latestNavInfo?.prevNav || 0;
        const officialIsToday = latestNavInfo?.date === todayStr;
        const officialNav = latestNavInfo?.nav || 0;
        const estNav = latestNavInfo?.estimatedNav && latestNavInfo.estimatedNav > 0 ? latestNavInfo.estimatedNav : 0;

        // 今日净值已出 → 用官方净值，不再看估值；否则用估值
        const currentNav = officialIsToday ? officialNav : estNav;
        const isEstimate = !officialIsToday && estNav > 0;

        // 日初持仓 = 当前持仓 + 今日卖出 - 今日买入
        let todayBought = 0, todaySold = 0;
        for (const tx of transactions) {
          if (tx.date === todayStr) {
            if (tx.type === 'buy') todayBought += tx.shares;
            else if (tx.type === 'sell') todaySold += tx.shares;
          }
        }
        const startOfDayShares = holdingShares + todaySold - todayBought;

        let dailyGain: number | null = null;
        let dailyPct: number | null = null;
        if (startOfDayShares > 0 && currentNav > 0 && prevNavVal > 0) {
          dailyGain = startOfDayShares * (currentNav - prevNavVal);
          dailyPct = ((currentNav - prevNavVal) / prevNavVal) * 100;
        }
        return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-4">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4">
          <div className="text-[11px] sm:text-xs text-gray-400 uppercase tracking-wide mb-1">总市值</div>
          <div className="text-base sm:text-xl font-bold text-gray-900">{fmt(totalValue)}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4">
          <div className="text-[11px] sm:text-xs text-gray-400 uppercase tracking-wide mb-1">总成本</div>
          <div className="text-base sm:text-xl font-bold text-gray-900">{fmt(totalCost)}</div>
        </div>
        <div className={`rounded-xl border shadow-sm p-4 ${
          mNav > 0 && costNav > 0
            ? mNav >= costNav ? 'bg-emerald-50/50 border-emerald-200' : 'bg-red-50/50 border-red-200'
            : 'bg-white border-gray-200'
        }`}>
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">成本净值</div>
          <div className="text-xl font-bold text-gray-900 font-mono">{costNav > 0 ? costNav.toFixed(4) : '-'}</div>
          {mNav > 0 && costNav > 0 && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-[11px] text-gray-400">市场 {mNav.toFixed(4)}</span>
              <span className={`text-[11px] font-bold ${mNav >= costNav ? 'text-emerald-600' : 'text-red-600'}`}>
                {mNav >= costNav ? '盈' : '亏'}{Math.abs((mNav - costNav) / costNav * 100).toFixed(2)}%
              </span>
            </div>
          )}
          {/* 成本净值每日变化 */}
          {snapshots.length >= 2 && costNav > 0 && (() => {
            const prevCostNav = snapshots[snapshots.length - 2]?.cost_nav || 0
            const costChange = prevCostNav > 0 ? costNav - prevCostNav : 0
            const costChangePct = prevCostNav > 0 ? (costChange / prevCostNav) * 100 : 0
            if (Math.abs(costChange) < 0.00005) return null
            return (
              <div className={`mt-1.5 pt-1.5 border-t ${costChange < 0 ? 'border-emerald-200' : 'border-red-200'}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-bold ${costChange < 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {costChange < 0 ? '↓' : '↑'}{Math.abs(costChange).toFixed(4)}
                  </span>
                  <span className={`text-[11px] font-medium ${costChange < 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    ({costChangePct >= 0 ? '+' : ''}{costChangePct.toFixed(2)}%)
                  </span>
                  <span className="text-[10px] text-gray-400">vs昨日</span>
                </div>
                <div className="text-[10px] text-gray-400">昨日 {prevCostNav.toFixed(4)}</div>
              </div>
            )
          })()}
        </div>
        <div className={`rounded-xl border shadow-sm p-4 ${
          dailyGain !== null
            ? dailyGain >= 0 ? 'bg-red-50/50 border-red-200' : 'bg-green-50/50 border-green-200'
            : 'bg-white border-gray-200'
        }`}>
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">当日收益</div>
          {dailyGain !== null ? (
            <>
              <div className={`text-xl font-bold ${dailyGain >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                {dailyGain >= 0 ? '+' : ''}{fmt(dailyGain)}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className={`text-[11px] font-bold ${dailyPct! >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {dailyPct! >= 0 ? '+' : ''}{dailyPct!.toFixed(2)}%
                </span>
                <span className="text-[11px] text-gray-400">
                  {isEstimate ? '估' : '官'}
                </span>
              </div>
            </>
          ) : (
            <div className="text-xl font-bold text-gray-400">-</div>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">累计盈亏</div>
          <div className={`text-xl font-bold ${totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {totalGain >= 0 ? '+' : ''}{fmt(totalGain)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">收益率</div>
          <div className={`text-xl font-bold ${totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {pct(totalCost > 0 ? (totalGain / totalCost) * 100 : 0)}
          </div>
        </div>
      </div>
        )
      })()}

      {/* 交易对成本净值的影响（支持选择日期） */}
      {(() => {
        // 找出所有有交易的日期（降序）
        const txDates = [...new Set(transactions.filter(t => t.type !== 'dividend' || true).map(t => t.date))].sort((a, b) => b.localeCompare(a))
        if (txDates.length === 0 || holdingShares <= 0) return null

        return <CostImpactPanel
          transactions={transactions}
          txDates={txDates}
          holdingShares={holdingShares}
          totalCost={totalCost}
          costNav={costNav}
          snapshots={snapshots}
        />
      })()}

      {/* 成本/收益趋势图 */}
      {snapshots.length >= 2 && (() => {
        // 计算每日成本净值变化
        const chartData = snapshots.map((s, i) => {
          const prevCost = i > 0 ? snapshots[i - 1].cost_nav : s.cost_nav
          const costChange = s.cost_nav - prevCost
          const costChangePct = prevCost > 0 ? (costChange / prevCost) * 100 : 0
          return {
            date: s.date.slice(5),
            fullDate: s.date,
            costNav: s.cost_nav,
            marketNav: s.market_nav,
            gainPct: s.gain_pct,
            gain: s.gain,
            costChange: i > 0 ? costChange : 0,
            costChangePct: i > 0 ? costChangePct : 0,
            totalCost: s.total_cost,
            holdingShares: s.holding_shares,
          }
        })
        // 统计：成本下降天数
        const downDays = chartData.filter(d => d.costChange < -0.00005).length
        const upDays = chartData.filter(d => d.costChange > 0.00005).length
        const totalCostDrop = chartData.reduce((s, d) => s + (d.costChange < 0 ? d.costChange : 0), 0)

        return (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" /></svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">成本 / 收益趋势</h3>
                  <p className="text-xs text-gray-400">
                    近{snapshots.length}天
                    {downDays > 0 && <span className="text-emerald-600 ml-1">降成本{downDays}天 累计{totalCostDrop.toFixed(4)}</span>}
                    {upDays > 0 && <span className="text-red-500 ml-1">升成本{upDays}天</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-500 inline-block rounded" /> 成本净值</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-500 inline-block rounded" /> 市场净值</span>
                <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-500 inline-block rounded" /> 收益率%</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="nav" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11 }} unit="%" domain={['auto', 'auto']} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null
                    const d = payload[0]?.payload
                    return (
                      <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs">
                        <div className="font-medium text-gray-700 mb-1.5">{label}</div>
                        <div className="space-y-1">
                          <div className="flex justify-between gap-4">
                            <span className="text-blue-600">成本净值</span>
                            <span className="font-mono font-bold">{d.costNav.toFixed(4)}</span>
                          </div>
                          {d.costChange !== 0 && (
                            <div className="flex justify-between gap-4">
                              <span className="text-gray-400">日变化</span>
                              <span className={`font-mono font-bold ${d.costChange < 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {d.costChange < 0 ? '↓' : '↑'}{Math.abs(d.costChange).toFixed(4)} ({d.costChangePct >= 0 ? '+' : ''}{d.costChangePct.toFixed(2)}%)
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between gap-4">
                            <span className="text-amber-600">市场净值</span>
                            <span className="font-mono">{d.marketNav.toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-emerald-600">收益率</span>
                            <span className={`font-mono font-bold ${d.gainPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{d.gainPct >= 0 ? '+' : ''}{d.gainPct.toFixed(2)}%</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-gray-400">盈亏</span>
                            <span className={`font-mono ${d.gain >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{d.gain >= 0 ? '+' : ''}{d.gain.toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                />
                <ReferenceLine yAxisId="pct" y={0} stroke="#9ca3af" strokeDasharray="3 3" />
                <Line yAxisId="nav" type="monotone" dataKey="costNav" stroke="#3b82f6" strokeWidth={2.5}
                  dot={(props: any) => {
                    const d = chartData[props.index]
                    if (!d || Math.abs(d.costChange) < 0.00005) return <circle key={props.index} cx={0} cy={0} r={0} />
                    return <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill={d.costChange < 0 ? '#10b981' : '#ef4444'} stroke="white" strokeWidth={1.5} />
                  }}
                />
                <Line yAxisId="nav" type="monotone" dataKey="marketNav" stroke="#f59e0b" strokeWidth={2} dot={false} />
                <Line yAxisId="pct" type="monotone" dataKey="gainPct" stroke="#10b981" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>

            {/* 成本净值每日变化明细表 */}
            <div className="mt-4 pt-3 border-t border-gray-100">
              <div className="text-xs font-medium text-gray-500 mb-2">成本净值每日变化</div>
              <div className="flex flex-wrap gap-1.5">
                {chartData.slice(1).reverse().map((d, i) => {
                  if (Math.abs(d.costChange) < 0.00005) return (
                    <span key={i} className="px-2 py-1 rounded-md bg-gray-50 text-[11px] text-gray-400 font-mono">
                      {d.date} 无变化
                    </span>
                  )
                  return (
                    <span key={i} className={`px-2 py-1 rounded-md text-[11px] font-mono font-medium ${d.costChange < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                      {d.date} {d.costChange < 0 ? '↓' : '↑'}{Math.abs(d.costChange).toFixed(4)}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* 技术面参考（弱化展示，默认折叠） */}
      <details className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <summary className="p-3 sm:p-5 cursor-pointer select-none">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center">
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-500">技术面参考</h3>
              <p className="text-xs text-gray-400">基于技术指标的信号汇总 · 准确率约65% · 仅供参考不构成投资建议</p>
            </div>
          {forecastLoading && <span className="text-xs text-gray-400 animate-pulse ml-auto">分析中...</span>}
        </div>

        {forecast?.prediction ? (
          <div className="space-y-4">
            {/* 预测结果 */}
            <div className={`rounded-xl p-4 ${
              forecast.prediction.direction === 'up' ? 'bg-red-50 border border-red-200' :
              forecast.prediction.direction === 'down' ? 'bg-green-50 border border-green-200' :
              'bg-gray-50 border border-gray-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg font-black ${
                    forecast.prediction.direction === 'up' ? 'bg-red-500 text-white' :
                    forecast.prediction.direction === 'down' ? 'bg-green-500 text-white' :
                    'bg-gray-300 text-white'
                  }`}>
                    {forecast.prediction.direction === 'up' ? '涨' : forecast.prediction.direction === 'down' ? '跌' : '平'}
                  </div>
                  <div>
                    <div className={`text-lg font-bold ${
                      forecast.prediction.direction === 'up' ? 'text-red-700' :
                      forecast.prediction.direction === 'down' ? 'text-green-700' :
                      'text-gray-700'
                    }`}>
                      预测{forecast.prediction.direction === 'up' ? '上涨' : forecast.prediction.direction === 'down' ? '下跌' : '震荡'}
                      <span className="ml-1.5 font-mono">{forecast.prediction.predictedChangePct >= 0 ? '+' : ''}{forecast.prediction.predictedChangePct.toFixed(2)}%</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      预测净值 <span className="font-mono font-medium">{forecast.prediction.predictedNav.toFixed(4)}</span>
                      <span className="mx-1.5 text-gray-300">|</span>
                      区间 {forecast.prediction.navRange.low.toFixed(4)} ~ {forecast.prediction.navRange.high.toFixed(4)}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">信心度</div>
                  <div className="text-xl font-bold text-gray-700">{forecast.prediction.confidence}%</div>
                </div>
              </div>
            </div>

            {/* 投资策略 */}
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                  forecast.strategy.action === 'buy' ? 'bg-emerald-100 text-emerald-700' :
                  forecast.strategy.action === 'sell' ? 'bg-red-100 text-red-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {forecast.strategy.action === 'buy' ? '买入' : forecast.strategy.action === 'sell' ? '卖出' : '持有'}
                </span>
                {forecast.strategy.amount > 0 && (
                  <span className="text-sm font-medium text-blue-800">{forecast.strategy.shares}份 · ¥{forecast.strategy.amount}</span>
                )}
              </div>
              <div className="space-y-1">
                {forecast.strategy.strategies.map((s, i) => (
                  <div key={i} className="text-xs text-blue-800 leading-relaxed">• {s}</div>
                ))}
              </div>
            </div>

            {/* 因子分解 */}
            <div>
              <div className="text-xs text-gray-400 mb-2">预测因子分解</div>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-1.5 sm:gap-2">
                {Object.entries(forecast.factors).map(([key, f]) => (
                  <div key={key} className="text-center p-2 rounded-lg bg-gray-50">
                    <div className="text-[10px] text-gray-400 mb-0.5">{f.label}</div>
                    <div className={`text-sm font-bold font-mono ${f.value > 0 ? 'text-red-600' : f.value < 0 ? 'text-green-600' : 'text-gray-500'}`}>
                      {f.value > 0 ? '+' : ''}{f.value.toFixed(3)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 近20日统计 + 预测理由 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-400 mb-1.5">近20日统计</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <div><span className="text-red-600 font-medium">{forecast.stats.recent20.upDays}涨</span> / <span className="text-green-600 font-medium">{forecast.stats.recent20.downDays}跌</span></div>
                  <div>日均涨 <span className="text-red-600 font-mono">+{forecast.stats.recent20.avgUp.toFixed(2)}%</span></div>
                  <div>日均跌 <span className="text-green-600 font-mono">{forecast.stats.recent20.avgDown.toFixed(2)}%</span></div>
                  <div>波动率 <span className="font-mono">{forecast.stats.volatility.toFixed(1)}%</span></div>
                </div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-400 mb-1.5">预测依据</div>
                <div className="space-y-0.5 max-h-24 overflow-y-auto">
                  {forecast.reasoning.map((r, i) => (
                    <div key={i} className="text-[11px] text-gray-600 leading-relaxed">{r}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : forecast?.message ? (
          <div className="text-sm text-gray-400 py-4 text-center">{forecast.message}</div>
        ) : !forecastLoading ? (
          <div className="text-sm text-gray-400 py-4 text-center">暂无预测数据</div>
        ) : null}
        </div>
      </details>

      {/* 实时净值快速决策 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">综合决策</h3>
            <p className="text-xs text-gray-400">输入实时净值 → 技术面+基本面+消息面综合分析 → 具体买卖份额</p>
          </div>
        </div>
        <div className="flex flex-wrap sm:flex-nowrap gap-2 items-end">
          <div className="flex-1 min-w-[120px]">
            <div className="relative">
              <span className="absolute left-3 top-2 text-gray-400 text-sm">¥</span>
              <input
                type="number" step="0.0001" value={quickNav}
                onChange={e => setQuickNav(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') fetchQuickAdvice() }}
                placeholder={mNav > 0 ? `当前净值 ${mNav.toFixed(4)}` : '输入实时净值'}
                className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>
          {modelList.length > 1 && (
            <select value={selectedModel} onChange={e => {
              setSelectedModel(e.target.value)
              // 切换模型后自动重新获取决策
              const nav = parseFloat(quickNav)
              if (nav > 0) {
                setQuickLoading(true)
                Promise.all([
                  api.getSwingAdvice(fundId, nav),
                  api.getDecision(fundId, nav, e.target.value),
                ]).then(([swing, dec]) => { setSwingResult(swing); setDecision(dec) })
                .catch(() => {}).finally(() => setQuickLoading(false))
              }
            }}
              className="px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
              {modelList.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          )}
          <button onClick={fetchQuickAdvice} disabled={quickLoading || !quickNav}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium transition-colors">
            {quickLoading ? '分析中...' : '分析'}
          </button>
        </div>

        {/* === 统一决策卡片 === */}
        {decision && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            {/* 大操作指示 */}
            <div className={`rounded-xl p-4 mb-4 ${
              decision.action === 'buy' ? 'bg-emerald-50 border border-emerald-200' :
              decision.action === 'sell' ? 'bg-red-50 border border-red-200' :
              'bg-gray-50 border border-gray-200'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl font-black ${
                    decision.action === 'buy' ? 'bg-emerald-500 text-white' :
                    decision.action === 'sell' ? 'bg-red-500 text-white' :
                    'bg-gray-300 text-white'
                  }`}>
                    {decision.action === 'buy' ? '买' : decision.action === 'sell' ? '卖' : '持'}
                  </div>
                  {decision.modelVersion && (
                    <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs font-medium">
                      {decision.modelVersion.label || decision.modelVersion.decision}
                    </span>
                  )}
                  <div>
                    <div className={`text-lg font-bold ${
                      decision.action === 'buy' ? 'text-emerald-800' :
                      decision.action === 'sell' ? 'text-red-800' :
                      'text-gray-800'
                    }`}>
                      {decision.action === 'buy' ? `买入 ${decision.shares} 份` :
                       decision.action === 'sell' ? `卖出 ${decision.shares} 份` :
                       '持有观望'}
                    </div>
                    {decision.amount > 0 && (
                      <div className="text-sm text-gray-600">
                        {decision.action === 'buy' ? '投入' : '回收'} {fmt(decision.amount)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-black ${
                    decision.compositeScore >= 20 ? 'text-emerald-600' :
                    decision.compositeScore <= -20 ? 'text-red-600' :
                    'text-amber-600'
                  }`}>{decision.compositeScore > 0 ? '+' : ''}{decision.compositeScore}</div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">综合评分</div>
                </div>
              </div>

              {/* 完整循环计划 - 核心降成本逻辑 */}
              {decision.cycle && (
                <div className="mt-3 pt-3 border-t border-dashed" style={{ borderColor: decision.action === 'buy' ? '#a7f3d0' : '#fecaca' }}>
                  <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">完整循环（高卖低买 = 真降成本）</div>
                  <div className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center sm:gap-2">
                    {/* Step 1 */}
                    <div className={`rounded-lg p-2 text-center sm:flex-1 ${decision.action === 'sell' ? 'bg-red-100/80 ring-2 ring-red-300' : 'bg-emerald-100/80 ring-2 ring-emerald-300'}`}>
                      <div className="text-[9px] sm:text-[10px] text-gray-500 mb-0.5">现在 · {decision.cycle.step1.action}</div>
                      <div className="text-xs sm:text-sm font-bold font-mono">{decision.cycle.step1.nav.toFixed(4)}</div>
                      <div className="text-[9px] sm:text-[10px] text-gray-600">{decision.cycle.step1.shares}份</div>
                    </div>
                    {/* Step 2 */}
                    <div className={`rounded-lg p-2 text-center sm:flex-1 border-2 border-dashed ${decision.action === 'sell' ? 'border-emerald-300 bg-emerald-50/50' : 'border-red-300 bg-red-50/50'}`}>
                      <div className="text-[9px] sm:text-[10px] text-gray-500 mb-0.5">目标 · {decision.cycle.step2.action}</div>
                      <div className="text-xs sm:text-sm font-bold font-mono">{decision.cycle.step2.nav.toFixed(4)}</div>
                      <div className="text-[9px] sm:text-[10px] text-gray-600">{decision.cycle.step2.shares}份</div>
                    </div>
                    {/* Result */}
                    <div className="rounded-lg p-2 text-center sm:flex-1 bg-emerald-50 border border-emerald-200">
                      <div className="text-[9px] sm:text-[10px] text-emerald-600 mb-0.5">循环完成</div>
                      <div className="text-xs sm:text-sm font-black text-emerald-700">降 {decision.cycle.cycleCostDrop.toFixed(4)}</div>
                      <div className="text-[9px] sm:text-[10px] text-emerald-600">利润 ¥{decision.cycle.cycleProfit}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* 单步影响（买入时的直接成本变化） */}
              {decision.action === 'buy' && decision.impact.costChange !== 0 && (
                <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-gray-100">
                  <div className="text-center">
                    <div className="text-[10px] text-gray-500">买入后份额</div>
                    <div className="text-sm font-bold text-gray-800">{decision.impact.newShares}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-gray-500">买入后成本</div>
                    <div className="text-sm font-bold font-mono text-gray-800">{decision.impact.newCostNav.toFixed(4)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-gray-500">直接降幅</div>
                    <div className={`text-sm font-bold ${decision.impact.costChange > 0 ? 'text-emerald-600' : 'text-gray-500'}`}>
                      {decision.impact.costChange > 0 ? `降${decision.impact.costChange.toFixed(4)}` : '不变'}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 大师策略指标 */}
            {decision.masterSignals && (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">
                <div className="bg-white rounded-lg border border-gray-200 p-2 text-center">
                  <div className="text-[10px] text-gray-400">恐惧/贪婪</div>
                  <div className={`text-lg font-black ${decision.masterSignals.fearGreed < 30 ? 'text-emerald-600' : decision.masterSignals.fearGreed > 70 ? 'text-red-600' : 'text-amber-600'}`}>
                    {decision.masterSignals.fearGreed}
                  </div>
                  <div className="text-[9px] text-gray-400">{decision.masterSignals.fearGreed < 30 ? '恐惧=机会' : decision.masterSignals.fearGreed > 70 ? '贪婪=风险' : '中性'}</div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-2 text-center">
                  <div className="text-[10px] text-gray-400">周期定位</div>
                  <div className="text-sm font-bold text-gray-800">{decision.masterSignals.cycleLabel}</div>
                  <div className="text-[9px] text-gray-400">Howard Marks</div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-2 text-center">
                  <div className="text-[10px] text-gray-400">信念强度</div>
                  <div className={`text-lg font-black ${decision.masterSignals.conviction > 1.3 ? 'text-emerald-600' : decision.masterSignals.conviction < 0.8 ? 'text-amber-600' : 'text-gray-700'}`}>
                    {decision.masterSignals.conviction}x
                  </div>
                  <div className="text-[9px] text-gray-400">{decision.masterSignals.conviction >= 1.6 ? '三维共振' : decision.masterSignals.conviction >= 1.3 ? '单维强信号' : decision.masterSignals.conviction < 0.8 ? '信号分歧' : '一般'}</div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-2 text-center">
                  <div className="text-[10px] text-gray-400">价值乘数</div>
                  <div className={`text-lg font-black ${decision.masterSignals.valueMultiplier > 1.5 ? 'text-emerald-600' : 'text-gray-700'}`}>
                    {decision.masterSignals.valueMultiplier}x
                  </div>
                  <div className="text-[9px] text-gray-400">Graham安全边际</div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-2 text-center">
                  <div className="text-[10px] text-gray-400">动态止盈</div>
                  <div className="text-lg font-black text-gray-700">
                    {decision.masterSignals.dynamicTakeProfit}%
                  </div>
                  <div className="text-[9px] text-gray-400">ATR自适应</div>
                </div>
              </div>
            )}

            {/* 三维评分条 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 mb-4">
              {[
                { label: '技术面(60%)', score: decision.dimensions.technical.score, color: 'blue', detail: `RSI ${decision.dimensions.technical.rsi.toFixed(0)} · ${decision.dimensions.technical.trend === 'strong_up' ? '强势' : decision.dimensions.technical.trend === 'up' ? '偏多' : decision.dimensions.technical.trend === 'down' ? '偏空' : decision.dimensions.technical.trend === 'strong_down' ? '弱势' : '震荡'}` },
                { label: '基本面(20%)', score: decision.dimensions.fundamental.score, color: 'purple', detail: decision.dimensions.fundamental.highlights[0] || '数据正常' },
                { label: '消息面(20%)', score: decision.dimensions.news.score, color: 'amber', detail: decision.dimensions.news.sentiment },
              ].map(d => (
                <div key={d.label} className="bg-white rounded-lg border border-gray-200 p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-gray-600">{d.label}</span>
                    <span className={`text-sm font-bold ${d.score >= 20 ? 'text-emerald-600' : d.score <= -20 ? 'text-red-600' : 'text-amber-600'}`}>
                      {d.score > 0 ? '+' : ''}{d.score}
                    </span>
                  </div>
                  {/* 分数条 */}
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-1.5">
                    <div className={`h-full rounded-full transition-all ${d.score >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
                      style={{ width: `${Math.min(Math.abs(d.score) + 50, 100)}%`, marginLeft: d.score < 0 ? `${50 + d.score / 2}%` : '50%', maxWidth: `${Math.abs(d.score / 2)}%` }} />
                  </div>
                  <div className="text-[10px] text-gray-400 truncate">{d.detail}</div>
                </div>
              ))}
            </div>

            {/* ====== 详细决策报告 ====== */}
            <div className="space-y-3">

              {/* 持仓概况 */}
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">当前持仓</div>
                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div><div className="text-gray-400">总份额</div><div className="font-bold text-gray-800">{decision.position.holdingShares}</div></div>
                  <div><div className="text-gray-400">成本净值</div><div className="font-bold text-gray-800 font-mono">{decision.position.costNav.toFixed(4)}</div></div>
                  <div><div className="text-gray-400">盈亏</div><div className={`font-bold ${decision.position.gainPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{decision.position.gainPct >= 0 ? '+' : ''}{decision.position.gainPct.toFixed(2)}%</div></div>
                  <div><div className="text-gray-400">底仓</div><div className="font-bold text-amber-700">{decision.position.baseShares}份</div></div>
                  <div><div className="text-gray-400">活仓</div><div className="font-bold text-blue-700">{decision.position.swingShares}份</div></div>
                  <div><div className="text-gray-400">市值</div><div className="font-bold text-gray-800">{fmt(decision.position.marketValue)}</div></div>
                </div>
              </div>

              {/* 决策依据（主要理由） */}
              <div className="bg-white rounded-lg border border-gray-200 p-3">
                <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">决策依据</div>
                <div className="space-y-1.5">
                  {decision.reasoning.map((r: string, i: number) => {
                    // 根据前缀标记颜色
                    const isMaster = r.startsWith('[');
                    const tag = isMaster ? r.match(/^\[([^\]]+)\]/)?.[1] || '' : '';
                    const content = isMaster ? r.replace(/^\[[^\]]+\]\s*/, '') : r;
                    const tagColor = tag.includes('Buffett') || tag.includes('Graham') ? 'bg-blue-100 text-blue-700'
                      : tag.includes('Soros') || tag.includes('止损') || tag.includes('熔断') ? 'bg-red-100 text-red-700'
                      : tag.includes('Marks') || tag.includes('确认') ? 'bg-purple-100 text-purple-700'
                      : tag.includes('Lynch') ? 'bg-green-100 text-green-700'
                      : tag.includes('Livermore') ? 'bg-amber-100 text-amber-700'
                      : tag.includes('风控') || tag.includes('赎回') || tag.includes('警告') || tag.includes('减速') ? 'bg-orange-100 text-orange-700'
                      : tag.includes('动态') || tag.includes('网格') ? 'bg-cyan-100 text-cyan-700'
                      : 'bg-gray-100 text-gray-600';
                    return (
                      <div key={i} className="text-xs text-gray-700 flex items-start gap-2">
                        <span className={`shrink-0 mt-0.5 ${i === 0 ? 'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white' : 'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white'} ${
                          i === 0 ? (decision.action === 'buy' ? 'bg-emerald-500' : decision.action === 'sell' ? 'bg-red-500' : 'bg-gray-400') : 'bg-gray-300'
                        }`}>{i + 1}</span>
                        <div className="flex-1">
                          {tag && <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold mr-1.5 ${tagColor}`}>{tag}</span>}
                          <span>{content}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 技术面信号详情 */}
              {decision.dimensions.technical.signals.length > 0 && (
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">技术面信号（权重60%）</div>
                  <div className="space-y-1">
                    {decision.dimensions.technical.signals.map((s: string, i: number) => (
                      <div key={i} className="text-[11px] text-gray-600 flex items-start gap-1.5">
                        <span className={`shrink-0 mt-1 w-1.5 h-1.5 rounded-full ${
                          s.includes('买') || s.includes('超卖') || s.includes('支撑') || s.includes('多') ? 'bg-emerald-400' :
                          s.includes('卖') || s.includes('超买') || s.includes('阻力') || s.includes('空') ? 'bg-red-400' :
                          'bg-amber-400'
                        }`} />
                        <span>{s}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 基本面 + 消息面摘要 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">基本面（权重20%）</div>
                  <div className={`text-sm font-bold mb-1 ${decision.dimensions.fundamental.score >= 20 ? 'text-emerald-600' : decision.dimensions.fundamental.score <= -20 ? 'text-red-600' : 'text-amber-600'}`}>
                    {decision.dimensions.fundamental.score > 0 ? '+' : ''}{decision.dimensions.fundamental.score}分
                  </div>
                  {decision.dimensions.fundamental.highlights.map((h: string, i: number) => (
                    <div key={i} className="text-[10px] text-gray-500 leading-relaxed">• {h}</div>
                  ))}
                  {decision.dimensions.fundamental.highlights.length === 0 && <div className="text-[10px] text-gray-400">数据正常</div>}
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-3">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">消息面（权重20%）</div>
                  <div className={`text-sm font-bold mb-1 ${decision.dimensions.news.score > 20 ? 'text-emerald-600' : decision.dimensions.news.score < -20 ? 'text-red-600' : 'text-amber-600'}`}>
                    {decision.dimensions.news.sentiment} {decision.dimensions.news.score > 0 ? '+' : ''}{decision.dimensions.news.score}分
                  </div>
                  {decision.dimensions.news.bullish?.slice(0, 2).map((n: string, i: number) => (
                    <div key={`b${i}`} className="text-[10px] text-emerald-600 leading-relaxed truncate">📈 {n.slice(0, 35)}</div>
                  ))}
                  {decision.dimensions.news.bearish?.slice(0, 2).map((n: string, i: number) => (
                    <div key={`r${i}`} className="text-[10px] text-red-600 leading-relaxed truncate">📉 {n.slice(0, 35)}</div>
                  ))}
                  {!decision.dimensions.news.bullish?.length && !decision.dimensions.news.bearish?.length && <div className="text-[10px] text-gray-400">无明显多空信号</div>}
                </div>
              </div>

              {/* 风险提示 */}
              {decision.riskWarnings && (
                <div className="bg-red-50/50 rounded-lg border border-red-100 p-3">
                  <div className="text-[10px] font-semibold text-red-400 uppercase tracking-wide mb-2">风险提示</div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    {decision.riskWarnings.worstCaseLoss > 0 && (
                      <div><span className="text-gray-400">最坏损失</span><div className="font-bold text-red-600">{fmt(decision.riskWarnings.worstCaseLoss)}</div></div>
                    )}
                    <div><span className="text-gray-400">赎回费率</span><div className="font-bold text-gray-700">{decision.riskWarnings.redeemFeeRate}%</div></div>
                    <div><span className="text-gray-400">持有天数</span><div className={`font-bold ${decision.riskWarnings.daysSinceLastBuy < 7 ? 'text-red-600' : 'text-gray-700'}`}>{decision.riskWarnings.daysSinceLastBuy}天{decision.riskWarnings.daysSinceLastBuy < 7 ? '（惩罚期）' : ''}</div></div>
                    <div><span className="text-gray-400">组合亏损</span><div className={`font-bold ${decision.riskWarnings.totalLossPct > 15 ? 'text-red-600' : 'text-gray-700'}`}>{decision.riskWarnings.totalLossPct}%{decision.riskWarnings.circuitBreaker ? '（已熔断）' : ''}</div></div>
                  </div>
                  {decision.riskWarnings.redeemFeeLevels?.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">查看赎回费率阶梯</summary>
                      <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
                        {decision.riskWarnings.redeemFeeLevels.map((l: any, i: number) => (
                          <div key={i} className={`flex justify-between px-2 py-0.5 rounded ${decision.riskWarnings.daysSinceLastBuy >= l.minDays && decision.riskWarnings.daysSinceLastBuy <= l.maxDays ? 'bg-amber-100 font-bold' : ''}`}>
                            <span className="text-gray-500">{l.label}</span>
                            <span className="text-gray-700">{l.feeRate}%</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* 底部汇总 */}
              <div className="flex items-center justify-between text-[10px] text-gray-400 px-1">
                <span>置信度 {decision.confidence}% · 紧急度 {decision.urgency === 'high' ? '高' : decision.urgency === 'medium' ? '中' : '低'}</span>
                <span>评分 {decision.compositeScore > 0 ? '+' : ''}{decision.compositeScore} · 技术60%+基本面20%+消息面20%</span>
              </div>
            </div>
          </div>
        )}

        {swingResult && (
          <div className={`${decision ? 'mt-3 pt-3 border-t border-gray-100' : 'mt-4 pt-4 border-t border-gray-100'}`}>
            {/* 净值对比 */}
            <div className="text-xs text-gray-500 mb-3">
              实时净值 <strong className="text-gray-900">{fmtNav(swingResult.nav)}</strong>
              {mNav > 0 && (
                <> &middot; vs 收盘 {fmtNav(mNav)}
                  <span className={`ml-1 font-medium ${swingResult.nav >= mNav ? 'text-red-600' : 'text-green-600'}`}>
                    ({((swingResult.nav - mNav) / mNav * 100) >= 0 ? '+' : ''}{((swingResult.nav - mNav) / mNav * 100).toFixed(2)}%)
                  </span>
                </>
              )}
              &middot; 成本 {fmtNav(swingResult.costNav)}
              <span className={`ml-1 font-medium ${swingResult.nav >= swingResult.costNav ? 'text-red-600' : 'text-green-600'}`}>
                ({((swingResult.nav - swingResult.costNav) / swingResult.costNav * 100) >= 0 ? '+' : ''}{((swingResult.nav - swingResult.costNav) / swingResult.costNav * 100).toFixed(2)}%)
              </span>
            </div>

            {/* 底仓保护模块 */}
            {swingResult.basePosition && (() => {
              const bp = swingResult.basePosition
              const baseValue = bp.shares * swingResult.nav
              const sellableValue = bp.maxSellable * swingResult.nav
              // 编辑态的实时预览
              const previewShares = editingBase ? Math.round(swingResult.holdingShares * baseForm / 100 * 10000) / 10000 : bp.shares
              const previewValue = previewShares * swingResult.nav
              const previewSellable = Math.round((swingResult.holdingShares - previewShares) * 10000) / 10000
              const previewSellableValue = previewSellable * swingResult.nav
              return (
                <div className="mb-3 bg-amber-50 rounded-lg p-3 border border-amber-200/60">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                      底仓保护
                    </div>
                    {!editingBase ? (
                      <button
                        onClick={() => { setEditingBase(true); setBaseForm(bp.pct) }}
                        className="text-[11px] text-amber-600 hover:text-amber-800 font-medium"
                      >调整</button>
                    ) : (
                      <div className="flex gap-1.5">
                        <button
                          onClick={async () => {
                            await api.updateFund(fundId, { base_position_pct: baseForm })
                            setEditingBase(false)
                            load()
                            // 重新获取波段建议
                            const nav = parseFloat(quickNav)
                            if (nav > 0) {
                              const swing = await api.getSwingAdvice(fundId, nav)
                              setSwingResult(swing)
                            }
                          }}
                          className="px-2 py-0.5 text-[11px] text-white bg-amber-600 rounded hover:bg-amber-700 font-medium"
                        >保存</button>
                        <button
                          onClick={() => setEditingBase(false)}
                          className="px-2 py-0.5 text-[11px] text-amber-600 hover:text-amber-800 font-medium"
                        >取消</button>
                      </div>
                    )}
                  </div>

                  {/* 编辑态：滑块 + 快捷按钮 */}
                  {editingBase && (
                    <div className="mb-2.5 space-y-2">
                      <div className="flex items-center gap-3">
                        <input
                          type="range" min="0" max="100" step="5" value={baseForm}
                          onChange={e => setBaseForm(Number(e.target.value))}
                          className="flex-1 h-2 accent-amber-500"
                        />
                        <span className="text-sm font-bold text-amber-900 w-12 text-right">{baseForm}%</span>
                      </div>
                      <div className="flex gap-1.5">
                        {[0, 20, 30, 50, 70].map(v => (
                          <button key={v} onClick={() => setBaseForm(v)}
                            className={`flex-1 py-1 rounded text-[11px] font-medium transition-colors ${baseForm === v ? 'bg-amber-500 text-white' : 'bg-white/60 text-amber-700 hover:bg-white'}`}
                          >{v}%</button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div className="bg-white/60 rounded-md px-2 py-1.5">
                      <div className="text-[10px] text-amber-600">底仓锁定</div>
                      <div className="text-sm font-bold text-amber-900">{editingBase ? fmtNum(previewShares, 2) : bp.shares}<span className="text-[10px] font-normal">份</span></div>
                      <div className="text-[10px] text-amber-600">{fmt(editingBase ? previewValue : baseValue)}</div>
                    </div>
                    <div className="bg-white/60 rounded-md px-2 py-1.5">
                      <div className="text-[10px] text-amber-600">活仓可操作</div>
                      <div className="text-sm font-bold text-amber-900">{editingBase ? fmtNum(previewSellable, 2) : bp.maxSellable}<span className="text-[10px] font-normal">份</span></div>
                      <div className="text-[10px] text-amber-600">{fmt(editingBase ? previewSellableValue : sellableValue)}</div>
                    </div>
                    <div className="bg-white/60 rounded-md px-2 py-1.5">
                      <div className="text-[10px] text-amber-600">底仓成本</div>
                      <div className="text-sm font-bold text-amber-900">{bp.baseCostNav ? bp.baseCostNav.toFixed(4) : '-'}</div>
                      <div className="text-[10px] text-amber-600">占比 {editingBase ? baseForm : bp.pct}%</div>
                    </div>
                    <div className="bg-white/60 rounded-md px-2 py-1.5">
                      <div className="text-[10px] text-amber-600">执行后成本</div>
                      <div className={`text-sm font-bold ${bp.baseCostDrop > 0 ? 'text-emerald-700' : 'text-amber-900'}`}>{bp.newBaseCostNav ? bp.newBaseCostNav.toFixed(4) : '-'}</div>
                      {bp.baseCostDrop > 0 && <div className="text-[10px] text-emerald-600 font-medium">降 {bp.baseCostDrop.toFixed(4)}</div>}
                      {bp.baseCostDrop <= 0 && <div className="text-[10px] text-gray-400">无变化</div>}
                    </div>
                  </div>
                  {/* 底仓进度条 */}
                  <div className="mt-2 h-2 bg-amber-200/50 rounded-full overflow-hidden flex">
                    <div className="h-full bg-amber-500 rounded-l-full" style={{ width: `${editingBase ? baseForm : bp.pct}%` }} />
                    <div className="h-full bg-emerald-400" style={{ width: `${100 - (editingBase ? baseForm : bp.pct)}%` }} />
                  </div>
                  <div className="flex justify-between text-[10px] text-amber-500 mt-0.5">
                    <span>底仓 {editingBase ? baseForm : bp.pct}%</span>
                    <span>活仓 {100 - (editingBase ? baseForm : bp.pct)}%</span>
                  </div>
                </div>
              )
            })()}

            {swingResult.suggestions.length > 0 ? (
              <>
                <h4 className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-2">
                  活仓波段操作（{swingResult.suggestions.length}笔，利润补贴底仓降成本）
                </h4>
                <div className="space-y-2">
                  {swingResult.suggestions.map((s: any, i: number) => {
                    const opPct = s.shares > 0 ? Math.round(s.opShares / s.shares * 100) : 0
                    const isSell = s.direction === 'sell'
                    return (
                      <div key={i} className={`rounded-lg p-2.5 ${isSell ? 'bg-red-50/50' : 'bg-emerald-50/50'}`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-gray-500">
                            {s.date} {isSell ? '买入' : '卖出'} {s.shares}份 @ {s.refPrice.toFixed(4)}
                          </span>
                          <span className={`text-xs font-bold ${s.profit > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            预期利润 +{fmt(s.profit)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="flex-1 h-5 bg-gray-200 rounded-full overflow-hidden flex">
                            <div className={`h-full flex items-center justify-center text-[10px] text-white font-bold ${isSell ? 'bg-red-400' : 'bg-emerald-400'}`}
                              style={{ width: `${opPct}%` }}>
                              {opPct > 15 && `${isSell ? '卖' : '买'}${opPct}%`}
                            </div>
                            {s.keepShares > 0 && (
                              <div className="h-full bg-gray-300 flex items-center justify-center text-[10px] text-white font-bold"
                                style={{ width: `${100 - opPct}%` }}>
                                {(100 - opPct) > 15 && `${isSell ? '留' : '不买'}${100 - opPct}%`}
                              </div>
                            )}
                          </div>
                          <span className="text-xs font-mono text-gray-700 shrink-0">
                            {isSell ? `卖${s.opShares}/留${s.keepShares}` : `买${s.opShares}份`}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-500">{s.reason}</p>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2 bg-indigo-50 rounded-lg p-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-indigo-700 font-medium">全部执行后</span>
                    <span className="text-emerald-700 font-bold">总利润 {fmt(swingResult.impact.totalProfit)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-indigo-600">
                    {swingResult.impact.totalSellShares > 0 && <span>卖出 {swingResult.impact.totalSellShares}份（利润{fmt(swingResult.impact.sellProfit)}）</span>}
                    {swingResult.impact.totalBuyShares > 0 && <span>买回 {swingResult.impact.totalBuyShares}份（利润{fmt(swingResult.impact.buyProfit)}）</span>}
                    <span>持仓 {swingResult.impact.newHoldingShares}份</span>
                    <span>整体成本 {swingResult.impact.newCostNav.toFixed(4)}</span>
                    {swingResult.impact.costReduction > 0 && <span className="text-emerald-600">整体降 {swingResult.impact.costReduction.toFixed(4)}</span>}
                  </div>
                  {swingResult.basePosition?.baseCostDrop > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-indigo-200/60 flex items-center justify-between">
                      <span className="text-amber-700 font-medium">底仓成本变化</span>
                      <span className="text-emerald-700 font-bold">
                        {swingResult.basePosition.baseCostNav.toFixed(4)} → {swingResult.basePosition.newBaseCostNav.toFixed(4)}
                        <span className="ml-1.5 text-emerald-600">降 {swingResult.basePosition.baseCostDrop.toFixed(4)}</span>
                      </span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-center py-4 text-sm text-gray-400">
                {swingResult.unpairedBuys.length === 0 && swingResult.unpairedSells?.length === 0
                  ? '无历史交易记录'
                  : '当前净值下无差价操作机会'}
              </div>
            )}

            {/* 下跌补仓策略 */}
            {swingResult.dipStrategy?.enabled && (() => {
              const dip = swingResult.dipStrategy
              return (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <h4 className="text-xs font-semibold text-orange-600 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" /></svg>
                    下跌补仓策略（距成本 -{dip.dropFromCost.toFixed(1)}%）
                  </h4>
                  <p className="text-[11px] text-gray-500 mb-3">{dip.outlook}</p>

                  <div className="space-y-2">
                    {dip.levels.map((lv: any) => (
                      <div key={lv.level} className="rounded-lg bg-orange-50/60 p-2.5 border border-orange-100/80">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
                              lv.level <= 2 ? 'bg-orange-400' : lv.level <= 3 ? 'bg-orange-500' : 'bg-red-500'
                            }`}>{lv.level}</span>
                            <span className="text-xs font-medium text-gray-700">
                              {lv.dropPct === 0 ? '当前价位' : `跌${lv.dropPct.toFixed(1)}%`} · {fmtNav(lv.nav)}
                            </span>
                          </div>
                          <span className="text-xs font-bold text-orange-700">{fmt(lv.amount)}</span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-gray-500 mb-1.5">
                          <span>买入 {lv.shares.toFixed(2)} 份</span>
                          <span>新成本 {lv.newCostNav.toFixed(4)}</span>
                          {lv.costReduction > 0 && (
                            <span className="text-emerald-600 font-medium">降 {lv.costReduction.toFixed(4)}</span>
                          )}
                        </div>
                        {lv.rebounds.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {lv.rebounds.map((rb: any, j: number) => (
                              <span key={j} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-[10px] text-emerald-700 border border-emerald-100">
                                回弹至{rb.targetLabel}（{rb.targetNav.toFixed(4)}）→ 利润{fmt(rb.sellProfit)}
                                {rb.baseCostDrop > 0 && <span className="font-bold">底仓降{rb.baseCostDrop.toFixed(4)}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-[10px] text-gray-400 mt-1">{lv.reason}</p>
                      </div>
                    ))}
                  </div>

                  {/* 全部执行汇总 */}
                  <div className="mt-2 bg-orange-50 rounded-lg p-2.5 text-xs border border-orange-200/60">
                    <div className="flex items-center justify-between">
                      <span className="text-orange-700 font-medium">全部补仓后</span>
                      <span className="text-orange-800 font-bold">投入 {fmt(dip.totalPlan.totalAmount)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-orange-600">
                      <span>新成本 {dip.totalPlan.newCostNav.toFixed(4)}</span>
                      {dip.totalPlan.totalCostReduction > 0 && (
                        <span className="text-emerald-600 font-bold">成本降 {dip.totalPlan.totalCostReduction.toFixed(4)}</span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {/* 消息面 + 基本面研究 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center">
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" /></svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">消息面 + 基本面</h3>
              <p className="text-xs text-gray-400">自动获取行业新闻和基金基本面数据，AI综合分析</p>
            </div>
          </div>
          <button
            onClick={fetchResearch}
            disabled={researchLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-lg hover:bg-cyan-100 disabled:opacity-50 transition-colors"
          >
            {researchLoading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                获取中...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                {research ? '刷新' : '开始研究'}
              </>
            )}
          </button>
        </div>

        {researchError && (
          <div className="px-5 py-3">
            <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
              {researchError}
            </div>
          </div>
        )}

        {researchLoading && !research && (
          <div className="flex items-center justify-center py-8 text-gray-400 text-sm">
            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            正在获取基本面数据和行业新闻...
          </div>
        )}

        {research && (
          <div className="px-5 py-4 space-y-4">
            {/* 基本面概要 */}
            {research.fundamental && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">基本面</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {research.fundamental.manager && (
                    <div className="bg-gray-50 rounded-lg p-2.5">
                      <div className="text-[10px] text-gray-400">基金经理</div>
                      <div className="text-sm font-medium text-gray-900">{research.fundamental.manager}</div>
                      <div className="text-[10px] text-gray-500">
                        {research.fundamental.managerDays && `任职${research.fundamental.managerDays}`}
                        {research.fundamental.managerReturn && ` · 回报${research.fundamental.managerReturn}`}
                      </div>
                    </div>
                  )}
                  {research.fundamental.scale && (
                    <div className="bg-gray-50 rounded-lg p-2.5">
                      <div className="text-[10px] text-gray-400">基金规模</div>
                      <div className="text-sm font-medium text-gray-900">{research.fundamental.scale}</div>
                    </div>
                  )}
                  {research.fundamental.rate && (
                    <div className="bg-gray-50 rounded-lg p-2.5">
                      <div className="text-[10px] text-gray-400">申购费率</div>
                      <div className="text-sm font-medium text-gray-900">{research.fundamental.rate}</div>
                    </div>
                  )}
                  {research.fundamental.holderStructure && (
                    <div className="bg-gray-50 rounded-lg p-2.5">
                      <div className="text-[10px] text-gray-400">持有人结构</div>
                      <div className="text-[11px] font-medium text-gray-700">{research.fundamental.holderStructure}</div>
                    </div>
                  )}
                </div>
                {research.fundamental.performance && (
                  <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-400">业绩：</span>{research.fundamental.performance}
                  </div>
                )}
                {research.fundamental.assetAlloc && (
                  <div className="mt-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-400">资产配置：</span>{research.fundamental.assetAlloc}
                  </div>
                )}
                {research.fundamental.topHoldings && (
                  <div className="mt-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-400">重仓：</span>{research.fundamental.topHoldings}
                  </div>
                )}
              </div>
            )}

            {/* 行业新闻 */}
            {research.news?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  行业新闻 · {research.sectorKeyword}
                </h4>
                <div className="space-y-1.5">
                  {research.news.map((n: any, i: number) => (
                    <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 transition-colors group">
                      <span className="shrink-0 w-5 h-5 rounded bg-cyan-100 text-cyan-700 text-[10px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-gray-800 group-hover:text-cyan-700 line-clamp-2 transition-colors">{n.title}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">{n.date} · {n.source}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* AI 分析结论 */}
            {research.analysis && (
              <div className="border-t border-gray-100 pt-4">
                <h4 className="text-xs font-semibold text-cyan-600 uppercase tracking-wide mb-2">AI 综合分析</h4>
                <div className="prose prose-sm max-w-none text-gray-700 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-gray-900 [&_h3]:mt-3 [&_h3]:mb-1.5 [&_ul]:ml-4 [&_li]:mb-1 [&_strong]:text-gray-900">
                  {research.analysis.split('\n').map((line: string, i: number) => {
                    if (line.startsWith('### ')) return <h3 key={i}>{line.replace('### ', '')}</h3>
                    if (line.startsWith('- ')) return <li key={i} className="list-disc ml-4">{renderBold(line.slice(2))}</li>
                    if (line.trim() === '') return <br key={i} />
                    return <p key={i} className="mb-1">{renderBold(line)}</p>
                  })}
                </div>
                {research.generated_at && (
                  <div className="mt-3 pt-2 border-t border-gray-100 text-[11px] text-gray-400">
                    生成时间：{new Date(research.generated_at).toLocaleString('zh-CN')} · 仅供参考
                  </div>
                )}
              </div>
            )}

            {research.error && !research.analysis && (
              <div className="text-sm text-amber-600 bg-amber-50 rounded-lg p-3">
                {research.error}
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
              <label className="block text-sm font-medium text-gray-700 mb-1.5">日期 {navLoading && <span className="text-blue-500 text-xs ml-1">查询净值中...</span>}</label>
              <input type="date" value={form.date} onChange={e => { setForm({ ...form, date: e.target.value }); if (form.type !== 'dividend') autoFetchNav(e.target.value) }} className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" required />
              {navHint && <p className="text-xs text-blue-600 mt-1">{navHint}</p>}
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
                  {form.inputValue > 0 && form.price > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      净值 {form.price.toFixed(4)} &middot;
                      {form.inputMode === 'amount'
                        ? <>份额 {(form.inputValue / form.price).toFixed(4)} &middot; 金额 {fmt(form.inputValue)}</>
                        : <>份额 {form.inputValue} &middot; 金额 {fmt(form.inputValue * form.price)}</>
                      }
                    </p>
                  )}
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
                    <> &middot; {fmtNum(selSummary.totalShares, 2)} 份 @ {fmtNav(selSummary.avgPrice)}/份</>
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
          {pairInfo && (
            <div className="mt-3 pt-3 border-t border-blue-200">
              <div className="text-sm font-medium text-blue-900 mb-2">
                买卖配对盈亏（{pairInfo.buys.length}买 + {pairInfo.sells.length}卖）
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <div className="text-emerald-600 font-medium mb-1">买入合计</div>
                  <div className="font-medium text-gray-900">{fmtNum(pairInfo.totalBuyShares, 2)} 份</div>
                  <div className="text-gray-500">均价 {fmtNav(pairInfo.avgBuyPrice)} &middot; 金额 {fmt(pairInfo.totalBuyCost)}</div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-blue-100">
                  <div className="text-red-600 font-medium mb-1">卖出合计</div>
                  <div className="font-medium text-gray-900">{fmtNum(pairInfo.totalSellShares, 2)} 份</div>
                  <div className="text-gray-500">均价 {fmtNav(pairInfo.avgSellPrice)} &middot; 金额 {fmt(pairInfo.totalSellRevenue)}</div>
                </div>
              </div>
              <div className="mt-3 bg-white rounded-lg p-3 border border-blue-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">配对盈亏（按 {fmtNum(pairInfo.pairedShares, 2)} 份计）</span>
                  <span className={`text-base font-bold ${pairInfo.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {pairInfo.profit >= 0 ? '+' : ''}{fmt(pairInfo.profit)}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-gray-400">均价差</span>
                  <span className={`text-xs font-medium ${pairInfo.priceDiff >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {pairInfo.priceDiff >= 0 ? '+' : ''}{pairInfo.priceDiff.toFixed(4)}/份
                  </span>
                </div>
                {pairInfo.remainder > 0.01 && (
                  <div className="mt-1 text-xs text-amber-600">
                    份额差 {fmtNum(pairInfo.remainder, 2)} 份，配对后剩余部分保留为独立交易
                  </div>
                )}
              </div>
              <button
                onClick={handlePair}
                disabled={pairing}
                className="mt-3 w-full py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {pairing ? '配对中...' : `确认配对（${fmtNum(pairInfo.pairedShares, 2)} 份）`}
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
                        <div className="font-medium text-gray-900 mt-0.5">{fmtNum(t.paired_shares, 2)} 份 @ {fmtNav(t.buy_price)}</div>
                        <div className="text-gray-500">金额 {fmt(buyAmount)}</div>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-gray-100">
                        <div className="text-red-600 font-medium mb-1">卖出</div>
                        <div>{formatDate(t.sell_date)}</div>
                        <div className="font-medium text-gray-900 mt-0.5">{fmtNum(t.paired_shares, 2)} 份 @ {fmtNav(t.sell_price)}</div>
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

      {/* 交易记录 */}
      {transactions.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无交易</h3>
          <p className="text-gray-500 text-sm">添加第一条交易记录开始追踪此基金。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">交易记录 <span className="text-gray-400 font-normal">({transactions.length}笔)</span></h2>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={transactions.length > 0 && transactions.every(tx => selected.has(tx.id))}
                onChange={() => {
                  if (transactions.every(tx => selected.has(tx.id))) {
                    setSelected(new Set())
                  } else {
                    setSelected(new Set(transactions.map(tx => tx.id)))
                  }
                }}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500">全选</span>
            </label>
          </div>
          {transactions.map(tx => {
            const cfg = typeConfig[tx.type]
            const total = tx.type === 'dividend' ? tx.price : tx.shares * tx.price
            const isSelected = selected.has(tx.id)

            return (
              <div key={tx.id} className={`px-5 py-3 flex items-center gap-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors ${isSelected ? 'bg-blue-50/50' : ''}`}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(tx.id)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
                />
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.text} ${cfg.border} shrink-0`}>
                  {cfg.icon} {cfg.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">{formatDate(tx.date)}</div>
                  <div className="text-xs text-gray-500">
                    {tx.type !== 'dividend'
                      ? <>{tx.shares} 份 @ {fmtNav(tx.price)}</>
                      : <>分红</>
                    }
                    {tx.notes && <span className="ml-2 text-gray-400">&middot; {tx.notes}</span>}
                  </div>
                </div>
                <div className={`text-sm font-semibold shrink-0 ${tx.type === 'sell' ? 'text-red-600' : 'text-gray-900'}`}>
                  {tx.type === 'sell' ? '-' : ''}{fmt(total)}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => openSplit(tx)} className="p-1.5 rounded-md text-gray-400 hover:text-purple-600 hover:bg-purple-50 transition-colors" title="拆分">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                  </button>
                  <button onClick={() => startEdit(tx)} className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                  </button>
                  <button onClick={() => setDeleteId(tx.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="删除">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
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

      <ConfirmDialog
        open={showBatchDeleteConfirm}
        title="批量删除交易"
        message={`确定要删除选中的 ${selected.size} 条交易记录吗？此操作不可撤销。`}
        confirmText={batchDeleting ? '删除中...' : `删除 ${selected.size} 条`}
        onConfirm={handleBatchDelete}
        onCancel={() => setShowBatchDeleteConfirm(false)}
      />

      {/* Adjust Holding Dialog */}
      {showAdjust && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAdjust(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900">调整持仓</h3>

            {/* Mode selector */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAdjustMode('gain')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  adjustMode === 'gain' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                修改盈亏
              </button>
              <button
                type="button"
                onClick={() => setAdjustMode('transaction')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  adjustMode === 'transaction' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                调整交易
              </button>
              <button
                type="button"
                onClick={() => setAdjustMode('fix_base')}
                disabled={!hasBase}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  adjustMode === 'fix_base' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                修正底仓
              </button>
            </div>
            <p className="text-xs text-gray-500">
              {adjustMode === 'gain'
                ? '输入当前盈亏金额，系统根据最新净值自动反算持仓成本。需先设置市场净值。'
                : adjustMode === 'transaction'
                ? '生成补差交易记录，适用于实际发生了变动的情况。'
                : '直接修改历史持仓底仓数据，适用于之前数据录入有误需要更正。'}
            </p>

            {adjustMode === 'gain' ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">当前盈亏金额</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-gray-400 text-sm">¥</span>
                    <input type="number" step="any" value={gainForm || ''} onChange={e => setGainForm(Number(e.target.value))}
                      className="w-full border border-gray-300 rounded-lg pl-7 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-green-500 outline-none"
                      placeholder="正数为盈利，负数为亏损" />
                  </div>
                </div>
                {mNav > 0 && holdingShares > 0 && (
                  <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2.5">
                    <div>当前净值 <strong>{fmtNav(mNav)}</strong> &middot; 持有 <strong>{fmtNum(holdingShares, 2)}</strong> 份</div>
                    <div className="mt-1">市值 <strong>{fmt(holdingShares * mNav)}</strong></div>
                    {gainForm !== 0 && (
                      <div className="mt-1 text-blue-600">
                        调整后成本 <strong>{fmt(holdingShares * mNav - gainForm)}</strong> &middot;
                        成本均价 <strong>{fmtNav((holdingShares * mNav - gainForm) / holdingShares)}</strong>
                      </div>
                    )}
                    {totalGain !== 0 && (
                      <div className="mt-1 text-gray-400">
                        当前盈亏 {totalGain >= 0 ? '+' : ''}{fmt(totalGain)} &middot; 成本均价 {fmtNav(costNav)}
                      </div>
                    )}
                  </div>
                )}
                {(!mNav || mNav <= 0) && (
                  <div className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2.5">
                    请先在策略模型中设置当前市场净值
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">持有份额</label>
                    <input type="number" step="any" value={adjustForm.shares || ''} onChange={e => setAdjustForm({ ...adjustForm, shares: Number(e.target.value) })}
                      className="w-full border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">持仓均价</label>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-gray-400 text-sm">¥</span>
                      <input type="number" step="any" value={adjustForm.nav || ''} onChange={e => setAdjustForm({ ...adjustForm, nav: Number(e.target.value) })}
                        className="w-full border border-gray-300 rounded-lg pl-7 pr-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                    </div>
                  </div>
                </div>
                {adjustForm.shares > 0 && adjustForm.nav > 0 && (
                  <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2.5">
                    调整后：持仓 <strong>{fmtNum(adjustForm.shares, 2)}</strong> 份 &middot;
                    均价 <strong>{fmtNav(adjustForm.nav)}</strong> &middot;
                    总成本 <strong>{fmt(adjustForm.shares * adjustForm.nav)}</strong>
                    {holdingShares > 0 && (
                      <div className="mt-1 text-gray-400">
                        当前：{fmtNum(holdingShares, 2)} 份 &middot; 均价 {fmtNav(costNav)} &middot; 总成本 {fmt(totalCost)}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowAdjust(false)} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">取消</button>
              <button onClick={handleAdjust} disabled={adjustMode === 'gain' ? (!mNav || mNav <= 0) : (!adjustForm.shares || !adjustForm.nav)}
                className={`px-4 py-2 text-sm text-white rounded-lg disabled:opacity-50 ${
                  adjustMode === 'gain' ? 'bg-green-600 hover:bg-green-700'
                    : adjustMode === 'fix_base' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-amber-600 hover:bg-amber-700'
                }`}>
                {adjustMode === 'gain' ? '确认修改盈亏' : adjustMode === 'fix_base' ? '修正底仓' : '确认调整'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                  : <>{splitTx.shares} 份 @ {fmtNav(splitTx.price)} = {fmt(splitTx.shares * splitTx.price)}</>
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
