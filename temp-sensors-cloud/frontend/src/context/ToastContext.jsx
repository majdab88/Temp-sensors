import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react'

const ToastContext = createContext(null)

let idSeq = 0

/**
 * App-wide toasts + a promise-based confirm dialog, replacing the browser's
 * blocking alert()/confirm(). Usage:
 *   const toast = useToast()
 *   toast.success('Saved'); toast.error('Failed to save')
 *   if (await toast.confirm({ title: 'Delete?', danger: true })) { ... }
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [confirmState, setConfirmState] = useState(null)
  const resolveRef = useRef(null)

  const remove = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const push = useCallback((type, message, opts = {}) => {
    const id = ++idSeq
    setToasts((t) => [...t.slice(-3), { id, type, message }]) // keep at most 4
    const ttl = opts.duration ?? (type === 'error' ? 6000 : 3500)
    if (ttl > 0) setTimeout(() => remove(id), ttl)
    return id
  }, [remove])

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolveRef.current = resolve
    setConfirmState(typeof opts === 'string' ? { message: opts } : opts)
  }), [])

  const closeConfirm = useCallback((result) => {
    setConfirmState(null)
    if (resolveRef.current) { resolveRef.current(result); resolveRef.current = null }
  }, [])

  const api = useMemo(() => ({
    success: (m, o) => push('success', m, o),
    error:   (m, o) => push('error', m, o),
    info:    (m, o) => push('info', m, o),
    confirm,
  }), [push, confirm])

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <button key={t.id} className={`toast toast-${t.type}`} onClick={() => remove(t.id)}>
            <span className="toast-icon">{t.type === 'success' ? '✓' : t.type === 'error' ? '!' : 'i'}</span>
            <span className="toast-msg">{t.message}</span>
          </button>
        ))}
      </div>

      {confirmState && (
        <div className="confirm-overlay" onClick={() => closeConfirm(false)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
            {confirmState.title && <h3 className="confirm-title">{confirmState.title}</h3>}
            {confirmState.message && <p className="confirm-msg">{confirmState.message}</p>}
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => closeConfirm(false)}>
                {confirmState.cancelLabel || 'Cancel'}
              </button>
              <button
                className={`btn ${confirmState.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => closeConfirm(true)}
                autoFocus
              >
                {confirmState.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
