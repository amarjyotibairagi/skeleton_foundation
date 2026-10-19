import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { CheckCircle2, Loader2, XCircle, Circle } from 'lucide-react'
import { Badge, Card, Field, formatDate, Notice, StatusBadge, useAsyncAction, useConfirm } from './ui'

type TestStep = { step: string; ok: boolean; detail: string; durationMs: number }
type Integration = {
  integrationId: string
  kind: 'storage' | 'database'
  provider: 's3' | 'postgresql'
  displayName: string
  settings: Record<string, unknown>
  secretHint: string
  status: string
  inUse: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestReport: { ok: boolean; steps: TestStep[] } | null
  testCurrent: boolean
}
type Job = { jobId: string; jobType: string; status: string; currentStep: string | null; errorMessage: string | null; steps: Array<{ stepCode: string; message: string; status: string }> }

export function TestReportView({ steps }: { steps: TestStep[] }) {
  return (
    <ol className="steps">
      {steps.map((step) => (
        <li key={step.step} className="step" data-status={step.ok ? 'ok' : 'fail'}>
          {step.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>
            <span className="strong">{step.step}</span>
            <span className="cell-sub">{step.detail}</span>
          </span>
          <span className="step-meta">{step.durationMs} ms</span>
        </li>
      ))}
    </ol>
  )
}

/** Polls a worker job until it finishes. */
export function JobProgress({ api, jobId, onDone }: { api: AdminApi; jobId: string; onDone?: (job: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null)
  useEffect(() => {
    let stopped = false
    const poll = async () => {
      try {
        const data = await api.get(`/api/tenant-provisioning/${jobId}`)
        if (stopped) return
        setJob(data.job)
        if (['succeeded', 'failed'].includes(data.job.status)) {
          onDone?.(data.job)
          return
        }
      } catch {
        // keep polling
      }
      if (!stopped) window.setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => {
      stopped = true
    }
  }, [jobId])
  if (!job) return <div className="hint inline-flex"><Loader2 size={14} className="spin" /> Starting…</div>
  return (
    <div className="job">
      <div className="section-head">
        <span className="strong" style={{ textTransform: 'capitalize' }}>{job.jobType.replace(/_/g, ' ')}</span>
        <StatusBadge status={job.status} />
      </div>
      <ol className="steps">
        {job.steps.map((step) => (
          <li key={step.stepCode} className="step" data-status={step.status}>
            {step.status === 'succeeded' ? <CheckCircle2 size={16} /> : step.status === 'failed' ? <XCircle size={16} /> : step.status === 'running' ? <Loader2 size={16} className="spin" /> : <Circle size={16} />}
            <span>{step.message}</span>
            <span className="step-meta">{step.status}</span>
          </li>
        ))}
      </ol>
      {job.errorMessage && <Notice tone="error">{job.errorMessage}</Notice>}
    </div>
  )
}

const emptySettings = {
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: 'skeleton-platform/', forcePathStyle: true },
  postgresql: { host: '', port: 5432, database: '', schema: 'skeleton_platform', sslMode: 'verify-full', caCert: '' },
}

function IntegrationForm({ provider, initial, onSubmit, busy }: {
  provider: 's3' | 'postgresql'
  initial?: Integration
  busy: boolean
  onSubmit: (payload: { provider: 's3' | 'postgresql'; displayName: string; settings: Record<string, unknown>; secret?: Record<string, unknown> }) => void
}) {
  const settings = { ...emptySettings[provider], ...(initial?.settings || {}) } as Record<string, any>
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (name: string) => String(form.get(name) ?? '').trim()
    const payload =
      provider === 's3'
        ? {
            settings: { endpoint: value('endpoint'), region: value('region'), bucket: value('bucket'), prefix: value('prefix'), forcePathStyle: form.get('forcePathStyle') === 'on' },
            secret: value('accessKeyId') || value('secretAccessKey') ? { accessKeyId: value('accessKeyId'), secretAccessKey: value('secretAccessKey') } : undefined,
          }
        : {
            settings: { host: value('host'), port: Number(value('port') || 5432), database: value('database'), schema: value('schema'), sslMode: value('sslMode'), caCert: value('caCert') },
            secret: value('user') || value('password') ? { user: value('user'), password: String(form.get('password') || '') } : undefined,
          }
    onSubmit({ provider, displayName: value('displayName'), settings: payload.settings, ...(payload.secret ? { secret: payload.secret } : {}) })
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <Field label="Name"><input className="input" name="displayName" defaultValue={initial?.displayName ?? (provider === 's3' ? 'Company bucket' : 'Company database')} required maxLength={120} /></Field>
      {provider === 's3' ? (
        <>
          <Field label="Endpoint" hint="https origin, e.g. https://s3.eu-central-1.amazonaws.com or your MinIO/R2 URL"><input className="input" name="endpoint" defaultValue={settings.endpoint} placeholder="https://s3.us-east-1.amazonaws.com" /></Field>
          <Field label="Region"><input className="input" name="region" defaultValue={settings.region} /></Field>
          <Field label="Bucket"><input className="input" name="bucket" defaultValue={settings.bucket} required /></Field>
          <Field label="Folder in the bucket" hint="All platform files go under this prefix"><input className="input" name="prefix" defaultValue={settings.prefix} /></Field>
          <label className="check span-all"><input type="checkbox" name="forcePathStyle" defaultChecked={settings.forcePathStyle !== false} /> Path-style addressing (MinIO, most S3-compatibles)</label>
          <Field label="Access key ID" hint={initial ? `Leave blank to keep (${initial.secretHint})` : undefined}><input className="input" name="accessKeyId" autoComplete="off" required={!initial} /></Field>
          <Field label="Secret access key"><input className="input" name="secretAccessKey" type="password" autoComplete="new-password" required={!initial} /></Field>
        </>
      ) : (
        <>
          <Field label="Host"><input className="input" name="host" defaultValue={settings.host} required /></Field>
          <Field label="Port"><input className="input" name="port" type="number" defaultValue={settings.port} /></Field>
          <Field label="Database"><input className="input" name="database" defaultValue={settings.database} required /></Field>
          <Field label="Schema (folder)" hint="A dedicated, empty schema; created if missing"><input className="input" name="schema" defaultValue={settings.schema} pattern="[a-z][a-z0-9_]{2,62}" /></Field>
          <Field label="TLS">
            <select className="input" name="sslMode" defaultValue={settings.sslMode}>
              <option value="verify-full">Verify certificate (recommended)</option>
              <option value="require">Encrypt, don't verify</option>
              <option value="disable">No TLS (only if the platform allows it)</option>
            </select>
          </Field>
          <Field label="CA certificate (PEM, optional)"><textarea className="input" name="caCert" rows={2} defaultValue={settings.caCert || ''} /></Field>
          <Field label="User" hint={initial ? `Leave blank to keep (${initial.secretHint})` : 'Needs CREATE on the database or ownership of the schema; must not be a superuser'}><input className="input" name="user" autoComplete="off" required={!initial} /></Field>
          <Field label="Password"><input className="input" name="password" type="password" autoComplete="new-password" required={!initial} /></Field>
        </>
      )}
      <div className="form-actions span-all"><button className="btn btn-primary" disabled={busy}>{initial ? 'Save changes' : 'Save connection'}</button></div>
    </form>
  )
}

/**
 * Bring-your-own storage and database for one tenant. The same workflow is
 * available to tenant owners in their workspace; operators can always use it.
 */
export function IntegrationsPanel({ api, tenantKey, active, onChanged }: {
  api: AdminApi
  tenantKey: string
  active: { storage: string | null; database: string | null }
  onChanged: () => void
}) {
  const [list, setList] = useState<Integration[]>([])
  const [available, setAvailable] = useState(true)
  const [creating, setCreating] = useState<'s3' | 'postgresql' | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [report, setReport] = useState<{ id: string; steps: TestStep[]; ok: boolean } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const action = useAsyncAction()
  const confirm = useConfirm()
  const base = `/api/tenants/${encodeURIComponent(tenantKey)}`

  const load = async () => {
    const data = await api.get(`${base}/integrations`)
    setList(data.integrations)
    setAvailable(data.available)
  }
  useEffect(() => { void load() }, [tenantKey])

  const save = (integrationId: string | null) => (payload: Parameters<Parameters<typeof IntegrationForm>[0]['onSubmit']>[0]) =>
    void action.run(async () => {
      await api.send(integrationId ? 'PUT' : 'POST', integrationId ? `${base}/integrations/${integrationId}` : `${base}/integrations`, payload)
      setCreating(null)
      setEditing(null)
      await load()
      return 'Saved. Run a connection test before activating.'
    })

  const test = (integration: Integration) =>
    void action.run(async () => {
      const data = await api.send('POST', `${base}/integrations/${integration.integrationId}/test`)
      setReport({ id: integration.integrationId, steps: data.report.steps, ok: data.report.ok })
      await load()
      return data.report.ok ? 'Connection test passed. You can activate within 30 minutes.' : undefined
    })

  const activate = async (integration: Integration) => {
    const ok = await confirm(
      integration.kind === 'database'
        ? { title: `Move this tenant's data to ${integration.displayName}?`, body: 'The tenant is in maintenance during the copy (usually seconds to minutes). The copy on this server is removed afterwards.', confirmLabel: 'Move data', tone: 'danger' }
        : { title: `Store new files in ${integration.displayName}?`, body: 'New uploads go to this bucket from now on. Existing files stay readable where they are.', confirmLabel: 'Activate' },
    )
    if (!ok) return
    void action.run(async () => {
      const data = await api.send('POST', `${base}/integrations/${integration.integrationId}/activate`)
      if (data.jobId) setJobId(data.jobId)
      await load()
      onChanged()
      return data.message
    })
  }

  const simple = async (method: 'POST', url: string, confirmText: string | null, done: string) => {
    if (confirmText && !(await confirm({ title: confirmText, confirmLabel: 'Continue' }))) return
    void action.run(async () => {
      const data = await api.send(method, url)
      if (data.jobId) setJobId(data.jobId)
      await load()
      onChanged()
      return data.message || done
    })
  }

  const section = (kind: 'storage' | 'database') => {
    const items = list.filter((item) => item.kind === kind && item.status !== 'retired')
    const activeId = kind === 'storage' ? active.storage : active.database
    return (
      <div className="integration-section">
        <div className="section-head">
          <h3>{kind === 'storage' ? 'File storage' : 'Database'}</h3>
          <div className="actions">
            <Badge tone={activeId ? 'info' : 'good'}>{activeId ? `Tenant ${kind === 'storage' ? 'bucket' : 'database'}` : 'On this VDS (default)'}</Badge>
            <button className="btn btn-sm" disabled={!available} onClick={() => { setCreating(kind === 'storage' ? 's3' : 'postgresql'); setEditing(null) }}>
              Connect {kind === 'storage' ? 'S3-compatible bucket' : 'PostgreSQL'}
            </button>
            {kind === 'storage' && activeId && <button className="btn btn-sm" onClick={() => void simple('POST', `${base}/storage/use-vds`, 'Write new files to the VDS again?', 'Switched to VDS storage.')}>Use VDS storage</button>}
            {kind === 'storage' && <button className="btn btn-sm" onClick={() => void simple('POST', `${base}/storage/relocate`, 'Move every file onto the currently active storage?', 'File move started.')}>Move existing files</button>}
            {kind === 'database' && activeId && <button className="btn btn-sm" onClick={() => void simple('POST', `${base}/database/use-vds`, 'Move this tenant\'s data back to the VDS? The tenant\'s own database is left untouched.', 'Move back started.')}>Move data back to VDS</button>}
          </div>
        </div>
        {creating === (kind === 'storage' ? 's3' : 'postgresql') && <IntegrationForm provider={creating} busy={action.busy} onSubmit={save(null)} />}
        {items.length === 0 && creating !== (kind === 'storage' ? 's3' : 'postgresql') && <div className="muted">No {kind} integrations yet.</div>}
        {items.map((item) => (
          <div key={item.integrationId} className="integration">
            <div className="section-head">
              <div>
                <span className="badges"><span className="strong">{item.displayName}</span>
                <Badge tone={item.status === 'active' ? 'good' : item.status === 'failed' ? 'bad' : item.status === 'verified' ? 'info' : 'neutral'}>{item.status}</Badge>
                {item.inUse && <Badge tone="good">In use</Badge>}</span>
                <div className="hint" style={{ marginTop: 4 }}>
                  {item.provider === 's3'
                    ? `${String(item.settings.endpoint)} · bucket ${String(item.settings.bucket)} · folder ${String(item.settings.prefix) || '/'}`
                    : `${String(item.settings.host)}:${String(item.settings.port)}/${String(item.settings.database)} · schema ${String(item.settings.schema)} · TLS ${String(item.settings.sslMode)}`}
                  {' · '}{item.secretHint}{item.lastTestAt && ` · tested ${formatDate(item.lastTestAt)}`}
                </div>
              </div>
              <div className="row-actions">
                {!item.inUse && item.status !== 'active' && <button className="btn btn-sm" onClick={() => setEditing(editing === item.integrationId ? null : item.integrationId)}>Edit</button>}
                <button className="btn btn-sm" disabled={action.busy} onClick={() => test(item)}>Test connection</button>
                {!item.inUse && <button className="btn btn-sm btn-primary" disabled={action.busy || !item.testCurrent} title={item.testCurrent ? '' : 'Run a successful test first'} onClick={() => void activate(item)}>{item.kind === 'database' ? 'Move data here' : 'Activate'}</button>}
                {!item.inUse && <button className="btn btn-sm" onClick={() => void simple('POST', `${base}/integrations/${item.integrationId}/retire`, `Retire ${item.displayName}?`, 'Retired.')}>Retire</button>}
              </div>
            </div>
            {editing === item.integrationId && <IntegrationForm provider={item.provider} initial={item} busy={action.busy} onSubmit={save(item.integrationId)} />}
            {report?.id === item.integrationId ? <TestReportView steps={report.steps} /> : item.lastTestReport && !item.testCurrent && item.lastTestOk === false ? <TestReportView steps={item.lastTestReport.steps} /> : null}
          </div>
        ))}
      </div>
    )
  }

  return (
    <Card title="Storage & database">
      <p className="hint">
        Files and data live on this VDS by default. A tenant can bring its own S3-compatible bucket or PostgreSQL database; the platform uses a dedicated folder (bucket prefix or schema) there. Every connection is tested without side effects before it can be activated.
      </p>
      {!available && <Notice tone="warning">Integrations are disabled on this server: set INTEGRATION_SECRET_KEY for the platform, tenant and provisioner services.</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {jobId && <JobProgress api={api} jobId={jobId} onDone={() => { void load(); onChanged() }} />}
      {section('storage')}
      {section('database')}
    </Card>
  )
}
