import { useState, type FormEvent } from 'react'
import { ArrowUpCircle, ExternalLink } from 'lucide-react'
import type { ConfigDefinition } from '../admin/ConfigEditor'
import { ConfigEditor } from '../admin/ConfigEditor'
import { IntegrationsPanel, JobProgress } from '../admin/IntegrationsPanel'
import {
  BUSY_STATES,
  Badge,
  Card,
  EmptyState,
  Field,
  Notice,
  OneTimeLink,
  PageHeader,
  Skeleton,
  StatusBadge,
  Table,
  Tabs,
  formatDate,
  useAsyncAction,
  useConfirm,
  useResource,
} from '../admin/ui'
import { useConsole, useCrumb } from '../shell/context'
import { href } from '../shell/router'
import type { TenantLifecycleStatus } from '../shell/types'
import { useTenantActions } from './tenantActions'

type Detail = {
  tenant: Record<string, any>
  domains: Array<{ hostname: string; isPrimary: boolean; status: string }>
  subscription: { planCode: string; planName: string; status: string; periodStart: string } | null
  jobs: Array<{ jobId: string; jobType: string; status: string; currentStep: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null }>
  ownerInvitations: Array<{ invitationId: string; email: string; displayName: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }>
  effectiveConfig: { planCode: string | null; values: Record<string, unknown>; sources: Record<string, string> } | null
  ownerAccount: { username: string; displayName: string; email: string | null; createdAt: string; createdInTenantAt: string | null } | null
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'profile', label: 'Profile & branding' },
  { id: 'plan', label: 'Plan & modules' },
  { id: 'access', label: 'Administrator access' },
  { id: 'storage', label: 'Storage & data' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'jobs', label: 'Jobs' },
] as const
type TabId = (typeof TABS)[number]['id']

export function TenantDetailPage({ tenantKey, tab }: { tenantKey: string; tab?: string }) {
  const { api } = useConsole()
  const active: TabId = TABS.some((item) => item.id === tab) ? (tab as TabId) : 'overview'
  const [pollMs, setPollMs] = useState<number | undefined>()
  const detail = useResource<Detail>(
    async () => {
      const data: Detail = await api.get(`/api/tenants/${encodeURIComponent(tenantKey)}`)
      setPollMs(BUSY_STATES.has(data.tenant.status) ? 3000 : undefined)
      return data
    },
    [api, tenantKey],
    pollMs,
  )
  const definitions = useResource<ConfigDefinition[]>(async () => (await api.get('/api/config/definitions')).definitions, [api])
  const reload = () => void detail.reload()
  const actions = useTenantActions(reload)

  const data = detail.data
  const tenant = data?.tenant
  useCrumb(tenant?.displayName ?? tenantKey)

  if (detail.error && !data)
    return (
      <div className="page">
        <Notice tone="error">{detail.error}</Notice>
        <a className="btn" href={href('tenants')} style={{ alignSelf: 'flex-start' }}>Back to tenants</a>
      </div>
    )
  if (!data || !tenant)
    return (
      <div className="page">
        <Skeleton height={40} width={320} />
        <Skeleton height={40} />
        <Skeleton height={260} />
      </div>
    )

  const hostname = data.domains.find((domain) => domain.isPrimary)?.hostname ?? data.domains[0]?.hostname ?? null
  const actionTenant = {
    tenantId: String(tenant.tenantId),
    displayName: String(tenant.displayName),
    hostname,
    subdomain: hostname ? hostname.split('.')[0] : null,
    status: tenant.status as TenantLifecycleStatus,
    jobId: data.jobs[0]?.jobId ?? null,
    currentStep: data.jobs[0]?.currentStep ?? null,
  }

  return (
    <div className="page">
      <PageHeader
        title={tenant.displayName}
        badge={<StatusBadge status={tenant.status} />}
        meta={
          <>
            <span className="mono">{tenant.tenantId}</span>
            {hostname && <span className="mono">{hostname}</span>}
            <span>{data.subscription ? `${data.subscription.planName} plan` : 'No plan'}</span>
          </>
        }
        onRefresh={reload}
        busy={detail.loading}
        actions={
          <>
            {actions.buttons(actionTenant, 'md')}
            {hostname && tenant.status === 'active' && (
              <a className="btn" href={`https://${hostname}`} target="_blank" rel="noreferrer">Open site <ExternalLink size={14} /></a>
            )}
          </>
        }
      />
      {actions.error && <Notice tone="error">{actions.error}</Notice>}
      {actions.message && <Notice tone="success">{actions.message}</Notice>}
      {tenant.lastErrorCode && (
        <Notice tone="error">
          Last error <code>{tenant.lastErrorCode}</code> at {formatDate(tenant.lastErrorAt)}. See the Jobs tab for the failing step.
        </Notice>
      )}

      <Tabs label="Tenant sections" active={active} tabs={TABS.map((item) => ({ ...item, href: href('tenants', tenantKey, item.id) }))} />

      {active === 'overview' && <Overview tenantKey={tenantKey} data={data} hostname={hostname} onChanged={reload} />}
      {active === 'profile' && <Profile tenantKey={tenantKey} tenant={tenant} onChanged={reload} />}
      {active === 'plan' && <PlanAndModules tenantKey={tenantKey} data={data} definitions={definitions.data ?? []} onChanged={reload} />}
      {active === 'access' && <Access tenantKey={tenantKey} data={data} onChanged={reload} />}
      {active === 'storage' && (
        <IntegrationsPanel api={api} tenantKey={tenantKey} active={{ storage: tenant.storageIntegrationId ?? null, database: tenant.dataIntegrationId ?? null }} onChanged={reload} />
      )}
      {active === 'configuration' && <TenantConfiguration tenantKey={tenantKey} data={data} definitions={definitions.data ?? []} onChanged={reload} />}
      {active === 'jobs' && <Jobs data={data} />}
    </div>
  )
}

function Overview({ tenantKey, data, hostname, onChanged }: { tenantKey: string; data: Detail; hostname: string | null; onChanged: () => void }) {
  const { api } = useConsole()
  const [upgradeJob, setUpgradeJob] = useState<string | null>(null)
  const action = useAsyncAction()
  const tenant = data.tenant
  const behind = tenant.schemaVersion < tenant.latestSchemaVersion
  const enabledModules = Object.entries(data.effectiveConfig?.values ?? {}).filter(([key, value]) => key.startsWith('module.') && value === true).length
  return (
    <div className="grid-main">
      <Card title="Status">
        <dl className="kv">
          <dt>Lifecycle</dt><dd><StatusBadge status={tenant.status} /></dd>
          <dt>Tenant key</dt><dd className="mono">{tenant.tenantId}</dd>
          <dt>Hostname</dt><dd>{hostname ? <span className="mono">{hostname}</span> : '—'}</dd>
          <dt>Other domains</dt><dd>{data.domains.filter((domain) => !domain.isPrimary).map((domain) => <Badge key={domain.hostname} mono>{domain.hostname}</Badge>)}{data.domains.filter((domain) => !domain.isPrimary).length === 0 && <span className="muted">None</span>}</dd>
          <dt>Plan</dt><dd>{data.subscription ? <>{data.subscription.planName} <StatusBadge status={data.subscription.status} /></> : <span className="muted">None</span>}</dd>
          <dt>Modules on</dt><dd>{enabledModules} <a href={href('tenants', tenantKey, 'plan')}>Manage</a></dd>
          <dt>Created</dt><dd>{formatDate(tenant.createdAt)}</dd>
          <dt>Activated</dt><dd>{formatDate(tenant.activatedAt)}</dd>
        </dl>
      </Card>
      <div className="grid">
        <Card title="Database schema">
          <dl className="kv">
            <dt>Version</dt>
            <dd>
              <span className="num">v{tenant.schemaVersion} of v{tenant.latestSchemaVersion}</span>
              {behind ? <Badge tone="warn" dot>Behind</Badge> : <Badge tone="good" dot>Current</Badge>}
            </dd>
            <dt>Connection</dt><dd><Badge tone={tenant.connectionTier === 'pooled' ? 'info' : 'neutral'}>{tenant.connectionTier}</Badge></dd>
            <dt>Data</dt><dd>{tenant.dataIntegrationId ? <Badge tone="info">Tenant database</Badge> : 'On this server'}</dd>
            <dt>Files</dt><dd>{tenant.storageIntegrationId ? <Badge tone="info">Tenant bucket</Badge> : 'On this server'}</dd>
          </dl>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          {upgradeJob ? (
            <JobProgress api={api} jobId={upgradeJob} onDone={() => { setUpgradeJob(null); onChanged() }} />
          ) : (
            <button
              type="button"
              className={`btn${behind ? ' btn-primary' : ''}`}
              disabled={action.busy}
              onClick={() => void action.run(async () => {
                const result = await api.send('POST', `/api/tenants/${encodeURIComponent(tenantKey)}/migrate`)
                setUpgradeJob(result.jobId)
              })}
            >
              <ArrowUpCircle size={15} /> {behind ? 'Upgrade schema' : 'Re-run schema upgrade'}
            </button>
          )}
        </Card>
        <Card title="Administrator">
          {data.ownerAccount ? (
            <dl className="kv">
              <dt>Username</dt><dd className="mono">{data.ownerAccount.username}</dd>
              <dt>Name</dt><dd>{data.ownerAccount.displayName}</dd>
              <dt>State</dt><dd>{data.ownerAccount.createdInTenantAt ? <Badge tone="good" dot>Created</Badge> : <Badge tone="info" dot>Pending provisioning</Badge>}</dd>
            </dl>
          ) : (
            <p className="hint">No login was created at onboarding.</p>
          )}
          <a className="btn" href={href('tenants', tenantKey, 'access')}>Invitations</a>
        </Card>
      </div>
    </div>
  )
}

function Profile({ tenantKey, tenant, onChanged }: { tenantKey: string; tenant: Record<string, any>; onChanged: () => void }) {
  const { api } = useConsole()
  const action = useAsyncAction()
  const [primary, setPrimary] = useState<string>(tenant.primaryColor ?? '#2563eb')
  const [secondary, setSecondary] = useState<string>(tenant.secondaryColor ?? '#0f172a')
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    form.set('primaryColor', primary)
    form.set('secondaryColor', secondary)
    const payload: Record<string, string> = {}
    for (const key of ['displayName', 'legalName', 'locale', 'logoUrl', 'primaryColor', 'secondaryColor', 'loginMessage']) {
      const value = String(form.get(key) ?? '').trim()
      // A legal name cannot be blanked (the server needs at least two characters).
      if (key === 'legalName' && !value) continue
      if (value !== String(tenant[key] ?? '')) payload[key] = value
    }
    void action.run(async () => {
      if (!Object.keys(payload).length) return 'Nothing changed.'
      await api.send('PATCH', `/api/tenants/${encodeURIComponent(tenantKey)}`, payload)
      onChanged()
      return 'Profile saved.'
    })
  }
  return (
    <Card title="Profile & branding" subtitle="Shown on the tenant's sign-in page and workspace">
      <form className="form" onSubmit={save}>
        <div className="form-grid">
          <Field label="Display name"><input className="input" name="displayName" defaultValue={tenant.displayName} maxLength={160} required /></Field>
          <Field label="Legal name" optional><input className="input" name="legalName" defaultValue={tenant.legalName ?? ''} maxLength={240} /></Field>
          <Field label="Locale" hint="For example en or en-GB"><input className="input" name="locale" defaultValue={tenant.locale} /></Field>
          <Field label="Logo URL" optional hint="https only"><input className="input" name="logoUrl" type="url" defaultValue={tenant.logoUrl ?? ''} /></Field>
          <Field label="Primary colour">
            <div className="color-field">
              <input className="input" type="color" value={primary} onChange={(event) => setPrimary(event.target.value)} aria-label="Pick primary colour" />
              <input className="input mono" value={primary} onChange={(event) => setPrimary(event.target.value)} pattern="#[0-9A-Fa-f]{6}" aria-label="Primary colour hex" />
            </div>
          </Field>
          <Field label="Secondary colour">
            <div className="color-field">
              <input className="input" type="color" value={secondary} onChange={(event) => setSecondary(event.target.value)} aria-label="Pick secondary colour" />
              <input className="input mono" value={secondary} onChange={(event) => setSecondary(event.target.value)} pattern="#[0-9A-Fa-f]{6}" aria-label="Secondary colour hex" />
            </div>
          </Field>
          <Field label="Sign-in message" optional className="span-all"><input className="input" name="loginMessage" defaultValue={tenant.loginMessage ?? ''} maxLength={300} /></Field>
        </div>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {action.message && <Notice tone="success">{action.message}</Notice>}
        <div className="form-actions"><button className="btn btn-primary" disabled={action.busy}>Save profile</button></div>
      </form>
    </Card>
  )
}

function PlanAndModules({ tenantKey, data, definitions, onChanged }: { tenantKey: string; data: Detail; definitions: ConfigDefinition[]; onChanged: () => void }) {
  const { api } = useConsole()
  const plans = useResource<Array<{ planCode: string; displayName: string; isActive: boolean; audience: string }>>(async () => (await api.get('/api/plans')).plans, [api])
  const planAction = useAsyncAction()
  const moduleAction = useAsyncAction()
  const modules = definitions.filter((d) => d.key.startsWith('module.') && d.kind === 'feature' && d.valueType === 'boolean' && d.scopes.includes('tenant'))
  const assign = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void planAction.run(async () => {
      await api.send('PUT', `/api/tenants/${encodeURIComponent(tenantKey)}/plan`, { planCode: form.get('planCode'), status: form.get('status') })
      onChanged()
      return 'Plan assigned.'
    })
  }
  const setModule = (key: string, enabled: boolean) =>
    moduleAction.run(async () => {
      await api.send('PUT', '/api/config/values', { scope: 'tenant', ref: tenantKey, key, value: enabled })
      onChanged()
      return `${modules.find((module) => module.key === key)?.label ?? key} ${enabled ? 'switched on' : 'switched off'}.`
    })
  return (
    <div className="grid-side">
      <Card title="Modules" subtitle="A switched-off module answers 404 and keeps its data" flush>
        {moduleAction.error && <div style={{ padding: '12px 18px 0' }}><Notice tone="error">{moduleAction.error}</Notice></div>}
        {moduleAction.message && <div style={{ padding: '12px 18px 0' }}><Notice tone="success">{moduleAction.message}</Notice></div>}
        {modules.length === 0 ? (
          <EmptyState title="No modules are declared" />
        ) : (
          <Table>
            <thead><tr><th>Module</th><th>State</th><th>Set by</th><th className="right" /></tr></thead>
            <tbody>
              {modules.map((module) => {
                const enabled = data.effectiveConfig?.values[module.key] === true
                return (
                  <tr key={module.key}>
                    <td><span className="cell-title">{module.label}</span>{module.description && <span className="cell-sub">{module.description}</span>}</td>
                    <td>{enabled ? <Badge tone="good" dot>On</Badge> : <Badge dot>Off</Badge>}</td>
                    <td className="muted">{data.effectiveConfig?.sources[module.key] ?? 'default'}</td>
                    <td className="right">
                      <button type="button" className={`btn btn-sm${enabled ? '' : ' btn-primary'}`} disabled={moduleAction.busy} onClick={() => void setModule(module.key, !enabled)}>
                        {enabled ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Plan" subtitle={data.subscription ? `Currently ${data.subscription.planName}` : 'No plan assigned'}>
        <form className="form" onSubmit={assign}>
          <Field label="Plan">
            <select className="input" name="planCode" defaultValue={data.subscription?.planCode ?? ''} required>
              <option value="" disabled>Choose a plan…</option>
              {(plans.data ?? []).filter((plan) => plan.isActive && plan.audience !== 'b2c').map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
            </select>
          </Field>
          <Field label="Subscription status">
            <select className="input" name="status" defaultValue={data.subscription?.status ?? 'active'}>
              {['active', 'trialing', 'past_due', 'paused'].map((status) => <option key={status} value={status}>{status.replace('_', ' ')}</option>)}
            </select>
          </Field>
          {planAction.error && <Notice tone="error">{planAction.error}</Notice>}
          {planAction.message && <Notice tone="success">{planAction.message}</Notice>}
          <button className="btn btn-primary" disabled={planAction.busy}>Assign plan</button>
        </form>
      </Card>
    </div>
  )
}

function Access({ tenantKey, data, onChanged }: { tenantKey: string; data: Detail; onChanged: () => void }) {
  const { api } = useConsole()
  const confirm = useConfirm()
  const action = useAsyncAction()
  const [issued, setIssued] = useState<{ link: string; delivered: boolean } | null>(null)
  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    void action.run(async () => {
      const result = await api.send('POST', `/api/tenants/${encodeURIComponent(tenantKey)}/owner-invitations`, { email: form.get('email'), displayName: form.get('displayName') })
      setIssued({ link: result.invitation.link, delivered: result.invitation.delivered })
      formElement.reset()
      onChanged()
      return 'Invitation issued. Any earlier pending link was revoked.'
    })
  }
  const revoke = async (invitationId: string, email: string) => {
    if (!(await confirm({ title: 'Revoke this invitation?', body: <>The link sent to {email} stops working.</>, confirmLabel: 'Revoke', tone: 'danger' }))) return
    void action.run(async () => {
      await api.send('DELETE', `/api/tenants/${encodeURIComponent(tenantKey)}/owner-invitations/${invitationId}`)
      onChanged()
      return 'Invitation revoked.'
    })
  }
  return (
    <div className="grid">
      <Card title="Invite the tenant's owner" subtitle="They open the link on the tenant's own hostname, choose a username and set a password">
        {data.ownerAccount && (
          <Notice>
            <div>
              Administrator created at onboarding: <strong>{data.ownerAccount.username}</strong> ({data.ownerAccount.displayName}).{' '}
              {data.ownerAccount.createdInTenantAt ? `Created ${formatDate(data.ownerAccount.createdInTenantAt)}.` : 'Created once provisioning finishes.'}
            </div>
          </Notice>
        )}
        <form className="form-inline" onSubmit={invite}>
          <input className="input" name="displayName" placeholder="Owner's full name" required maxLength={255} aria-label="Owner's full name" />
          <input className="input" name="email" type="email" placeholder="owner@company.com" required aria-label="Owner's email" />
          <button className="btn btn-primary" disabled={action.busy}>Issue invitation</button>
        </form>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {action.message && <Notice tone="success">{action.message}</Notice>}
        {issued && <OneTimeLink label="Owner invitation link" link={issued.link} delivered={issued.delivered} />}
      </Card>
      <Card title="Invitations" flush>
        {data.ownerInvitations.length === 0 ? (
          <EmptyState title="No invitations issued" />
        ) : (
          <Table>
            <thead><tr><th>Invitee</th><th>Issued</th><th>Expires</th><th>State</th><th className="right" /></tr></thead>
            <tbody>
              {data.ownerInvitations.map((invitation) => {
                const pending = !invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt) > new Date()
                return (
                  <tr key={invitation.invitationId}>
                    <td><span className="cell-title">{invitation.displayName}</span><span className="cell-sub">{invitation.email}</span></td>
                    <td className="nowrap">{formatDate(invitation.createdAt)}</td>
                    <td className="nowrap">{formatDate(invitation.expiresAt)}</td>
                    <td>{invitation.acceptedAt ? <Badge tone="good" dot>Accepted</Badge> : invitation.revokedAt ? <Badge dot>Revoked</Badge> : pending ? <Badge tone="info" dot>Pending</Badge> : <Badge tone="warn" dot>Expired</Badge>}</td>
                    <td className="right">{pending && <button type="button" className="btn btn-sm btn-danger" onClick={() => void revoke(invitation.invitationId, invitation.email)}>Revoke</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}

function TenantConfiguration({ tenantKey, data, definitions, onChanged }: { tenantKey: string; data: Detail; definitions: ConfigDefinition[]; onChanged: () => void }) {
  const { api } = useConsole()
  const values = useResource<Record<string, unknown>>(
    async () => Object.fromEntries((await api.get(`/api/config/values?scope=tenant&ref=${encodeURIComponent(tenantKey)}`)).values.map((row: { key: string; value: unknown }) => [row.key, row.value])),
    [api, tenantKey],
  )
  return (
    <Card title="Configuration overrides" subtitle="Values here win over the plan and platform. Tenant administrators can also change keys marked tenant-editable.">
      {values.error && <Notice tone="error">{values.error}</Notice>}
      <ConfigEditor
        api={api}
        definitions={definitions}
        scope={{ scope: 'tenant', ref: tenantKey }}
        overrides={values.data ?? {}}
        effective={data.effectiveConfig}
        onChanged={() => {
          void values.reload()
          onChanged()
        }}
      />
    </Card>
  )
}

function Jobs({ data }: { data: Detail }) {
  return (
    <Card title="Provisioning and maintenance jobs" flush>
      {data.jobs.length === 0 ? (
        <EmptyState title="No jobs yet" />
      ) : (
        <Table minWidth={720}>
          <thead><tr><th>Job</th><th>Status</th><th>Step</th><th>Started</th><th>Finished</th></tr></thead>
          <tbody>
            {data.jobs.map((job) => (
              <tr key={job.jobId}>
                <td><span className="cell-title" style={{ textTransform: 'capitalize' }}>{job.jobType.replace(/_/g, ' ')}</span><span className="cell-sub mono">{job.jobId.slice(0, 8)}</span></td>
                <td><StatusBadge status={job.status} />{job.errorMessage && <span className="cell-sub text-bad">{job.errorMessage}</span>}</td>
                <td className="mono">{job.currentStep ?? '—'}</td>
                <td className="nowrap">{formatDate(job.createdAt)}</td>
                <td className="nowrap">{formatDate(job.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  )
}
