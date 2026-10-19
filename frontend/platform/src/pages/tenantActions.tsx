import { useState } from 'react'
import { PauseCircle, PlayCircle, RefreshCw, Trash2 } from 'lucide-react'
import { useConfirm } from '../admin/ui'
import { isOwner, useConsole } from '../shell/context'
import type { TenantSummary } from '../shell/types'

type Action = 'suspend' | 'resume' | 'deprovision' | 'retry'
type ActionTenant = Pick<TenantSummary, 'tenantId' | 'displayName' | 'hostname' | 'subdomain' | 'status' | 'jobId' | 'currentStep'>

/**
 * Suspend, resume, remove and retry-removal for one tenant, with the same
 * confirmations wherever a tenant is listed. Removal is owner-only on the
 * server and asks for the subdomain to be typed.
 */
export function useTenantActions(onChanged: () => void) {
  const { api, user, refreshShell } = useConsole()
  const confirm = useConfirm()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const run = async (tenant: ActionTenant, action: Action) => {
    const name = tenant.displayName
    if (action === 'suspend') {
      const ok = await confirm({
        title: `Suspend ${name}?`,
        body: <>Its users are signed out and {tenant.hostname ? <code>{tenant.hostname}</code> : 'its subdomain'} stops serving until you resume it. No data is removed.</>,
        confirmLabel: 'Suspend tenant',
        tone: 'danger',
      })
      if (!ok) return
    }
    if (action === 'deprovision') {
      const ok = await confirm({
        title: `Permanently remove ${name}?`,
        body: <>This deletes the tenant's database schema, users, files and credentials, and releases {tenant.hostname ? <code>{tenant.hostname}</code> : 'its subdomain'}. It cannot be undone.</>,
        confirmLabel: 'Remove permanently',
        tone: 'danger',
        typeToConfirm: tenant.subdomain || tenant.tenantId,
      })
      if (!ok) return
    }
    setPending(`${tenant.tenantId}:${action}`)
    setError(null)
    setMessage(null)
    try {
      if (action === 'retry') {
        if (!tenant.jobId) throw new Error('There is no job to retry.')
        await api.send('POST', `/api/tenant-provisioning/${encodeURIComponent(tenant.jobId)}/retry`)
      } else {
        await api.send('POST', `/api/tenants/${encodeURIComponent(tenant.tenantId)}/${action}`)
      }
      setMessage(
        action === 'suspend' ? `${name} suspended.` : action === 'resume' ? `${name} resumed.` : action === 'deprovision' ? `Removing ${name}. This takes a minute.` : `Retrying the job for ${name}.`,
      )
      onChanged()
      refreshShell()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action failed.')
    } finally {
      setPending(null)
    }
  }

  /** Rendered as a plain function (not a component) so rows keep focus across polls. */
  const buttons = (tenant: ActionTenant, size: 'sm' | 'md' = 'sm') => {
    const cls = size === 'sm' ? 'btn btn-sm' : 'btn'
    const busy = pending !== null
    const spinning = (action: Action) => pending === `${tenant.tenantId}:${action}`
    return (
      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
        {tenant.status === 'active' && (
          <button type="button" className={cls} disabled={busy} onClick={() => void run(tenant, 'suspend')}>
            <PauseCircle size={14} className={spinning('suspend') ? 'spin' : undefined} /> Suspend
          </button>
        )}
        {tenant.status === 'suspended' && (
          <button type="button" className={cls} disabled={busy} onClick={() => void run(tenant, 'resume')}>
            <PlayCircle size={14} className={spinning('resume') ? 'spin' : undefined} /> Resume
          </button>
        )}
        {tenant.status === 'suspended' && isOwner(user) && (
          <button type="button" className={`${cls} btn-danger`} disabled={busy} onClick={() => void run(tenant, 'deprovision')}>
            <Trash2 size={14} className={spinning('deprovision') ? 'spin' : undefined} /> Remove
          </button>
        )}
        {tenant.status === 'deletion_failed' && isOwner(user) && tenant.jobId && (
          <button type="button" className={`${cls} btn-danger`} disabled={busy} onClick={() => void run(tenant, 'retry')} title="Retry the removal from the step that failed">
            <RefreshCw size={14} className={spinning('retry') ? 'spin' : undefined} /> Retry removal
          </button>
        )}
        {tenant.status === 'deleting' && (
          <span className="hint inline-flex">
            <RefreshCw size={13} className="spin" /> Removing{tenant.currentStep ? ` · ${tenant.currentStep.replace(/^DEPROV_/, '').replace(/_/g, ' ').toLowerCase()}` : '…'}
          </span>
        )}
      </div>
    )
  }

  return { run, pending, error, message, setError, setMessage, buttons }
}
