import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { TurnstileSlot } from '@skeleton/ui/TurnstileSlot'
import { useTurnstile } from '@skeleton/ui/useTurnstile'
import { WorkspaceSettings } from './WorkspaceSettings'
import { FilesPage } from './FilesPage'
import { IntegrationsSettings } from './IntegrationsSettings'
import { TeamForm, TeamsPage, useTeams, type Team } from './workspace/Teams'
import { AddUserForm, CategoryManager, ChangePasswordForm, DefaultPasswordForm, ForcedPasswordChange, ImportUsersForm, SetupWizard, createTenantApi, useUserCategories } from './workspace/UserAdmin'
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FileClock,
  FileText,
  Home,
  KeyRound,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  Upload,
  UserCheck,
  Tags,
  UserPlus,
  Users,
  X,
  Building2,
} from 'lucide-react'

const API_ORIGIN = import.meta.env.VITE_TENANT_API_ORIGIN || ''

type TenantRole = 'admin' | 'manager' | 'user' | 'guest'

// The API accepts canonical role codes only; the UI keeps its short labels.
const CANONICAL_ROLE: Record<TenantRole, string> = {
  admin: 'tenant_admin',
  manager: 'tenant_manager',
  user: 'tenant_member',
  guest: 'tenant_viewer',
}

const ROLE_INFO: Record<TenantRole, { label: string; summary: string }> = {
  admin: { label: 'Administrator', summary: 'Full control of members, roles, settings and the audit trail.' },
  manager: { label: 'Manager', summary: 'Adds users and viewers, runs their departments and groups, and reviews the audit trail.' },
  user: { label: 'User', summary: 'Uses the workspace and the modules shared with them.' },
  guest: { label: 'Viewer', summary: 'Read-only access to what is shared with them.' },
}

const ROLES = ['admin', 'manager', 'user', 'guest'] as const

type TenantUser = {
  id: string
  username: string
  displayName: string
  email: string
  status: string
  role: TenantRole
  canonicalRole?: string
  roleDescription?: string
  createdAt?: string
  category?: { id: string; name: string } | null
  /** On the signed-in user: an administrator set the password, change it first. */
  mustChangePassword?: boolean
  /** In the users list: the same, shown to administrators. */
  passwordChangeRequired?: boolean
}

type AuditLog = {
  id: string
  action: string
  resourceType: string
  outcome: 'success' | 'denied' | 'failure'
  occurredAt: string
  actor: string
}

type TenantInfo = {
  tenantId: string
  slug: string
  name: string
  domain: string
  description: string
  primaryColor: string
  accentColor: string
  planName: string
  loginMessage: string
  logoUrl: string | null
}

type NavId = 'Overview' | 'Members' | 'Teams' | 'Audit' | 'Files' | 'Settings'

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '·'
  )
}

/** `auth:login` → "Auth login"; good enough for codes the UI does not know. */
function humanAction(action: string): string {
  const known: Record<string, string> = {
    'auth:login': 'Signed in',
    'auth:logout': 'Signed out',
    'auth:login_failed': 'Sign-in failed',
    'auth:turnstile_failed': 'Verification failed',
    'user:create': 'Added a user',
    'user:invite': 'Invited a user',
    'user:category': 'Changed a user category',
    'user:password_change': 'Changed their password',
    'user:password_reset': 'Reset a user\'s password',
    'workspace:default_password': 'Changed the default password',
    'user_category:create': 'Created a user category',
    'user_category:delete': 'Removed a user category',
    'team:create': 'Created a department or group',
    'team:update': 'Changed a department or group',
    'team:archive': 'Archived a department or group',
  }
  if (known[action]) return known[action]
  const words = action.replace(/[:._]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d < 7 ? `${d} d ago` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function BrandMark({ info, size = 40 }: { info: TenantInfo; size?: number }) {
  return (
    <span className="ws-mark" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {info.logoUrl ? <img src={info.logoUrl} alt="" /> : initialsOf(info.name)}
    </span>
  )
}

// Sign-in backdrop: faint route lines with stops drifting over the brand gradient.
const LOGIN_ROUTES = [
  'M-40 760 C 220 700, 360 520, 600 540 S 980 700, 1180 560 S 1500 300, 1660 340',
  'M-40 300 C 180 360, 300 220, 520 260 S 860 460, 1060 380 S 1380 140, 1660 180',
  'M200 1040 C 260 820, 420 700, 640 720 S 900 900, 1100 820 S 1360 620, 1660 660',
  'M-40 520 C 160 480, 260 600, 460 580 S 740 380, 960 420 S 1260 560, 1660 480',
  'M900 -40 C 860 160, 980 260, 1000 420 S 900 760, 1020 1040',
  'M420 -40 C 460 120, 360 260, 400 400 S 560 640, 520 1040',
]
const LOGIN_STOPS: [number, number][] = [
  [600, 540], [1180, 560], [520, 260], [1060, 380], [640, 720], [1100, 820], [460, 580], [960, 420], [1000, 420], [400, 400], [300, 228], [1380, 142],
]

function LoginBackdrop() {
  return (
    <div className="ws-login-backdrop" aria-hidden>
      <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        {LOGIN_ROUTES.map((d, i) => (
          <g key={i}>
            <path d={d} className="base" />
            <path d={d} className="flow" style={{ animationDelay: `${i * -2.3}s` }} />
          </g>
        ))}
        {LOGIN_STOPS.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4" className="stop" style={{ animationDelay: `${i * 0.45}s` }} />
        ))}
      </svg>
    </div>
  )
}

function RolePill({ role }: { role: TenantRole }) {
  return (
    <span className="ws-role" data-role={role}>
      {ROLE_INFO[role]?.label ?? role}
    </span>
  )
}

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="ws-scrim" onClick={onClose}>
      <div className="ws-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button type="button" className="ws-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="ws-modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export default function App() {
  const [tenantInfo, setTenantInfo] = useState<TenantInfo>({
    tenantId: '',
    slug: '',
    name: 'Workspace',
    domain: '',
    description: '',
    primaryColor: '#2563eb',
    accentColor: '#0f172a',
    planName: 'Enterprise',
    loginMessage: '',
    logoUrl: null,
  })

  // Shared app host (app.<domain>): the company is chosen at sign-in and remembered on the device.
  const [appMode, setAppMode] = useState<{ company: string | null } | null>(null)
  const [company, setCompany] = useState('')
  // Auth state
  const [currentUser, setCurrentUser] = useState<TenantUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)

  // Login Gate form state
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const turnstile = useTurnstile({
    enabled: !checkingSession && !currentUser,
    onError: setErrorMsg,
  })
  const { isVerified, turnstileToken, resetTurnstile } = turnstile

  // Workspace UI state
  const [mobileOpen, setMobileOpen] = useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [editRoleUser, setEditRoleUser] = useState<TenantUser | null>(null)
  const [toast, setToast] = useState('')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<TenantRole | ''>('')
  const [activeNav, setActiveNav] = useState<NavId>('Overview')
  const [tenantConfig, setTenantConfig] = useState<Record<string, unknown>>({})
  const [members, setMembers] = useState<TenantUser[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [isLoadingData, setIsLoadingData] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ name: string; link: string; delivered: boolean } | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [addUserOpen, setAddUserOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [defaultPasswordOpen, setDefaultPasswordOpen] = useState(false)
  const [teamEdit, setTeamEdit] = useState<Team | 'new' | null>(null)
  const [defaultPassword, setDefaultPassword] = useState<{ configured: boolean; updatedAt: string | null }>({ configured: false, updatedAt: null })
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [setupPending, setSetupPending] = useState(false)
  const tenantApi = useMemo(() => createTenantApi(csrfToken), [csrfToken])

  const role: TenantRole = currentUser?.role ?? 'guest'
  const can = {
    // The user directory is for administrators and managers only.
    members: role === 'admin' || role === 'manager',
    invite: role === 'admin' || role === 'manager',
    editRoles: role === 'admin' || role === 'manager',
    audit: role === 'admin' || role === 'manager',
    settings: role === 'admin',
  }
  const assignableRoles: TenantRole[] = role === 'manager' ? ['user','guest'] : currentUser?.canonicalRole === 'tenant_owner' ? ['admin','manager','user','guest'] : ['manager','user','guest']
  const passwordMinLength = Number(tenantConfig['auth.password.min_length'] ?? 8) || 8
  // Administrators can only be added by the owner (see canAssignRole).
  const canAddAdministrators = currentUser?.canonicalRole === 'tenant_owner'
  // Until a forced password change is done, the server answers everything else with 403.
  const workspaceUnlocked = Boolean(currentUser) && !currentUser?.mustChangePassword
  const { categories, reload: reloadCategories } = useUserCategories(tenantApi, workspaceUnlocked && can.members)
  const { teams, loaded: teamsLoaded, reload: reloadTeams } = useTeams(tenantApi, workspaceUnlocked && can.members)
  const loadDefaultPassword = async () => {
    try {
      const data = await tenantApi.send<{ configured: boolean; updatedAt: string | null }>('GET', '/api/v1/users/default-password')
      setDefaultPassword({ configured: data.configured, updatedAt: data.updatedAt })
    } catch {
      setDefaultPassword({ configured: false, updatedAt: null })
    }
  }
  useEffect(() => {
    if (workspaceUnlocked && can.invite) void loadDefaultPassword()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceUnlocked, can.invite, tenantApi])
  // Load tenant metadata
  const loadTenantInfo = async () => {
    const res = await fetch(`${API_ORIGIN}/api/tenant/bootstrap`, { credentials: 'include' })
    const data = await res.json()
    if (res.ok && data.app) setAppMode({ company: data.app.company ?? null })
    if (res.ok && data.app && !data.tenant) {
      setTenantInfo((info) => ({ ...info, name: 'Sign in', domain: window.location.hostname }))
      document.title = 'Sign in'
      return
    }
    if (!res.ok || !data.tenant) throw new Error(data.message || 'This workspace is unavailable.')
    const metadata = data.tenant.branding?.safeMetadata || {}
    setTenantConfig(data.config || {})
    setTenantInfo({
      tenantId: data.tenant.tenantId,
      slug: data.tenant.subdomain,
      name: data.tenant.displayName,
      domain: data.tenant.hostname,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      primaryColor: data.tenant.branding?.primaryColor || '#2563eb',
      accentColor: data.tenant.branding?.secondaryColor || '#0f172a',
      planName: typeof metadata.planName === 'string' ? metadata.planName : 'Enterprise',
      loginMessage: data.tenant.branding?.loginMessage || '',
      logoUrl: data.tenant.branding?.logoUrl || null,
    })
    document.title = data.tenant.displayName
  }

  // Check the initial session.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadTenantInfo(),
      fetch(`${API_ORIGIN}/api/auth/session`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        if (data.authenticated && data.user) {
          setCurrentUser({
            id: data.user.id,
            username: data.user.username,
            displayName: data.user.displayName,
            email: data.user.email,
            status: 'active',
            role: data.user.role || 'user',
            canonicalRole: data.user.canonicalRole,
            mustChangePassword: data.user.mustChangePassword === true,
          })
          setCsrfToken(data.csrfToken)
        }
      }),
    ])
      .catch(() => {
        if (!cancelled) setErrorMsg('This workspace could not be reached. Check your connection and try again.')
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Handle Login Submit
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    if (!isVerified) return

    setErrorMsg(null)
    if (appMode && !appMode.company && !company.trim()) {
      setErrorMsg('Enter your company.')
      return
    }
    if (!username.trim()) {
      setErrorMsg('Enter your email or username.')
      return
    }

    setIsLoading(true)
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: username.trim(),
          password,
          turnstileToken,
          ...(appMode && !appMode.company ? { company: company.trim() } : {}),
        }),
      })

      const data = await res.json()

      if (res.ok && data.success && appMode && !appMode.company) {
        // First sign-in on the shared app: load the chosen company's workspace.
        window.location.replace('/')
        return
      }
      if (res.ok && data.success) {
        setCurrentUser({
          id: data.user.id,
          username: data.user.username,
          displayName: data.user.displayName,
          email: data.user.email,
          status: 'active',
          role: data.user.role || 'user',
          canonicalRole: data.user.canonicalRole,
          mustChangePassword: data.user.mustChangePassword === true,
        })
        setCsrfToken(data.csrfToken)
        setPassword('')
      } else {
        setErrorMsg(data.message || 'That email and password did not match.')
        resetTurnstile()
      }
    } catch {
      setErrorMsg('Unable to reach the server. Check your connection and try again.')
      resetTurnstile()
    } finally {
      setIsLoading(false)
    }
  }

  // Handle Logout
  const handleLogout = async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Logout failed')
    } catch {
      setToast('Unable to sign out. Please retry.')
      return
    }
    setCurrentUser(null)
    setCsrfToken(null)
    setMembers([])
    setAuditLogs([])
    setUsername('')
    setPassword('')
    setMobileOpen(false)
    resetTurnstile()
    // The shared app forgets the company on a manual sign-out.
    if (appMode) window.location.replace('/')
  }

  const forgetCompany = async () => {
    await fetch(`${API_ORIGIN}/api/app/forget-company`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
    window.location.replace('/')
  }

  // Fetch members & audit logs for authenticated workspace
  const loadTenantData = async () => {
    if (!currentUser || currentUser.mustChangePassword) return
    const wantMembers = currentUser.role === 'admin' || currentUser.role === 'manager'
    const wantAudit = currentUser.role === 'admin' || currentUser.role === 'manager'
    if (!wantMembers && !wantAudit) return
    setIsLoadingData(true)
    try {
      const [usersRes, auditRes] = await Promise.all([
        wantMembers ? fetch(`${API_ORIGIN}/api/v1/users?limit=100`, { credentials: 'include' }) : null,
        wantAudit ? fetch(`${API_ORIGIN}/api/v1/audit`, { credentials: 'include' }) : null,
      ])
      const [usersData, auditData] = await Promise.all([usersRes?.json(), auditRes?.json()])
      if (usersRes) {
        if (usersRes.ok && usersData.users) setMembers(usersData.users)
        else setToast(usersData?.message || 'Unable to load members.')
      }
      if (auditRes) {
        if (auditRes.ok && auditData.logs) setAuditLogs(auditData.logs)
        else if (auditRes.status !== 403) setToast(auditData?.message || 'Unable to load the audit trail.')
      }
    } catch {
      setToast('Unable to load workspace data.')
    } finally {
      setIsLoadingData(false)
    }
  }

  useEffect(() => {
    if (currentUser) {
      loadTenantData()
    }
  }, [currentUser])

  // First sign-in of an administrator: offer the guided workspace setup.
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin' || currentUser.mustChangePassword) {
      setSetupPending(false)
      return
    }
    let cancelled = false
    tenantApi
      .send<{ pending: boolean }>('GET', '/api/v1/setup')
      .then((data) => !cancelled && setSetupPending(Boolean(data.pending)))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id, currentUser?.mustChangePassword])

  const handleCategoryChange = async (userId: string, categoryId: string | null) => {
    try {
      await tenantApi.send('PATCH', `/api/v1/users/${userId}/category`, { categoryId })
      const category = categoryId ? categories.find((c) => c.id === categoryId) : null
      setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, category: category ? { id: category.id, name: category.name } : null } : m)))
      setToast(category ? `Category set to ${category.name}` : 'Category removed')
      void reloadCategories()
    } catch (error) {
      setToast((error as Error).message)
    }
  }

  // Toast timer
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return members.filter((member) => {
      const matchSearch = !q || `${member.displayName} ${member.username} ${member.email}`.toLowerCase().includes(q)
      const matchRole = !roleFilter || member.role === roleFilter
      return matchSearch && matchRole
    })
  }, [members, search, roleFilter])

  // Invite member: the invited person chooses their own password from the link.
  const handleInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const displayName = String(form.get('displayName') || '')
    const username = String(form.get('username') || '').toLowerCase()
    const email = String(form.get('email') || '').toLowerCase()
    const role = (form.get('role') || 'user') as TenantRole
    const categoryId = String(form.get('categoryId') || '') || null

    try {
      const res = await fetch(`${API_ORIGIN}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ displayName, username, email, role: CANONICAL_ROLE[role], categoryId }),
      })
      const data = await res.json()
      if (data.success && data.user) {
        setToast(`${displayName} invited as ${ROLE_INFO[role].label.toLowerCase()}`)
        setInviteDialogOpen(false)
        if (data.invitation) setInviteResult({ name: displayName, link: data.invitation.link, delivered: data.invitation.delivered })
        void loadTenantData()
        void reloadCategories()
      } else {
        setToast(data.message || 'Unable to invite this member.')
      }
    } catch {
      setToast('Unable to invite this member.')
    }
  }

  const handleResetPassword = async (user: TenantUser) => {
    if (!defaultPassword.configured) {
      setToast('Set a default password first.')
      setDefaultPasswordOpen(true)
      return
    }
    if (!window.confirm(`Reset ${user.displayName}'s password to the workspace default? They will be signed out and must choose a new password at their next sign-in.`)) return
    try {
      const data = await tenantApi.send<{ message: string }>('POST', `/api/v1/users/${user.id}/reset-password`)
      setMembers((prev) => prev.map((m) => (m.id === user.id ? { ...m, passwordChangeRequired: true, status: 'active' } : m)))
      setToast(data.message)
    } catch (error) {
      setToast((error as Error).message)
    }
  }

  // Update role
  const handleUpdateRole = async (userId: string, newRole: TenantRole) => {
    try {
      const res = await fetch(`${API_ORIGIN}/api/v1/users/${userId}/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ role: CANONICAL_ROLE[newRole] }),
      })
      const data = await res.json()
      if (data.success) {
        setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, role: newRole } : m)))
        setToast(`Role changed to ${ROLE_INFO[newRole].label.toLowerCase()}`)
        setEditRoleUser(null)
      } else {
        setToast(data.message || 'Unable to update this role.')
      }
    } catch {
      setToast('Unable to update this role.')
    }
  }

  const brandStyle = { '--ws-brand': tenantInfo.primaryColor } as CSSProperties

  // Loading screen
  if (checkingSession) {
    return (
      <div className="ws-splash" style={brandStyle}>
        <span className="ws-splash-ring" />
      </div>
    )
  }

  // ==========================================
  // SIGN IN (TENANT BRANDED)
  // ==========================================
  if (!currentUser) {
    return (
      <div className="ws-login" style={brandStyle}>
        <LoginBackdrop />
        <header className="ws-login-top">
          <BrandMark info={tenantInfo} size={40} />
          <span>{tenantInfo.name}</span>
        </header>

        <main className="ws-login-center">
          <div className="ws-login-card">
            <h2>Sign in</h2>
            {appMode && !appMode.company ? (
              <p className="ws-login-sub">Sign in with your company account.</p>
            ) : appMode ? (
              <p className="ws-login-sub">
                Signing in to <strong>{appMode.company}</strong>.{' '}
                <button type="button" className="ws-link-btn" onClick={() => void forgetCompany()}>
                  Not {appMode.company}? Change company
                </button>
              </p>
            ) : (
              <p className="ws-login-sub">Use your {tenantInfo.name} account.</p>
            )}

            {errorMsg && (
              <div className="ws-alert" role="alert">
                {errorMsg}
              </div>
            )}

            <form onSubmit={handleLogin} className="ws-form">
              {appMode && !appMode.company && (
                <label className="ws-field">
                  <span>Company</span>
                  <input
                    id="tenant-login-company"
                    type="text"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Your company or workspace address"
                    autoComplete="organization"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="ws-field">
                <span>Email or username</span>
                <input
                  id="tenant-login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="email"
                />
              </label>

              <label className="ws-field">
                <span>Password</span>
                <span className="ws-input-wrap">
                  <input
                    id="tenant-login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="ws-reveal"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </span>
              </label>

              <TurnstileSlot turnstile={turnstile} />

              <button type="submit" disabled={!isVerified || isLoading} className="ws-submit">
                {isLoading ? <RefreshCw size={18} className="spin" /> : null}
                <span>{isLoading ? 'Signing in…' : 'Sign in'}</span>
                {!isLoading && <ArrowRight size={18} />}
              </button>
            </form>
          </div>
          {tenantInfo.loginMessage && <p className="ws-login-tagline">{tenantInfo.loginMessage}</p>}
        </main>
        <footer className="ws-login-foot">{tenantInfo.domain}</footer>
      </div>
    )
  }

  // ==========================================
  // FORCED PASSWORD CHANGE
  // ==========================================
  if (currentUser.mustChangePassword) {
    return (
      <div className="ws-shell" style={brandStyle}>
        <ForcedPasswordChange
          api={tenantApi}
          workspaceName={tenantInfo.name}
          displayName={currentUser.displayName}
          minLength={passwordMinLength}
          onLogout={handleLogout}
          onChanged={() => {
            setToast('Password changed. Welcome!')
            setCurrentUser({ ...currentUser, mustChangePassword: false })
          }}
        />
      </div>
    )
  }

  // ==========================================
  // WORKSPACE
  // ==========================================
  const nav: { id: NavId; label: string; icon: typeof Home; show: boolean; count?: number }[] = [
    { id: 'Overview', label: 'Welcome', icon: Home, show: true },
    { id: 'Members', label: 'Users', icon: Users, show: can.members, count: members.length || undefined },
    { id: 'Teams', label: 'Departments & groups', icon: Building2, show: can.members, count: teams.length || undefined },
    { id: 'Files', label: 'Files', icon: FileText, show: true },
    { id: 'Audit', label: 'Audit trail', icon: FileClock, show: can.audit },
    { id: 'Settings', label: 'Settings', icon: Settings, show: can.settings },
  ]
  const visibleNav = nav.filter((n) => n.show)
  const current = visibleNav.find((n) => n.id === activeNav) ?? visibleNav[0]!
  const go = (id: NavId) => {
    setActiveNav(id)
    setMobileOpen(false)
  }
  const firstName = currentUser.displayName.split(' ')[0]
  const roleCounts = ROLES.map((r) => ({ role: r, count: members.filter((m) => m.role === r).length }))

  return (
    <div className="ws-shell" style={brandStyle}>
      {mobileOpen && <button className="ws-nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <aside className={`ws-sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="ws-side-brand">
          <BrandMark info={tenantInfo} size={36} />
          <span>{tenantInfo.name}</span>
        </div>

        <nav className="ws-nav" aria-label="Workspace">
          {visibleNav.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className="ws-nav-item"
                aria-current={current.id === item.id ? 'page' : undefined}
                onClick={() => go(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.count !== undefined && <em>{item.count}</em>}
              </button>
            )
          })}
        </nav>

        <div className="ws-side-foot">
          <div className="ws-me">
            <span className="ws-avatar">{initialsOf(currentUser.displayName)}</span>
            <div>
              <strong>{currentUser.displayName}</strong>
              <span>{ROLE_INFO[role].label}</span>
            </div>
            <button type="button" className="ws-icon-btn dark" onClick={() => setPasswordOpen(true)} aria-label="Change password" title="Change password">
              <KeyRound size={17} />
            </button>
            <button type="button" className="ws-icon-btn dark" onClick={handleLogout} aria-label="Sign out" title="Sign out">
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="ws-main">
        <header className="ws-topbar">
          <button className="ws-icon-btn ws-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <Menu size={20} />
          </button>
          <h1>{current.id === 'Overview' ? tenantInfo.name : current.label}</h1>
          <div className="ws-topbar-actions">
            {current.id === 'Members' && can.settings && (
              <>
                <button type="button" className="ws-btn ghost" onClick={() => setDefaultPasswordOpen(true)}>
                  <KeyRound size={16} />
                  <span>Default password</span>
                </button>
                <button type="button" className="ws-btn ghost" onClick={() => setCategoriesOpen(true)}>
                  <Tags size={16} />
                  <span>Categories</span>
                </button>
              </>
            )}
            {current.id === 'Members' && can.invite && (
              <>
                <button type="button" className="ws-btn ghost" onClick={() => setImportOpen(true)}>
                  <Upload size={16} />
                  <span>Import CSV</span>
                </button>
                <button type="button" className="ws-btn ghost" onClick={() => setInviteDialogOpen(true)}>
                  <UserCheck size={16} />
                  <span>Invite</span>
                </button>
                <button type="button" className="ws-btn primary" onClick={() => setAddUserOpen(true)}>
                  <UserPlus size={16} />
                  <span>Add user</span>
                </button>
              </>
            )}
            {current.id === 'Teams' && can.editRoles && (
              <button type="button" className="ws-btn primary" onClick={() => setTeamEdit('new')}>
                <Building2 size={16} />
                <span>Add department or group</span>
              </button>
            )}
            {(current.id === 'Members' || current.id === 'Audit') && (
              <button type="button" className="ws-icon-btn" onClick={() => loadTenantData()} aria-label="Refresh" title="Refresh">
                <RefreshCw size={16} className={isLoadingData ? 'spin' : ''} />
              </button>
            )}
          </div>
        </header>

        <main className="ws-content">
          {/* OVERVIEW */}
          {current.id === 'Overview' && (
            <div className="ws-stack">
              <section className="ws-hero">
                <span className="ws-eyebrow">
                  {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                </span>
                <h2>
                  Welcome to {tenantInfo.name}, <em>{firstName}.</em>
                </h2>
                <p>{tenantInfo.description || tenantInfo.loginMessage || 'Your workspace: people, files and the modules your organisation uses, in one place.'}</p>
              </section>

              {(can.invite || can.settings) && (
                <section className="ws-card">
                  <header className="ws-card-head">
                    <h3>Get started</h3>
                  </header>
                  <div className="ws-shortcuts">
                    {can.invite && (
                      <button type="button" onClick={() => setInviteDialogOpen(true)}>
                        <UserPlus size={18} /> {members.length > 1 ? 'Invite more people' : 'Invite your team'} <ArrowRight size={14} />
                      </button>
                    )}
                    {can.editRoles && (
                      <button type="button" onClick={() => go('Members')}>
                        <Users size={18} /> Assign roles and categories <ArrowRight size={14} />
                      </button>
                    )}
                    {can.settings && (
                      <button type="button" onClick={() => go('Settings')}>
                        <Settings size={18} /> Review workspace settings <ArrowRight size={14} />
                      </button>
                    )}
                    <button type="button" onClick={() => go('Files')}>
                      <FileText size={18} /> Upload shared files <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
              )}

              <div className="ws-grid">
                {can.members && (
                  <section className="ws-card">
                    <header className="ws-card-head">
                      <h3>Team</h3>
                      <button type="button" className="ws-link" onClick={() => go('Members')}>
                        View users <ArrowRight size={14} />
                      </button>
                    </header>
                    <div className="ws-team">
                      <div className="ws-big">
                        {members.length}
                        <span>{members.length === 1 ? 'member' : 'members'}</span>
                      </div>
                      <div className="ws-faces">
                        {members.slice(0, 4).map((m) => (
                          <span key={m.id} className="ws-avatar sm" title={m.displayName}>
                            {initialsOf(m.displayName)}
                          </span>
                        ))}
                        {members.length > 4 && <span className="ws-avatar sm more">+{members.length - 4}</span>}
                      </div>
                    </div>
                    <ul className="ws-roles-list">
                      {roleCounts
                        .filter((r) => r.count > 0)
                        .map((r) => (
                          <li key={r.role}>
                            <RolePill role={r.role} />
                            <span className="ws-bar">
                              <i style={{ width: `${(r.count / Math.max(1, members.length)) * 100}%` }} />
                            </span>
                            <b>{r.count}</b>
                          </li>
                        ))}
                    </ul>
                    {can.invite && (
                      <button type="button" className="ws-btn subtle block" onClick={() => setInviteDialogOpen(true)}>
                        <UserPlus size={16} /> Invite someone
                      </button>
                    )}
                  </section>
                )}

                {can.audit && (
                  <section className="ws-card">
                    <header className="ws-card-head">
                      <h3>Recent activity</h3>
                      <button type="button" className="ws-link" onClick={() => go('Audit')}>
                        Audit trail <ArrowRight size={14} />
                      </button>
                    </header>
                    {auditLogs.length === 0 ? (
                      <p className="ws-empty-line">No activity recorded yet.</p>
                    ) : (
                      <ul className="ws-activity">
                        {auditLogs.slice(0, 6).map((log) => (
                          <li key={log.id}>
                            <span className="ws-avatar sm">{initialsOf(log.actor || '?')}</span>
                            <div>
                              <strong>{log.actor}</strong> <span>{humanAction(log.action).toLowerCase()}</span>
                              <time>{relativeTime(log.occurredAt)}</time>
                            </div>
                            {log.outcome !== 'success' && <span className="ws-outcome" data-outcome={log.outcome}>{log.outcome}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                {!can.audit && (
                  <section className="ws-card">
                    <header className="ws-card-head">
                      <h3>Shortcuts</h3>
                    </header>
                    <div className="ws-shortcuts">
                      <button type="button" onClick={() => go('Files')}>
                        <FileText size={18} /> Files <ArrowRight size={14} />
                      </button>
                      {can.members && (
                        <button type="button" onClick={() => go('Members')}>
                          <Users size={18} /> Users <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}

          {/* PEOPLE */}
          {current.id === 'Members' && (
            <div className="ws-stack">
              <div className="ws-toolbar">
                <label className="ws-search">
                  <Search size={16} />
                  <input type="search" placeholder="Search users" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
                </label>
                <div className="ws-chips" role="group" aria-label="Filter by role">
                  <button type="button" aria-pressed={roleFilter === ''} onClick={() => setRoleFilter('')}>
                    All <em>{members.length}</em>
                  </button>
                  {roleCounts
                    .filter((r) => r.count > 0)
                    .map((r) => (
                      <button key={r.role} type="button" aria-pressed={roleFilter === r.role} onClick={() => setRoleFilter(r.role)}>
                        {ROLE_INFO[r.role].label} <em>{r.count}</em>
                      </button>
                    ))}
                </div>
              </div>

              <div className="ws-table-card">
                <table className="ws-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Category</th>
                      {can.editRoles && <th aria-label="Actions" />}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMembers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="ws-empty-cell">
                          {members.length === 0 ? 'No users yet.' : 'Nobody matches this search.'}
                        </td>
                      </tr>
                    ) : (
                      filteredMembers.map((user) => (
                        <tr key={user.id}>
                          <td>
                            <div className="ws-person">
                              <span className="ws-avatar sm">{initialsOf(user.displayName)}</span>
                              <div>
                                <strong>{user.displayName}</strong>
                                {user.status && user.status !== 'active' && <span className="ws-status">{user.status}</span>}
                                {user.passwordChangeRequired && <span className="ws-status">must change password</span>}
                              </div>
                            </div>
                          </td>
                          <td className="ws-muted" data-label="Email">{user.email}</td>
                          <td data-label="Role">
                            <RolePill role={user.role} />
                          </td>
                          <td data-label="Category">
                            {can.editRoles && (role !== 'manager' || ['user', 'guest'].includes(user.role)) ? (
                              <select
                                className="ws-cell-select"
                                value={user.category?.id ?? ''}
                                onChange={(e) => void handleCategoryChange(user.id, e.target.value || null)}
                                aria-label={`Category for ${user.displayName}`}
                              >
                                <option value="">None</option>
                                {categories.map((category) => (
                                  <option key={category.id} value={category.id}>{category.name}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="ws-muted">{user.category?.name ?? '—'}</span>
                            )}
                          </td>
                          {can.editRoles && (
                            <td className="ws-right">
                              {user.id !== currentUser.id && (role !== 'manager' || ['user','guest'].includes(user.role)) && (
                                <span className="ws-row-actions">
                                  <button type="button" className="ws-btn ghost sm" onClick={() => setEditRoleUser(user)}>
                                    Change role
                                  </button>
                                  {user.status !== 'suspended' && (
                                    <button type="button" className="ws-btn ghost sm" onClick={() => void handleResetPassword(user)}>
                                      Reset password
                                    </button>
                                  )}
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* DEPARTMENTS & GROUPS */}
          {current.id === 'Teams' && (
            <TeamsPage
              api={tenantApi}
              teams={teams}
              loaded={teamsLoaded}
              members={members}
              managerOnly={role === 'manager'}
              onChanged={() => void reloadTeams()}
              onEdit={(team) => setTeamEdit(team)}
              onToast={setToast}
            />
          )}

          {/* AUDIT */}
          {current.id === 'Audit' && (
            <div className="ws-table-card">
              <table className="ws-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="ws-empty-cell">
                        No activity recorded yet.
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td className="ws-muted ws-nowrap" data-label="When" title={new Date(log.occurredAt).toLocaleString()}>
                          {relativeTime(log.occurredAt)}
                        </td>
                        <td data-label="Who">
                          <strong>{log.actor}</strong>
                        </td>
                        <td data-label="What">
                          {humanAction(log.action)}
                          {log.resourceType && <span className="ws-muted"> · {log.resourceType}</span>}
                        </td>
                        <td data-label="Outcome">
                          <span className="ws-outcome" data-outcome={log.outcome}>
                            {log.outcome}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* FILES */}
          {current.id === 'Files' && <FilesPage csrfToken={csrfToken} accent={tenantInfo.primaryColor} />}

          {/* SETTINGS */}
          {current.id === 'Settings' && (
            <div className="ws-stack ws-narrow">
              <section className="ws-card">
                <header className="ws-card-head">
                  <h3>Workspace</h3>
                </header>
                <dl className="ws-dl">
                  <div>
                    <dt>Name</dt>
                    <dd>{tenantInfo.name}</dd>
                  </div>
                  <div>
                    <dt>Web address</dt>
                    <dd>{tenantInfo.domain}</dd>
                  </div>
                </dl>
              </section>
              <WorkspaceSettings csrfToken={csrfToken} accent={tenantInfo.primaryColor} />
              <IntegrationsSettings csrfToken={csrfToken} accent={tenantInfo.primaryColor} />
            </div>
          )}
        </main>
      </div>

      {toast && (
        <div className="ws-toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
        </div>
      )}

      {/* ONE-TIME INVITATION LINK */}
      {inviteResult && (
        <Modal
          title={`Invitation for ${inviteResult.name}`}
          onClose={() => setInviteResult(null)}
          footer={
            <>
              <button
                type="button"
                className="ws-btn ghost"
                onClick={() => void navigator.clipboard.writeText(inviteResult.link).then(() => setToast('Invitation link copied'))}
              >
                Copy link
              </button>
              <button type="button" className="ws-btn primary" onClick={() => setInviteResult(null)}>
                Done
              </button>
            </>
          }
        >
          <p className="ws-muted">
            {inviteResult.delivered
              ? 'An invitation email is on its way. You can also share this link directly.'
              : 'Share this link with them privately. It works once and is shown only now.'}
          </p>
          <code className="ws-code">{inviteResult.link}</code>
        </Modal>
      )}

      {/* INVITE */}
      {inviteDialogOpen && (
        <Modal title={`Invite to ${tenantInfo.name}`} onClose={() => setInviteDialogOpen(false)}>
          <form onSubmit={handleInvite} className="ws-form">
            <label className="ws-field">
              <span>Full name</span>
              <input id="tenant-invite-display-name" name="displayName" type="text" required autoComplete="off" />
            </label>
            <label className="ws-field">
              <span>Email</span>
              <input id="tenant-invite-email" name="email" type="email" required autoComplete="off" />
            </label>
            <label className="ws-field">
              <span>Username</span>
              <input id="tenant-invite-username" name="username" type="text" required autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </label>
            <label className="ws-field">
              <span>Role</span>
              <select id="tenant-invite-role" name="role" defaultValue="user">
                {assignableRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_INFO[r].label} — {ROLE_INFO[r].summary}
                  </option>
                ))}
              </select>
            </label>
            {categories.length > 0 && (
              <label className="ws-field">
                <span>Category</span>
                <select name="categoryId" defaultValue="">
                  <option value="">No category</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="ws-modal-actions">
              <button type="button" className="ws-btn ghost" onClick={() => setInviteDialogOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="ws-btn primary">
                Send invitation
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ADD USER */}
      {addUserOpen && (
        <Modal title={`Add a user to ${tenantInfo.name}`} onClose={() => setAddUserOpen(false)}>
          <AddUserForm
            api={tenantApi}
            categories={categories}
            canAddAdministrators={canAddAdministrators}
            passwordMinLength={passwordMinLength}
            allowInvitation={false}
            defaultPasswordConfigured={defaultPassword.configured}
            onCancel={() => setAddUserOpen(false)}
            onCreated={(user) => {
              setAddUserOpen(false)
              setToast(`${user.displayName} added as ${user.kind === 'administrator' ? 'an administrator' : 'a user'}`)
              void loadTenantData()
              void reloadCategories()
            }}
          />
        </Modal>
      )}

      {/* IMPORT USERS */}
      {importOpen && (
        <Modal title="Import users from CSV" onClose={() => setImportOpen(false)}>
          <ImportUsersForm
            api={tenantApi}
            onClose={() => setImportOpen(false)}
            onImported={() => {
              void loadTenantData()
              void reloadCategories()
            }}
          />
        </Modal>
      )}

      {/* DEPARTMENT OR GROUP */}
      {teamEdit && (
        <Modal title={teamEdit === 'new' ? 'Add department or group' : `Edit ${teamEdit.name}`} onClose={() => setTeamEdit(null)}>
          <TeamForm
            api={tenantApi}
            team={teamEdit === 'new' ? null : teamEdit}
            members={members}
            managerOnly={role === 'manager'}
            onCancel={() => setTeamEdit(null)}
            onSaved={(text) => {
              setTeamEdit(null)
              setToast(text)
              void reloadTeams()
            }}
          />
        </Modal>
      )}

      {/* DEFAULT PASSWORD */}
      {defaultPasswordOpen && (
        <Modal title="Default password" onClose={() => setDefaultPasswordOpen(false)}>
          <DefaultPasswordForm api={tenantApi} minLength={passwordMinLength} status={defaultPassword} onSaved={() => void loadDefaultPassword()} />
        </Modal>
      )}

      {/* USER CATEGORIES */}
      {categoriesOpen && (
        <Modal title="User categories" onClose={() => setCategoriesOpen(false)}>
          <CategoryManager api={tenantApi} categories={categories} onChanged={() => void reloadCategories()} />
        </Modal>
      )}

      {/* OWN PASSWORD */}
      {passwordOpen && (
        <Modal title="Change your password" onClose={() => setPasswordOpen(false)}>
          <ChangePasswordForm api={tenantApi} minLength={passwordMinLength} onChanged={(message) => setToast(message)} />
        </Modal>
      )}

      {/* FIRST-LOGIN SETUP */}
      {setupPending && (
        <SetupWizard
          api={tenantApi}
          workspaceName={tenantInfo.name}
          canAddAdministrators={canAddAdministrators}
          passwordMinLength={passwordMinLength}
          defaultPasswordConfigured={defaultPassword.configured}
          onUsersAdded={() => void loadTenantData()}
          onDone={() => {
            setSetupPending(false)
            void reloadCategories()
          }}
        />
      )}

      {/* CHANGE ROLE */}
      {editRoleUser && (
        <Modal title={`Role for ${editRoleUser.displayName}`} onClose={() => setEditRoleUser(null)}>
          <div className="ws-role-options" role="radiogroup" aria-label="Role">
            {assignableRoles.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={editRoleUser.role === r}
                onClick={() => (editRoleUser.role === r ? setEditRoleUser(null) : handleUpdateRole(editRoleUser.id, r))}
              >
                <span className="ws-radio" />
                <span>
                  <strong>{ROLE_INFO[r].label}</strong>
                  <small>{ROLE_INFO[r].summary}</small>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
