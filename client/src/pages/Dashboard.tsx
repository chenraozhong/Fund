import { useEffect, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { api } from '../api'
import type { Summary, Allocation, Fund } from '../api'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [allocation, setAllocation] = useState<Allocation[]>([])
  const [funds, setFunds] = useState<Fund[]>([])

  useEffect(() => {
    api.getSummary().then(setSummary)
    api.getAllocation().then(setAllocation)
    api.getFunds().then(setFunds)
  }, [])

  if (!summary) return <div className="text-center py-12 text-gray-500">加载中...</div>

  if (summary.fund_count === 0) {
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

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">总览</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="总市值" value={fmt(summary.total_value)} />
        <StatCard label="总投入" value={fmt(summary.total_cost)} />
        <StatCard
          label="盈亏"
          value={`${fmt(summary.gain)} (${summary.gain_pct.toFixed(1)}%)`}
          color={summary.gain >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <StatCard label="基金数" value={String(summary.fund_count)} />
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
                  <span className="font-medium text-gray-900">{f.name}</span>
                </div>
                <div className="text-right">
                  <div className="font-medium text-gray-900">{fmt(f.current_value)}</div>
                  <div className={`text-sm ${f.gain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {f.gain >= 0 ? '+' : ''}{fmt(f.gain)} ({f.gain_pct.toFixed(1)}%)
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${color || 'text-gray-900'}`}>{value}</div>
    </div>
  )
}
