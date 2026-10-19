import type { ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Cpu,
  FileText,
  Globe,
  Layers,
  Loader2,
  Plus,
  Server,
  User,
  XCircle,
} from 'lucide-react'
import {
  BUSY_STATES,
  Badge,
  Card,
  EmptyState,
  FAILED_STATES,
  Meter,
  Notice,
  PageHeader,
  Skeleton,
  Stat,
  StatusBadge,
  Table,
  formatRelative,
  formatUptime,
  roleLabel,
  useResource,
} from '../admin/ui'
import { isAdmin, useConsole } from '../shell/context'
import { href } from '../shell/router'
import { StepUpPrompt } from './StepUp'
import { normalizeService, type AuditEvent, type DnsRecord, type Fleet, type HardwareData, type ServiceItem, type TenantSummary } from '../shell/types'

type Issue = { tone: 'bad' | 'warn' | 'info'; title: string; detail: string; link: string }

export function DashboardPage() {
  const { api, user, productName } = useConsole()
  const admin = isAdmin(user)

  const tenants = useResource<TenantSummary[]>(admin ? async () => (await api.get('/api/tenants')).tenants : null, [api], 20_000)
  const fleet = useResource<Fleet>(admin ? () => api.get('/api/fleet/status') : null, [api], 60_000)
  const hardware = useResource<HardwareData>(admin ? () => api.get('/api/system/hardware') : null, [api], 15_000)
  const services = useResource<ServiceItem[]>(admin ? async () => (await api.get('/api/system/services')).services.map(normalizeService) : null, [api], 30_000)
  const audit = useResource<AuditEvent[]>(admin ? async () => (await api.get('/api/audit/events?limit=8')).events : null, [api], 30_000)
  const consumers = useResource<{ total: number; byStatus: Record<string, number>; activeSessions: number }>(
    admin ? async () => (await api.get('/api/consumers/stats')).stats : null,
    [api],
    60_000,
  )
  const dns = useResource<{ records: DnsRecord[] }>(() => api.get('/api/cloudflare/subdomains'), [api])
  const plans = useResource<Array<{ planCode: string; isActive: boolean; tenantCount: number }>>(async () => (await api.get('/api/plans')).plans, [api])

  const refreshAll = () => {
    for (const resource of [tenants, fleet, hardware, services, audit, consumers, dns, plans]) void resource.reload()
  }
  const busy = [tenants, fleet, hardware, audit].some((resource) => resource.loading)
  const updatedAt = Math.max(...[tenants, fleet, hardware, dns].map((resource) => resource.updatedAt ?? 0))

  const list = tenants.data ?? []
  const active = list.filter((tenant) => tenant.status === 'active').length
  const suspended = list.filter((tenant) => tenant.status === 'suspended').length
  const failing = list.filter((tenant) => FAILED_STATES.has(tenant.status))
  const working = list.filter((tenant) => BUSY_STATES.has(tenant.status))

  // What an operator should look at first, most severe first.
  const issues: Issue[] = []
  for (const tenant of failing)
    issues.push({ tone: 'bad', title: `${tenant.displayName}: ${tenant.status.replace(/_/g, ' ')}`, detail: tenant.hostname ?? tenant.tenantId, link: href('tenants', tenant.tenantId) })
  if (fleet.data?.summary.failed) issues.push({ tone: 'bad', title: `${fleet.data.summary.failed} tenant schema upgrade(s) failed`, detail: 'Review the error and retry from Fleet & schema', link: href('fleet') })
  if (hardware.data) {
    const { storage, memory, cpu } = hardware.data
    if (storage.usedPercent >= 85) issues.push({ tone: storage.usedPercent >= 92 ? 'bad' : 'warn', title: `Disk ${storage.usedPercent}% full`, detail: `${storage.availGB} GB free on ${storage.filesystem}`, link: href('server') })
    if (memory.usedPercent >= 90) issues.push({ tone: 'warn', title: `Memory ${memory.usedPercent}% used`, detail: `${memory.freeGB} GB free`, link: href('server') })
    if (cpu.loadAvg['5m'] / Math.max(1, cpu.cores) >= 1) issues.push({ tone: 'warn', title: 'CPU saturated', detail: `5-minute load ${cpu.loadAvg['5m']} on ${cpu.cores} cores`, link: href('server') })
  }
  if (fleet.data?.summary.behind) issues.push({ tone: 'warn', title: `${fleet.data.summary.behind} tenant(s) behind schema v${fleet.data.latestSchemaVersion}`, detail: 'Upgrade them from Fleet & schema', link: href('fleet') })
  for (const tenant of working)
    issues.push({ tone: 'info', title: `${tenant.displayName} is ${tenant.status === 'deleting' ? 'being removed' : 'being provisioned'}`, detail: tenant.currentStep ? tenant.currentStep.replace(/_/g, ' ').toLowerCase() : 'Waiting for the worker', link: href('tenants', tenant.tenantId) })
  const deniedRecently = (audit.data ?? []).filter((event) => event.status !== 'SUCCESS').length
  if (deniedRecently) issues.push({ tone: 'info', title: `${deniedRecently} failed or denied action(s) recently`, detail: 'In the latest audit events', link: href('audit') })

  const loadingIssues = admin && (tenants.loading && !tenants.data)

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        description={`${productName} platform at a glance: what needs attention, tenant health and server load.`}
        meta={
          <>
            <span className="inline-flex"><Clock size={13} /> {updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Loading…'}</span>
            <span>Signed in as {roleLabel(user.role).toLowerCase()}</span>
          </>
        }
        onRefresh={refreshAll}
        busy={busy}
        actions={admin && <a className="btn btn-primary" href={href('tenants', 'new')}><Plus size={15} /> New tenant</a>}
      />

      {!admin && (
        <Notice>
          You have read-only access. You can view domains, plans and configuration; tenant, server and audit details need a platform administrator.
        </Notice>
      )}

      {admin && (
        <Card
          title="Needs attention"
          icon={issues.some((issue) => issue.tone === 'bad') ? <XCircle size={16} className="text-bad" /> : issues.length ? <AlertTriangle size={16} className="text-warn" /> : <CheckCircle2 size={16} className="text-good" />}
          actions={issues.length > 0 && <Badge tone={issues.some((issue) => issue.tone === 'bad') ? 'bad' : 'warn'}>{issues.length} item{issues.length === 1 ? '' : 's'}</Badge>}
          flush
        >
          {loadingIssues ? (
            <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={36} /><Skeleton height={36} /></div>
          ) : issues.length === 0 ? (
            <div className="list">
              <div className="list-item">
                <span className="list-icon" data-tone="good"><CheckCircle2 size={16} /></span>
                <div className="list-main">
                  <strong>Everything is running normally</strong>
                  <span>No failed tenants, pending upgrades or resource pressure.</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="list">
              {issues.map((issue, index) => (
                <a key={index} className="list-item" href={issue.link}>
                  <span className="list-icon" data-tone={issue.tone}>
                    {issue.tone === 'bad' ? <XCircle size={16} /> : issue.tone === 'warn' ? <AlertTriangle size={16} /> : <Loader2 size={16} />}
                  </span>
                  <div className="list-main">
                    <strong>{issue.title}</strong>
                    <span>{issue.detail}</span>
                  </div>
                  <span className="list-aside">
                    <Badge tone={issue.tone}>{issue.tone === 'bad' ? 'Critical' : issue.tone === 'warn' ? 'Warning' : 'In progress'}</Badge>
                    <ArrowRight size={14} />
                  </span>
                </a>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="stats">
        {admin ? (
          <>
            <Stat
              label="Active tenants"
              icon={<Building2 size={16} />}
              href={href('tenants')}
              value={tenants.data ? active : '—'}
              unit={tenants.data ? `of ${list.length}` : undefined}
              foot={tenants.data ? <>{suspended} suspended · {failing.length} failing</> : tenants.forbidden ? 'Not available' : null}
            />
            <Stat
              label="Individual accounts"
              icon={<User size={16} />}
              href={href('individuals')}
              value={consumers.data ? consumers.data.total : '—'}
              foot={consumers.data ? <>{consumers.data.activeSessions} signed in now · {consumers.data.byStatus.suspended ?? 0} suspended</> : null}
            />
            <Stat
              label="Schema"
              icon={<Activity size={16} />}
              href={href('fleet')}
              value={fleet.data ? `v${fleet.data.latestSchemaVersion}` : '—'}
              foot={fleet.data ? <>{fleet.data.summary.current} of {fleet.data.summary.total} tenants current</> : null}
            />
          </>
        ) : (
          <Stat
            label="Plans"
            icon={<Layers size={16} />}
            href={href('plans')}
            value={plans.data ? plans.data.filter((plan) => plan.isActive).length : '—'}
            foot={plans.data ? <>{plans.data.length} defined</> : null}
          />
        )}
        <Stat
          label="DNS records"
          icon={<Globe size={16} />}
          href={href('domains')}
          value={dns.data ? dns.data.records.length : '—'}
          foot={dns.data ? <>{dns.data.records.filter((record) => record.proxied).length} proxied through Cloudflare</> : dns.error ? 'Cloudflare unavailable' : null}
        />
      </div>

      {admin && (
        <div className="grid-main">
          <Card
            title="Tenants"
            icon={<Building2 size={16} />}
            subtitle="Problems first, then the most recently created"
            actions={<a className="btn btn-sm" href={href('tenants')}>View all</a>}
            flush
          >
            {tenants.loading && !tenants.data ? (
              <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={28} /><Skeleton height={28} /><Skeleton height={28} /></div>
            ) : list.length === 0 ? (
              <EmptyState icon={<Building2 size={20} />} title="No tenants yet" action={<a className="btn btn-primary" href={href('tenants', 'new')}><Plus size={15} /> Create the first tenant</a>}>
                Each tenant gets its own subdomain, isolated schema and administrator.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr><th>Tenant</th><th>Hostname</th><th>Status</th><th className="right">Created</th></tr>
                </thead>
                <tbody>
                  {[...list]
                    .sort((a, b) => rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt))
                    .slice(0, 6)
                    .map((tenant) => (
                      <tr key={tenant.tenantId} className="row-link" onClick={() => (window.location.hash = href('tenants', tenant.tenantId).slice(1))}>
                        <td>
                          <a className="cell-title" href={href('tenants', tenant.tenantId)} onClick={(event) => event.stopPropagation()}>{tenant.displayName}</a>
                          <span className="cell-sub mono">{tenant.tenantId}</span>
                        </td>
                        <td className="mono">{tenant.hostname ?? '—'}</td>
                        <td><StatusBadge status={tenant.status} /></td>
                        <td className="right nowrap muted">{formatRelative(tenant.createdAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card
            title="Server"
            icon={<Cpu size={16} />}
            subtitle={hardware.data ? `${hardware.data.system.hostname} · up ${formatUptime(hardware.data.system.uptimeSeconds)}` : 'Host resources'}
            actions={<a className="btn btn-sm" href={href('server')}>Details</a>}
            footer={
              <>
                <span className="inline-flex"><Server size={13} /> {services.data ? `${services.data.length} services listening` : services.needsStepUp ? 'Services need a security-key check' : 'Services…'}</span>
                <a className="link-arrow" href={href('server', 'services')}>Services <ArrowRight size={13} /></a>
              </>
            }
          >
            {hardware.needsStepUp && <StepUpPrompt what="live server data" stale={!!hardware.data} onVerified={() => { void hardware.reload(); void services.reload() }} />}
            {hardware.data ? <ResourceMeters data={hardware.data} /> : hardware.error ? <Notice tone="error">{hardware.error}</Notice> : !hardware.needsStepUp && <><Skeleton height={34} /><Skeleton height={34} /><Skeleton height={34} /></>}
          </Card>
        </div>
      )}

      {admin && (
        <div className="grid-main">
          <Card title="Recent activity" icon={<FileText size={16} />} subtitle="Latest control-plane actions" actions={<a className="btn btn-sm" href={href('audit')}>Audit log</a>} flush>
            {audit.loading && !audit.data ? (
              <div style={{ padding: 18, display: 'grid', gap: 10 }}><Skeleton height={30} /><Skeleton height={30} /></div>
            ) : !audit.data?.length ? (
              <EmptyState title="No activity yet" />
            ) : (
              <div className="list">
                {audit.data.map((event) => (
                  <div key={event.id} className="list-item">
                    <span className="list-icon" data-tone={event.status === 'SUCCESS' ? 'good' : 'bad'}>
                      {event.status === 'SUCCESS' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                    </span>
                    <div className="list-main">
                      <strong className="mono" style={{ fontSize: 12.5 }}>{event.action}</strong>
                      <span>{event.username ?? 'system'} · {event.feature}{event.tenantKey ? ` · ${event.tenantKey}` : ''}</span>
                    </div>
                    <span className="list-aside nowrap" title={new Date(event.timestamp).toLocaleString()}>{formatRelative(event.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Jobs · last 30 days" icon={<Activity size={16} />} subtitle="Provisioning, upgrade and removal outcomes" flush>
            {fleet.data ? <JobSummary rows={fleet.data.jobs30d} /> : <div style={{ padding: 18 }}><Skeleton height={60} /></div>}
          </Card>
        </div>
      )}
    </div>
  )
}

const rank = (tenant: TenantSummary) => (FAILED_STATES.has(tenant.status) ? 2 : BUSY_STATES.has(tenant.status) ? 1 : 0)

export function ResourceMeters({ data }: { data: HardwareData }) {
  const loadPct = (data.cpu.loadAvg['1m'] / Math.max(1, data.cpu.cores)) * 100
  const cache = ((data.memory.cachedBytes + data.memory.buffersBytes) / Math.max(1, data.memory.totalBytes)) * 100
  return (
    <>
      <Meter label="CPU load" percent={loadPct} value={`${Math.round(loadPct)}%`} detail={`load ${data.cpu.loadAvg['1m']} / ${data.cpu.cores} cores`} warnAt={75} badAt={100} />
      <Meter label="Memory" percent={data.memory.usedPercent} secondary={cache} value={`${data.memory.usedPercent}%`} detail={`${data.memory.usedGB} of ${data.memory.totalGB} GB`} warnAt={85} badAt={95} note={<>Light segment: cache and buffers</>} />
      <Meter label="Disk" percent={data.storage.usedPercent} value={`${data.storage.usedPercent}%`} detail={`${data.storage.usedGB} of ${data.storage.totalGB} GB`} warnAt={85} badAt={92} />
    </>
  )
}

function JobSummary({ rows }: { rows: Fleet['jobs30d'] }) {
  const types = [...new Set(rows.map((row) => row.jobType))].sort()
  if (!types.length) return <EmptyState title="No jobs in the last 30 days" />
  const count = (type: string, match: (status: string) => boolean) => rows.filter((row) => row.jobType === type && match(row.status)).reduce((sum, row) => sum + row.count, 0)
  const cell = (value: number, tone: 'good' | 'bad' | 'neutral'): ReactNode => (value ? <Badge tone={tone}>{value}</Badge> : <span className="muted">0</span>)
  return (
    <Table>
      <thead>
        <tr><th>Job</th><th className="right">Succeeded</th><th className="right">Failed</th><th className="right">Other</th></tr>
      </thead>
      <tbody>
        {types.map((type) => {
          const ok = count(type, (status) => status === 'succeeded')
          const failed = count(type, (status) => status === 'failed' || status === 'rolled_back')
          const other = count(type, (status) => !['succeeded', 'failed', 'rolled_back'].includes(status))
          return (
            <tr key={type}>
              <td className="strong" style={{ textTransform: 'capitalize' }}>{type.replace(/_/g, ' ')}</td>
              <td className="right">{cell(ok, 'good')}</td>
              <td className="right">{cell(failed, 'bad')}</td>
              <td className="right">{cell(other, 'neutral')}</td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}
