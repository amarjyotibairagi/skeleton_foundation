import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, Clock, ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Badge, Card, Field, Notice, OneTimeLink, PageHeader, StatusBadge, useResource } from '../admin/ui'
import { useConsole } from '../shell/context'
import { href } from '../shell/router'
import type { ProvisioningJob } from '../shell/types'

type OwnerMode = 'account' | 'invitation' | 'none'
type Definition = { key: string; kind: string; valueType: string; label: string; description: string | null; scopes: string[] }
type Plan = { planCode: string; displayName: string; audience: string; isActive: boolean }

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function NewTenantPage() {
  const { api, tenantRootDomain, refreshShell } = useConsole()
  const definitions = useResource<Definition[]>(async () => (await api.get('/api/config/definitions')).definitions, [api])
  const plans = useResource<Plan[]>(async () => (await api.get('/api/plans')).plans, [api])
  const modules = (definitions.data ?? []).filter((d) => d.key.startsWith('module.') && d.kind === 'feature' && d.valueType === 'boolean' && d.scopes.includes('tenant'))
  const tenantPlans = (plans.data ?? []).filter((plan) => plan.isActive && plan.audience !== 'b2c')

  const [ownerMode, setOwnerMode] = useState<OwnerMode>('account')
  const [displayName, setDisplayName] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [subdomainTouched, setSubdomainTouched] = useState(false)
  const [primary, setPrimary] = useState('#2563eb')
  const [secondary, setSecondary] = useState('#0f172a')
  const [chosenModules, setChosenModules] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<ProvisioningJob | null>(null)
  const [ownerAccount, setOwnerAccount] = useState<{ username: string; loginUrl: string } | null>(null)
  const [ownerInvitation, setOwnerInvitation] = useState<{ link: string; delivered: boolean } | null>(null)

  // Suggest the subdomain from the name until the operator edits it.
  useEffect(() => {
    if (subdomainTouched) return
    setSubdomain(displayName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63))
  }, [displayName, subdomainTouched])

  const loadJob = async (jobId: string) => {
    const data = await api.get(`/api/tenant-provisioning/${encodeURIComponent(jobId)}`)
    setJob(data.job)
    return data.job as ProvisioningJob
  }

  useEffect(() => {
    if (!job || ['succeeded', 'failed', 'rolled_back'].includes(job.status)) {
      if (job) refreshShell()
      return
    }
    const timer = window.setInterval(() => {
      loadJob(job.jobId).catch(() => setError('Provisioning continues, but its progress could not be refreshed.'))
    }, 1500)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, job?.status])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    setError(null)
    if (!SUBDOMAIN.test(subdomain)) return setError('The subdomain may use lowercase letters, digits and hyphens, and must not start or end with a hyphen.')
    if (ownerMode === 'account' && form.get('ownerPassword') !== form.get('ownerPasswordConfirm')) return setError('The administrator passwords do not match.')
    const payload = {
      displayName: text('displayName'),
      // Optional fields are left out when blank: the server rejects empty values.
      ...(text('legalName') ? { legalName: text('legalName') } : {}),
      subdomain,
      locale: text('locale') || 'en',
      ...(text('logoUrl') ? { logoUrl: text('logoUrl') } : {}),
      primaryColor: primary,
      secondaryColor: secondary,
      ...(text('loginMessage') ? { loginMessage: text('loginMessage') } : {}),
      region: 'global',
      ...(ownerMode === 'account'
        ? { owner: { displayName: text('ownerName') || text('ownerUsername'), username: text('ownerUsername').toLowerCase(), password: String(form.get('ownerPassword') ?? ''), email: text('ownerEmail') } }
        : ownerMode === 'invitation'
          ? { owner: { email: text('ownerEmail'), displayName: text('ownerName') || text('ownerEmail') } }
          : {}),
      modules: [...chosenModules],
      ...(text('planCode') ? { planCode: text('planCode') } : {}),
      ...(text('connectionTier') ? { connectionTier: text('connectionTier') } : {}),
    }
    setCreating(true)
    try {
      const data = await api.send('POST', '/api/tenants', payload)
      setOwnerInvitation(data.ownerInvitation ? { link: data.ownerInvitation.link, delivered: data.ownerInvitation.delivered } : null)
      setOwnerAccount(data.ownerAccount ? { username: data.ownerAccount.username, loginUrl: data.ownerAccount.loginUrl } : null)
      if (data.planError) setError(`The tenant was created, but the plan could not be assigned: ${data.planError}`)
      await loadJob(data.jobId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The tenant could not be created.')
    } finally {
      setCreating(false)
    }
  }

  const retry = async () => {
    if (!job) return
    setError(null)
    try {
      await api.send('POST', `/api/tenant-provisioning/${encodeURIComponent(job.jobId)}/retry`)
      await loadJob(job.jobId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Provisioning could not be retried.')
    }
  }

  if (job) {
    const done = job.status === 'succeeded'
    const failed = job.status === 'failed' || job.status === 'rolled_back'
    const finished = job.steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped').length
    return (
      <div className="page">
        <PageHeader
          title={done ? `${job.displayName} is ready` : failed ? `Provisioning ${job.displayName} stopped` : `Creating ${job.displayName}`}
          badge={<StatusBadge status={job.status} />}
          description={<span className="mono">{job.hostname}</span>}
          meta={<span>Correlation <span className="mono">{job.correlationId}</span></span>}
        />
        <div className="grid-side">
          <Card title="Provisioning steps" subtitle={`${finished} of ${job.steps.length} complete`}>
            <ol className="steps">
              {job.steps.map((step) => (
                <li key={step.stepCode} className="step" data-status={step.status}>
                  {step.status === 'succeeded' ? <CheckCircle2 size={17} /> : step.status === 'running' ? <Loader2 size={17} className="spin" /> : step.status === 'failed' ? <AlertTriangle size={17} /> : step.status === 'skipped' ? <Circle size={17} /> : <Clock size={17} />}
                  <span>
                    {step.message}
                    {step.errorMessage && <span className="cell-sub text-bad">{step.errorMessage}</span>}
                  </span>
                  <span className="step-meta">{step.status}</span>
                </li>
              ))}
            </ol>
          </Card>
          <div className="grid">
            {(job.errorMessage || error) && <Notice tone="error">{job.errorMessage || error}</Notice>}
            {ownerAccount && (
              <Notice tone={done ? 'success' : 'info'}>
                <div>
                  Administrator login <strong>{ownerAccount.username}</strong> with the password you set, at{' '}
                  <a href={ownerAccount.loginUrl} target="_blank" rel="noreferrer">{ownerAccount.loginUrl}</a>. {done ? 'Ready to sign in.' : 'Usable once the tenant is active.'}
                </div>
              </Notice>
            )}
            {ownerInvitation && <OneTimeLink label="Owner invitation link (works once the tenant is active)" link={ownerInvitation.link} delivered={ownerInvitation.delivered} />}
            <Card title="Next">
              <div className="form-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {failed && job.retryable && <button type="button" className="btn btn-primary" onClick={() => void retry()}><RefreshCw size={14} /> Retry from the failed step</button>}
                {done && <a className="btn btn-primary" href={`https://${job.hostname}`} target="_blank" rel="noreferrer">Open the tenant <ExternalLink size={14} /></a>}
                <a className="btn" href={href('tenants', job.tenantId)}>Manage this tenant</a>
                {(done || failed) && (
                  <button type="button" className="btn" onClick={() => { setJob(null); setError(null); setOwnerAccount(null); setOwnerInvitation(null); setDisplayName(''); setSubdomainTouched(false) }}>
                    Create another tenant
                  </button>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  const subdomainValid = !subdomain || SUBDOMAIN.test(subdomain)
  return (
    <div className="page">
      <PageHeader
        title="New tenant"
        description="Creates the tenant's identity, an isolated database schema and its hostname. Database names are generated by the server, never taken from what you type here."
        actions={<a className="btn" href={href('tenants')}><ArrowLeft size={15} /> Tenants</a>}
      />
      <form onSubmit={(event) => void submit(event)} className="grid-side">
        <div className="grid">
          <Card title="Organisation" subtitle="How the tenant is named across the platform">
            <div className="form-grid">
              <Field label="Display name">
                <input className="input" name="displayName" required maxLength={160} placeholder="Acme Corporation" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <Field label="Legal name" optional>
                <input className="input" name="legalName" maxLength={240} placeholder="Acme Corporation Limited" />
              </Field>
              <Field label="Language">
                <select className="input" name="locale" defaultValue="en">
                  <option value="en">English</option>
                  <option value="de">German</option>
                  <option value="fr">French</option>
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Address" subtitle="The tenant's own hostname; served through the platform's wildcard route">
            <Field label="Subdomain" hint={subdomainValid ? 'Lowercase letters, digits and hyphens.' : <span className="text-bad">Use lowercase letters, digits and hyphens; no hyphen at either end.</span>}>
              <div className="input-group">
                <input
                  className="input mono"
                  name="subdomain"
                  required
                  minLength={2}
                  maxLength={63}
                  placeholder="acme"
                  value={subdomain}
                  aria-invalid={!subdomainValid}
                  onChange={(event) => {
                    setSubdomainTouched(true)
                    setSubdomain(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                  }}
                />
                <span className="input-addon">.{tenantRootDomain || 'example.com'}</span>
              </div>
            </Field>
          </Card>

          <Card title="Branding" subtitle="Shown on the tenant's sign-in page and workspace">
            <div className="form-grid">
              <Field label="Logo URL" optional hint="https only" className="span-all">
                <input className="input" name="logoUrl" type="url" placeholder="https://cdn.example.com/logo.png" />
              </Field>
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
              <Field label="Sign-in message" optional className="span-all">
                <input className="input" name="loginMessage" maxLength={300} placeholder="Sign in with your company credentials." />
              </Field>
            </div>
          </Card>

          <Card title="Administrator" subtitle="The tenant's first administrator, with the owner role">
            <div className="choice-grid" role="radiogroup" aria-label="Administrator setup">
              {([
                ['account', 'Create the login now', 'Set a username and password; share them over a secure channel.'],
                ['invitation', 'Email an invitation', 'They choose their own username and password from a one-time link.'],
                ['none', 'Later', 'Invite the owner from the tenant page afterwards.'],
              ] as const).map(([id, title, text]) => (
                <label key={id} className="choice">
                  <input type="radio" name="ownerMode" checked={ownerMode === id} onChange={() => setOwnerMode(id)} />
                  <div><strong>{title}</strong><span>{text}</span></div>
                </label>
              ))}
            </div>
            {ownerMode !== 'none' && (
              <div className="form-grid">
                <Field label="Full name">
                  <input className="input" name="ownerName" required={ownerMode === 'account'} maxLength={255} placeholder="Jane Doe" />
                </Field>
                <Field label="Email" optional={ownerMode === 'account'}>
                  <input className="input" name="ownerEmail" type="email" required={ownerMode === 'invitation'} placeholder="jane@acme.com" />
                </Field>
                {ownerMode === 'account' && (
                  <>
                    <Field label="Username" hint="3–64 characters: a–z, 0–9, dot, dash, underscore">
                      <input className="input mono" name="ownerUsername" required minLength={3} maxLength={64} pattern="[a-z0-9._\-]{3,64}" autoComplete="off" placeholder="admin" onInput={(event) => { event.currentTarget.value = event.currentTarget.value.toLowerCase() }} />
                    </Field>
                    <Field label="Initial password" hint="At least 8 characters">
                      <input className="input" name="ownerPassword" type="password" required minLength={8} maxLength={512} autoComplete="new-password" />
                    </Field>
                    <Field label="Confirm password">
                      <input className="input" name="ownerPasswordConfirm" type="password" required minLength={8} maxLength={512} autoComplete="new-password" />
                    </Field>
                  </>
                )}
              </div>
            )}
          </Card>

          <Card title="Modules" subtitle="Every tenant schema has all module tables; only switched-on modules are reachable. Change this any time." actions={modules.length > 0 && <Badge>{chosenModules.size} of {modules.length}</Badge>}>
            {modules.length === 0 ? (
              <p className="hint">{definitions.loading ? 'Loading modules…' : 'No modules are declared.'}</p>
            ) : (
              <div className="choice-grid">
                {modules.map((module) => (
                  <label key={module.key} className="choice">
                    <input
                      type="checkbox"
                      checked={chosenModules.has(module.key)}
                      onChange={(event) =>
                        setChosenModules((current) => {
                          const next = new Set(current)
                          if (event.target.checked) next.add(module.key)
                          else next.delete(module.key)
                          return next
                        })
                      }
                    />
                    <div><strong>{module.label}</strong>{module.description && <span>{module.description}</span>}</div>
                  </label>
                ))}
              </div>
            )}
          </Card>

          <Card title="Plan & capacity" subtitle="Optional; both can be changed later">
            <div className="form-grid">
              <Field label="Plan">
                <select className="input" name="planCode" defaultValue="">
                  <option value="">No plan yet</option>
                  {tenantPlans.map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
                </select>
              </Field>
              <Field label="Database connection">
                <select className="input" name="connectionTier" defaultValue="">
                  <option value="">Platform or plan default</option>
                  <option value="dedicated">Dedicated: own database login</option>
                  <option value="pooled">Pooled: shared login for many small tenants</option>
                </select>
              </Field>
            </div>
          </Card>
        </div>

        <div className="sticky-top" style={{ top: 0 }}>
          <Card title="Summary">
            <dl className="kv">
              <dt>Name</dt><dd>{displayName || <span className="muted">—</span>}</dd>
              <dt>Address</dt><dd className="mono">{subdomain ? `${subdomain}.${tenantRootDomain}` : <span className="muted">—</span>}</dd>
              <dt>Colours</dt><dd><span className="swatch" style={{ background: primary }} /> <span className="swatch" style={{ background: secondary }} /></dd>
              <dt>Administrator</dt><dd>{ownerMode === 'account' ? 'Login created now' : ownerMode === 'invitation' ? 'Invitation by email' : 'Later'}</dd>
              <dt>Modules</dt><dd>{chosenModules.size ? modules.filter((m) => chosenModules.has(m.key)).map((m) => m.label).join(', ') : <span className="muted">None</span>}</dd>
            </dl>
            {error && <Notice tone="error">{error}</Notice>}
            <button type="submit" className="btn btn-primary btn-block" disabled={creating} style={{ height: 40 }}>
              {creating ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
              {creating ? 'Starting provisioning…' : 'Create tenant'}
            </button>
            <p className="hint">Provisioning runs in the background and takes about a minute. You can follow every step here.</p>
          </Card>
        </div>
      </form>
    </div>
  )
}
