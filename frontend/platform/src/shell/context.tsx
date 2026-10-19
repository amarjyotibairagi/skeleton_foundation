import { createContext, useContext, useEffect } from 'react'
import type { AdminApi } from '../admin/api'
import type { AuthUser } from './types'

export type ConsoleContext = {
  api: AdminApi
  user: AuthUser
  productName: string
  tenantRootDomain: string
  mfaRecent: boolean
  setMfaRecent: (value: boolean) => void
  /** Extra breadcrumb after the page name, e.g. the open tenant's name. */
  setCrumb: (label: string | null) => void
  /** Re-reads the shell's own counts (e.g. after a tenant changed state). */
  refreshShell: () => void
}

export const Console = createContext<ConsoleContext | null>(null)

export function useConsole(): ConsoleContext {
  const value = useContext(Console)
  if (!value) throw new Error('useConsole outside the console shell')
  return value
}

export const isOwner = (user: AuthUser) => user.role === 'platform_owner'
export const isAdmin = (user: AuthUser) => user.role === 'platform_owner' || user.role === 'platform_admin'

export function useCrumb(label: string | null | undefined) {
  const { setCrumb } = useConsole()
  useEffect(() => {
    setCrumb(label ?? null)
    return () => setCrumb(null)
  }, [label, setCrumb])
}
