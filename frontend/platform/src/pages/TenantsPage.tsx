import { useMemo, useState } from 'react'
import { Building2, ExternalLink, Plus, Search } from 'lucide-react'
import { BUSY_STATES, Card, EmptyState, FAILED_STATES, Notice, PageHeader, Segmented, Skeleton, StatusBadge, Table, formatDay, useResource } from '../admin/ui'
import { useConsole } from '../shell/context'
import { href, navigate } from '../shell/router'
import type { TenantSummary } from '../shell/types'
import { useTenantActions } from './tenantActions'

type Filter = 'all' | 'active' | 'suspended' | 'attention' | 'working'

const FILTERS: Record<Filter, (tenant: TenantSummary) => boolean> = {
  all: () => true,
  active: (tenant) => tenant.status === 'active',
  suspended: (tenant) => tenant.status === 'suspended',
  attention: (tenant) => FAILED_STATES.has(tenant.status),
  working: (tenant) => BUSY_STATES.has(tenant.status),
}

export function TenantsPage() {
  const { api } = useConsole()
  const [poll, setPoll] = useState<number | undefined>(undefined)
  const tenants = useResource<TenantSummary[]>(
    async () => {
      const list: TenantSummary[] = (await api.get('/api/tenants')).tenants
      // Follow running provisioning and removal closely; otherwise refresh now and then.
      setPoll(list.some((tenant) => BUSY_STATES.has(tenant.status)) ? 3000 : 30_000)
      return list
    },
    [api],
    poll,
  )
  const actions = useTenantActions(() => void tenants.reload())
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const list = tenants.data ?? []
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      list
        .filter(FILTERS[filter])
        .filter((tenant) => !q || `${tenant.displayName} ${tenant.tenantId} ${tenant.hostname ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [list, filter, q],
  )
  const count = (id: Filter) => list.filter(FILTERS[id]).length

  return (
    <div className="page">
      <PageHeader
        title="Tenants"
        description="Organisations on the platform. Each has its own subdomain, isolated database schema and administrators."
        onRefresh={() => void tenants.reload()}
        busy={tenants.loading}
        actions={<a className="btn btn-primary" href={href('tenants', 'new')}><Plus size={15} /> New tenant</a>}
      />
      {tenants.error && <Notice tone="error">{tenants.error}</Notice>}
      {actions.error && <Notice tone="error">{actions.error}</Notice>}
      {actions.message && <Notice tone="success">{actions.message}</Notice>}

      <Card flush>
        <div className="toolbar">
          <label className="search">
            <Search size={15} />
            <input className="input" type="search" placeholder="Search name, key or hostname" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search tenants" />
          </label>
          <Segmented
            label="Status"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: 'All', count: list.length },
              { id: 'active', label: 'Active', count: count('active') },
              { id: 'suspended', label: 'Suspended', count: count('suspended') },
              { id: 'attention', label: 'Failing', count: count('attention') },
              { id: 'working', label: 'In progress', count: count('working') },
            ]}
          />
        </div>
        {tenants.loading && !tenants.data ? (
          <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={34} /><Skeleton height={34} /><Skeleton height={34} /></div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Building2 size={20} />} title="No tenants yet" action={<a className="btn btn-primary" href={href('tenants', 'new')}><Plus size={15} /> New tenant</a>}>
            Create a tenant to give an organisation its own workspace.
          </EmptyState>
        ) : (
          <Table minWidth={760}>
            <thead>
              <tr><th>Tenant</th><th>Hostname</th><th>Status</th><th>Created</th><th className="right">Actions</th></tr>
            </thead>
            <tbody>
              {visible.map((tenant) => (
                <tr key={tenant.tenantId} className="row-link" onClick={() => navigate('tenants', tenant.tenantId)}>
                  <td>
                    <a className="cell-title" href={href('tenants', tenant.tenantId)} onClick={(event) => event.stopPropagation()}>{tenant.displayName}</a>
                    <span className="cell-sub mono">{tenant.tenantId}</span>
                  </td>
                  <td>
                    {tenant.hostname ? (
                      tenant.status === 'active' ? (
                        <a className="mono inline-flex" href={`https://${tenant.hostname}`} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                          {tenant.hostname} <ExternalLink size={12} />
                        </a>
                      ) : (
                        <span className="mono">{tenant.hostname}</span>
                      )
                    ) : '—'}
                  </td>
                  <td>
                    <StatusBadge status={tenant.status} />
                    {tenant.jobStatus && ['pending', 'running', 'retrying'].includes(tenant.jobStatus) && tenant.currentStep && (
                      <span className="cell-sub">{tenant.currentStep.replace(/_/g, ' ').toLowerCase()}</span>
                    )}
                  </td>
                  <td className="nowrap muted">{formatDay(tenant.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      {actions.buttons(tenant)}
                      <a className="btn btn-sm" href={href('tenants', tenant.tenantId)} onClick={(event) => event.stopPropagation()}>Manage</a>
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr className="empty-row"><td colSpan={5}>No tenants match this filter.</td></tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
