export type PlatformRole = 'platform_owner' | 'platform_admin' | 'platform_viewer'

export type AuthUser = { id: string; username: string; role: PlatformRole }

export type TenantLifecycleStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'migration_failed'
  | 'provisioning_failed'
  | 'deleting'
  | 'deletion_failed'

export type TenantSummary = {
  tenantId: string
  displayName: string
  hostname: string | null
  subdomain: string | null
  status: TenantLifecycleStatus
  region: string
  createdAt: string
  activatedAt: string | null
  jobId: string | null
  jobStatus: string | null
  currentStep: string | null
}

export type ProvisioningStep = {
  stepCode: string
  stepOrder: number
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  message: string
  errorMessage: string | null
}

export type ProvisioningJob = {
  jobId: string
  tenantId: string
  displayName: string
  hostname: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'retrying' | 'rolled_back'
  currentStep: string | null
  retryable: boolean
  errorMessage: string | null
  correlationId: string
  steps: ProvisioningStep[]
}

export type DnsRecord = {
  id: string
  name: string
  type: string
  content: string
  proxiable: boolean
  proxied: boolean
  ttl: number
  created_on: string
  modified_on: string
  comment?: string | null
  managed?: boolean
}

export type DnsZone = { id: string; name: string; status: string }

export type HardwareData = {
  timestamp: string
  cpu: { model: string; cores: number; speedMhz: number; loadAvg: { '1m': number; '5m': number; '15m': number } }
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; cachedBytes: number; buffersBytes: number; usedPercent: number; totalGB: string; freeGB: string; usedGB: string }
  storage: { filesystem: string; totalBytes: number; usedBytes: number; availBytes: number; usedPercent: number; totalGB: string; usedGB: string; availGB: string }
  system: { hostname: string; platform: string; osName: string; release: string; arch: string; uptimeSeconds: number }
}

export type ServiceItem = {
  id: string
  port: number
  name: string
  category: string
  description: string
  pid: number | null
  user: string
  cpuPercent: number
  memPercent: number
  memoryMb: number
  uptime: string
  cmd: string
  protocol: string
}

export type Fleet = {
  latestSchemaVersion: number
  summary: { total: number; current: number; behind: number; failed: number }
  tenants: Array<{ tenantId: string; displayName: string; status: string; schemaVersion: number; lastErrorCode: string | null; lastErrorAt: string | null; planCode: string | null }>
  jobs30d: Array<{ status: string; jobType: string; count: number }>
}

export type AuditEvent = {
  id: string
  timestamp: string
  username: string | null
  userId: string | null
  feature: string
  action: string
  status: string
  tenantKey: string | null
  resourceType: string | null
  resourceId: string | null
}

const num = (value: unknown, fallback = 0) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** The services endpoint has used a few field names over time; read any of them. */
export function normalizeService(raw: Record<string, unknown>): ServiceItem {
  const port = num(raw.port)
  const pid = raw.pid == null ? null : num(raw.pid)
  return {
    id: String(raw.id || `${port}-${pid ?? 'unknown'}`),
    port,
    name: String(raw.name || 'Application service'),
    category: String(raw.category || 'Application'),
    description: String(raw.description || `Listening on port ${port}`),
    pid,
    user: String(raw.user || 'unknown'),
    cpuPercent: num(raw.cpuPercent ?? raw.cpu),
    memPercent: num(raw.memPercent ?? raw.mem),
    memoryMb: num(raw.memoryMb ?? raw.rssMb),
    uptime: String(raw.uptime || ''),
    cmd: String(raw.cmd || ''),
    protocol: String(raw.protocol || 'TCP'),
  }
}
