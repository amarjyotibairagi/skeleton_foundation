import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, CheckCircle2, Copy, Info, MoreHorizontal, RefreshCw, X, XCircle } from 'lucide-react'
import { ApiError } from './api'

// Shared building blocks of the platform console. Pages compose these; styling
// lives in theme.css so light and dark themes stay identical in structure.

export function PageHeader({ title, description, meta, actions, onRefresh, busy, badge }: {
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  onRefresh?: () => void
  busy?: boolean
  badge?: ReactNode
}) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        <div className="page-title-row">
          <h1 className="page-title">{title}</h1>
          {badge}
        </div>
        {description && <p className="page-desc">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {(actions || onRefresh) && (
        <div className="actions">
          {onRefresh && (
            <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
              <RefreshCw size={14} className={busy ? 'spin' : undefined} />
              Refresh
            </button>
          )}
          {actions}
        </div>
      )}
    </header>
  )
}

export function Card({ title, subtitle, icon, actions, children, footer, flush, id }: {
  title?: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  flush?: boolean
  id?: string
}) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="card-title">{icon}{title}</h2>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  )
}

const noticeIcon = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle }

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode; action?: ReactNode }) {
  const Icon = noticeIcon[tone]
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  )
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

export function Badge({ tone = 'neutral', dot, mono, children, title }: { tone?: Tone; dot?: boolean; mono?: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={`badge${tone === 'neutral' ? '' : ` badge-${tone}`}${mono ? ' badge-mono' : ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  )
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  active: { tone: 'good', label: 'Active' },
  provisioning: { tone: 'info', label: 'Provisioning' },
  suspended: { tone: 'warn', label: 'Suspended' },
  migration_failed: { tone: 'bad', label: 'Migration failed' },
  provisioning_failed: { tone: 'bad', label: 'Provisioning failed' },
  deleting: { tone: 'info', label: 'Removing' },
  deletion_failed: { tone: 'bad', label: 'Removal failed' },
  succeeded: { tone: 'good', label: 'Succeeded' },
  failed: { tone: 'bad', label: 'Failed' },
  running: { tone: 'info', label: 'Running' },
  pending: { tone: 'neutral', label: 'Pending' },
  retrying: { tone: 'warn', label: 'Retrying' },
  rolled_back: { tone: 'warn', label: 'Rolled back' },
  SUCCESS: { tone: 'good', label: 'Success' },
  FAILED: { tone: 'bad', label: 'Failed' },
  DENIED: { tone: 'bad', label: 'Denied' },
}

/** Lifecycle and job states with a consistent colour, dot and readable label. */
export function StatusBadge({ status }: { status: string }) {
  const known = STATUS[status] ?? { tone: /fail/i.test(status) ? 'bad' : 'neutral', label: status.replace(/_/g, ' ') }
  return <Badge tone={known.tone} dot>{known.label}</Badge>
}

export const FAILED_STATES = new Set(['migration_failed', 'provisioning_failed', 'deletion_failed'])
export const BUSY_STATES = new Set(['provisioning', 'deleting'])

export function Field({ label, hint, optional, children, className }: { label: string; hint?: ReactNode; optional?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={`field${className ? ` ${className}` : ''}`}>
      <span className="field-label">
        {label}
        {optional && <em> (optional)</em>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

export function Table({ children, minWidth }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="table-wrap">
      <table className="table" style={minWidth ? { minWidth } : undefined}>{children}</table>
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}

export function Skeleton({ height = 16, width = '100%', radius }: { height?: number; width?: number | string; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />
}

export function Stat({ label, value, unit, foot, icon, href }: { label: string; value: ReactNode; unit?: string; foot?: ReactNode; icon?: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="stat-label">
        <span>{label}</span>
        {icon}
      </div>
      <div className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="stat-foot">{foot}</div>
    </>
  )
  return href ? <a className="stat" href={href}>{body}</a> : <div className="stat">{body}</div>
}

/**
 * Utilisation bar. The tone (and its written note) changes at the warning and
 * critical thresholds, so the state never relies on colour alone.
 */
export function Meter({ label, percent, value, detail, secondary, warnAt = 80, badAt = 92, note }: {
  label: string
  percent: number
  value: ReactNode
  detail?: ReactNode
  secondary?: number
  warnAt?: number
  badAt?: number
  note?: ReactNode
}) {
  const pct = Math.max(0, Math.min(100, percent))
  const tone = pct >= badAt ? 'bad' : pct >= warnAt ? 'warn' : 'ok'
  return (
    <div className="meter" data-tone={tone}>
      <div className="meter-row">
        <span>{label}</span>
        <b>
          {value}
          {detail && <small>{detail}</small>}
        </b>
      </div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
        {secondary !== undefined && secondary > 0 && <div className="meter-fill alt" style={{ width: `${Math.min(100 - pct, secondary)}%` }} />}
      </div>
      {(note || tone !== 'ok') && (
        <div className="meter-note">
          {tone !== 'ok' && <AlertTriangle size={12} />}
          {tone === 'bad' ? 'Critical' : tone === 'warn' ? 'High' : null}
          {tone !== 'ok' && note ? ' · ' : null}
          {note}
        </div>
      )}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, active, onChange, label }: {
  tabs: Array<{ id: T; label: string; href?: string; count?: number }>
  active: T
  onChange?: (id: T) => void
  label: string
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) =>
        tab.href ? (
          <a key={tab.id} className="tab" role="tab" aria-selected={tab.id === active} href={tab.href}>
            {tab.label}
            {tab.count !== undefined && <Badge>{tab.count}</Badge>}
          </a>
        ) : (
          <button key={tab.id} type="button" className="tab" role="tab" aria-selected={tab.id === active} onClick={() => onChange?.(tab.id)}>
            {tab.label}
            {tab.count !== undefined && <Badge>{tab.count}</Badge>}
          </button>
        ),
      )}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: Array<{ id: T; label: string; count?: number }>
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={option.id === value} onClick={() => onChange(option.id)}>
          {option.label}
          {option.count !== undefined && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Closes a popover on outside click or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

/**
 * Overflow menu for table rows. The menu is portalled to <body> and placed
 * against the trigger, so scrolling table containers never clip it.
 */
export function RowMenu({ label, disabled, children }: { label: string; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const up = window.innerHeight - rect.bottom < 240
    setPos({ top: up ? rect.top - 6 : rect.bottom + 6, right: window.innerWidth - rect.right, up })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close()
    const onScroll = () => close()
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])
  return (
    <>
      <button ref={trigger} type="button" className="btn btn-sm btn-icon" disabled={disabled} onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }} aria-haspopup="menu" aria-expanded={open} aria-label={label}>
        <MoreHorizontal size={15} />
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menu}
            className="menu"
            role="menu"
            style={{ position: 'fixed', top: pos.up ? 'auto' : pos.top, bottom: pos.up ? window.innerHeight - pos.top : 'auto', right: pos.right, left: 'auto', textAlign: 'left' }}
            onClick={(event) => event.stopPropagation()}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  )
}

export function Modal({ title, description, icon, tone, onClose, children, footer, width }: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  tone?: 'danger'
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = dialogRef.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-close)')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose])
  return (
    <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={width ? { maxWidth: width } : undefined}>
        <div className="modal-head">
          {icon && <div className="modal-icon" data-tone={tone}>{icon}</div>}
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="btn btn-ghost btn-icon btn-sm modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ confirm dialog

type ConfirmOptions = {
  title: string
  body?: ReactNode
  confirmLabel?: string
  tone?: 'danger'
  /** The operator must type this exact text to enable the confirm button. */
  typeToConfirm?: string
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null)
  const [typed, setTyped] = useState('')
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped('')
        setRequest({ ...options, resolve })
      }),
    [],
  )
  const finish = useCallback(
    (ok: boolean) => {
      request?.resolve(ok)
      setRequest(null)
    },
    [request],
  )
  const close = useCallback(() => finish(false), [finish])
  const matches = !request?.typeToConfirm || typed.trim().toLowerCase() === request.typeToConfirm.toLowerCase()
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal
          title={request.title}
          icon={<AlertTriangle size={18} />}
          tone={request.tone}
          onClose={close}
          footer={
            <>
              <button type="button" className="btn" onClick={close}>Cancel</button>
              <button
                type="button"
                className={`btn ${request.tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}`}
                disabled={!matches}
                onClick={() => finish(true)}
              >
                {request.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          {request.body && <div>{request.body}</div>}
          {request.typeToConfirm && (
            <Field label={`Type ${request.typeToConfirm} to confirm`}>
              <input
                className="input mono"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches) finish(true)
                }}
              />
            </Field>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export const useConfirm = () => useContext(ConfirmContext)

// ------------------------------------------------------------------ one-time secrets

/** Displays a secret link that cannot be retrieved again, with a copy button. */
export function OneTimeLink({ label, link, delivered }: { label: string; link: string; delivered?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="onetime">
      <div className="onetime-label">
        {label}
        {delivered ? <Badge tone="good">Sent by email</Badge> : <Badge tone="warn">Not sent: share it securely</Badge>}
      </div>
      <div className="onetime-row">
        <code className="onetime-link">{link}</code>
        <CopyButton text={link} copied={copied} onCopied={setCopied} />
      </div>
      <div className="hint">Shown once. The platform stores only a hash of this link; issue a new one if it is lost.</div>
    </div>
  )
}

export function CopyButton({ text, label = 'Copy', copied: controlled, onCopied, small }: { text: string; label?: string; copied?: boolean; onCopied?: (copied: boolean) => void; small?: boolean }) {
  const [own, setOwn] = useState(false)
  const copied = controlled ?? own
  const set = onCopied ?? setOwn
  return (
    <button
      type="button"
      className={`btn${small ? ' btn-sm' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard.writeText(text).then(() => {
          set(true)
          window.setTimeout(() => set(false), 1500)
        })
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

// ------------------------------------------------------------------ formatting

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function formatRelative(value: string | number | null | undefined): string {
  if (!value) return '—'
  const time = typeof value === 'number' ? value : new Date(value).getTime()
  if (Number.isNaN(time)) return '—'
  const seconds = Math.round((Date.now() - time) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return formatDay(new Date(time).toISOString())
}

export function formatUptime(seconds: number) {
  if (!seconds) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ')
}

export const roleLabel = (role: string) => role.replace('platform_', '').replace(/^./, (c) => c.toUpperCase())

// ------------------------------------------------------------------ async helpers

export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await action()
      if (result) setMessage(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action failed.')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, message, run, setError, setMessage }
}

/**
 * Loads one resource, optionally polling while the page is visible. A refresh
 * keeps the previous data on screen; `forbidden` marks a 403 so a panel can
 * explain the missing role instead of showing an error.
 */
export function useResource<T>(load: (() => Promise<T>) | null, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  // The server wants a recent security-key check before it answers (live server
  // data). The last data stays on screen and polling pauses until verified.
  const [needsStepUp, setNeedsStepUp] = useState(false)
  const [loading, setLoading] = useState(Boolean(load))
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const loader = useRef(load)
  loader.current = load
  const paused = useRef(false)
  const reload = useCallback(async () => {
    if (!loader.current) return
    setLoading(true)
    try {
      setData(await loader.current())
      setError(null)
      setForbidden(false)
      setNeedsStepUp(false)
      paused.current = false
      setUpdatedAt(Date.now())
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'MFA_STEP_UP_REQUIRED') {
        setNeedsStepUp(true)
        paused.current = true
      } else if (caught instanceof ApiError && caught.status === 403) setForbidden(true)
      else setError(caught instanceof Error ? caught.message : 'Could not load.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    if (!pollMs || !load) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !paused.current) void reload()
    }, pollMs)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, reload, ...deps])
  return { data, error, forbidden, needsStepUp, loading, reload, updatedAt, setData }
}
