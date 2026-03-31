import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { ImportPreview } from '../api'

function fmt(n: number) {
  return n.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })
}

function fmtNav(n: number) {
  return '¥' + n.toFixed(4)
}

const typeLabel: Record<string, string> = { buy: '买入', sell: '卖出', dividend: '分红' }

const EXAMPLE = `基金名称：南方有色金属ETF联接E
基金代码：012414
持仓总份额：5000
盈亏：+500
最近交易：
  2026-03-20 买入 1000份
  2026-03-25 卖出 500份
  2026-03-28 买入 800元

基金名称：科技成长
基金代码：000001
持仓总份额：3000
盈亏：-200
最近交易：
  2026-03-22 买入 500份 净值2.60
  2026-03-27 买入 300份 净值2.50`

export default function Import() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ImportPreview[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [navErrors, setNavErrors] = useState<string[]>([])
  const [result, setResult] = useState<{ name: string; fundId: number; transactionCount: number }[] | null>(null)

  const handlePreview = async () => {
    if (!text.trim()) { setError('请输入数据'); return }
    setLoading(true)
    setError('')
    setPreview(null)
    setResult(null)
    setNavErrors([])
    try {
      const res = await api.importPreview(text) as any
      setPreview(res.funds)
      if (res.navErrors?.length) setNavErrors(res.navErrors)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleImport = async () => {
    setImporting(true)
    setError('')
    try {
      const res = await api.importExecute(text)
      setResult(res.imported)
      setPreview(null)
      setText('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">批量导入</h1>
        <p className="text-sm text-gray-500 mt-1">支持同时导入多个基金及其交易记录</p>
      </div>

      {/* Input */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-gray-700">粘贴基金数据</label>
          <button
            onClick={() => setText(EXAMPLE)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            填入示例
          </button>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={16}
          placeholder={`支持的格式：\n\n基金名称：xxx\n基金代码：012414（填写后自动获取净值和成本价）\n持仓总份额：xxx\n盈亏：xxx\n最近交易：\n  2026-03-20 买入 1000份\n  2026-03-25 卖出 500份\n\n（有基金代码时，净值和持仓成本价均自动获取计算）`}
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-y"
        />
        <div className="flex gap-3">
          <button
            onClick={handlePreview}
            disabled={loading || !text.trim()}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium shadow-sm transition-colors"
          >
            {loading ? '解析中（正在获取净值）...' : '预览'}
          </button>
          <button
            onClick={() => { setText(''); setPreview(null); setError(''); setResult(null) }}
            className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors"
          >
            清空
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
          {error}
        </div>
      )}

      {/* NAV fetch warnings */}
      {navErrors.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
            净值获取提醒
          </div>
          {navErrors.map((e, i) => <p key={i} className="ml-6">{e}</p>)}
        </div>
      )}

      {/* Success */}
      {result && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-green-800 font-medium">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
            导入成功！共导入 {result.length} 个基金
          </div>
          <div className="space-y-2">
            {result.map((r, i) => (
              <div key={i} className="flex items-center justify-between bg-white rounded-lg px-4 py-2.5 border border-green-100">
                <span className="text-sm font-medium text-gray-900">{r.name}</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{r.transactionCount} 条交易</span>
                  <button
                    onClick={() => navigate(`/funds/${r.fundId}`)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    查看详情
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigate('/funds')}
            className="mt-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium transition-colors"
          >
            前往基金管理
          </button>
        </div>
      )}

      {/* Preview */}
      {preview && preview.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">预览（共 {preview.length} 个基金）</h2>
            <button
              onClick={handleImport}
              disabled={importing}
              className="px-5 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium shadow-sm transition-colors"
            >
              {importing ? '导入中...' : `确认导入 ${preview.length} 个基金`}
            </button>
          </div>

          {preview.map((f, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {/* Fund header */}
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="text-base font-semibold text-gray-900">
                  {f.name} {(f as any).code && <span className="text-sm font-normal text-gray-400 ml-1">({(f as any).code})</span>}
                  {(f as any).existingFundId && (
                    <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-full">
                      已存在，将更新
                    </span>
                  )}
                </h3>
                <div className="flex flex-wrap gap-4 mt-2 text-sm text-gray-600">
                  <span>持仓 <strong>{f.totalShares}</strong> 份</span>
                  <span>当前净值 <strong>{fmtNav((f as any).marketNav || 0)}</strong></span>
                  <span>持仓均价 <strong>{fmtNav(f.avgNav)}</strong> <span className="text-xs text-gray-400">(自动计算)</span></span>
                  <span className={f.gain >= 0 ? 'text-green-600' : 'text-red-600'}>
                    盈亏 <strong>{f.gain >= 0 ? '+' : ''}{fmt(f.gain)}</strong>
                  </span>
                  <span className="text-gray-400">共 {f.transactionCount} 条交易</span>
                </div>
              </div>

              {/* Transactions to be created */}
              <div className="divide-y divide-gray-50">
                {/* Base position */}
                {f.baseShares > 0 && (
                  <div className="px-5 py-2.5 flex items-center gap-3 bg-blue-50/50">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-50 text-blue-700 border-blue-200">
                      历史
                    </span>
                    <div className="flex-1 text-sm text-gray-700">
                      历史持仓 <strong>{f.baseShares}</strong> 份 @ {fmtNav(f.basePrice)}
                    </div>
                    <div className="text-sm font-medium text-gray-900">
                      {fmt(f.baseShares * f.basePrice)}
                    </div>
                  </div>
                )}

                {/* Recent transactions */}
                {f.recentTransactions.map((tx, j) => (
                  <div key={j} className="px-5 py-2.5 flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                      tx.type === 'buy' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : tx.type === 'sell' ? 'bg-red-50 text-red-700 border-red-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}>
                      {typeLabel[tx.type] || tx.type}
                    </span>
                    <div className="flex-1 text-sm text-gray-700">
                      {tx.date}
                      {tx.type !== 'dividend'
                        ? <> &middot; {tx.shares} 份 @ {fmtNav(tx.price)}</>
                        : <> &middot; {fmt(tx.price)}</>
                      }
                    </div>
                    <div className={`text-sm font-medium ${tx.type === 'sell' ? 'text-red-600' : 'text-gray-900'}`}>
                      {tx.type === 'sell' ? '-' : ''}{fmt(tx.type === 'dividend' ? tx.price : tx.shares * tx.price)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Format help */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">格式说明</h3>
        <div className="text-xs text-gray-500 space-y-1.5 font-mono">
          <p>基金名称：[名称]</p>
          <p>基金代码：[代码] <span className="text-gray-400">← 填写后自动获取净值和计算成本价</span></p>
          <p>持仓总份额：[当前持有份额]</p>
          <p>盈亏：[+/-数字]</p>
          <p>最近交易：</p>
          <p className="ml-4">[日期] 买入 [数值]份  <span className="text-gray-400">← 按份额，净值自动获取</span></p>
          <p className="ml-4">[日期] 买入 [数值]元  <span className="text-gray-400">← 按金额，净值自动获取</span></p>
          <p className="ml-4">[日期] 买入 [数值]份 净值[价格]  <span className="text-gray-400">← 手动指定净值</span></p>
          <p className="ml-4">[日期] 卖出 [数值]份/元</p>
          <p className="ml-4">[日期] 分红 [金额]元</p>
          <p className="mt-2 text-gray-400">有基金代码时，持仓成本价根据「最新净值×份额-盈亏」自动计算</p>
          <p className="text-gray-400">交易行可省略净值，系统自动从天天基金查询</p>
          <p className="text-gray-400">多个基金用空行分隔，可一次性导入</p>
        </div>
      </div>
    </div>
  )
}
