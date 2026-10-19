import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, KeyRound, LogOut, Menu, Monitor, Moon, ShieldCheck, ShieldOff, Sun } from 'lucide-react'
import { createAdminApi } from './admin/api'
import { AuditView } from './admin/AuditView'
import { ConfigurationView } from './admin/ConfigurationView'
import { ConsumersView } from './admin/ConsumersView'
import { FleetView } from './admin/FleetView'
import { OperatorsView } from './admin/OperatorsView'
import { PlansView } from './admin/PlansView'
import { SecurityView } from './admin/SecurityView'
import { ConfirmProvider, EmptyState, roleLabel, useDismiss, useResource } from './admin/ui'
import { DashboardPage } from './pages/DashboardPage'
import { DomainsPage } from './pages/DomainsPage'
import { LoginPage } from './pages/LoginPage'
import { NewTenantPage } from './pages/NewTenantPage'
import { ServerPage } from './pages/ServerPage'
import { TenantDetailPage } from './pages/TenantDetailPage'
import { TenantsPage } from './pages/TenantsPage'
import { Console, type ConsoleContext } from './shell/context'
import { NAV, PAGE_LABELS, canOpen, isPageId, type PageId } from './shell/nav'
import { href, useRoute } from './shell/router'
import { useTheme, type ThemePref } from './shell/theme'
import type { AuthUser, TenantSummary } from './shell/types'
import { FAILED_STATES } from './admin/ui'

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [mfaRecent, setMfaRecent] = useState(false)
  const [checking, setChecking] = useState(true)
  const [productName, setProductName] = useState('Platform')
  const [tenantRootDomain, setTenantRootDomain] = useState('')

  useEffect(() => {
    fetch('/api/public-config', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.success) return
        setProductName(data.productName)
        setTenantRootDomain(data.tenantRootDomain || '')
      })
      .catch(() => undefined)
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.success) return
        setUser(data.user)
        setCsrfToken(data.csrfToken)
        setMfaRecent(Boolean(data.mfaRecent))
      })
      .catch(() => undefined)
      .finally(() => setChecking(false))
  }, [])

  const clearSession = useCallback(() => {
    setUser(null)
    setCsrfToken(null)
  }, [])

  if (checking) return <div className="boot" role="status">Checking your session…</div>
  if (!user || !csrfToken)
    return (
      <LoginPage
        productName={productName}
        onSignedIn={(signedIn, token, recent) => {
          setUser(signedIn)
          setCsrfToken(token)
          setMfaRecent(recent)
          window.location.hash = '#/'
        }}
      />
    )
  return (
    <ConfirmProvider>
      <Shell
        user={user}
        csrfToken={csrfToken}
        mfaRecent={mfaRecent}
        setMfaRecent={setMfaRecent}
        productName={productName}
        tenantRootDomain={tenantRootDomain}
        onSignedOut={clearSession}
      />
    </ConfirmProvider>
  )
}

function Shell({ user, csrfToken, mfaRecent, setMfaRecent, productName, tenantRootDomain, onSignedOut }: {
  user: AuthUser
  csrfToken: string
  mfaRecent: boolean
  setMfaRecent: (value: boolean) => void
  productName: string
  tenantRootDomain: string
  onSignedOut: () => void
}) {
  const api = useMemo(() => createAdminApi(csrfToken, onSignedOut), [csrfToken, onSignedOut])
  const route = useRoute()
  const [crumb, setCrumb] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const theme = useTheme()
  const admin = user.role !== 'platform_viewer'

  const page: PageId = route.parts.length === 0 ? 'dashboard' : isPageId(route.parts[0]) ? route.parts[0] : 'dashboard'
  const unknown = route.parts.length > 0 && !isPageId(route.parts[0])
  const allowed = canOpen(page, user.role)

  // Tenants needing attention, shown as a count in the sidebar.
  const tenants = useResource<TenantSummary[]>(admin ? async () => (await api.get('/api/tenants')).tenants : null, [api, admin], 60_000)
  const failing = tenants.data?.filter((tenant) => FAILED_STATES.has(tenant.status)).length ?? 0
  const health = useResource(async () => {
    const response = await fetch('/api/health', { credentials: 'same-origin' })
    return response.ok
  }, [], 60_000)
  const healthy = health.error ? false : health.data

  useEffect(() => setNavOpen(false), [route.path])
  useEffect(() => {
    document.title = `${crumb ?? PAGE_LABELS[page]} · ${productName} Platform`
  }, [page, crumb, productName])

  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } })
    } catch {
      // The session ends locally either way.
    }
    window.location.hash = ''
    onSignedOut()
  }

  const context: ConsoleContext = useMemo(
    () => ({ api, user, productName, tenantRootDomain, mfaRecent, setMfaRecent, setCrumb, refreshShell: () => void tenants.reload() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, user, productName, tenantRootDomain, mfaRecent],
  )

  return (
    <Console.Provider value={context}>
      <div className="app" data-nav-open={navOpen}>
        <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
        <aside className="sidebar">
          <a className="brand" href={href()}>
            <span className="brand-mark"><ShieldCheck size={16} /></span>
            <span className="brand-name">{productName}</span>
            <span className="brand-tag">Platform</span>
          </a>
          <nav className="nav" aria-label="Platform navigation">
            {NAV.map((group) => {
              const items = group.items.filter((item) => item.roles.includes(user.role))
              if (!items.length) return null
              return (
                <div key={group.label} className="nav-group">
                  <div className="nav-heading">{group.label}</div>
                  {items.map((item) => (
                    <a key={item.id} className="nav-item" href={item.id === 'dashboard' ? href() : href(item.id)} aria-current={page === item.id && !unknown ? 'page' : undefined}>
                      <item.icon size={17} />
                      {item.label}
                      {item.id === 'tenants' && failing > 0 && <span className="nav-count" data-tone="bad" title={`${failing} tenant(s) need attention`}>{failing}</span>}
                      {item.id === 'tenants' && failing === 0 && tenants.data && <span className="nav-count">{tenants.data.length}</span>}
                    </a>
                  ))}
                </div>
              )
            })}
          </nav>
          <div className="sidebar-foot">
            Tenant domain
            <strong>{tenantRootDomain ? `*.${tenantRootDomain}` : '—'}</strong>
          </div>
        </aside>
        <div className="scrim" onClick={() => setNavOpen(false)} />

        <div className="main">
          <header className="topbar">
            <button type="button" className="btn btn-ghost btn-icon topbar-menu" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <Menu size={18} />
            </button>
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href={href()}>Platform</a>
              <ChevronRight size={14} />
              {crumb ? (
                <>
                  <a href={href(page)}>{PAGE_LABELS[page]}</a>
                  <ChevronRight size={14} />
                  <span aria-current="page">{crumb}</span>
                </>
              ) : (
                <span aria-current="page">{unknown ? 'Not found' : PAGE_LABELS[page]}</span>
              )}
            </nav>
            <div className="topbar-spacer" />
            <span className="health" data-state={healthy === null ? 'unknown' : healthy ? 'ok' : 'down'} title="Platform API and database">
              <span className="health-dot" />
              <span className="health-label">{healthy === null ? 'Checking' : healthy ? 'All systems operational' : 'API or database unreachable'}</span>
            </span>
            <ThemeMenu pref={theme.pref} onChoose={theme.choose} />
            <UserMenu user={user} onSignOut={() => void signOut()} />
          </header>

          <main className="content" id="main" tabIndex={-1}>
            <div className="content-inner" key={`${page}:${route.parts[1] ?? ''}`}>
              {unknown ? (
                <EmptyState title="Page not found" action={<a className="btn" href={href()}>Go to the dashboard</a>}>
                  There is nothing at this address.
                </EmptyState>
              ) : !allowed ? (
                <EmptyState icon={<ShieldOff size={20} />} title="Not available for your role">
                  {PAGE_LABELS[page]} needs a {page === 'operators' ? 'platform owner' : 'platform administrator'}. You are signed in as {roleLabel(user.role).toLowerCase()}.
                </EmptyState>
              ) : (
                <PageView page={page} parts={route.parts} />
              )}
            </div>
          </main>
        </div>
      </div>
    </Console.Provider>
  )
}

function PageView({ page, parts }: { page: PageId; parts: string[] }) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />
    case 'tenants':
      if (parts[1] === 'new') return <NewTenantPage />
      if (parts[1]) return <TenantDetailPage key={parts[1]} tenantKey={parts[1]} tab={parts[2]} />
      return <TenantsPage />
    case 'individuals':
      return <ConsumersView />
    case 'plans':
      return <PlansView />
    case 'domains':
      return <DomainsPage />
    case 'fleet':
      return <FleetView />
    case 'server':
      return <ServerPage tab={parts[1] === 'services' ? 'services' : 'resources'} />
    case 'configuration':
      return <ConfigurationView />
    case 'operators':
      return <OperatorsView />
    case 'audit':
      return <AuditView />
    case 'security':
      return <SecurityView />
  }
}

function ThemeMenu({ pref, onChoose }: { pref: ThemePref; onChoose: (pref: ThemePref) => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor
  const options: Array<[ThemePref, string, typeof Sun]> = [['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Match system', Monitor]]
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Appearance">
        <Icon size={17} />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ minWidth: 180 }}>
          <div className="menu-label">Appearance</div>
          {options.map(([id, label, OptionIcon]) => (
            <button key={id} type="button" className="menu-item" role="menuitemradio" aria-checked={pref === id} onClick={() => { onChoose(id); close() }}>
              <OptionIcon size={15} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UserMenu({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useDismiss(open, close)
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="user-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Account">
        <span className="avatar">{user.username.charAt(0).toUpperCase()}</span>
        <span className="user-meta">
          <strong>{user.username}</strong>
          <span>{roleLabel(user.role)}</span>
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{user.username}</strong>
            <span>Platform {roleLabel(user.role).toLowerCase()}</span>
          </div>
          <a className="menu-item" role="menuitem" href={href('security')} onClick={close}>
            <KeyRound size={15} />
            Password & security keys
          </a>
          <div className="menu-sep" />
          <button type="button" className="menu-item" role="menuitem" data-tone="danger" onClick={() => { close(); onSignOut() }}>
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
