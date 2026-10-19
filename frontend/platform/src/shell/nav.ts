import { Activity, Building2, FileText, Globe, Layers, LayoutDashboard, Server, Sliders, User, Users, type LucideIcon } from 'lucide-react'
import type { PlatformRole } from './types'

export type PageId =
  | 'dashboard'
  | 'tenants'
  | 'individuals'
  | 'plans'
  | 'domains'
  | 'fleet'
  | 'server'
  | 'configuration'
  | 'operators'
  | 'audit'
  | 'security'

export type NavItem = { id: PageId; label: string; icon: LucideIcon; roles: PlatformRole[] }

const ALL: PlatformRole[] = ['platform_owner', 'platform_admin', 'platform_viewer']
const ADMINS: PlatformRole[] = ['platform_owner', 'platform_admin']
const OWNERS: PlatformRole[] = ['platform_owner']

// Grouped by what an operator is doing: looking after customers, keeping the
// infrastructure healthy, or governing the platform itself. Roles mirror the
// server's route guards, so nobody is shown a page that only answers 403.
export const NAV: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Overview', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ALL }] },
  {
    label: 'Customers',
    items: [
      { id: 'tenants', label: 'Tenants', icon: Building2, roles: ADMINS },
      { id: 'individuals', label: 'Individuals', icon: User, roles: ADMINS },
      { id: 'plans', label: 'Plans', icon: Layers, roles: ALL },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { id: 'domains', label: 'Domains', icon: Globe, roles: ALL },
      { id: 'fleet', label: 'Fleet & schema', icon: Activity, roles: ADMINS },
      { id: 'server', label: 'Server', icon: Server, roles: ADMINS },
    ],
  },
  {
    label: 'Governance',
    items: [
      { id: 'configuration', label: 'Configuration', icon: Sliders, roles: ALL },
      { id: 'operators', label: 'Operators', icon: Users, roles: OWNERS },
      { id: 'audit', label: 'Audit log', icon: FileText, roles: ADMINS },
    ],
  },
]

export const PAGE_LABELS: Record<PageId, string> = {
  dashboard: 'Dashboard',
  tenants: 'Tenants',
  individuals: 'Individuals',
  plans: 'Plans',
  domains: 'Domains',
  fleet: 'Fleet & schema',
  server: 'Server',
  configuration: 'Configuration',
  operators: 'Operators',
  audit: 'Audit log',
  security: 'My security',
}

const PAGE_ROLES: Record<PageId, PlatformRole[]> = Object.fromEntries(
  [...NAV.flatMap((group) => group.items.map((item) => [item.id, item.roles])), ['security', ALL]],
) as Record<PageId, PlatformRole[]>

export const canOpen = (page: PageId, role: PlatformRole) => PAGE_ROLES[page]?.includes(role) ?? false

export const isPageId = (value: string | undefined): value is PageId => !!value && value in PAGE_LABELS
