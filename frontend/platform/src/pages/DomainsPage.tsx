import { useMemo, useState, type FormEvent } from 'react'
import { ExternalLink, Globe, Lock, Plus, Search, Trash2 } from 'lucide-react'
import { Badge, Card, CopyButton, EmptyState, Field, Modal, Notice, PageHeader, Skeleton, Stat, StatusBadge, Table, formatDay, useConfirm, useResource } from '../admin/ui'
import { isAdmin, isOwner, useConsole } from '../shell/context'
import { href } from '../shell/router'
import type { DnsRecord, DnsZone, TenantSummary } from '../shell/types'
import { useTenantActions } from './tenantActions'


export function DomainsPage() {
  const { api, user, tenantRootDomain } = useConsole()
  const confirm = useConfirm()
  const owner = isOwner(user)
  const dns = useResource<{ records: DnsRecord[]; zone: DnsZone | null }>(async () => {
    const data = await api.get('/api/cloudflare/subdomains')
    return { records: data.records ?? [], zone: data.zone ?? null }
  }, [api])
  const tenants = useResource<TenantSummary[]>(isAdmin(user) ? async () => (await api.get('/api/tenants')).tenants : null, [api])
  const actions = useTenantActions(() => void tenants.reload())
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [external, setExternal] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const records = dns.data?.records ?? []
  const zoneName = dns.data?.zone?.name ?? tenantRootDomain
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => records.filter((record) => !q || `${record.name} ${record.type} ${record.content}`.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)),
    [records, q],
  )
  // The platform's own hostnames: deleting them would take a surface offline,
  // so the console never offers it, whatever the server reports.
  const root = (zoneName || tenantRootDomain).toLowerCase()
  const protectedNames = new Set([root, `www.${root}`, `platform.${root}`, `user.${root}`, `*.${root}`])
  const isProtected = (record: DnsRecord) => protectedNames.has(record.name.trim().toLowerCase())
  const deletable = (record: DnsRecord) => record.managed === true && !isProtected(record)

  const remove = async (record: DnsRecord) => {
    if (!(await confirm({ title: `Delete ${record.name}?`, body: 'The DNS record is removed from Cloudflare. Anything served on this hostname stops resolving.', confirmLabel: 'Delete record', tone: 'danger' }))) return
    try {
      await api.send('DELETE', `/api/cloudflare/subdomains?id=${encodeURIComponent(record.id)}`)
      setNotice({ tone: 'success', text: `${record.name} deleted.` })
      void dns.reload()
    } catch (caught) {
      setNotice({ tone: 'error', text: caught instanceof Error ? caught.message : 'The record could not be deleted.' })
    }
  }

  const hostnames = (tenants.data ?? []).filter((tenant) => tenant.hostname)
  const routing = (hostname: string) => {
    const lower = hostname.toLowerCase()
    if (records.some((record) => record.name.toLowerCase() === lower)) return 'Own DNS record'
    if (records.some((record) => record.name.startsWith('*.') && lower.endsWith(record.name.slice(1).toLowerCase()))) return `Wildcard *.${tenantRootDomain}`
    return records.length ? 'No DNS route' : '—'
  }

  return (
    <div className="page">
      <PageHeader
        title="Domains"
        description={<>DNS records in the <span className="mono">{zoneName || 'Cloudflare'}</span> zone and the hostnames tenants are served on.</>}
        onRefresh={() => { void dns.reload(); void tenants.reload() }}
        busy={dns.loading}
        actions={
          owner && (
            <>
              <button type="button" className="btn" onClick={() => setExternal(true)}><ExternalLink size={14} /> External domain</button>
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> Add subdomain</button>
            </>
          )
        }
      />
      {dns.error && <Notice tone="error">Cloudflare could not be reached: {dns.error}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {actions.error && <Notice tone="error">{actions.error}</Notice>}
      {actions.message && <Notice tone="success">{actions.message}</Notice>}

      <div className="stats">
        <Stat label="DNS records" icon={<Globe size={16} />} value={dns.data ? records.length : '—'} foot={dns.data?.zone ? <>Zone {dns.data.zone.status}</> : null} />
        <Stat label="Proxied" value={dns.data ? records.filter((record) => record.proxied).length : '—'} foot="Served through Cloudflare's edge" />
        <Stat label="Managed by this platform" value={dns.data ? records.filter((record) => record.managed).length : '—'} foot="Point at this deployment's tunnel" />
        {isAdmin(user) && <Stat label="Tenant hostnames" value={tenants.data ? hostnames.length : '—'} foot={tenants.data ? <>{hostnames.filter((tenant) => tenant.status === 'active').length} serving</> : null} />}
      </div>

      {isAdmin(user) && (
        <Card title="Tenant hostnames" subtitle="Tenants are usually served by the wildcard record. Suspending a tenant takes its hostname offline; removing it releases the name." flush>
          {tenants.loading && !tenants.data ? (
            <div style={{ padding: 18 }}><Skeleton height={60} /></div>
          ) : hostnames.length === 0 ? (
            <EmptyState title="No tenant hostnames yet" />
          ) : (
            <Table minWidth={760}>
              <thead><tr><th>Hostname</th><th>Tenant</th><th>Status</th><th>Routed by</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {hostnames.map((tenant) => (
                  <tr key={tenant.tenantId}>
                    <td>
                      {tenant.status === 'active' ? (
                        <a className="mono inline-flex strong" href={`https://${tenant.hostname}`} target="_blank" rel="noreferrer">{tenant.hostname} <ExternalLink size={12} /></a>
                      ) : (
                        <span className="mono strong">{tenant.hostname}</span>
                      )}
                    </td>
                    <td><a href={href('tenants', tenant.tenantId)}>{tenant.displayName}</a></td>
                    <td><StatusBadge status={tenant.status} /></td>
                    <td className="muted">{routing(tenant.hostname!)}</td>
                    <td>{actions.buttons(tenant)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Card flush>
        <div className="toolbar">
          <label className="search">
            <Search size={15} />
            <input className="input" type="search" placeholder="Filter by name, type or target" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter DNS records" />
          </label>
          <span className="toolbar-note">{visible.length} of {records.length} records</span>
        </div>
        {dns.loading && !dns.data ? (
          <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} /></div>
        ) : (
          <Table minWidth={880}>
            <thead><tr><th>Name</th><th>Type</th><th>Target</th><th>Proxy</th><th>TTL</th><th>Modified</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {visible.map((record) => (
                <tr key={record.id}>
                  <td>
                    <span className="badges">
                      <span className="mono strong">{record.name}</span>
                      {isProtected(record) && <Badge title="System hostname: cannot be deleted"><Lock size={11} /> Protected</Badge>}
                      {record.managed && !isProtected(record) && <Badge tone="accent">Platform</Badge>}
                    </span>
                  </td>
                  <td><Badge mono tone={record.type === 'CNAME' ? 'info' : 'neutral'}>{record.type}</Badge></td>
                  <td className="mono" style={{ maxWidth: 300, overflowWrap: 'anywhere' }}>{record.content}</td>
                  <td>{record.proxied ? <Badge tone="warn" dot>Proxied</Badge> : <Badge dot>DNS only</Badge>}</td>
                  <td className="muted">{record.ttl === 1 ? 'Auto' : `${record.ttl}s`}</td>
                  <td className="muted nowrap" title={new Date(record.modified_on).toUTCString()}>{formatDay(record.modified_on)}</td>
                  <td>
                    <div className="row-actions">
                      <CopyButton text={record.name} small />
                      {owner && deletable(record) && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(record)}><Trash2 size={13} /> Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && <tr className="empty-row"><td colSpan={7}>{records.length ? 'No records match this filter.' : 'No DNS records.'}</td></tr>}
            </tbody>
          </Table>
        )}
      </Card>

      {creating && <CreateSubdomain zone={zoneName} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); setNotice({ tone: 'success', text: `${name} created.` }); void dns.reload() }} />}
      {external && (
        <Modal title="Attach an external domain" icon={<ExternalLink size={18} />} onClose={() => setExternal(false)} footer={<button type="button" className="btn" onClick={() => setExternal(false)}>Close</button>}>
          Customer-owned domains are not available yet. That workflow will cover ownership verification, DNS instructions, certificate activation and routing, separately from {zoneName} subdomains.
        </Modal>
      )}
    </div>
  )
}

function CreateSubdomain({ zone, onClose, onCreated }: { zone: string; onClose: () => void; onCreated: (name: string) => void }) {
  const { api } = useConsole()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!label) return setError('Enter a subdomain.')
    setBusy(true)
    setError(null)
    try {
      await api.send('POST', '/api/cloudflare/subdomains', { label })
      onCreated(`${label}.${zone}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The subdomain could not be created.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Add a subdomain"
      description="Record type, target and proxy are set by the platform: a proxied CNAME to this deployment's tunnel."
      icon={<Plus size={18} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="create-subdomain" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create subdomain'}</button>
        </>
      }
    >
      <form id="create-subdomain" onSubmit={(event) => void submit(event)} className="form">
        <Field label="Subdomain" hint="This only reserves the DNS name. A tenant is served on it once one is provisioned with this subdomain.">
          <div className="input-group">
            <input
              className="input mono"
              value={label}
              onChange={(event) => setLabel(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="acme"
              maxLength={63}
              pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
              required
            />
            <span className="input-addon">.{zone}</span>
          </div>
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </form>
    </Modal>
  )
}
