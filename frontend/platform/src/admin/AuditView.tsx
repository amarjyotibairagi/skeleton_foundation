import { useEffect, useState, type FormEvent } from 'react'
import { Filter, X } from 'lucide-react'
import { useConsole } from '../shell/context'
import { href } from '../shell/router'
import type { AuditEvent } from '../shell/types'
import { Card, Notice, PageHeader, StatusBadge, Table, useAsyncAction } from './ui'

type Filters = { feature: string; action: string; status: string; tenantKey: string }
const emptyFilters: Filters = { feature: '', action: '', status: '', tenantKey: '' }

export function AuditView() {
  const { api } = useConsole()
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [features, setFeatures] = useState<string[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)
  const loader = useAsyncAction()

  const query = (active: Filters, before?: string) => {
    const params = new URLSearchParams({ limit: '100' })
    for (const [key, value] of Object.entries(active)) if (value) params.set(key, value)
    if (before) params.set('before', before)
    return `/api/audit/events?${params}`
  }

  const load = (active = filters, before?: string) =>
    loader.run(async () => {
      const data = await api.get(query(active, before))
      setEvents((current) => (before ? [...current, ...data.events] : data.events))
      setNextBefore(data.nextBefore)
      setFeatures(data.features)
    })
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = Object.fromEntries(Object.keys(emptyFilters).map((key) => [key, String(form.get(key) || '').trim()])) as Filters
    setFilters(next)
    void load(next)
  }
  const clear = () => {
    setFilters(emptyFilters)
    setFormKey((key) => key + 1)
    void load(emptyFilters)
  }
  const filtered = Object.values(filters).some(Boolean)

  return (
    <div className="page">
      <PageHeader title="Audit log" description="Every control-plane action, append-only. Sign-ins, configuration changes, tenant lifecycle and operator management." onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      <Card flush>
        <form key={formKey} className="toolbar" onSubmit={apply} style={{ justifyContent: 'flex-start' }}>
          <select className="input input-inline" name="feature" defaultValue={filters.feature} aria-label="Area">
            <option value="">All areas</option>
            {features.map((feature) => <option key={feature} value={feature}>{feature}</option>)}
          </select>
          <input className="input input-inline" name="action" defaultValue={filters.action} placeholder="Action starts with…" aria-label="Action prefix" />
          <select className="input input-inline" name="status" defaultValue={filters.status} aria-label="Outcome" style={{ minWidth: 150 }}>
            <option value="">Any outcome</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILED">Failed</option>
            <option value="DENIED">Denied</option>
          </select>
          <input className="input input-inline mono" name="tenantKey" defaultValue={filters.tenantKey} placeholder="Tenant key" aria-label="Tenant key" style={{ minWidth: 150 }} />
          <button className="btn btn-primary"><Filter size={14} /> Apply</button>
          {filtered && <button type="button" className="btn btn-ghost" onClick={clear}><X size={14} /> Clear</button>}
        </form>
        <Table minWidth={940}>
          <thead><tr><th>Time (UTC)</th><th>Operator</th><th>Area</th><th>Action</th><th>Tenant</th><th>Resource</th><th>Outcome</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="mono nowrap">{new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td>{event.username || (event.userId ? <span className="mono">{event.userId.slice(0, 8)}</span> : <span className="muted">system</span>)}</td>
                <td>{event.feature}</td>
                <td className="mono">{event.action}</td>
                <td>{event.tenantKey ? <a className="mono" href={href('tenants', event.tenantKey)}>{event.tenantKey}</a> : <span className="muted">—</span>}</td>
                <td className="muted" style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{event.resourceType ? `${event.resourceType}${event.resourceId ? `: ${event.resourceId}` : ''}` : '—'}</td>
                <td><StatusBadge status={event.status} /></td>
              </tr>
            ))}
            {!events.length && !loader.busy && <tr className="empty-row"><td colSpan={7}>No matching events.</td></tr>}
          </tbody>
        </Table>
        {(nextBefore || events.length > 0) && (
          <div className="card-foot">
            <span>{events.length} event(s) shown</span>
            {nextBefore && <button type="button" className="btn btn-sm" disabled={loader.busy} onClick={() => void load(filters, nextBefore)}>Load older events</button>}
          </div>
        )}
      </Card>
    </div>
  )
}
