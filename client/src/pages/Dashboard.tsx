import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { api } from '../api'
import type { Summary, Allocation, Fund } from '../api'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNav(n: number) {
  return '¥' + n.toFixed(4)
}

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [allocation, setAllocation] = useState<Allocation[]>([])
  const [funds, setFunds] = useState<Fund[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState('')
  const [editNavId, setEditNavId] = useState<number | null>(null)
  const [editNavValue, setEditNavValue] = useState('')

  const loadAll = () => {
    api.getSummary().then(setSummary)
    api.getAllocation().then(setAllocation)
    api.getFunds().then(setFunds)
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
        <h1 className="text-2xl font-bold text-gray-900">总览</h1>
        <div className="flex items-center gap-3">
          {refreshResult && <span className="text-sm text-green-600">{refreshResult}</span>}
          <button
            onClick={handleRefreshNav}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 text-sm font-medium transition-colors disabled:opacity-50"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            {refreshing ? '刷新中...' : '刷新净值'}
          </button>
        </div>
      </div>

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

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">基金列表</h2>
          <div className="space-y-3">
            {funds.map(f => (
              <div key={f.id} className="flex items-center justify-between p-3 rounded-md bg-gray-50">
                <div className="flex items-center gap-3">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: f.color }} />
                  <div>
                    <span className="font-medium text-gray-900">{f.name}</span>
                    {f.code && <span className="text-xs text-gray-400 ml-1.5">{f.code}</span>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium text-gray-900">{fmt(f.current_value)}</div>
                  <div className={`text-sm ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {f.gain >= 0 ? '+' : ''}{fmt(f.gain)} ({f.gain_pct.toFixed(1)}%)
                  </div>
                  {editNavId === f.id ? (
                    <div className="flex items-center gap-1 mt-1">
                      <input
                        type="number"
                        step="0.0001"
                        value={editNavValue}
                        onChange={e => setEditNavValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveNav(f.id); if (e.key === 'Escape') setEditNavId(null) }}
                        className="w-20 border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:ring-1 focus:ring-blue-500 outline-none"
                        autoFocus
                        placeholder="净值"
                      />
                      <button onClick={() => handleSaveNav(f.id)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">保存</button>
                      <button onClick={() => setEditNavId(null)} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
                    </div>
                  ) : (
                    <div
                      className="text-xs text-gray-400 cursor-pointer hover:text-blue-600 transition-colors"
                      onClick={() => { setEditNavId(f.id); setEditNavValue(f.market_nav > 0 ? f.market_nav.toFixed(4) : '') }}
                      title="点击手动修改净值"
                    >
                      {f.market_nav > 0 ? `净值 ${f.market_nav.toFixed(4)}` : '点击设置净值'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
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
