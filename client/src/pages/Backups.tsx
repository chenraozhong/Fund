import { useEffect, useState } from 'react'
import { api } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

interface Backup {
  filename: string
  size: number
  created_at: string
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function isAuto(filename: string) {
  return filename.includes('_auto')
}

export default function Backups() {
  const [backups, setBackups] = useState<Backup[]>([])
  const [creating, setCreating] = useState(false)
  const [restoreFile, setRestoreFile] = useState<string | null>(null)
  const [deleteFile, setDeleteFile] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = () => api.getBackups().then(setBackups)
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    setCreating(true)
    setMessage(null)
    try {
      const result = await api.createBackup()
      setMessage({ type: 'success', text: `备份创建成功：${result.filename}（${formatSize(result.size)}）` })
      load()
    } catch (err: any) {
      setMessage({ type: 'error', text: `备份失败：${err.message}` })
    } finally {
      setCreating(false)
    }
  }

  const handleRestore = async () => {
    if (!restoreFile) return
    setMessage(null)
    try {
      const result = await api.restoreBackup(restoreFile)
      setMessage({ type: 'success', text: `恢复成功。${result.message}` })
      setRestoreFile(null)
    } catch (err: any) {
      setMessage({ type: 'error', text: `恢复失败：${err.message}` })
      setRestoreFile(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteFile) return
    try {
      await api.deleteBackup(deleteFile)
      setDeleteFile(null)
      load()
    } catch (err: any) {
      setMessage({ type: 'error', text: `删除失败：${err.message}` })
      setDeleteFile(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">数据备份</h1>
          <p className="text-sm text-gray-500 mt-1">
            共 {backups.length} 个备份 &middot; 自动备份每小时一次，最多保留 20 个
          </p>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
          {creating ? '备份中...' : '立即备份'}
        </button>
      </div>

      {/* Message */}
      {message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
          message.type === 'success'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>
          <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            {message.type === 'success'
              ? <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              : <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            }
          </svg>
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-auto text-current opacity-60 hover:opacity-100">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Backup List */}
      {backups.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">暂无备份</h3>
          <p className="text-gray-500 text-sm">点击"立即备份"创建第一个备份。</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-100">
            {backups.map(b => (
              <div key={b.filename} className="px-5 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors">
                {/* Icon */}
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                  isAuto(b.filename) ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-600'
                }`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 font-mono truncate">{b.filename}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      isAuto(b.filename)
                        ? 'bg-gray-100 text-gray-500'
                        : 'bg-blue-50 text-blue-600'
                    }`}>
                      {isAuto(b.filename) ? '自动' : '手动'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {formatTime(b.created_at)} &middot; {formatSize(b.size)}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => setRestoreFile(b.filename)}
                    className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
                  >
                    恢复
                  </button>
                  <button
                    onClick={() => setDeleteFile(b.filename)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Restore Confirm */}
      <ConfirmDialog
        open={restoreFile !== null}
        title="恢复数据"
        message={`确定要从备份 "${restoreFile}" 恢复数据吗？当前数据将被覆盖，建议先手动备份。恢复后需要刷新页面。`}
        confirmText="恢复"
        confirmColor="bg-amber-600 hover:bg-amber-700"
        onConfirm={handleRestore}
        onCancel={() => setRestoreFile(null)}
      />

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteFile !== null}
        title="删除备份"
        message={`确定要删除备份 "${deleteFile}" 吗？此操作不可撤销。`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteFile(null)}
      />
    </div>
  )
}
