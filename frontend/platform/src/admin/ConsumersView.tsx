import { useState, type FormEvent } from 'react'
import { Search, User, X } from 'lucide-react'
import { useConsole } from '../shell/context'
import { Badge, Card, EmptyState, Notice, PageHeader, Stat, StatusBadge, Table, formatDate, formatRelative, useAsyncAction, useConfirm, useResource } from './ui'

type Consumer = {
  userId: string
  username: string
  displayName: string
  email: string | null
  status: string
  planCode: string | null
  subscriptionStatus: string | null
  createdAt: string
  activeSessions: number
}

type Detail = {
  user: { userId: string; username: string; displayName: string; email: string | null; status: string; createdAt: string }
  subscriptions: Array<{ planCode: string; status: string; periodStart: string | null; periodEnd: string | null }>
  projects: number
  groups: number
  activeSessions: number
  recentEvents: Array<{ action: string; outcome: string; occurred_at: string }>
}

const pageSize = 50
const statusTone = (status: string) => (status === 'active' ? 'good' : status === 'suspended' ? 'warn' : 'neutral')

export function ConsumersView() {
  const { api } = useConsole()
  const confirm = useConfirm()
  const [filters, setFilters] = useState({ search: '', status: '', plan: '' })
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Detail | null>(null)
  const action = useAsyncAction()

  const list = useResource<{ users: Consumer[]; total: number }>(async () => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) })
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
    return api.get(`/api/consumers?${params}`)
  }, [api, filters, offset])
  const stats = useResource<{ total: number; byStatus: Record<string, number>; byPlan: Record<string, number>; activeSessions: number }>(async () => (await api.get('/api/consumers/stats')).stats, [api])
  const plans = useResource<Array<{ planCode: string; displayName: string; audience: string; isActive: boolean }>>(
    async () => (await api.get('/api/plans')).plans.filter((plan: { audience: string; isActive: boolean }) => plan.isActive && plan.audience !== 'b2b'),
    [api],
  )

  const open = (userId: string) => void action.run(async () => setSelected(await api.get(`/api/consumers/${userId}`)))

  const act = async (userId: string, path: string, body?: unknown, ask?: { title: string; body: string; label: string }) => {
    if (ask && !(await confirm({ title: ask.title, body: ask.body, confirmLabel: ask.label, tone: path === 'suspend' ? 'danger' : undefined }))) return
    void action.run(async () => {
      await (body === undefined ? api.send('POST', `/api/consumers/${userId}/${path}`) : api.send('PUT', `/api/consumers/${userId}/${path}`, body))
      await Promise.all([list.reload(), stats.reload()])
      setSelected(await api.get(`/api/consumers/${userId}`))
      return 'Saved.'
    })
  }

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setOffset(0)
    setFilters({ search: String(form.get('search') || '').trim(), status: String(form.get('status') || ''), plan: String(form.get('plan') || '') })
  }

  const users = list.data?.users ?? []
  const total = list.data?.total ?? 0
  const currentPlan = selected?.subscriptions.find((sub) => ['active', 'trialing', 'past_due', 'paused'].includes(sub.status))

  return (
    <div className="page">
      <PageHeader
        title="Individuals"
        description="Personal accounts on the public app: their status, sessions and plans."
        onRefresh={() => { void list.reload(); void stats.reload() }}
        busy={list.loading}
      />
      {list.error && <Notice tone="error">{list.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}

      <div className="stats">
        <Stat label="Accounts" icon={<User size={16} />} value={stats.data ? stats.data.total : '—'} />
        <Stat label="Active" value={stats.data ? stats.data.byStatus.active ?? 0 : '—'} />
        <Stat label="Suspended" value={stats.data ? stats.data.byStatus.suspended ?? 0 : '—'} />
        <Stat label="Signed in now" value={stats.data ? stats.data.activeSessions : '—'} />
      </div>

      <div className="grid-main">
        <Card flush>
          <form className="toolbar" onSubmit={applyFilters} style={{ justifyContent: 'flex-start' }}>
            <label className="search">
              <Search size={15} />
              <input className="input" type="search" name="search" placeholder="Name, username or email" defaultValue={filters.search} aria-label="Search individuals" />
            </label>
            <select className="input input-inline" name="status" defaultValue={filters.status} aria-label="Status" style={{ minWidth: 140 }}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="pending">Pending</option>
            </select>
            <select className="input input-inline" name="plan" defaultValue={filters.plan} aria-label="Plan" style={{ minWidth: 140 }}>
              <option value="">Any plan</option>
              {(plans.data ?? []).map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
            </select>
            <button className="btn btn-primary">Apply</button>
          </form>
          <Table minWidth={560}>
            <thead><tr><th>Person</th><th>Status</th><th>Plan</th><th className="right">Sessions</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId} className={`row-link${selected?.user.userId === user.userId ? ' row-selected' : ''}`} onClick={() => open(user.userId)}>
                  <td><span className="cell-title">{user.displayName}</span><span className="cell-sub">{user.username}{user.email ? ` · ${user.email}` : ''}</span></td>
                  <td><Badge tone={statusTone(user.status)} dot>{user.status}</Badge></td>
                  <td>{user.planCode ?? <span className="muted">None</span>}</td>
                  <td className="right num">{user.activeSessions}</td>
                </tr>
              ))}
              {!users.length && !list.loading && <tr className="empty-row"><td colSpan={4}>No accounts match.</td></tr>}
            </tbody>
          </Table>
          <div className="card-foot">
            <span>{total ? `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}` : 'No results'}</span>
            <div className="actions">
              <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
              <button type="button" className="btn btn-sm" disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>Next</button>
            </div>
          </div>
        </Card>

        {selected ? (
          <Card
            title={selected.user.displayName}
            subtitle={<span className="mono">{selected.user.username}</span>}
            actions={<button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setSelected(null)} aria-label="Close details"><X size={15} /></button>}
          >
            <dl className="kv">
              <dt>Email</dt><dd>{selected.user.email ?? '—'}</dd>
              <dt>Status</dt><dd><Badge tone={statusTone(selected.user.status)} dot>{selected.user.status}</Badge></dd>
              <dt>Joined</dt><dd>{formatDate(selected.user.createdAt)}</dd>
              <dt>Projects / groups</dt><dd className="num">{selected.projects} / {selected.groups}</dd>
              <dt>Active sessions</dt><dd className="num">{selected.activeSessions}</dd>
              <dt>Plan</dt><dd>{currentPlan ? <>{currentPlan.planCode} <StatusBadge status={currentPlan.status} /></> : <span className="muted">None</span>}</dd>
            </dl>
            <div className="form-inline">
              {selected.user.status === 'active' ? (
                <button type="button" className="btn btn-danger" disabled={action.busy} onClick={() => void act(selected.user.userId, 'suspend', undefined, { title: `Suspend ${selected.user.username}?`, body: 'Their sessions end immediately and they cannot sign in until reactivated.', label: 'Suspend' })}>Suspend</button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act(selected.user.userId, 'reactivate')}>Reactivate</button>
              )}
              <button type="button" className="btn" disabled={action.busy || !selected.activeSessions} onClick={() => void act(selected.user.userId, 'revoke-sessions')}>End sessions</button>
              <select
                className="input input-inline"
                value=""
                aria-label="Change plan"
                onChange={(event) => {
                  const planCode = event.target.value
                  if (planCode) void act(selected.user.userId, 'plan', { planCode, status: 'active' }, { title: `Move ${selected.user.username} to ${planCode}?`, body: 'The new plan applies immediately.', label: 'Change plan' })
                }}
              >
                <option value="">Change plan…</option>
                {(plans.data ?? []).map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
              </select>
            </div>
            {action.message && <Notice tone="success">{action.message}</Notice>}
            <div className="subhead">Recent activity</div>
            {selected.recentEvents.length === 0 ? (
              <p className="hint">No events.</p>
            ) : (
              <div className="list" style={{ margin: '0 calc(var(--card-pad) * -1)' }}>
                {selected.recentEvents.map((event, index) => (
                  <div key={index} className="list-item">
                    <div className="list-main"><strong className="mono" style={{ fontSize: 12.5 }}>{event.action}</strong><span>{formatDate(event.occurred_at)}</span></div>
                    <span className="list-aside">{event.outcome === 'success' ? <Badge tone="good">success</Badge> : <Badge tone="bad">{event.outcome}</Badge>}<span>{formatRelative(event.occurred_at)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ) : (
          <Card>
            <EmptyState icon={<User size={20} />} title="Select a person">See their plan, sessions and recent activity, and suspend or reactivate them.</EmptyState>
          </Card>
        )}
      </div>
    </div>
  )
}
