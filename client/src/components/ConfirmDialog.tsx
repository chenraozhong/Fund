interface Props {
  open: boolean
  title: string
  message: string
  confirmText?: string
  confirmColor?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmText = '删除', confirmColor = 'bg-red-600 hover:bg-red-700', onConfirm, onCancel }: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-gray-600 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200">
            取消
          </button>
          <button onClick={onConfirm} className={`px-4 py-2 text-sm text-white rounded-md ${confirmColor}`}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
