import { useState } from 'react'
import { ArrowUpCircle } from 'lucide-react'
import { useConsole } from '../shell/context'
import { href, navigate } from '../shell/router'
import type { Fleet } from '../shell/types'
import { Badge, Card, EmptyState, Notice, PageHeader, Skeleton, Stat, StatusBadge, Table, formatDate, useAsyncAction, useConfirm, useResource } from './ui'

export function FleetView() {
  const { api } = useConsole()
  const confirm = useConfirm()
  const fleet = useResource<Fleet>(() => api.get('/api/fleet/status'), [api], 30_000)
  const action = useAsyncAction()
  const [queued, setQueued] = useState<Array<{ tenantId: string; jobId?: string; error?: string }>>([])

  const upgradeAll = async () => {
    const data = fleet.data
    if (!data) return
    const ok = await confirm({
      title: 'Upgrade every tenant that is behind?',
      body: <>Queues a schema upgrade to v{data.latestSchemaVersion} for {data.summary.behind + data.summary.failed} tenant(s). The worker runs them one at a time; each tenant is briefly in maintenance.</>,
      confirmLabel: 'Queue upgrades',
    })
    if (!ok) return
    void action.run(async () => {
      const result = await api.send('POST', '/api/fleet/migrate')
      setQueued(result.jobs)
      window.setTimeout(() => void fleet.reload(), 3000)
      return `${result.queued} upgrade(s) queued.`
    })
  }

  const data = fleet.data
  const needsUpgrade = data ? data.summary.behind + data.summary.failed > 0 : false
  return (
    <div className="page">
      <PageHeader
        title="Fleet & schema"
        description="Database schema versions and lifecycle failures across every tenant, and how background jobs have fared."
        onRefresh={() => void fleet.reload()}
        busy={fleet.loading}
        actions={needsUpgrade && <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void upgradeAll()}><ArrowUpCircle size={15} /> Upgrade all behind</button>}
      />
      {fleet.error && <Notice tone="error">{fleet.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {queued.some((job) => job.error) && <Notice tone="error">{queued.filter((job) => job.error).map((job) => `${job.tenantId}: ${job.error}`).join(' · ')}</Notice>}

      <div className="stats">
        <Stat label="Tenants" value={data ? data.summary.total : '—'} />
        <Stat label="Latest schema" value={data ? `v${data.latestSchemaVersion}` : '—'} foot={data ? <>{data.summary.current} tenant(s) current</> : null} />
        <Stat label="Behind" value={data ? data.summary.behind : '—'} foot={data?.summary.behind ? <Badge tone="warn" dot>Upgrade pending</Badge> : 'None'} />
        <Stat label="Failed upgrades" value={data ? data.summary.failed : '—'} foot={data?.summary.failed ? <Badge tone="bad" dot>Needs attention</Badge> : 'None'} />
      </div>

      <Card title="Tenants" subtitle="Select a tenant to manage it" flush>
        {!data ? (
          <div style={{ padding: 18 }}><Skeleton height={80} /></div>
        ) : data.tenants.length === 0 ? (
          <EmptyState title="No tenants yet" />
        ) : (
          <Table minWidth={760}>
            <thead><tr><th>Tenant</th><th>Status</th><th>Schema</th><th>Plan</th><th>Last error</th></tr></thead>
            <tbody>
              {data.tenants.map((tenant) => (
                <tr key={tenant.tenantId} className="row-link" onClick={() => navigate('tenants', tenant.tenantId)}>
                  <td>
                    <a className="cell-title" href={href('tenants', tenant.tenantId)} onClick={(event) => event.stopPropagation()}>{tenant.displayName}</a>
                    <span className="cell-sub mono">{tenant.tenantId}</span>
                  </td>
                  <td><StatusBadge status={tenant.status} /></td>
                  <td>
                    <span className="badges">
                      <span className="num">v{tenant.schemaVersion}</span>
                      {tenant.schemaVersion < data.latestSchemaVersion ? <Badge tone="warn">Behind</Badge> : <Badge tone="good">Current</Badge>}
                    </span>
                  </td>
                  <td>{tenant.planCode ?? <span className="muted">None</span>}</td>
                  <td>{tenant.lastErrorCode ? <><Badge tone="bad" mono>{tenant.lastErrorCode}</Badge><span className="cell-sub">{formatDate(tenant.lastErrorAt)}</span></> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Jobs in the last 30 days" flush>
        {!data ? null : data.jobs30d.length === 0 ? (
          <EmptyState title="No jobs in the last 30 days" />
        ) : (
          <Table>
            <thead><tr><th>Job</th><th>Status</th><th className="right">Count</th></tr></thead>
            <tbody>
              {[...data.jobs30d].sort((a, b) => a.jobType.localeCompare(b.jobType) || b.count - a.count).map((row) => (
                <tr key={`${row.jobType}-${row.status}`}>
                  <td style={{ textTransform: 'capitalize' }}>{row.jobType.replace(/_/g, ' ')}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="right num strong">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
