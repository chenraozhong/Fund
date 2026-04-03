import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { api } from '../api'
import type { Summary, Allocation, Fund, BatchDecision, BatchForecast, EstimateData, ForecastReviewSummary } from '../api'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNav(n: number) {
  return '¥' + n.toFixed(4)
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [allocation, setAllocation] = useState<Allocation[]>([])
  const [funds, setFunds] = useState<Fund[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState('')
  const [editNavId, setEditNavId] = useState<number | null>(null)
  const [editNavValue, setEditNavValue] = useState('')
  const [estimates, setEstimates] = useState<Record<number, EstimateData>>({})
  const [decisions, setDecisions] = useState<BatchDecision[]>([])
  const [decisionsLoading, setDecisionsLoading] = useState(false)
  const [forecasts, setForecasts] = useState<Record<number, BatchForecast>>({})
  const [forecastsLoading, setForecastsLoading] = useState(false)
  const [reviewSummary, setReviewSummary] = useState<ForecastReviewSummary | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // 判断今日净值是否已出（officialDate = 今天）
  const isNavPublished = (est: EstimateData | undefined) => {
    if (!est || !est.officialDate) return false
    const today = new Date().toISOString().slice(0, 10)
    return est.officialDate === today
  }

  const loadAll = () => {
    api.getSummary().then(setSummary)
    api.getAllocation().then(setAllocation)
    api.getFunds().then(setFunds)
    // 自动获取实时估值
    api.getEstimateAll().then(est => {
      setEstimates(est as Record<number, EstimateData>)
      // 自动获取批量决策
      const estNavs: Record<number, number> = {}
      for (const [id, e] of Object.entries(est)) {
        estNavs[Number(id)] = e.gsz
      }
      setDecisionsLoading(true)
      api.getBatchDecisions(estNavs).then(setDecisions).catch(() => {}).finally(() => setDecisionsLoading(false))
    }).catch(() => {})
    // 自动获取批量预测
    setForecastsLoading(true)
    api.getBatchForecasts().then(setForecasts).catch(() => {}).finally(() => setForecastsLoading(false))
    // 加载复盘摘要
    api.getForecastReviewSummary(30).then(setReviewSummary).catch(() => {})
  }

  useEffect(() => { loadAll() }, [])

  const handleSaveNav = async (fundId: number) => {
    const nav = parseFloat(editNavValue)
    if (!nav || nav <= 0) return
    try {
      await api.updateFund(fundId, { market_nav: nav })
      setEditNavId(null)
      setEditNavValue('')
      loadAll()
    } catch { /* ignore */ }
  }

  const handleRefreshNav = async () => {
    setRefreshing(true)
    setRefreshResult('')
    try {
      const res = await api.refreshAllNav()
      setRefreshResult(`已更新 ${res.updated}/${res.total} 个基金净值`)
      loadAll()
      setTimeout(() => setRefreshResult(''), 5000)
    } catch (err: any) {
      setRefreshResult('刷新失败: ' + err.message)
    } finally {
      setRefreshing(false)
    }
  }

  if (!summary) return <div className="text-center py-12 text-gray-500">加载中...</div>

  if (funds.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">欢迎使用投资组合管理</h2>
        <p className="text-gray-500 mb-6">创建你的第一个基金，开始追踪投资吧。</p>
        <a href="/funds" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
          创建基金
        </a>
      </div>
    )
  }

  // 从 funds 数据汇总（funds GET / 已正确使用 market_nav 计算）
  const totalValue = funds.reduce((s, f) => s + f.current_value, 0)
  const totalCost = funds.reduce((s, f) => s + f.total_cost, 0)
  const totalGain = totalValue - totalCost
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">总览</h1>
        <div className="flex items-center gap-2 sm:gap-3">
          {refreshResult && <span className="text-xs sm:text-sm text-green-600 hidden sm:inline">{refreshResult}</span>}
          <button
            onClick={handleRefreshNav}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 text-xs sm:text-sm font-medium transition-colors disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? '刷新中...' : '刷新净值'}
          </button>
        </div>
      </div>
      {refreshResult && <div className="sm:hidden text-xs text-green-600">{refreshResult}</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="总市值" value={fmt(totalValue)} />
        <StatCard label="持仓成本" value={fmt(totalCost)} />
        <StatCard
          label="浮动盈亏"
          value={`${totalGain >= 0 ? '+' : ''}${fmt(totalGain)}`}
          sub={`${totalGainPct >= 0 ? '+' : ''}${totalGainPct.toFixed(2)}%`}
          color={totalGain >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <StatCard label="基金数" value={String(funds.length)} sub={`${summary.tx_count} 条交易`} />
      </div>

      {/* 全局决策面板 */}
      <div className="bg-white rounded-lg shadow p-3 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">实时估值 & 决策</h2>
              <p className="text-xs text-gray-400">基于实时估值自动生成买卖建议</p>
            </div>
          </div>
          {(decisionsLoading || forecastsLoading) && <span className="text-xs text-gray-400 animate-pulse">{decisionsLoading ? '决策分析中...' : '预测中...'}</span>}
        </div>
        <div className="space-y-2">
          {(decisions.length > 0 ? decisions : funds).map((item: any) => {
            const d = decisions.length > 0 ? item : null
            const f = decisions.length > 0 ? null : item
            const fundId = d ? d.fundId : f.id
            const fundName = d ? d.name : f.name
            const fundCode = d ? d.code : f.code
            const fundColor = d ? d.color : f.color
            const est = estimates[fundId]
            const fc = forecasts[fundId]
            const pos = d?.position
            const costNav = pos?.costNav ?? 0
            const gainPct = pos?.gainPct ?? (f ? f.gain_pct : 0)
            const mktValue = pos?.marketValue ?? (f ? f.current_value : 0)
            const isExpanded = expandedId === fundId
            const published = isNavPublished(est)
            const displayNav = published ? est.officialNav : (est ? est.gsz : (d ? d.nav : (f ? f.market_nav : 0)))
            const displayChangePct = published
              ? (est.prevNav > 0 ? ((est.officialNav - est.prevNav) / est.prevNav) * 100 : 0)
              : (est ? est.gszzl : 0)
            return (
              <div key={fundId} className="bg-gray-50/50 hover:bg-gray-50 rounded-xl p-3 sm:p-3.5 transition-colors cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : fundId)}>
                {/* 主行：基金名 + 核心数据 + 预测/建议 */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* 左：基金 */}
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full shrink-0" style={{ backgroundColor: fundColor }} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-xs sm:text-sm text-gray-900 truncate">{fundName}</span>
                        {fundCode && <span className="text-[10px] sm:text-[11px] text-gray-400 shrink-0 hidden sm:inline">{fundCode}</span>}
                      </div>
                      <div className="flex items-center gap-1.5 sm:gap-2 mt-0.5 text-[11px] sm:text-xs text-gray-500">
                        <span className="font-mono">{displayNav > 0 ? displayNav.toFixed(4) : '-'}</span>
                        {displayNav > 0 && <span className={`font-medium ${displayChangePct >= 0 ? 'text-red-500' : 'text-green-600'}`}>{displayChangePct >= 0 ? '+' : ''}{displayChangePct.toFixed(2)}%</span>}
                        {published && <span className="text-[10px] text-blue-500">净值</span>}
                        {!published && est?.gztime && <span className="text-[10px] text-gray-400 hidden sm:inline">{est.gztime.slice(11, 16)}</span>}
                      </div>
                    </div>
                  </div>

                  {/* 中：市值+盈亏 */}
                  <div className="hidden sm:block text-right shrink-0 w-28">
                    <div className="text-sm font-semibold text-gray-900">{mktValue > 0 ? fmt(mktValue) : '-'}</div>
                    <div className={`text-xs font-medium ${gainPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>{gainPct >= 0 ? '+' : ''}{gainPct.toFixed(2)}%</div>
                  </div>

                  {/* 右：预测 */}
                  <div className="shrink-0 w-16 sm:w-20 text-center">
                    {fc ? (
                      <span className={`inline-flex items-center gap-0.5 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg text-[11px] sm:text-xs font-bold ${
                        fc.direction === 'up' ? 'bg-red-50 text-red-600' :
                        fc.direction === 'down' ? 'bg-green-50 text-green-600' :
                        'bg-gray-100 text-gray-500'
                      }`}>
                        {fc.direction === 'up' ? '↑' : fc.direction === 'down' ? '↓' : '→'}
                        {fc.predictedChangePct >= 0 ? '+' : ''}{fc.predictedChangePct.toFixed(2)}%
                      </span>
                    ) : forecastsLoading ? (
                      <span className="text-[11px] sm:text-xs text-gray-400 animate-pulse">预测中</span>
                    ) : <span className="text-[11px] sm:text-xs text-gray-400">-</span>}
                  </div>

                  {/* 右：决策 */}
                  <div className="shrink-0 w-14 sm:w-24 text-right">
                    {d ? (
                      <div>
                        <span className={`inline-flex items-center px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-lg text-[11px] sm:text-xs font-bold ${
                          d.action === 'buy' ? 'bg-emerald-100 text-emerald-700' :
                          d.action === 'sell' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {d.action === 'buy' ? '买入' : d.action === 'sell' ? '卖出' : '持有'}
                        </span>
                        {d.amount > 0 && <div className={`text-[11px] sm:text-xs mt-0.5 font-medium hidden sm:block ${d.action === 'buy' ? 'text-emerald-700' : 'text-red-700'}`}>{fmt(d.amount)}</div>}
                      </div>
                    ) : <span className="text-[11px] sm:text-xs text-gray-400 animate-pulse">分析中</span>}
                  </div>

                  <svg className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-300 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>

                {/* 展开详情 */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-gray-200/60 space-y-2" onClick={e => e.stopPropagation()}>
                    {/* 关键指标行 */}
                    <div className="flex flex-wrap gap-2 text-xs">
                      {costNav > 0 && <span className="px-2 py-1 bg-white rounded-md border border-gray-200 text-gray-600">成本 {costNav.toFixed(4)}</span>}
                      {d?.masterSignals && <span className="px-2 py-1 bg-blue-50 rounded-md text-blue-600">恐惧贪婪 {d.masterSignals.fearGreed}</span>}
                      {d?.masterSignals && <span className="px-2 py-1 bg-purple-50 rounded-md text-purple-600">{d.masterSignals.cycleLabel}</span>}
                      {d?.dimensions && <span className="px-2 py-1 bg-orange-50 rounded-md text-orange-600">RSI {d.dimensions.technical.rsi.toFixed(0)}</span>}
                      {d?.capitalFlow && <span className={`px-2 py-1 rounded-md ${d.capitalFlow.flowScore > 10 ? 'bg-red-50 text-red-600' : d.capitalFlow.flowScore < -10 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>{d.capitalFlow.flowLabel}</span>}
                      {d?.confidence > 0 && <span className="px-2 py-1 bg-yellow-50 rounded-md text-yellow-700">信心 {d.confidence}%</span>}
                    </div>
                    {/* 推理过程 */}
                    {d?.reasoning && d.reasoning.length > 0 && (
                      <div className="space-y-0.5">
                        {d.reasoning.map((r: string, i: number) => (
                          <div key={i} className="text-xs text-gray-500 leading-relaxed">{r}</div>
                        ))}
                      </div>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/funds/${fundId}`) }} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">查看详情 →</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 预测复盘面板 */}
      {reviewSummary && reviewSummary.stats.total > 0 && (
        <div className="bg-white rounded-lg shadow p-3 sm:p-6">
          <div className="flex items-center justify-between mb-4 cursor-pointer" onClick={() => setShowReview(!showReview)}>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
                <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">预测复盘</h2>
                <p className="text-xs text-gray-400">近{reviewSummary.days}天预测准确率统计与因子分析</p>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="hidden sm:flex items-center gap-4 text-sm">
                <span className="text-gray-500">准确率 <span className={`font-bold ${reviewSummary.stats.accuracy >= 60 ? 'text-green-600' : reviewSummary.stats.accuracy >= 40 ? 'text-amber-600' : 'text-red-600'}`}>{reviewSummary.stats.accuracy}%</span></span>
                <span className="text-gray-500">区间命中 <span className="font-bold text-blue-600">{reviewSummary.stats.inRangePct}%</span></span>
                <span className="text-gray-500">平均误差 <span className="font-bold text-gray-700">{reviewSummary.stats.avgError.toFixed(2)}%</span></span>
                <span className="text-gray-400">{reviewSummary.stats.correct}/{reviewSummary.stats.total}次</span>
              </div>
              <span className="sm:hidden text-xs text-gray-500">准确率 <span className={`font-bold ${reviewSummary.stats.accuracy >= 60 ? 'text-green-600' : reviewSummary.stats.accuracy >= 40 ? 'text-amber-600' : 'text-red-600'}`}>{reviewSummary.stats.accuracy}%</span></span>
              <svg className={`w-4 h-4 text-gray-400 transition-transform ${showReview ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </div>
          </div>

          {showReview && (
            <div className="space-y-4">
              {/* 因子准确率 */}
              {reviewSummary.factorAccuracy.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">因子准确率排名</h3>
                  <div className="flex flex-wrap gap-2">
                    {reviewSummary.factorAccuracy.map(f => (
                      <div key={f.factor} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-gray-50 text-xs">
                        <span className="text-gray-600">{f.label}</span>
                        <span className={`font-bold ${f.accuracy >= 60 ? 'text-green-600' : f.accuracy >= 40 ? 'text-amber-600' : 'text-red-500'}`}>{f.accuracy}%</span>
                        <span className="text-gray-400">({f.correct}/{f.total})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 按基金统计 */}
              {reviewSummary.byFund.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">各基金预测表现</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {reviewSummary.byFund.map(f => (
                      <div key={f.fund_id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-gray-900 truncate">{f.name}</div>
                          <div className="text-[11px] text-gray-500">
                            准确 <span className={`font-bold ${f.accuracy >= 60 ? 'text-green-600' : 'text-amber-600'}`}>{f.accuracy}%</span>
                            <span className="text-gray-400 ml-1">({f.correct}/{f.total})</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 最近复盘记录 */}
              {reviewSummary.recent.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">最近复盘记录</h3>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {reviewSummary.recent.map(r => (
                      <div key={`${r.fund_id}-${r.target_date}`} className={`px-3 py-2 rounded-lg text-xs border-l-3 ${r.direction_correct ? 'border-l-green-400 bg-green-50/50' : 'border-l-red-400 bg-red-50/50'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.fund_color }} />
                            <span className="font-medium text-gray-900">{r.fund_name}</span>
                            <span className="text-gray-400">{r.target_date}</span>
                          </div>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.direction_correct ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {r.direction_correct ? '正确' : '错误'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-gray-500 mb-1">
                          <span>预测: <span className={r.predicted_change_pct >= 0 ? 'text-red-600' : 'text-green-600'}>{r.predicted_change_pct >= 0 ? '+' : ''}{r.predicted_change_pct.toFixed(2)}%</span></span>
                          <span>实际: <span className={r.actual_change_pct >= 0 ? 'text-red-600' : 'text-green-600'}>{r.actual_change_pct >= 0 ? '+' : ''}{r.actual_change_pct.toFixed(2)}%</span></span>
                          <span>误差: {r.error_pct.toFixed(2)}%</span>
                          <span>信心: {r.confidence}%</span>
                        </div>
                        {r.analysis && (
                          <div className="text-[11px] text-gray-600 whitespace-pre-line leading-relaxed">{r.analysis}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">资产配置</h2>
          {allocation.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={allocation} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, percentage }) => `${name} ${percentage}%`}>
                  {allocation.map(a => (
                    <Cell key={a.id} fill={a.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => fmt(value)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 text-center py-8">暂无配置数据。</p>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${color || 'text-gray-900'}`}>{value}</div>
      {sub && <div className={`text-xs mt-0.5 ${color || 'text-gray-400'}`}>{sub}</div>}
    </div>
  )
}
