import { Fragment, useState, type FormEvent } from 'react'
import { KeyRound, LogOut, Power, RotateCcw, UserPlus } from 'lucide-react'
import { useConsole } from '../shell/context'
import { Badge, Card, Field, Modal, Notice, OneTimeLink, PageHeader, RowMenu, Table, formatRelative, useAsyncAction, useConfirm, useResource } from './ui'

type Operator = {
  id: string
  username: string
  displayName: string | null
  email: string | null
  role: 'platform_owner' | 'platform_admin' | 'platform_viewer'
  isActive: boolean
  hasPassword: boolean
  mfaCredentials: number
  activeSessions: number
  pendingInvitationExpiresAt: string | null
  lastAuthenticatedAt: string | null
}

const roles = [
  ['platform_owner', 'Owner', 'Everything, including operators, plans and DNS'],
  ['platform_admin', 'Administrator', 'Tenants, individuals, server and audit'],
  ['platform_viewer', 'Viewer', 'Read-only: domains, plans and configuration'],
] as const

export function OperatorsView() {
  const { api, user } = useConsole()
  const confirm = useConfirm()
  const operators = useResource<Operator[]>(async () => (await api.get('/api/platform/users')).users, [api])
  const [issued, setIssued] = useState<{ username: string; link: string; delivered: boolean } | null>(null)
  const [inviting, setInviting] = useState(false)
  const action = useAsyncAction()

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.run(async () => {
      const username = String(form.get('username'))
      const result = await api.send('POST', '/api/platform/users', {
        username,
        displayName: form.get('displayName'),
        email: form.get('email') || '',
        role: form.get('role'),
      })
      setIssued({ username, link: result.invitation.link, delivered: result.invitation.delivered })
      setInviting(false)
      await operators.reload()
      return `Invitation created for ${username}.`
    })
  }

  const operate = async (operator: Operator, path: string, body: unknown, done: string, ask?: { title: string; body: string; label: string }) => {
    if (ask && !(await confirm({ title: ask.title, body: ask.body, confirmLabel: ask.label, tone: 'danger' }))) return
    void action.run(async () => {
      const result = await api.send('POST', `/api/platform/users/${operator.id}/${path}`, body)
      if (result.invitation) setIssued({ username: operator.username, link: result.invitation.link, delivered: false })
      await operators.reload()
      return done
    })
  }

  const list = operators.data ?? []
  return (
    <div className="page">
      <PageHeader
        title="Operators"
        description="People who can sign in to this console. Every change needs a fresh security-key check."
        onRefresh={() => void operators.reload()}
        busy={operators.loading}
        actions={<button type="button" className="btn btn-primary" onClick={() => setInviting(true)}><UserPlus size={15} /> Invite operator</button>}
      />
      {operators.error && <Notice tone="error">{operators.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {issued && <OneTimeLink label={`Set-password link for ${issued.username}`} link={issued.link} delivered={issued.delivered} />}

      <Card title="Team" subtitle={`${list.filter((operator) => operator.isActive).length} active of ${list.length}`} flush>
        <Table minWidth={860}>
          <thead><tr><th>Operator</th><th>Role</th><th>State</th><th>Security keys</th><th>Last sign-in</th><th className="right" /></tr></thead>
          <tbody>
            {list.map((operator) => {
              const self = operator.id === user.id
              return (
                <tr key={operator.id}>
                  <td>
                    <span className="inline-flex" style={{ gap: 10 }}>
                      <span className="avatar">{(operator.displayName || operator.username).charAt(0).toUpperCase()}</span>
                      <span>
                        <span className="cell-title">{operator.displayName || operator.username}{self && <Badge tone="accent">You</Badge>}</span>
                        <span className="cell-sub"><span className="mono">{operator.username}</span>{operator.email ? ` · ${operator.email}` : ''}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <select
                      className="input input-sm input-inline"
                      style={{ minWidth: 150 }}
                      value={operator.role}
                      disabled={self || action.busy}
                      aria-label={`Role of ${operator.username}`}
                      onChange={(event) => void operate(operator, 'role', { role: event.target.value }, 'Role changed; their sessions were ended.')}
                    >
                      {roles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                  </td>
                  <td>
                    {operator.isActive ? <Badge tone="good" dot>Active</Badge> : operator.pendingInvitationExpiresAt ? <Badge tone="info" dot>Invited</Badge> : <Badge tone="warn" dot>Disabled</Badge>}
                    {operator.activeSessions > 0 && <span className="cell-sub">{operator.activeSessions} session(s)</span>}
                  </td>
                  <td>{operator.mfaCredentials > 0 ? <Badge tone="good">{operator.mfaCredentials} enrolled</Badge> : <Badge tone="warn">None</Badge>}</td>
                  <td className="nowrap muted">{formatRelative(operator.lastAuthenticatedAt)}</td>
                  <td className="right">
                    {!self && (
                      <OperatorMenu
                        operator={operator}
                        disabled={action.busy}
                        onDisable={() => void operate(operator, 'deactivate', undefined, 'Operator disabled.', { title: `Disable ${operator.username}?`, body: 'Their sessions end immediately and they can no longer sign in.', label: 'Disable' })}
                        onEnable={() => void operate(operator, 'enable', undefined, 'Operator enabled.')}
                        onResetAccess={() => void operate(operator, 'invitation', undefined, 'New set-password link issued.', { title: `Reset access for ${operator.username}?`, body: 'Issues a new set-password link. Accepting it replaces their password and removes their security keys.', label: 'Issue link' })}
                        onResetKeys={() => void operate(operator, 'reset-mfa', undefined, 'Security keys removed; they enrol again at their next sign-in.', { title: `Remove ${operator.username}'s security keys?`, body: 'They must enrol a new key before their next privileged action.', label: 'Remove keys' })}
                        onEndSessions={() => void operate(operator, 'revoke-sessions', undefined, 'Sessions ended.')}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      </Card>

      <Card title="Roles">
        <dl className="kv">
          {roles.map(([id, label, text]) => (
            <Fragment key={id}><dt>{label}</dt><dd>{text}</dd></Fragment>
          ))}
        </dl>
      </Card>

      {inviting && (
        <Modal
          title="Invite an operator"
          description="They receive a one-time link to set their password, then enrol a security key."
          icon={<UserPlus size={18} />}
          onClose={() => setInviting(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setInviting(false)}>Cancel</button>
              <button type="submit" form="invite-operator" className="btn btn-primary" disabled={action.busy}>Create invitation</button>
            </>
          }
        >
          <form id="invite-operator" className="form" onSubmit={invite}>
            <Field label="Full name"><input className="input" name="displayName" required maxLength={255} /></Field>
            <Field label="Username" hint="Lowercase; 3–64 characters"><input className="input mono" name="username" required pattern="[a-z0-9][a-z0-9._\-]{2,63}" autoComplete="off" /></Field>
            <Field label="Email" optional hint="The link is emailed when email delivery is configured"><input className="input" name="email" type="email" /></Field>
            <Field label="Role">
              <select className="input" name="role" defaultValue="platform_viewer">
                {roles.map(([id, label, text]) => <option key={id} value={id}>{label}: {text}</option>)}
              </select>
            </Field>
            {action.error && <Notice tone="error">{action.error}</Notice>}
          </form>
        </Modal>
      )}
    </div>
  )
}

function OperatorMenu({ operator, disabled, onDisable, onEnable, onResetAccess, onResetKeys, onEndSessions }: {
  operator: Operator
  disabled: boolean
  onDisable: () => void
  onEnable: () => void
  onResetAccess: () => void
  onResetKeys: () => void
  onEndSessions: () => void
}) {
  return (
    <RowMenu label={`Actions for ${operator.username}`} disabled={disabled}>
      {(close) => {
        const item = (label: string, Icon: typeof Power, run: () => void, danger?: boolean) => (
          <button type="button" className="menu-item" role="menuitem" data-tone={danger ? 'danger' : undefined} onClick={() => { close(); run() }}>
            <Icon size={15} />
            {label}
          </button>
        )
        return (
          <>
            {item('End sessions', LogOut, onEndSessions)}
            {item('Reset security keys', KeyRound, onResetKeys)}
            {item('Reset access (new link)', RotateCcw, onResetAccess)}
            <div className="menu-sep" />
            {operator.isActive ? item('Disable', Power, onDisable, true) : operator.hasPassword ? item('Enable', Power, onEnable) : null}
          </>
        )
      }}
    </RowMenu>
  )
}
