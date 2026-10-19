import { useEffect, useState, type FormEvent } from 'react'
import { Check, Download, FileUp, KeyRound, Tags, Trash2, UserPlus, X } from 'lucide-react'
import { csvCell, download, parseCsv } from '../csv'

// Administrator-facing user management pieces shared by the Users page and the
// first-login workspace setup: adding users, defining user categories and
// changing one's own password.

const API_ORIGIN = import.meta.env.VITE_TENANT_API_ORIGIN || ''

export type UserCategory = { id: string; name: string; description: string; userCount: number }

/** The two primary kinds of user; categories classify users further. */
export type UserKind = 'administrator' | 'user'
export const KIND_ROLE: Record<UserKind, string> = { administrator: 'tenant_admin', user: 'tenant_member' }

export type CreatedUser = {
  id: string
  username: string
  displayName: string
  email: string | null
  kind: UserKind
  category: { id: string; name: string } | null
  invitation: { link: string; delivered: boolean } | null
}

export function createTenantApi(csrfToken: string | null) {
  const send = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${API_ORIGIN}${url}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(csrfToken && method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) throw new Error(data.message || `Request failed (${res.status}).`)
    return data as T
  }
  return { send }
}
export type TenantApi = ReturnType<typeof createTenantApi>

export function useUserCategories(api: TenantApi, enabled = true) {
  const [categories, setCategories] = useState<UserCategory[]>([])
  const reload = async () => {
    if (!enabled) return
    try {
      setCategories((await api.send<{ categories: UserCategory[] }>('GET', '/api/v1/user-categories')).categories)
    } catch {
      setCategories([])
    }
  }
  useEffect(() => {
    if (enabled) void reload()
    else setCategories([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled])
  return { categories, reload }
}

function FormError({ message }: { message: string | null }) {
  return message ? <div className="ws-alert ws-inline-alert" role="alert">{message}</div> : null
}

// ---------------------------------------------------------------------------

export function ChangePasswordForm({ api, minLength = 8, onChanged }: { api: TenantApi; minLength?: number; onChanged?: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const newPassword = String(form.get('newPassword') || '')
    setError(null)
    if (newPassword !== String(form.get('confirmPassword') || '')) {
      setError('The new passwords do not match.')
      return
    }
    setBusy(true)
    try {
      const result = await api.send<{ message: string }>('POST', '/api/v1/auth/password', {
        currentPassword: String(form.get('currentPassword') || ''),
        newPassword,
      })
      formElement.reset()
      setDone(result.message)
      onChanged?.(result.message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ws-form" onSubmit={submit}>
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <label className="ws-field">
        <span>Current password</span>
        <input name="currentPassword" type="password" autoComplete="current-password" required maxLength={512} />
      </label>
      <label className="ws-field">
        <span>New password</span>
        <input name="newPassword" type="password" autoComplete="new-password" required minLength={minLength} maxLength={512} />
      </label>
      <label className="ws-field">
        <span>Confirm new password</span>
        <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={minLength} maxLength={512} />
      </label>
      <FormError message={error} />
      {done && <p className="ws-ok-line"><Check size={15} /> {done}</p>}
      <div>
        <button type="submit" className="ws-btn primary" disabled={busy}>
          <KeyRound size={16} /> {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

export function CategoryManager({ api, categories, onChanged }: { api: TenantApi; categories: UserCategory[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setBusy(true)
    setError(null)
    try {
      await api.send('POST', '/api/v1/user-categories', {
        name: String(form.get('name') || ''),
        description: String(form.get('description') || ''),
      })
      formElement.reset()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (category: UserCategory) => {
    if (category.userCount > 0 && !window.confirm(`${category.userCount} user(s) are in "${category.name}". Remove the category? They become uncategorised.`)) return
    setError(null)
    try {
      await api.send('DELETE', `/api/v1/user-categories/${category.id}`)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="ws-form">
      {categories.length === 0 ? (
        <p className="ws-empty-line">No categories yet. Add the kinds of users your organisation has, for example Inspector or Supervisor.</p>
      ) : (
        <ul className="ws-category-list">
          {categories.map((category) => (
            <li key={category.id}>
              <Tags size={15} />
              <div>
                <strong>{category.name}</strong>
                {category.description && <small>{category.description}</small>}
              </div>
              <em>{category.userCount} {category.userCount === 1 ? 'user' : 'users'}</em>
              <button type="button" className="ws-icon-btn" onClick={() => void remove(category)} aria-label={`Remove ${category.name}`} title="Remove">
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="ws-inline-form" onSubmit={add}>
        <label className="ws-field">
          <span>Category name</span>
          <input name="name" required maxLength={80} placeholder="e.g. Inspector" autoComplete="off" />
        </label>
        <label className="ws-field">
          <span>Description (optional)</span>
          <input name="description" maxLength={300} placeholder="What these users do" autoComplete="off" />
        </label>
        <button type="submit" className="ws-btn subtle" disabled={busy}>
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </form>
      <FormError message={error} />
    </div>
  )
}

// ---------------------------------------------------------------------------

export function AddUserForm({
  api,
  categories,
  canAddAdministrators,
  passwordMinLength = 8,
  allowInvitation = true,
  defaultPasswordConfigured = false,
  onCreated,
  onCancel,
}: {
  api: TenantApi
  categories: UserCategory[]
  canAddAdministrators: boolean
  passwordMinLength?: number
  /** Off where a separate Invite action exists: Add user then always sets a password. */
  allowInvitation?: boolean
  /** Offer the workspace default password (set under Users → Default password). */
  defaultPasswordConfigured?: boolean
  onCreated: (user: CreatedUser) => void
  onCancel?: () => void
}) {
  const [kind, setKind] = useState<UserKind>('user')
  const [access, setAccess] = useState<'default' | 'password' | 'invitation'>(defaultPasswordConfigured ? 'default' : 'password')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const password = String(form.get('password') || '')
    setError(null)
    if (access === 'password' && password !== String(form.get('confirmPassword') || '')) {
      setError('The passwords do not match.')
      return
    }
    const categoryId = String(form.get('categoryId') || '') || null
    setBusy(true)
    try {
      const result = await api.send<{ user: { id: string; username: string; displayName: string; email: string | null }; invitation?: { link: string; delivered: boolean } }>(
        'POST',
        '/api/v1/users',
        {
          displayName: String(form.get('displayName') || ''),
          username: String(form.get('username') || '').toLowerCase(),
          email: String(form.get('email') || '').toLowerCase(),
          role: KIND_ROLE[kind],
          categoryId,
          ...(access === 'password' ? { password } : access === 'default' ? { useDefaultPassword: true } : {}),
        },
      )
      formElement.reset()
      onCreated({
        ...result.user,
        kind,
        category: categoryId ? { id: categoryId, name: categories.find((c) => c.id === categoryId)?.name ?? '' } : null,
        invitation: result.invitation ?? null,
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ws-form" onSubmit={submit}>
      <div className="ws-segmented" role="radiogroup" aria-label="Kind of user">
        <button type="button" role="radio" aria-checked={kind === 'user'} onClick={() => setKind('user')}>
          <strong>User</strong>
          <small>Uses the workspace and its modules.</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === 'administrator'}
          disabled={!canAddAdministrators}
          title={canAddAdministrators ? undefined : 'Only the workspace owner can add administrators.'}
          onClick={() => setKind('administrator')}
        >
          <strong>Administrator</strong>
          <small>Manages users, categories and settings.</small>
        </button>
      </div>
      <label className="ws-field">
        <span>Full name</span>
        <input name="displayName" required maxLength={255} autoComplete="off" />
      </label>
      <label className="ws-field">
        <span>Username</span>
        <input name="username" required maxLength={64} pattern="[A-Za-z0-9._\-]+" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </label>
      <label className="ws-field">
        <span>Category</span>
        <select name="categoryId" defaultValue="">
          <option value="">No category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.name}</option>
          ))}
        </select>
      </label>
      {(allowInvitation || defaultPasswordConfigured) && (
        <div className="ws-segmented compact" style={{ gridTemplateColumns: `repeat(${1 + Number(allowInvitation) + Number(defaultPasswordConfigured)}, 1fr)` }} role="radiogroup" aria-label="Sign-in setup">
          {defaultPasswordConfigured && (
            <button type="button" role="radio" aria-checked={access === 'default'} onClick={() => setAccess('default')}>
              <strong>Default password</strong>
            </button>
          )}
          <button type="button" role="radio" aria-checked={access === 'password'} onClick={() => setAccess('password')}>
            <strong>Set a password</strong>
          </button>
          {allowInvitation && (
            <button type="button" role="radio" aria-checked={access === 'invitation'} onClick={() => setAccess('invitation')}>
              <strong>Email an invitation</strong>
            </button>
          )}
        </div>
      )}
      {access !== 'invitation' && <p className="ws-setup-hint" style={{ margin: 0 }}>The user must change this password at their first sign-in.</p>}
      <label className="ws-field">
        <span>Email{access === 'password' ? ' (optional)' : ''}</span>
        <input name="email" type="email" required={access === 'invitation'} maxLength={320} autoComplete="off" />
      </label>
      {access === 'password' && (
        <>
          <label className="ws-field">
            <span>Initial password</span>
            <input name="password" type="password" required minLength={passwordMinLength} maxLength={512} autoComplete="new-password" />
          </label>
          <label className="ws-field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" required minLength={passwordMinLength} maxLength={512} autoComplete="new-password" />
          </label>
        </>
      )}
      <FormError message={error} />
      <div className="ws-modal-actions">
        {onCancel && (
          <button type="button" className="ws-btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="ws-btn primary" disabled={busy}>
          <UserPlus size={16} /> {busy ? 'Adding…' : 'Add user'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

const SETUP_STEPS = [
  { title: 'Change your password', hint: 'Replace the password you were given with one only you know.' },
  { title: 'Add user categories', hint: 'Group users by what they do, for example Inspector or Supervisor. You can change these later under Users.' },
  { title: 'Add users', hint: 'Add administrators and users now, or later from the Users page.' },
] as const

/**
 * First-login workspace setup for administrators. Every step can be skipped
 * with Next; closing or finishing marks setup done so it is not shown again.
 */
export function SetupWizard({
  api,
  workspaceName,
  canAddAdministrators,
  passwordMinLength,
  defaultPasswordConfigured = false,
  onUsersAdded,
  onDone,
}: {
  api: TenantApi
  workspaceName: string
  canAddAdministrators: boolean
  passwordMinLength: number
  defaultPasswordConfigured?: boolean
  onUsersAdded: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState(0)
  const [added, setAdded] = useState<CreatedUser[]>([])
  const { categories, reload } = useUserCategories(api)

  const finish = async () => {
    try {
      await api.send('POST', '/api/v1/setup/complete')
    } catch {
      // Shown again next time; nothing else depends on it.
    }
    onDone()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void finish()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = SETUP_STEPS[step]!
  const last = step === SETUP_STEPS.length - 1

  return (
    <div className="ws-scrim ws-setup-scrim">
      <div className="ws-modal ws-setup" role="dialog" aria-modal="true" aria-labelledby="ws-setup-step">
        <header>
          <div>
            <span id="ws-setup-step" className="ws-setup-step">Step {step + 1} of {SETUP_STEPS.length}</span>
            <h3>Your workspace is almost ready</h3>
          </div>
          <button type="button" className="ws-icon-btn" onClick={() => void finish()} aria-label="Close setup" title="Close">
            <X size={18} />
          </button>
        </header>
        <div className="ws-setup-progress" aria-hidden>
          {SETUP_STEPS.map((_, index) => <i key={index} data-done={index <= step || undefined} />)}
        </div>
        <div className="ws-modal-body">
          <p>Please provide the following information to set up {workspaceName}. You can skip any step with Next.</p>
          <section className="ws-setup-section">
            <h4>{current.title}</h4>
            <p className="ws-setup-hint">{current.hint}</p>
            {step === 0 && <ChangePasswordForm api={api} minLength={passwordMinLength} />}
            {step === 1 && <CategoryManager api={api} categories={categories} onChanged={() => void reload()} />}
            {step === 2 && (
              <>
                {added.length > 0 && (
                  <ul className="ws-category-list">
                    {added.map((user) => (
                      <li key={user.id}>
                        <Check size={15} />
                        <div>
                          <strong>{user.displayName}</strong>
                          <small>{user.kind === 'administrator' ? 'Administrator' : 'User'}{user.category ? ` · ${user.category.name}` : ''} · {user.invitation ? 'invitation sent' : 'must change password at first sign-in'}</small>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <AddUserForm
                  api={api}
                  categories={categories}
                  canAddAdministrators={canAddAdministrators}
                  passwordMinLength={passwordMinLength}
                  defaultPasswordConfigured={defaultPasswordConfigured}
                  onCreated={(user) => {
                    setAdded((prev) => [...prev, user])
                    onUsersAdded()
                    void reload()
                  }}
                />
              </>
            )}
          </section>
        </div>
        <footer>
          <button type="button" className="ws-btn primary" onClick={() => (last ? void finish() : setStep(step + 1))}>
            {last ? 'Finish' : 'Next'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CSV import

export const USER_CSV_COLUMNS = ['name', 'username', 'email', 'kind', 'category', 'password'] as const
const CSV_TEMPLATE = `${USER_CSV_COLUMNS.join(',')}\nJane Doe,jane.doe,jane@example.com,user,Inspector,\nAli Khan,ali.khan,,administrator,,Initial-Pass-2026\n`

const HEADER_ALIASES: Record<string, (typeof USER_CSV_COLUMNS)[number]> = {
  name: 'name', 'full name': 'name', fullname: 'name', 'display name': 'name', displayname: 'name',
  username: 'username', 'user name': 'username', login: 'username',
  email: 'email', 'e-mail': 'email', 'email address': 'email',
  kind: 'kind', type: 'kind', role: 'kind',
  category: 'category', group: 'category',
  password: 'password', 'initial password': 'password',
}

type ImportRow = { displayName: string; username: string; email: string; kind: string; category: string; password: string }
type ImportResult = { row: number; username: string; status: 'created' | 'invited' | 'error'; message: string; invitationLink?: string; delivered?: boolean }

function toImportRows(table: string[][]): { rows: ImportRow[]; error: string | null } {
  if (table.length < 2) return { rows: [], error: 'The file needs a header row and at least one user.' }
  const header = table[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null)
  if (!header.includes('name') || !header.includes('username')) return { rows: [], error: 'The header must include at least "name" and "username" columns.' }
  const rows = table.slice(1).map((cells) => {
    const get = (key: (typeof USER_CSV_COLUMNS)[number]) => (header.indexOf(key) >= 0 ? (cells[header.indexOf(key)] ?? '').trim() : '')
    return { displayName: get('name'), username: get('username'), email: get('email'), kind: get('kind') || 'user', category: get('category'), password: get('password') }
  })
  if (rows.length > 500) return { rows: [], error: 'Import up to 500 users at a time.' }
  return { rows, error: null }
}

export function ImportUsersForm({ api, onImported, onClose }: { api: TenantApi; onImported: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)

  const load = async (next: File | null | undefined) => {
    setError(null)
    setResults(null)
    setRows([])
    setFile(next ?? null)
    if (!next) return
    const file = next
    if (file.size > 2 * 1024 * 1024) {
      setError('The file is larger than 2 MB.')
      return
    }
    const parsed = toImportRows(parseCsv(await file.text()))
    if (parsed.error) setError(parsed.error)
    setRows(parsed.rows)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.send<{ results: ImportResult[] }>('POST', '/api/v1/users/import', { rows })
      setResults(data.results)
      onImported()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const downloadResults = () => {
    if (!results) return
    const lines = ['row,username,status,message,invitation_link']
    for (const r of results) lines.push([String(r.row), r.username, r.status, r.message, r.invitationLink ?? ''].map(csvCell).join(','))
    download('user-import-results.csv', `${lines.join('\n')}\n`)
  }

  if (results) {
    const created = results.filter((r) => r.status === 'created').length
    const invited = results.filter((r) => r.status === 'invited').length
    const failed = results.filter((r) => r.status === 'error').length
    return (
      <div className="ws-form">
        <p className="ws-ok-line"><Check size={15} /> {created} created · {invited} invited · {failed} failed</p>
        {invited > 0 && <p className="ws-setup-hint">Invitation links are in the results file. Share them privately; each works once.</p>}
        <div className="ws-import-table">
          <table className="ws-table">
            <thead><tr><th>Row</th><th>Username</th><th>Result</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{r.username || '—'}</td>
                  <td><span className="ws-import-status" data-status={r.status}>{r.status === 'error' ? r.message : r.status === 'invited' ? 'Invited' : 'Created'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ws-modal-actions">
          <button type="button" className="ws-btn ghost" onClick={downloadResults}><Download size={16} /> Download results</button>
          <button type="button" className="ws-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  const issues = rows.filter((r) => !r.displayName || !r.username).length
  return (
    <div className="ws-form">
      {file ? (
        <div className="ws-file-chip">
          <span className="ws-file-icon" aria-hidden>
            CSV
          </span>
          <span className="ws-file-name">
            <strong>{file.name}</strong>
            <small>
              {rows.length} {rows.length === 1 ? 'user' : 'users'} found{issues ? ` · ${issues} missing a name or username` : ''}
            </small>
          </span>
          <label className="ws-btn ghost sm">
            Replace
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void load(e.target.files?.[0])} />
          </label>
          <button type="button" className="ws-icon-btn" aria-label="Remove file" onClick={() => void load(null)}>
            <X size={16} />
          </button>
        </div>
      ) : (
        <label
          className="ws-drop"
          data-over={over || undefined}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            void load(e.dataTransfer.files?.[0])
          }}
        >
          <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void load(e.target.files?.[0])} />
          <span className="ws-drop-icon" aria-hidden>
            <FileUp size={22} />
          </span>
          <strong>Choose a CSV file of users</strong>
          <span>
            Drag it here, or <u>choose a file</u>
          </span>
          <small>Columns: name, username, email, kind, category, password · up to 500 users</small>
        </label>
      )}
      <p className="ws-setup-hint" style={{ margin: 0 }}>
        Rows with a password get that password; rows without one get the workspace default if set, otherwise an email invitation. Users change an administrator-set password at
        first sign-in. Unknown categories are created.{' '}
        <button type="button" className="ws-link-btn" onClick={() => download('users-template.csv', CSV_TEMPLATE)}>
          <Download size={13} /> Download the template
        </button>
      </p>
      <FormError message={error} />
      {rows.length > 0 && (
        <div className="ws-import-table">
          <table className="ws-table">
            <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Kind</th><th>Category</th><th>Sign-in</th></tr></thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td>{r.displayName || '—'}</td>
                  <td>{r.username || '—'}</td>
                  <td>{r.email || '—'}</td>
                  <td>{r.kind}</td>
                  <td>{r.category || '—'}</td>
                  <td>{r.password ? 'Password' : 'Default or invitation'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && <p className="ws-setup-hint ws-table-more">Showing the first 50 of {rows.length}.</p>}
        </div>
      )}
      <div className="ws-modal-actions ws-import-actions">
        <span className="ws-muted">{rows.length ? `${rows.length} ${rows.length === 1 ? 'user' : 'users'} ready to import` : ''}</span>
        <button type="button" className="ws-btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="ws-btn primary" disabled={busy || rows.length === 0 || Boolean(error)} onClick={() => void submit()}>
          <FileUp size={16} /> {busy ? 'Importing…' : rows.length ? `Import ${rows.length} ${rows.length === 1 ? 'user' : 'users'}` : 'Import'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Default password and forced change

export function DefaultPasswordForm({
  api,
  minLength = 8,
  status,
  onSaved,
}: {
  api: TenantApi
  minLength?: number
  status: { configured: boolean; updatedAt: string | null }
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const password = String(form.get('password') || '')
    setError(null)
    setDone(false)
    if (password !== String(form.get('confirmPassword') || '')) {
      setError('The passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await api.send('PUT', '/api/v1/users/default-password', { password })
      formElement.reset()
      setDone(true)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ws-form" onSubmit={submit}>
      <p className="ws-setup-hint" style={{ margin: 0 }}>
        {status.configured
          ? `A default password is set${status.updatedAt ? ` (changed ${new Date(status.updatedAt).toLocaleString()})` : ''}. It cannot be shown again; enter a new one to replace it.`
          : 'No default password is set yet.'}{' '}
        It is used for new users without a password and when you reset a user&rsquo;s password. Users must change it at their first sign-in.
      </p>
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <label className="ws-field">
        <span>{status.configured ? 'New default password' : 'Default password'}</span>
        <input name="password" type="password" required minLength={minLength} maxLength={512} autoComplete="new-password" />
      </label>
      <label className="ws-field">
        <span>Confirm</span>
        <input name="confirmPassword" type="password" required minLength={minLength} maxLength={512} autoComplete="new-password" />
      </label>
      <FormError message={error} />
      {done && <p className="ws-ok-line"><Check size={15} /> Default password saved.</p>}
      <div>
        <button type="submit" className="ws-btn primary" disabled={busy}>
          <KeyRound size={16} /> {busy ? 'Saving…' : 'Save default password'}
        </button>
      </div>
    </form>
  )
}

/** Blocking screen: an administrator set this user's password, so it must be changed first. */
export function ForcedPasswordChange({
  api,
  workspaceName,
  displayName,
  minLength,
  onChanged,
  onLogout,
}: {
  api: TenantApi
  workspaceName: string
  displayName: string
  minLength: number
  onChanged: () => void
  onLogout: () => void
}) {
  return (
    <div className="ws-scrim ws-setup-scrim">
      <div className="ws-modal ws-setup" role="dialog" aria-modal="true" aria-labelledby="ws-forced-title">
        <header>
          <div>
            <span className="ws-setup-step">{workspaceName}</span>
            <h3 id="ws-forced-title">Choose a new password</h3>
          </div>
        </header>
        <div className="ws-modal-body">
          <p>Welcome, {displayName}. Your password was set by an administrator. Choose your own password to continue.</p>
          <ChangePasswordForm api={api} minLength={minLength} onChanged={() => onChanged()} />
        </div>
        <footer>
          <button type="button" className="ws-btn ghost" onClick={onLogout}>Sign out</button>
        </footer>
      </div>
    </div>
  )
}
