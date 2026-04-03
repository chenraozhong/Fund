import { useState } from 'react'
import { api } from '../api'

interface SyncSummary {
  exportedAt: string
  counts: Record<string, number>
  totalRecords: number
  latestFund?: string
  latestTransaction?: string
}

function summarize(data: any): SyncSummary {
  const counts: Record<string, number> = {}
  let totalRecords = 0
  for (const [table, rows] of Object.entries(data.data || {})) {
    const len = Array.isArray(rows) ? rows.length : 0
    counts[table] = len
    totalRecords += len
  }
  const funds = data.data?.funds as any[] || []
  const txs = data.data?.transactions as any[] || []
  const latestFund = funds.length > 0 ? `${funds.length}只基金` : '无基金'
  const latestTx = txs.length > 0 ? txs.sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''))[0] : null
  const latestTransaction = latestTx ? `最新交易: ${latestTx.date}` : '无交易'
  return { exportedAt: data.exportedAt || '未知', counts, totalRecords, latestFund, latestTransaction }
}

const tableLabels: Record<string, string> = {
  funds: '基金', transactions: '交易', trades: '配对交易',
  daily_snapshots: '每日快照', forecasts: '预测记录',
  forecast_reviews: '预测复盘', decision_logs: '决策日志',
}

export default function Sync() {
  const [pcUrl, setPcUrl] = useState(() => {
    try { return localStorage.getItem('sync_pc_url') || 'http://192.168.1.100:3001' } catch { return 'http://192.168.1.100:3001' }
  })
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(() => {
    try { return localStorage.getItem('sync_last_time') } catch { return null }
  })
  // Compare view
  const [localSummary, setLocalSummary] = useState<SyncSummary | null>(null)
  const [remoteSummary, setRemoteSummary] = useState<SyncSummary | null>(null)
  const [localData, setLocalData] = useState<any>(null)
  const [remoteData, setRemoteData] = useState<any>(null)
  const [compared, setCompared] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'pull' | 'push' | null>(null)

  const savePcUrl = (url: string) => {
    setPcUrl(url)
    try { localStorage.setItem('sync_pc_url', url) } catch {}
  }

  // Step 1: Compare both sides
  const compareData = async () => {
    setLoading(true)
    setStatus('正在获取双方数据摘要...')
    setCompared(false)
    setConfirmAction(null)
    try {
      const [local, remote] = await Promise.all([
        api.syncExport(),
        api.syncPullFromPC(pcUrl.replace(/\/+$/, '')),
      ])
      setLocalData(local)
      setRemoteData(remote)
      setLocalSummary(summarize(local))
      setRemoteSummary(summarize(remote))
      setCompared(true)
      setStatus('')
    } catch (err: any) {
      setStatus(`对比失败: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  // Step 2: Execute sync with backup
  const executePull = async () => {
    setLoading(true)
    setConfirmAction(null)
    try {
      // Auto backup local data first
      setStatus('正在备份本地数据...')
      try { await api.createBackup() } catch { /* ignore if backup fails */ }

      setStatus('正在导入PC数据...')
      const result = await api.syncImport(remoteData)
      const total = Object.values(result.imported).reduce((s: number, n: any) => s + (n as number), 0)
      const now = new Date().toLocaleString('zh-CN')
      setLastSync(now)
      try { localStorage.setItem('sync_last_time', now) } catch {}
      setStatus(`同步成功！从PC导入 ${total} 条记录。已自动备份本地旧数据。请刷新页面。`)
      setCompared(false)
    } catch (err: any) {
      setStatus(`同步失败: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const executePush = async () => {
    setLoading(true)
    setConfirmAction(null)
    try {
      setStatus('正在推送到PC...')
      const result = await api.syncPushToPC(pcUrl.replace(/\/+$/, ''), localData)
      const total = Object.values(result.imported).reduce((s: number, n: any) => s + (n as number), 0)
      const now = new Date().toLocaleString('zh-CN')
      setLastSync(now)
      try { localStorage.setItem('sync_last_time', now) } catch {}
      setStatus(`推送成功！共推送 ${total} 条记录到PC。`)
      setCompared(false)
    } catch (err: any) {
      setStatus(`推送失败: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">数据同步</h1>
        <p className="text-sm text-gray-500 mt-1">在局域网内同步PC和手机的投资数据</p>
      </div>

      {/* PC连接设置 */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">PC服务器地址</h2>
        <p className="text-sm text-gray-500">确保手机和PC在同一局域网，PC端正在运行投资组合服务。</p>
        <div className="flex gap-2">
          <input
            value={pcUrl}
            onChange={e => savePcUrl(e.target.value)}
            className="flex-1 border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            placeholder="http://192.168.1.100:3001"
          />
          <button
            onClick={compareData}
            disabled={loading}
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 transition-colors shrink-0"
          >
            {loading && !compared ? '连接中...' : '对比数据'}
          </button>
        </div>
        <p className="text-xs text-gray-400">
          提示：PC终端运行 <code className="bg-gray-100 px-1.5 py-0.5 rounded">ifconfig</code> / <code className="bg-gray-100 px-1.5 py-0.5 rounded">ipconfig</code> 查看IP。端口默认3001。
        </p>
      </div>

      {/* 数据对比 */}
      {compared && localSummary && remoteSummary && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">数据对比</h2>

          <div className="grid grid-cols-2 gap-4">
            {/* 本机 */}
            <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700 text-sm font-bold">机</div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">本机(手机)</div>
                  <div className="text-[10px] text-gray-400">{localSummary.exportedAt.slice(0, 19)}</div>
                </div>
              </div>
              <div className="space-y-1">
                {Object.entries(localSummary.counts).map(([table, count]) => (
                  <div key={table} className="flex justify-between text-xs">
                    <span className="text-gray-600">{tableLabels[table] || table}</span>
                    <span className="font-mono font-medium text-gray-900">{count}</span>
                  </div>
                ))}
                <div className="border-t border-amber-200 pt-1 mt-1 flex justify-between text-xs font-semibold">
                  <span>合计</span>
                  <span>{localSummary.totalRecords}</span>
                </div>
              </div>
              <div className="mt-2 text-[10px] text-gray-500">
                {localSummary.latestFund} · {localSummary.latestTransaction}
              </div>
            </div>

            {/* PC */}
            <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700 text-sm font-bold">PC</div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">PC端</div>
                  <div className="text-[10px] text-gray-400">{remoteSummary.exportedAt.slice(0, 19)}</div>
                </div>
              </div>
              <div className="space-y-1">
                {Object.entries(remoteSummary.counts).map(([table, count]) => {
                  const localCount = localSummary.counts[table] || 0
                  const diff = count - localCount
                  return (
                    <div key={table} className="flex justify-between text-xs">
                      <span className="text-gray-600">{tableLabels[table] || table}</span>
                      <span className="font-mono font-medium text-gray-900">
                        {count}
                        {diff !== 0 && <span className={`ml-1 ${diff > 0 ? 'text-blue-600' : 'text-amber-600'}`}>({diff > 0 ? '+' : ''}{diff})</span>}
                      </span>
                    </div>
                  )
                })}
                <div className="border-t border-blue-200 pt-1 mt-1 flex justify-between text-xs font-semibold">
                  <span>合计</span>
                  <span>{remoteSummary.totalRecords}</span>
                </div>
              </div>
              <div className="mt-2 text-[10px] text-gray-500">
                {remoteSummary.latestFund} · {remoteSummary.latestTransaction}
              </div>
            </div>
          </div>

          {/* 差异提示 */}
          {(() => {
            const diff = remoteSummary.totalRecords - localSummary.totalRecords
            if (diff > 0) return <p className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3">PC端多 <strong>{diff}</strong> 条记录，建议 <strong>从PC拉取</strong> 到手机。</p>
            if (diff < 0) return <p className="text-sm text-amber-700 bg-amber-50 rounded-lg p-3">手机端多 <strong>{Math.abs(diff)}</strong> 条记录，建议 <strong>推送到PC</strong>。</p>
            return <p className="text-sm text-gray-500 bg-gray-50 rounded-lg p-3">双方数据量一致。如果内容有差异，请根据实际情况选择方向。</p>
          })()}

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setConfirmAction('pull')}
              disabled={loading}
              className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              PC → 手机
            </button>
            <button
              onClick={() => setConfirmAction('push')}
              disabled={loading}
              className="px-4 py-3 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              手机 → PC
            </button>
          </div>

          {/* 确认弹窗 */}
          {confirmAction && (
            <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-red-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <span className="font-semibold text-red-800">
                  {confirmAction === 'pull' ? '确认用PC数据覆盖手机？' : '确认用手机数据覆盖PC？'}
                </span>
              </div>
              <p className="text-xs text-red-700">
                {confirmAction === 'pull'
                  ? `手机现有 ${localSummary.totalRecords} 条记录将被PC的 ${remoteSummary.totalRecords} 条记录替换。操作前会自动备份手机数据。`
                  : `PC现有 ${remoteSummary.totalRecords} 条记录将被手机的 ${localSummary.totalRecords} 条记录替换。`
                }
              </p>
              <div className="flex gap-2">
                <button
                  onClick={confirmAction === 'pull' ? executePull : executePush}
                  disabled={loading}
                  className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium disabled:opacity-50"
                >
                  {loading ? '同步中...' : '确认覆盖'}
                </button>
                <button
                  onClick={() => setConfirmAction(null)}
                  className="px-4 py-2.5 bg-white text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-50 text-sm font-medium"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 状态信息 */}
      {status && (
        <div className={`rounded-xl border p-4 text-sm ${
          status.includes('失败') ? 'bg-red-50 border-red-200 text-red-700' :
          status.includes('成功') ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
          'bg-blue-50 border-blue-200 text-blue-700'
        }`}>
          {status}
        </div>
      )}

      {lastSync && (
        <p className="text-xs text-gray-400 text-center">上次同步: {lastSync}</p>
      )}

      {/* 说明 */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-5 space-y-2">
        <h3 className="font-semibold text-gray-700 text-sm">使用说明</h3>
        <ul className="text-xs text-gray-500 space-y-1.5 list-disc list-inside">
          <li>手机和PC需在同一WiFi/局域网下</li>
          <li>PC端需运行 <code className="bg-white px-1 py-0.5 rounded border">./start.sh</code> 启动服务</li>
          <li>点击<strong>「对比数据」</strong>查看双方数据差异，确认后再选择方向</li>
          <li><strong>PC → 手机</strong>：适用于首次同步、或PC端有更新（如策略调整、净值刷新）</li>
          <li><strong>手机 → PC</strong>：适用于手机端记录了新交易</li>
          <li>覆盖前会自动备份本地数据，可在「数据备份」页恢复</li>
        </ul>
      </div>
    </div>
  )
}
