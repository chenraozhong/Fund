import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

function fmt(n: number) { return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' }) }

const tierConfig = {
  core: { label: '核心底仓', bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', icon: '🏦', desc: '长期持有，目标年化8%+' },
  swing: { label: '波段操作', bg: 'bg-purple-50', border: 'border-purple-200', text: 'text-purple-700', icon: '📈', desc: '底仓+活仓波段，目标年化5%' },
  reduce: { label: '建议减持', bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', icon: '⚠️', desc: '趋势下行或深度亏损' },
}

export default function Portfolio() {
  const navigate = useNavigate()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getPortfolioAdvice().then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="text-center py-20 text-gray-400">分析持仓中...</div>
  if (!data) return <div className="text-center py-20 text-gray-400">暂无持仓数据</div>

  const { funds, summary } = data

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">组合配置</h1>
        <p className="text-sm text-gray-500 mt-1">基于7年回测数据，自动分析持仓并给出配置建议</p>
      </div>

      {/* 总览卡片 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
          <div className="text-2xl font-bold text-gray-900">{fmt(summary.totalValue)}</div>
          <div className="text-xs text-gray-500 mt-1">总市值</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
          <div className="text-2xl font-bold text-emerald-600">+{summary.estimatedAnnualReturn}%</div>
          <div className="text-xs text-gray-500 mt-1">预期年化</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
          <div className="text-2xl font-bold text-gray-900">{summary.totalFunds}</div>
          <div className="text-xs text-gray-500 mt-1">持仓基金</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 text-center">
          <div className="text-lg font-bold text-blue-600">{summary.core.pct}%</div>
          <div className="text-lg font-bold text-purple-600">{summary.swing.pct}%</div>
          <div className="text-xs text-gray-500 mt-1">底仓/波段比例</div>
        </div>
      </div>

      {/* 配置比例条 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-700">当前配置比例</span>
          <span className="text-xs text-gray-400">目标: 核心70% · 波段20% · 观望10%</span>
        </div>
        <div className="flex rounded-full overflow-hidden h-4">
          {summary.core.pct > 0 && <div className="bg-blue-500 transition-all" style={{ width: `${summary.core.pct}%` }} />}
          {summary.swing.pct > 0 && <div className="bg-purple-500 transition-all" style={{ width: `${summary.swing.pct}%` }} />}
          {summary.reduce.pct > 0 && <div className="bg-red-400 transition-all" style={{ width: `${summary.reduce.pct}%` }} />}
        </div>
        <div className="flex justify-between mt-1.5 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> 核心{summary.core.count}只 {fmt(summary.core.value)}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500" /> 波段{summary.swing.count}只 {fmt(summary.swing.value)}</span>
          {summary.reduce.count > 0 && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> 减持{summary.reduce.count}只 {fmt(summary.reduce.value)}</span>}
        </div>
      </div>

      {/* 分级基金列表 */}
      {(['core', 'swing', 'reduce'] as const).map(tier => {
        const tierFunds = funds.filter((f: any) => f.tier === tier)
        if (tierFunds.length === 0) return null
        const cfg = tierConfig[tier]
        return (
          <div key={tier}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">{cfg.icon}</span>
              <div>
                <h2 className="text-lg font-bold text-gray-900">{cfg.label}</h2>
                <p className="text-xs text-gray-400">{cfg.desc}</p>
              </div>
              <span className={`ml-auto px-3 py-1 rounded-full text-xs font-bold ${cfg.bg} ${cfg.text}`}>
                {tierFunds.length}只
              </span>
            </div>
            <div className="space-y-2">
              {tierFunds.map((f: any) => (
                <div key={f.id} className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4 cursor-pointer hover:shadow-md transition-shadow`}
                  onClick={() => navigate(`/funds/${f.id}`)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className="w-1.5 h-8 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                      <div className="min-w-0">
                        <div className="font-medium text-sm text-gray-900 truncate">{f.name}</div>
                        <div className="text-[11px] text-gray-400">{f.code}</div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <div className="text-sm font-bold text-gray-900">{fmt(f.marketValue)}</div>
                      <div className={`text-xs font-medium ${f.gainPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {f.gainPct >= 0 ? '+' : ''}{f.gainPct}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    <span className={`px-2 py-0.5 rounded-md ${cfg.bg} ${cfg.text} font-medium`}>{f.strategy}</span>
                    <span className="px-2 py-0.5 rounded-md bg-white text-gray-500">波动率{f.volatility}%</span>
                    {f.trend20 !== 0 && (
                      <span className={`px-2 py-0.5 rounded-md bg-white ${f.trend20 > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        20日{f.trend20 > 0 ? '+' : ''}{f.trend20}%
                      </span>
                    )}
                    <span className="px-2 py-0.5 rounded-md bg-white text-gray-500">底仓{f.basePct}%</span>
                  </div>

                  <p className="mt-2 text-xs text-gray-600 leading-relaxed">{f.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* 说明 */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-5 space-y-2">
        <h3 className="font-semibold text-gray-700 text-sm">配置说明</h3>
        <ul className="text-xs text-gray-500 space-y-1.5 list-disc list-inside">
          <li><strong>核心底仓(70%)</strong>：长期持有不频繁交易，黄金买入持有、成长用v8.0趋势追踪、防御用v8.1</li>
          <li><strong>波段操作(20%)</strong>：底仓持有+活仓做7-30天差价，选高波动品种</li>
          <li><strong>建议减持(10%)</strong>：趋势下行或持续亏损，止损部分仓位等待企稳</li>
          <li>分级基于：20日波动率 + 20日趋势 + 当前盈亏 + 资产类型</li>
          <li>预期年化基于7年回测(含2022大熊市)，实际收益受市场环境影响</li>
        </ul>
      </div>
    </div>
  )
}
