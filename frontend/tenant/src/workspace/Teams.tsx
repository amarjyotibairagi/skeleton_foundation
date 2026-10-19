import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Building2, Pencil, Search, Trash2, Users, X } from 'lucide-react'
import type { TenantApi } from './UserAdmin'

// Departments and groups of the workspace. Modules may grant access to them;
// they are managed here, in the workspace admin area.

export type Team = { id: string; name: string; kind: 'department' | 'group'; userIds: string[]; canManage: boolean }
export type TeamMember = { id: string; displayName: string; username: string; role: 'admin' | 'manager' | 'user' | 'guest' }

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')

export function useTeams(api: TenantApi, enabled: boolean) {
  const [teams, setTeams] = useState<Team[]>([])
  const [loaded, setLoaded] = useState(false)
  const reload = async () => {
    if (!enabled) return
    try {
      setTeams((await api.send<{ teams: Team[] }>('GET', '/api/v1/teams')).teams)
    } catch {
      setTeams([])
    } finally {
      setLoaded(true)
    }
  }
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled])
  return { teams, loaded, reload }
}

export function TeamsPage({
  api,
  teams,
  loaded,
  members,
  managerOnly,
  onChanged,
  onEdit,
  onToast,
}: {
  api: TenantApi
  teams: Team[]
  loaded: boolean
  members: TeamMember[]
  managerOnly: boolean
  onChanged: () => void
  onEdit: (team: Team) => void
  onToast: (message: string) => void
}) {
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const archive = async (team: Team) => {
    if (!window.confirm(`Archive ${team.name}? Its members lose any access it granted.`)) return
    try {
      await api.send('DELETE', `/api/v1/teams/${team.id}`)
      onToast(`${team.name} archived`)
      onChanged()
    } catch (error) {
      onToast((error as Error).message)
    }
  }
  const section = (kind: Team['kind'], title: string, hint: string) => {
    const list = teams.filter((t) => t.kind === kind)
    return (
      <section className="ws-teams-section">
        <header>
          <h3>
            {title} <em>{list.length}</em>
          </h3>
          <p>{hint}</p>
        </header>
        {list.length === 0 ? (
          <p className="ws-empty-line">None yet.</p>
        ) : (
          <div className="ws-teams-grid">
            {list.map((team) => (
              <article key={team.id} className="ws-team-card" data-kind={team.kind}>
                <div className="ws-team-card-head">
                  <span className="ws-team-icon">{team.kind === 'department' ? <Building2 size={18} /> : <Users size={18} />}</span>
                  <div>
                    <strong>{team.name}</strong>
                    <small>
                      {team.userIds.length} member{team.userIds.length === 1 ? '' : 's'}
                    </small>
                  </div>
                  {team.canManage && (
                    <span className="ws-team-actions">
                      <button type="button" className="ws-icon-btn" aria-label={`Edit ${team.name}`} title="Edit" onClick={() => onEdit(team)}>
                        <Pencil size={15} />
                      </button>
                      <button type="button" className="ws-icon-btn" aria-label={`Archive ${team.name}`} title="Archive" onClick={() => void archive(team)}>
                        <Trash2 size={15} />
                      </button>
                    </span>
                  )}
                </div>
                <div className="ws-faces">
                  {team.userIds.slice(0, 6).map((id) => {
                    const m = byId.get(id)
                    return (
                      <span key={id} className="ws-avatar sm" title={m?.displayName ?? 'User'}>
                        {initialsOf(m?.displayName ?? '?')}
                      </span>
                    )
                  })}
                  {team.userIds.length > 6 && <span className="ws-avatar sm more">+{team.userIds.length - 6}</span>}
                  {team.userIds.length === 0 && <span className="ws-muted">No members</span>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    )
  }
  if (!loaded) return <p className="ws-empty-line">Loading departments and groups…</p>
  return (
    <div className="ws-stack">
      {managerOnly && <p className="ws-setup-hint">As a manager you can change the departments and groups you created, with users and viewers as members.</p>}
      {section('department', 'Departments', 'Organisational units. Members can belong to several.')}
      {section('group', 'Groups', 'Working groups and teams that cut across departments.')}
    </div>
  )
}

export function TeamForm({
  api,
  team,
  members,
  managerOnly,
  onSaved,
  onCancel,
}: {
  api: TenantApi
  team: Team | null
  members: TeamMember[]
  managerOnly: boolean
  onSaved: (message: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(team?.name ?? '')
  const [kind, setKind] = useState<Team['kind']>(team?.kind ?? 'department')
  const [chosen, setChosen] = useState<Set<string>>(new Set(team?.userIds ?? []))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Managers may only add users and viewers (enforced by the server too).
  const eligible = members.filter((m) => !managerOnly || m.role === 'user' || m.role === 'guest')
  const q = query.trim().toLowerCase()
  const visible = eligible.filter((m) => !q || `${m.displayName} ${m.username}`.toLowerCase().includes(q))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = { name, kind, userIds: [...chosen] }
      if (team) await api.send('PUT', `/api/v1/teams/${team.id}`, body)
      else await api.send('POST', '/api/v1/teams', body)
      onSaved(`${name} ${team ? 'saved' : 'created'}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ws-form" onSubmit={submit}>
      <div className="ws-segmented" role="radiogroup" aria-label="Type">
        <button type="button" role="radio" aria-checked={kind === 'department'} onClick={() => setKind('department')}>
          <strong>Department</strong>
          <small>An organisational unit.</small>
        </button>
        <button type="button" role="radio" aria-checked={kind === 'group'} onClick={() => setKind('group')}>
          <strong>Group</strong>
          <small>A working group or team.</small>
        </button>
      </div>
      <label className="ws-field">
        <span>Name</span>
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <div className="ws-field">
        <span>
          Members <em className="ws-muted">({chosen.size} selected)</em>
        </span>
        <label className="ws-search ws-team-search">
          <Search size={16} />
          <input type="search" placeholder="Search users" aria-label="Search members" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" className="ws-icon-btn" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <ul className="ws-member-pick">
          {visible.map((m) => (
            <li key={m.id}>
              <label>
                <input
                  type="checkbox"
                  checked={chosen.has(m.id)}
                  onChange={() =>
                    setChosen((prev) => {
                      const next = new Set(prev)
                      if (next.has(m.id)) next.delete(m.id)
                      else next.add(m.id)
                      return next
                    })
                  }
                />
                <span className="ws-avatar sm">{initialsOf(m.displayName)}</span>
                <span>
                  <strong>{m.displayName}</strong>
                  <small>{m.username}</small>
                </span>
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="ws-empty-line">No matching users.</li>}
        </ul>
      </div>
      {error && <div className="ws-alert ws-inline-alert" role="alert">{error}</div>}
      <div className="ws-modal-actions">
        <button type="button" className="ws-btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="ws-btn primary" disabled={busy}>
          {busy ? 'Saving…' : team ? 'Save' : 'Create'}
        </button>
      </div>
    </form>
  )
}
