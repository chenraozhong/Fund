import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { api } from '../api'
import type { PerformanceData } from '../api'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

export default function Performance() {
  const [perf, setPerf] = useState<PerformanceData | null>(null)

  useEffect(() => {
    api.getPerformance().then(setPerf)
  }, [])

  if (!perf) return <div className="text-center py-12 text-gray-500">加载中...</div>

  if (perf.funds.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">暂无业绩数据</h2>
        <p className="text-gray-500">创建基金并添加交易后即可查看业绩走势图。</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">业绩走势（近12个月）</h1>

      <div className="bg-white rounded-lg shadow p-6">
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={perf.data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `¥${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(value: number) => fmt(value)} />
            {perf.funds.map(f => (
              <Line
                key={f.id}
                type="monotone"
                dataKey={f.name}
                stroke={f.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        <div className="flex flex-wrap gap-4 mt-4 justify-center">
          {perf.funds.map(f => (
            <div key={f.id} className="flex items-center gap-2 text-sm">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: f.color }} />
              <span className="text-gray-700">{f.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
