import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import argon2 from 'argon2'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from 'fastify'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z, ZodError } from 'zod'
import { createDatabaseClient } from './index.js'
import {
  normalizeTenantHostname,
  publicTenantBootstrap,
  TenantResolver,
  MIN_SUPPORTED_SCHEMA_VERSION,
  type TenantContext,
} from './tenant-context.js'
import { TenantDatabaseManager, type ExternalConnectionLoader } from './tenant-database.js'
import { TenantStorage } from './tenant-storage.js'
import { createFileService } from './modules/files.js'
import { createIntegrationsModule } from './modules/integrations.js'
import {
  ALL_SUPPORTED_ROLES,
  toCanonicalRole,
  getHighestCanonicalRole,
  canAssignRole,
  canManageTargetUser,
  assertNotDemotingLastOwner,
} from './authorization.js'
import { recordTenantAudit } from './audit.js'
import {
  createSharedRateLimitStore,
  createThrottleStore,
  deriveCsrfToken,
  externalPostgresConfig,
  IntegrationService,
  integrationSecretAad,
  normalizePostgresCredentials,
  normalizePostgresSettings,
  SecretBox,
  sharedStateBackend,
  configBoolean,
  configInteger,
  deploymentSetting,
  ARGON2ID_OPTIONS,
  DUMMY_ARGON2ID_HASH,
  hashToken,
  NotificationSender,
  publicConfigValues,
  secureEqual,
  verifyTurnstileToken,
} from '@skeleton/server-kit'
import { TenantConfigService } from './tenant-config.js'
import { applicationModules } from './modules/index.js'
import {
  createInvitationsModule,
  deliverInvitation,
  invitationsEnabled,
  issueUserInvitation,
} from './modules/invitations.js'
import { createSettingsModule } from './modules/settings.js'
import { createTeamsModule } from './modules/teams.js'
import type { TenantModule, TenantRequestKit, TenantSession } from './modules/types.js'

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({
    path: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.env'),
    quiet: true,
  })
}

const isProduction = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'
const config = {
  host: process.env.TENANT_BFF_HOST || '127.0.0.1',
  port: Number(process.env.TENANT_BFF_PORT || 6355),
  registryDatabaseUrl: process.env.TENANT_REGISTRY_DATABASE_URL || '',
  rootDomain: deploymentSetting('TENANT_ROOT_DOMAIN', { production: isProduction, developmentDefault: 'example.test' }).toLowerCase(),
  /** Shared host of the installable app for every tenant ("app.<root>"); the company is chosen at sign-in. */
  get appHost() {
    return (process.env.TENANT_APP_HOST || `app.${this.rootDomain}`).trim().toLowerCase()
  },
  credentialsDirectory: deploymentSetting('TENANT_CREDENTIALS_DIR', {
    production: isProduction,
    developmentDefault: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.secrets/tenants'),
  }),
  cookieSecure: isProduction || (process.env.TENANT_COOKIE_SECURE || '').toLowerCase() === 'true',
  serveStatic: (process.env.SERVE_TENANT_STATIC || '').toLowerCase() === 'true',
  staticRoot:
    process.env.TENANT_STATIC_ROOT ||
    path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'frontend/tenant/dist'),
  sessionTtlMs: Number(process.env.TENANT_SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  turnstileSecretKey: process.env.CLOUDFLARE_TENANT_TURNSTILE_SECRET_KEY || '',
  // Local object storage on the VDS (default backend for tenant files).
  storageRoot: deploymentSetting('STORAGE_ROOT', {
    production: isProduction,
    developmentDefault: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.data/storage'),
  }),
  // Optional. When set (>= 32 chars, identical on every process), CSRF tokens
  // are derived from the session instead of cached per process, so several
  // tenant BFF processes can serve the same session.
  sessionSecret: process.env.TENANT_SESSION_SECRET || '',
}
if (config.sessionSecret && config.sessionSecret.length < 32) throw new Error('TENANT_SESSION_SECRET must be at least 32 characters.')

const cookieName = config.cookieSecure ? '__Host-tenant_session' : 'tenant_session'

// Shared app host: the company a device signed in to, so the next sign-in skips it. HMAC-signed
// so a hand-made cookie cannot be used to probe which companies exist; cleared on manual sign-out.
const companyCookie = config.cookieSecure ? '__Host-tenant_company' : 'tenant_company'
const companySecret = config.sessionSecret || crypto.randomBytes(32).toString('base64url')
const companySignature = (tenantKey: string) => crypto.createHmac('sha256', companySecret).update(`company-hint:${tenantKey}`).digest('base64url')
const companyCookieValue = (tenantKey: string) => `${tenantKey}.${companySignature(tenantKey)}`
function companyFromCookie(value: string | undefined): string | null {
  if (!value) return null
  const at = value.lastIndexOf('.')
  if (at <= 0) return null
  const key = value.slice(0, at)
  return secureEqual(value.slice(at + 1), companySignature(key)) ? key : null
}
const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/
const validDummyHash = DUMMY_ARGON2ID_HASH

// Plaintext CSRF tokens for live sessions, keyed by session token hash.
//
// GET /api/auth/session previously minted and stored a fresh CSRF token on
// every call, so opening a second tab silently invalidated the first tab's
// token and its next mutation failed verification. Only the token's SHA-256 is
// persisted, so the plaintext cannot be re-read from the database -- it is
// cached here for the life of the session instead. A cache miss (process
// restart, eviction) falls back to minting a new token, which is exactly the
// previous behaviour, so this is never worse than what it replaces. Entries are
// dropped at logout and bounded so an attacker cannot grow the map without
// also holding that many valid sessions.
const MAXIMUM_CACHED_CSRF_TOKENS = 10_000
const csrfTokensBySession = new Map<string, string>()

function cacheCsrfToken(sessionTokenHash: string, csrfToken: string): void {
  if (csrfTokensBySession.size >= MAXIMUM_CACHED_CSRF_TOKENS) {
    const oldest = csrfTokensBySession.keys().next().value
    if (oldest !== undefined) csrfTokensBySession.delete(oldest)
  }
  csrfTokensBySession.set(sessionTokenHash, csrfToken)
}

type UiRole = TenantSession['role']

function quoteIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error('Trusted tenant identifier is invalid.')
  return `"${value}"`
}

class UserLimitError extends Error {
  constructor(limit: number) {
    super(`This workspace has reached its limit of ${limit} users.`)
  }
}

// Role names as the workspace UI shows them; error messages use these, never role codes.
const ROLE_LABELS: Record<string, string> = {
  tenant_owner: 'Owner',
  tenant_admin: 'Administrator',
  tenant_manager: 'Manager',
  tenant_member: 'User',
  tenant_viewer: 'Viewer',
}
function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABELS[role]) || 'an unknown role'
}

class ResetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

class UnknownCategoryError extends Error {
  constructor() {
    super('That user category does not exist.')
  }
}

function mapRole(roleCodes: string[]): UiRole {
  if (roleCodes.some((role) => ['admin', 'tenant_owner', 'tenant_admin'].includes(role))) return 'admin'
  if (roleCodes.some((role) => ['manager', 'tenant_manager'].includes(role))) return 'manager'
  if (roleCodes.some((role) => ['user', 'tenant_member'].includes(role))) return 'user'
  return 'guest'
}

// LOGIN_CHALLENGE=none disables Turnstile for deployments without Cloudflare.
const loginChallengeDisabled = process.env.LOGIN_CHALLENGE === 'none'

async function verifyTurnstile(token: string, remoteIp: string, hostname: string): Promise<boolean> {
  if (loginChallengeDisabled) return true
  if (!config.turnstileSecretKey) return !isProduction
  const result = await verifyTurnstileToken({
    secret: config.turnstileSecretKey,
    token,
    remoteIp,
    expectedAction: 'login',
    expectedHostname: isProduction ? hostname : undefined,
  })
  return result.ok
}

function publicUser(session: TenantSession) {
  return {
    id: session.userId,
    username: session.username,
    displayName: session.displayName,
    email: session.email,
    role: session.role,
    canonicalRole: session.canonicalRole,
    mustChangePassword: session.passwordChangeRequired,
  }
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, session: TenantSession): boolean {
  const supplied = request.headers['x-csrf-token']
  if (typeof supplied !== 'string' || !secureEqual(hashToken(supplied), session.csrfHash)) {
    void reply.code(403).send({ success: false, message: 'CSRF verification failed.' })
    return false
  }
  return true
}

async function requirePermission(
  databases: TenantDatabaseManager,
  context: TenantContext,
  request: FastifyRequest,
  reply: FastifyReply,
  session: TenantSession,
  permission: string,
  resourceType: string = 'permission',
  resourceId?: string | null,
): Promise<boolean> {
  if (!session.permissions.has(permission)) {
    await recordTenantAudit({
      databases,
      context,
      actorUserId: session.userId,
      action: 'permission:denied',
      resourceType,
      resourceId,
      outcome: 'denied',
      correlationId: request.id,
      reason: `Missing permission: ${permission}`,
    })
    void reply.code(403).send({ success: false, message: 'You do not have permission for this action.' })
    return false
  }
  return true
}

export async function createServer(): Promise<FastifyInstance> {
  if (!config.registryDatabaseUrl) throw new Error('TENANT_REGISTRY_DATABASE_URL is required.')
  if (loginChallengeDisabled) console.warn('[tenant-bff] LOGIN_CHALLENGE=none: Turnstile verification is disabled for sign-in.')
  if (isProduction && !config.turnstileSecretKey && !loginChallengeDisabled) {
    throw new Error('CLOUDFLARE_TENANT_TURNSTILE_SECRET_KEY is required in production.')
  }

  const registry = createDatabaseClient(config.registryDatabaseUrl).pool
  const registryIdentity = await registry.query<{ current_user: string }>('select current_user')
  if (registryIdentity.rows[0]?.current_user !== 'tenant_registry_reader_login') {
    await registry.end()
    throw new Error('Tenant registry connection must use tenant_registry_reader_login.')
  }
  const resolver = new TenantResolver(registry, config.rootDomain)
  const secretBox = SecretBox.fromEnvironment()
  const integrations = new IntegrationService(registry, secretBox)
  // Tenants whose data lives in their own PostgreSQL (bring-your-own).
  const loadExternal: ExternalConnectionLoader = async (context) => {
    if (!secretBox || !context.dataIntegrationId) throw new Error('External tenant database is unavailable (INTEGRATION_SECRET_KEY missing).')
    const row = (await registry.query<{ integration_id: string; kind: string; settings: unknown; secret_ciphertext: string }>(
      `select integration_id::text, kind, settings, secret_ciphertext from platform.tenant_integration
        where integration_id = $1 and tenant_id = $2 and kind = 'database'`,
      [context.dataIntegrationId, context.tenantId],
    )).rows[0]
    if (!row) throw new Error('External tenant database integration not found.')
    const settings = normalizePostgresSettings(row.settings)
    const credentials = normalizePostgresCredentials(JSON.parse(secretBox.open(row.secret_ciphertext, integrationSecretAad(context.tenantId, row.integration_id, row.kind))))
    return {
      integrationId: row.integration_id,
      schema: settings.schema,
      config: await externalPostgresConfig(settings, credentials, await integrations.policy(), `tenant-bff:${context.tenantKey}`),
    }
  }
  const databases = new TenantDatabaseManager(config.credentialsDirectory, 100, {
    poolDatabaseUrl: process.env.TENANT_POOL_DATABASE_URL,
    poolSize: Number(process.env.TENANT_POOL_SIZE || 20),
    loadExternal,
  })
  const storage = new TenantStorage(registry, secretBox, () => integrations.policy(), config.storageRoot)
  const fileService = createFileService(storage)
  const loginThrottle = createThrottleStore(registry)
  const configs = new TenantConfigService(registry, databases)
  const notifier = new NotificationSender()
  const requestContexts = new WeakMap<FastifyRequest, TenantContext>()

  const contextFor = (request: FastifyRequest): TenantContext => {
    const context = requestContexts.get(request)
    if (!context) throw new Error('Trusted tenant context is unavailable.')
    return context
  }

  const loadSession = async (request: FastifyRequest): Promise<TenantSession | null> => {
    const context = contextFor(request)
    const rawToken = request.cookies[cookieName] || (!isProduction ? (request.cookies['__Host-tenant_session'] || request.cookies['tenant_session']) : undefined)
    if (!rawToken) return null
    const tokenHash = hashToken(rawToken)
    const schema = quoteIdentifier(context.dataSchema)
    const storedResult = await databases.directQuery<{
      token_hash: string
      csrf_hash: string
      tenant_id: string
      user_id: string
    }>(
      context,
      `select token_hash, csrf_hash, tenant_id::text, user_id::text
         from ${schema}.user_session
        where token_hash = $1 and tenant_id = $2 and expires_at > now()`,
      [tokenHash, context.tenantId],
    )
    const stored = storedResult.rows[0]
    if (!stored || stored.tenant_id !== context.tenantId) return null

    const profile = await databases.withTenant(context, async (client) => {
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string | null
        password_change_required: boolean
        role_codes: string[]
        permissions: string[]
      }>(
        `select u.user_id::text, u.username, u.display_name, u.email_normalized, u.password_change_required,
                coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes,
                coalesce(array_agg(distinct p.permission_code) filter (where p.permission_code is not null), '{}') as permissions
           from user_account u
           left join role_assignment ra on ra.user_id = u.user_id
             and (ra.expires_at is null or ra.expires_at > now())
           left join role_definition r on r.role_id = ra.role_id
           left join role_permission rp on rp.role_id = r.role_id
           left join permission p on p.permission_id = rp.permission_id
          where u.user_id = $1 and u.account_status = 'active'
          group by u.user_id`,
        [stored.user_id],
      )
      const row = result.rows[0]
      if (!row) return row
      const delegated = await client.query<{ permission_code: string }>(
        `select permission_code
           from capability_delegation
          where grantee_user_id = $1
            and status = 'active'
            and (expires_at is null or expires_at > now())`,
        [row.user_id],
      )
      return {
        ...row,
        permissions: [
          ...new Set([
            ...(row.permissions || []),
            ...delegated.rows.map((delegation) => delegation.permission_code),
          ]),
        ],
      }
    })
    if (!profile) return null
    void databases.directQuery(
      context,
      `update ${schema}.user_session set last_seen_at = now() where token_hash = $1 and tenant_id = $2`,
      [tokenHash, context.tenantId],
    ).catch((error: unknown) => request.log.warn({ error }, 'tenant session heartbeat update failed'))
    const canonicalRole = getHighestCanonicalRole(profile.role_codes) || 'tenant_viewer'
    return {
      tokenHash,
      csrfHash: stored.csrf_hash,
      tenantId: stored.tenant_id,
      userId: profile.user_id,
      username: profile.username,
      displayName: profile.display_name,
      email: profile.email_normalized,
      role: mapRole(profile.role_codes),
      canonicalRole,
      permissions: new Set(profile.permissions),
      passwordChangeRequired: profile.password_change_required === true,
    }
  }

  const sessionsForRequest = new WeakMap<FastifyRequest, Promise<TenantSession | null>>()
  const getSession = (request: FastifyRequest): Promise<TenantSession | null> => {
    let session = sessionsForRequest.get(request)
    if (!session) { session = loadSession(request); sessionsForRequest.set(request,session) }
    return session
  }

  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.currentPassword', 'req.body.newPassword', 'req.body.rows[*].password'] },
    bodyLimit: 64 * 1024,
    trustProxy: ['127.0.0.1', '::1'],
    genReqId: (request) => {
      const supplied = request.headers['x-request-id']
      return typeof supplied === 'string' && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : crypto.randomUUID()
    },
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    ...(sharedStateBackend() === 'postgres' ? { store: createSharedRateLimitStore(registry), skipOnError: true } : {}),
  })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure ? { maxAge: 31_536_000, preload: true, includeSubDomains: true } : false,
  })

  // Unauthenticated, read-only, non-sensitive endpoints the provisioning
  // pipeline must be able to reach before a tenant is fully activated, to
  // verify the hostname is genuinely reachable over the public edge (DNS ->
  // Cloudflare -> tunnel -> this process) before flipping it live.
  const provisioningVisibleRoutes = new Set(['/api/health', '/api/tenant/bootstrap', '/api/v1/tenant/info'])

  // Requests on the shared app host, where the company comes from the sign-in, not the hostname.
  const appRequests = new WeakSet<FastifyRequest>()
  // Without a remembered company the shared host only serves the sign-in surface.
  const appSignedOutRoutes = new Set([
    '/api/health',
    '/api/tenant/bootstrap',
    '/api/v1/tenant/info',
    '/api/auth/session',
    '/api/v1/auth/session',
    '/api/auth/login',
    '/api/v1/auth/login',
    '/api/auth/logout',
    '/api/v1/auth/logout',
    '/api/app/forget-company',
  ])

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
    const requestHost = normalizeTenantHostname(request.headers.host)
    const onApp = !!requestHost && requestHost === config.appHost
    let context: TenantContext | null
    if (onApp) {
      appRequests.add(request)
      const tenantKey = companyFromCookie(request.cookies[companyCookie])
      const hostname = tenantKey ? await resolver.hostnameForKey(tenantKey) : null
      context = hostname ? await resolver.resolve(hostname) : null
      if (!context) {
        const pathname = request.url.split('?', 1)[0] || '/'
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.origin !== `https://${requestHost}`) {
          return reply.code(403).send({ success: false, message: 'Request origin is not allowed.' })
        }
        if (pathname.startsWith('/api/') && !appSignedOutRoutes.has(pathname)) {
          return reply.code(401).send({ success: false, message: 'Sign in to continue.' })
        }
        return
      }
    } else {
      context = await resolver.resolve(request.headers.host)
    }
    if (!context) {
      return reply.code(404).send({ success: false, message: 'Tenant not found.' })
    }
    if (context.status === 'suspended') {
      return reply.code(403).send({ success: false, message: 'Tenant access is suspended.' })
    }
    if (context.status === 'migration_failed') {
      return reply.code(503).send({ success: false, message: 'Tenant workspace migration failed.' })
    }
    const pathname = request.url.split('?', 1)[0] || '/'
    const isProvisioningVisible =
      context.status === 'provisioning' &&
      request.method === 'GET' &&
      provisioningVisibleRoutes.has(pathname)
    // While data moves between databases, reads needed to show progress stay
    // available; everything else waits for the move to finish.
    const isMaintenanceVisible =
      context.status === 'relocating' &&
      request.method === 'GET' &&
      (provisioningVisibleRoutes.has(pathname) || pathname.endsWith('/auth/session') || pathname.startsWith('/api/v1/operations/'))
    if (context.status === 'relocating' && !isMaintenanceVisible) {
      return reply.code(503).header('Retry-After', '30').send({ success: false, message: 'This workspace is being moved to a new database. Try again shortly.' })
    }
    if (context.status !== 'active' && !isProvisioningVisible && !isMaintenanceVisible) {
      return reply.code(503).send({ success: false, message: 'Tenant workspace is not available.' })
    }
    if (context.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION && !isProvisioningVisible) {
      return reply.code(503).send({
        success: false,
        message: 'Tenant schema is below minimum supported version.',
      })
    }
    requestContexts.set(request, context)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== `https://${onApp ? requestHost : context.hostname}`) {
        return reply.code(403).send({ success: false, message: 'Request origin is not allowed.' })
      }
    }
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ success: false, message: 'Invalid request.' })
    }
    // Client errors raised by Fastify and its plugins (rate limiting, body size, malformed
    // JSON) keep their status, so a 429 reaches the browser as a 429 with its Retry-After
    // header instead of looking like a server failure.
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      request.log.warn({ statusCode, correlationId: request.id }, 'tenant request rejected')
      return reply.code(statusCode).send({ success: false, message: statusCode === 429 ? 'Too many requests. Try again shortly.' : 'The request could not be completed.' })
    }
    request.log.error({ error, correlationId: request.id }, 'tenant request failed')
    return reply.code(500).send({ success: false, message: 'The request could not be completed.' })
  })

  const kit: TenantRequestKit = {
    tenant: contextFor,
    withTenant: async (request, callback) => {
      const session = await getSession(request)
      return databases.withTenant(contextFor(request), async client => {
        // The signed-in user, for module row-level security policies:
        // current_setting('app.user_id', true). Empty when signed out.
        await client.query(`select set_config('app.user_id', $1, true)`, [session?.userId ?? ''])
        return callback(client)
      })
    },
    config: (request) => configs.forTenant(contextFor(request)),
    async requireSession(request, reply) {
      const session = await getSession(request)
      if (!session) {
        void reply.code(401).send({ success: false, message: 'Authentication required.' })
        return null
      }
      return session
    },
    requirePermission: (request, reply, session, permission) =>
      requirePermission(databases, contextFor(request), request, reply, session, permission),
    requireCsrf,
    async requireFeature(request, reply, featureKey) {
      if (configBoolean(await configs.forTenant(contextFor(request)), featureKey, false)) return true
      void reply.code(404).send({ success: false, message: 'API route not found.' })
      return false
    },
    audit: (request, event) =>
      recordTenantAudit({ ...event, databases, context: contextFor(request), correlationId: request.id }),
    get files() {
      return fileService.service(kit)
    },
  }

  // Mounts a module in its own encapsulated scope. A module with a feature key
  // is invisible (404) for tenants where the feature resolves to false.
  const mountModule = async (module: TenantModule) => {
    await app.register(async (scope) => {
      if (module.featureKey) {
        const featureKey = module.featureKey
        scope.addHook('preHandler', async (request, reply) => {
          if (!(await kit.requireFeature(request, reply, featureKey))) return reply
        })
      }
      await module.register(scope, kit)
    })
  }

  // A user whose password was set by an administrator must change it before
  // doing anything else. Enforced here, not only in the UI, so API clients are
  // held to it too.
  const passwordChangeAllowed = new Set([
    '/api/auth/session', '/api/v1/auth/session',
    '/api/auth/logout', '/api/v1/auth/logout',
    '/api/v1/auth/password',
    '/api/auth/login', '/api/v1/auth/login',
    '/api/auth/invitations/inspect', '/api/auth/invitations/accept',
    '/api/tenant/bootstrap', '/api/v1/tenant/info', '/api/health',
  ])
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0] || '/'
    if (!pathname.startsWith('/api/') || passwordChangeAllowed.has(pathname) || !requestContexts.has(request)) return
    const session = await getSession(request)
    if (session?.passwordChangeRequired) {
      return reply.code(403).send({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Change your password to continue.',
      })
    }
  })

  app.get('/api/health', async (request, reply) => {
    try {
      await databases.withTenant(contextFor(request), async (client) => client.query('select 1'))
      return { success: true, status: 'ok', timestamp: new Date().toISOString() }
    } catch {
      return reply.code(503).send({ success: false, status: 'unavailable' })
    }
  })

  const bootstrapHandler: RouteHandlerMethod = async (request) => {
    const onApp = appRequests.has(request)
    // Shared app host without a remembered company: only the company sign-in.
    if (onApp && !requestContexts.has(request)) return { success: true, app: { company: null }, tenant: null, config: {} }
    const context = contextFor(request)
    let publicConfig: Record<string, unknown> = {}
    try {
      publicConfig = publicConfigValues(await configs.forTenant(context))
    } catch (error) {
      request.log.warn({ error }, 'tenant configuration unavailable for bootstrap')
    }
    return {
      success: true,
      ...(onApp ? { app: { company: context.displayName } } : {}),
      tenant: publicTenantBootstrap(context),
      config: publicConfig,
    }
  }
  app.get('/api/tenant/bootstrap', bootstrapHandler)
  app.get('/api/v1/tenant/info', bootstrapHandler)

  const sessionHandler: RouteHandlerMethod = async (request) => {
    if (appRequests.has(request) && !requestContexts.has(request)) return { success: true, authenticated: false, user: null, tenantId: null, csrfToken: null }
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return { success: true, authenticated: false, user: null, tenantId: context.tenantKey, csrfToken: null }
    // Issue a per-session CSRF token rather than minting a new one on every
    // call. Rotating here invalidated the token every other open tab held, so
    // a second tab's next mutation failed CSRF verification through no fault
    // of the user. The token is bound to the session and dies with it; it is
    // rotated deliberately at login and logout, not on every read.
    const schema = quoteIdentifier(context.dataSchema)
    let csrfToken = config.sessionSecret ? deriveCsrfToken(config.sessionSecret, session.tokenHash) : csrfTokensBySession.get(session.tokenHash)
    if (csrfToken && config.sessionSecret && !secureEqual(hashToken(csrfToken), session.csrfHash)) {
      // Session created before TENANT_SESSION_SECRET was configured.
      await databases.directQuery(
        context,
        `update ${schema}.user_session set csrf_hash = $1 where token_hash = $2 and tenant_id = $3`,
        [hashToken(csrfToken), session.tokenHash, context.tenantId],
      )
    }
    if (!csrfToken) {
      csrfToken = crypto.randomBytes(32).toString('base64url')
      await databases.directQuery(
        context,
        `update ${schema}.user_session set csrf_hash = $1 where token_hash = $2 and tenant_id = $3`,
        [hashToken(csrfToken), session.tokenHash, context.tenantId],
      )
      cacheCsrfToken(session.tokenHash, csrfToken)
    }
    return {
      success: true,
      authenticated: true,
      user: publicUser(session),
      tenantId: context.tenantKey,
      csrfToken,
    }
  }
  app.get('/api/auth/session', sessionHandler)
  app.get('/api/v1/auth/session', sessionHandler)

  const loginSchema = z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().min(8).max(512),
    turnstileToken: z.string().min(20).max(4096),
    /** Shared app host only: the company (subdomain, hostname or name) the user belongs to. */
    company: z.string().trim().max(255).optional(),
  })
  // Shared app host: one answer for an unknown company, an unknown user or a wrong password.
  const appLoginFailure = 'Invalid company, username or password.'
  const appThrottlePolicy = { maximumFailures: 10, lockoutMs: 15 * 60_000 }
  const loginHandler: RouteHandlerMethod = async (request, reply) => {
    const body = loginSchema.parse(request.body)
    const onApp = appRequests.has(request)
    let turnstileChecked = false
    let appKey = ''
    let context: TenantContext
    if (onApp) {
      const requestHost = normalizeTenantHostname(request.headers.host) ?? config.appHost
      const remembered = requestContexts.get(request) ?? null
      const company = (body.company ?? '').toLowerCase()
      // Counted per company as typed and username, whether or not either exists, so lockouts
      // behave the same for real and made-up companies.
      appKey = `app:${company || remembered?.tenantKey || ''}:${body.username.toLowerCase()}`
      if (!(await loginThrottle.allowed(appKey))) {
        return reply.code(429).send({ success: false, message: 'Too many sign-in attempts. Try again later.' })
      }
      if (!(await verifyTurnstile(body.turnstileToken, request.ip, requestHost))) {
        return reply.code(403).send({ success: false, message: 'Human verification failed.' })
      }
      turnstileChecked = true
      let chosen: TenantContext | null = remembered
      if (company) {
        const hostname = await resolver.hostnameForCompany(company)
        chosen = hostname ? await resolver.resolve(hostname) : null
      }
      if (!chosen || chosen.status !== 'active' || chosen.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
        // Same work and the same answer as a wrong password in a real company.
        await argon2.verify(validDummyHash, body.password).catch(() => false)
        await loginThrottle.failure(appKey, appThrottlePolicy)
        return reply.code(401).send({ success: false, message: appLoginFailure })
      }
      requestContexts.set(request, chosen)
      context = chosen
    } else {
      context = contextFor(request)
    }
    const tenantConfig = await configs.forTenant(context)
    const sessionTtlMs = configInteger(tenantConfig, 'auth.session_ttl_minutes', Math.floor(config.sessionTtlMs / 60_000)) * 60_000
    const throttlePolicy = {
      maximumFailures: configInteger(tenantConfig, 'auth.lockout.max_failures', 10),
      lockoutMs: configInteger(tenantConfig, 'auth.lockout.duration_minutes', 15) * 60_000,
    }
    const throttleKey = `${context.tenantId}:${body.username}`
    if (!(await loginThrottle.allowed(throttleKey))) {
      // On the shared host a locked account must look like any failed sign-in.
      if (onApp) {
        await loginThrottle.failure(appKey, appThrottlePolicy)
        return reply.code(401).send({ success: false, message: appLoginFailure })
      }
      await recordTenantAudit({
        databases,
        context,
        action: 'auth:lockout',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: 'Rate limit exceeded',
      })
      return reply.code(429).send({ success: false, message: 'Too many sign-in attempts. Try again later.' })
    }
    if (!turnstileChecked && !(await verifyTurnstile(body.turnstileToken, request.ip, context.hostname))) {
      await recordTenantAudit({
        databases,
        context,
        action: 'auth:turnstile_failed',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: 'Human verification failed',
      })
      return reply.code(403).send({ success: false, message: 'Human verification failed.' })
    }
    const candidate = await databases.withTenant(context, async (client) => {
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string | null
        account_status: string
        password_change_required: boolean
        password_hash: string | null
        role_codes: string[]
      }>(
        `select u.user_id::text, u.username, u.display_name, u.email_normalized, u.account_status,
                u.password_change_required, i.password_hash,
                coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes
           from user_account u
           left join user_identity i on i.user_id = u.user_id and i.credential_type = 'password'
           left join role_assignment ra on ra.user_id = u.user_id
             and (ra.expires_at is null or ra.expires_at > now())
           left join role_definition r on r.role_id = ra.role_id
          where lower(u.username) = lower($1) or lower(u.email_normalized) = lower($1)
          group by u.user_id, i.password_hash
          limit 1`,
        [body.username],
      )
      return result.rows[0]
    })
    let passwordValid = false
    try {
      passwordValid = await argon2.verify(candidate?.password_hash || validDummyHash, body.password)
    } catch {
      passwordValid = false
    }
    if (!candidate || candidate.account_status !== 'active' || !passwordValid) {
      await loginThrottle.failure(throttleKey, throttlePolicy)
      if (onApp) await loginThrottle.failure(appKey, appThrottlePolicy)
      await recordTenantAudit({
        databases,
        context,
        actorUserId: candidate?.user_id || null,
        action: 'auth:login_failure',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: !candidate
          ? 'User not found'
          : candidate.account_status !== 'active'
            ? 'Account inactive'
            : 'Invalid password',
      })
      return reply.code(401).send({ success: false, message: onApp ? appLoginFailure : 'Invalid username or password.' })
    }

    await loginThrottle.success(throttleKey)
    if (onApp) {
      await loginThrottle.success(appKey)
      // Remember the company on this device until a manual sign-out.
      reply.setCookie(companyCookie, companyCookieValue(context.tenantKey), {
        path: '/',
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'strict',
        maxAge: 400 * 24 * 60 * 60,
      })
    }

    const rawSessionToken = crypto.randomBytes(32).toString('base64url')
    const csrfToken = config.sessionSecret
      ? deriveCsrfToken(config.sessionSecret, hashToken(rawSessionToken))
      : crypto.randomBytes(32).toString('base64url')
    const schema = quoteIdentifier(context.dataSchema)
    await databases.directQuery(
      context,
      `insert into ${schema}.user_session (tenant_id, user_id, token_hash, csrf_hash, expires_at)
       values ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'))`,
      [context.tenantId, candidate.user_id, hashToken(rawSessionToken), hashToken(csrfToken), sessionTtlMs],
    )
    cacheCsrfToken(hashToken(rawSessionToken), csrfToken)
    await recordTenantAudit({
      databases,
      context,
      actorUserId: candidate.user_id,
      action: 'auth:login',
      resourceType: 'session',
      outcome: 'success',
      correlationId: request.id,
    })
    reply.setCookie(cookieName, rawSessionToken, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
    return {
      success: true,
      user: {
        id: candidate.user_id,
        username: candidate.username,
        displayName: candidate.display_name,
        email: candidate.email_normalized,
        role: mapRole(candidate.role_codes),
        canonicalRole: getHighestCanonicalRole(candidate.role_codes),
        mustChangePassword: candidate.password_change_required === true,
      },
      tenantId: context.tenantKey,
      csrfToken,
    }
  }
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)

  const logoutHandler: RouteHandlerMethod = async (request, reply) => {
    // Manual sign-out on the shared host also forgets the company.
    if (appRequests.has(request)) reply.clearCookie(companyCookie, { path: '/' })
    if (appRequests.has(request) && !requestContexts.has(request)) return { success: true }
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    const schema = quoteIdentifier(context.dataSchema)
    await databases.directQuery(
      context,
      `delete from ${schema}.user_session where token_hash = $1 and tenant_id = $2`,
      [session.tokenHash, context.tenantId],
    )
    csrfTokensBySession.delete(session.tokenHash)
    await recordTenantAudit({
      databases,
      context,
      actorUserId: session.userId,
      action: 'auth:logout',
      resourceType: 'session',
      outcome: 'success',
      correlationId: request.id,
    })
    reply.clearCookie(cookieName, { path: '/' })
    return { success: true }
  }
  app.post('/api/auth/logout', logoutHandler)
  app.post('/api/v1/auth/logout', logoutHandler)

  // Shared app host: "not your company?" on the sign-in screen.
  app.post('/api/app/forget-company', async (request, reply) => {
    if (!appRequests.has(request)) return reply.code(404).send({ success: false, message: 'Not found.' })
    reply.clearCookie(companyCookie, { path: '/' })
    return { success: true }
  })

  const usersQuery = z.object({
    role: z.string().trim().max(64).optional(),
    search: z.string().trim().max(100).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  app.get('/api/v1/users', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.read')) return
    const query = usersQuery.parse(request.query)
    const users = await databases.withTenant(context, async (client) => {
      const params: unknown[] = []
      let sql = `select u.user_id::text, u.username, u.display_name, u.email_normalized, u.account_status, u.created_at,
                        u.password_change_required,
                        c.category_id::text, c.name as category_name,
                        coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes
                   from user_account u
                   left join user_category_member cm on cm.user_id = u.user_id
                   left join user_category c on c.category_id = cm.category_id
                   left join role_assignment ra on ra.user_id = u.user_id
                   left join role_definition r on r.role_id = ra.role_id
                  where u.account_status <> 'departed'`
      if (query.search) {
        params.push(`%${query.search.toLowerCase()}%`)
        sql += ` and (lower(u.display_name) like $${params.length} or lower(u.username) like $${params.length})`
      }
      sql += ' group by u.user_id, c.category_id, c.name'
      if (query.role) {
        params.push(query.role)
        sql += ` having $${params.length} = any(array_agg(r.role_code))`
      }
      params.push(query.limit)
      sql += ` order by u.created_at desc limit $${params.length}`
      return (await client.query(sql, params)).rows as Array<Record<string, unknown> & { role_codes: string[] }>
    })
    return {
      success: true,
      tenantId: context.tenantKey,
      total: users.length,
      users: users.map((user) => ({
        id: user.user_id,
        username: user.username,
        displayName: user.display_name,
        email: user.email_normalized,
        status: user.account_status,
        createdAt: user.created_at,
        role: mapRole(user.role_codes),
        category: user.category_id ? { id: user.category_id, name: user.category_name } : null,
        passwordChangeRequired: user.password_change_required === true,
      })),
    }
  })

  // --- User categories --------------------------------------------------------
  // Administrator-defined classification of users ("Inspector", "Supervisor").
  // Defining them is workspace configuration; assigning one is user management.

  const categoryBody = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(''),
  })

  app.get('/api/v1/user-categories', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.read')) return
    const categories = await databases.withTenant(context, async (client) =>
      (await client.query(
        `select c.category_id::text as id, c.name, c.description,
                (select count(*)::int from user_category_member m join user_account u on u.user_id = m.user_id
                  where m.category_id = c.category_id and u.account_status <> 'departed') as "userCount"
           from user_category c order by lower(c.name)`,
      )).rows,
    )
    return { success: true, categories }
  })

  app.post('/api/v1/user-categories', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.settings.manage') || !requireCsrf(request, reply, session)) return
    const body = categoryBody.parse(request.body)
    try {
      const category = await databases.withTenant(context, async (client) => {
        const row = (await client.query<{ id: string }>(
          `insert into user_category (name, description, created_by) values ($1, $2, $3) returning category_id::text as id`,
          [body.name, body.description, session.userId],
        )).rows[0]!
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user_category:create', 'user_category', $2, 'success', $3)`,
          [session.userId, row.id, request.id],
        )
        return { id: row.id, name: body.name, description: body.description, userCount: 0 }
      })
      return reply.code(201).send({ success: true, category })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return reply.code(409).send({ success: false, message: 'A category with that name already exists.' })
      throw error
    }
  })

  app.delete('/api/v1/user-categories/:categoryId', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.settings.manage') || !requireCsrf(request, reply, session)) return
    const { categoryId } = z.object({ categoryId: z.string().uuid() }).parse(request.params)
    const removed = await databases.withTenant(context, async (client) => {
      const result = await client.query('delete from user_category where category_id = $1', [categoryId])
      if (result.rowCount) {
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user_category:delete', 'user_category', $2, 'success', $3)`,
          [session.userId, categoryId, request.id],
        )
      }
      return Boolean(result.rowCount)
    })
    if (!removed) return reply.code(404).send({ success: false, message: 'Category not found.' })
    return { success: true }
  })

  app.patch('/api/v1/users/:userId/category', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    const { categoryId } = z.object({ categoryId: z.string().uuid().nullable() }).parse(request.body)
    try {
      const updated = await databases.withTenant(context, async (client) => {
        if (categoryId && !(await client.query('select 1 from user_category where category_id = $1', [categoryId])).rowCount) {
          throw new UnknownCategoryError()
        }
        const result = await client.query(`select 1 from user_account where user_id = $1 and account_status <> 'departed' for update`, [userId])
        if (result.rowCount) {
          if (categoryId) {
            await client.query(
              `insert into user_category_member (user_id, category_id) values ($1, $2)
               on conflict (user_id) do update set category_id = excluded.category_id, assigned_at = now()`,
              [userId, categoryId],
            )
          } else {
            await client.query('delete from user_category_member where user_id = $1', [userId])
          }
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
             values ($1, 'user:category', 'user_account', $2, 'success', $3)`,
            [session.userId, userId, request.id],
          )
        }
        return Boolean(result.rowCount)
      })
      if (!updated) return reply.code(404).send({ success: false, message: 'User not found.' })
      return { success: true }
    } catch (error) {
      if (error instanceof UnknownCategoryError) return reply.code(400).send({ success: false, message: error.message })
      throw error
    }
  })

  // --- First-login setup and own password ---------------------------------------

  app.get('/api/v1/setup', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    // Guided setup is for administrators: it configures categories and users.
    if (!session.permissions.has('tenant.settings.manage')) return { success: true, pending: false }
    const row = await databases.withTenant(context, async (client) =>
      (await client.query<{ setup_completed_at: Date | null }>('select setup_completed_at from user_account where user_id = $1', [session.userId])).rows[0],
    )
    return { success: true, pending: Boolean(row && !row.setup_completed_at) }
  })

  app.post('/api/v1/setup/complete', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    await databases.withTenant(context, async (client) => {
      await client.query('update user_account set setup_completed_at = coalesce(setup_completed_at, now()) where user_id = $1', [session.userId])
    })
    return { success: true }
  })

  const ownPasswordSchema = z.object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(512),
  })

  // The signed-in user changes their own password. Other sessions end; this
  // one stays signed in.
  app.post('/api/v1/auth/password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    const body = ownPasswordSchema.parse(request.body)
    const minLength = configInteger(await configs.forTenant(context), 'auth.password.min_length', 8)
    if (body.newPassword.length < minLength) {
      return reply.code(400).send({ success: false, message: `The new password must be at least ${minLength} characters.` })
    }
    if (body.newPassword === body.currentPassword) {
      return reply.code(400).send({ success: false, message: 'The new password must differ from the current one.' })
    }
    const current = await databases.withTenant(context, async (client) =>
      (await client.query<{ password_hash: string }>(
        `select password_hash from user_identity where user_id = $1 and credential_type = 'password' limit 1`,
        [session.userId],
      )).rows[0]?.password_hash,
    )
    let matches = false
    try {
      matches = await argon2.verify(current || validDummyHash, body.currentPassword)
    } catch {
      matches = false
    }
    if (!current || !matches) {
      await recordTenantAudit({
        databases, context, actorUserId: session.userId, action: 'user:password_change', resourceType: 'user_account',
        resourceId: session.userId, outcome: 'denied', correlationId: request.id, reason: 'Current password incorrect.',
      })
      return reply.code(400).send({ success: false, message: 'The current password is incorrect.' })
    }
    const newHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, ...ARGON2ID_OPTIONS })
    const changed = await databases.withTenant(context, async (client) => {
      const result = await client.query(
        `update user_identity set password_hash = $3
          where user_id = $1 and credential_type = 'password' and password_hash = $2`,
        [session.userId, current, newHash],
      )
      if (result.rowCount) {
        await client.query('update user_account set password_change_required = false, updated_at = now() where user_id = $1', [session.userId])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user:password_change', 'user_account', $1, 'success', $2)`,
          [session.userId, request.id],
        )
      }
      return Boolean(result.rowCount)
    })
    if (!changed) return reply.code(409).send({ success: false, message: 'Your password was changed elsewhere. Sign in again and retry.' })
    await databases.directQuery(
      context,
      `delete from ${quoteIdentifier(context.dataSchema)}.user_session where user_id = $1 and tenant_id = $2 and token_hash <> $3`,
      [session.userId, context.tenantId, session.tokenHash],
    )
    return { success: true, message: 'Password changed. Your other sessions have been signed out.' }
  })

  // Without a password the user is invited by email and sets their own; with
  // one, the account is active immediately and the administrator shares it.
  const createUserSchema = z
    .object({
      username: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(1).max(255),
      email: z.union([z.string().email().max(320), z.literal('')]).optional(),
      role: z.enum(ALL_SUPPORTED_ROLES).default('tenant_member'),
      password: z.string().max(512).optional(),
      useDefaultPassword: z.boolean().optional(),
      categoryId: z.string().uuid().nullable().optional(),
    })
    .refine((body) => Boolean(body.password) || body.useDefaultPassword === true || Boolean(body.email), {
      message: 'Provide an email for an invitation, set an initial password, or use the default password.',
    })

  app.post('/api/v1/users', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create') || !requireCsrf(request, reply, session)) return
    const body = createUserSchema.parse(request.body)
    const targetCanonical = toCanonicalRole(body.role)
    if (!targetCanonical) {
      return reply.code(400).send({ success: false, message: 'Invalid role.' })
    }
    if (!canAssignRole(session.canonicalRole, targetCanonical)) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:invite',
        resourceType: 'user_account',
        outcome: 'denied',
        correlationId: request.id,
        reason: `Your role (${session.canonicalRole}) is not permitted to assign ${targetCanonical}.`,
      })
      return reply.code(403).send({
        success: false,
        message: `As ${roleLabel(session.canonicalRole)}, you cannot add or assign the ${roleLabel(targetCanonical)} role.`,
      })
    }
    const tenantConfig = await configs.forTenant(context)
    const directPassword = body.password || null
    if (directPassword) {
      const minLength = configInteger(tenantConfig, 'auth.password.min_length', 8)
      if (directPassword.length < minLength) {
        return reply.code(400).send({ success: false, message: `The password must be at least ${minLength} characters.` })
      }
    } else if (!invitationsEnabled(tenantConfig)) {
      return reply.code(403).send({ success: false, message: 'User invitations are disabled for this workspace.' })
    }
    let passwordHash = directPassword ? await argon2.hash(directPassword, { type: argon2.argon2id, ...ARGON2ID_OPTIONS }) : null
    if (!passwordHash && body.useDefaultPassword) {
      passwordHash = await databases.withTenant(context, async (client) =>
        (await client.query<{ password_hash: string }>('select password_hash from workspace_default_password where singleton')).rows[0]?.password_hash ?? null,
      )
      if (!passwordHash) return reply.code(409).send({ success: false, message: 'No default password is set for this workspace yet.' })
    }
    const maximumUsers = configInteger(tenantConfig, 'limit.users.max', 0)
    const ttlHours = configInteger(tenantConfig, 'invitations.ttl_hours', 72)
    let created
    try {
      created = await databases.withTenant(context, async (client) => {
      // Serialise concurrent invites so the user limit cannot be overshot.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-user-limit:${context.schemaName}`])
      if (maximumUsers > 0) {
        const count = await client.query<{ total: number }>(
          `select count(*)::int as total from user_account where account_status <> 'departed'`,
        )
        if ((count.rows[0]?.total || 0) >= maximumUsers) throw new UserLimitError(maximumUsers)
      }
      const role = await client.query<{ role_id: string }>(
        'select role_id::text from role_definition where role_code = $1 limit 1',
        [targetCanonical],
      )
      if (!role.rows[0]) throw new Error('Configured role is unavailable.')
      if (body.categoryId) {
        const category = await client.query('select 1 from user_category where category_id = $1', [body.categoryId])
        if (!category.rowCount) throw new UnknownCategoryError()
      }
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string | null
      }>(
        `insert into user_account (username, display_name, email_normalized, account_status, password_change_required)
         values (lower($1), $2, nullif(lower($3), ''), $4, $5)
         returning user_id::text, username, display_name, email_normalized`,
        [body.username, body.displayName, body.email ?? '', passwordHash ? 'active' : 'invited', Boolean(passwordHash)],
      )
      const user = result.rows[0]
      if (!user) throw new Error('User creation failed.')
      await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
        user.user_id,
        role.rows[0].role_id,
        session.userId,
      ])
      if (body.categoryId) {
        await client.query('insert into user_category_member (user_id, category_id) values ($1, $2)', [result.rows[0]!.user_id, body.categoryId])
      }
      if (passwordHash) {
        await client.query(
          `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash)
           values ($1, 'local', lower($2), 'password', $3)`,
          [user.user_id, user.username, passwordHash],
        )
      }
      await client.query(
        `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
         values ($1, $2, 'user_account', $3, 'success', $4)`,
        [session.userId, passwordHash ? 'user:create' : 'user:invite', user.user_id, request.id],
      )
      const invitation = passwordHash ? null : await issueUserInvitation(client, { userId: user.user_id, invitedBy: session.userId, ttlHours })
      return { ...user, invitation }
      })
    } catch (error) {
      if (error instanceof UserLimitError) {
        await recordTenantAudit({
          databases,
          context,
          actorUserId: session.userId,
          action: 'user:invite',
          resourceType: 'user_account',
          outcome: 'denied',
          correlationId: request.id,
          reason: error.message,
        })
        return reply.code(409).send({ success: false, message: error.message })
      }
      if (error instanceof UnknownCategoryError) return reply.code(400).send({ success: false, message: error.message })
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ success: false, message: 'That username or email is already in use.' })
      }
      throw error
    }
    if (!created.invitation) {
      return {
        success: true,
        user: {
          id: created.user_id,
          username: created.username,
          displayName: created.display_name,
          email: created.email_normalized,
          role: targetCanonical,
          status: 'active',
        },
      }
    }
    const { link, delivery } = await deliverInvitation(notifier, context, {
      to: created.email_normalized,
      token: created.invitation.token,
      type: 'tenant_user_invitation',
      displayName: created.display_name,
    })
    return {
      success: true,
      user: {
        id: created.user_id,
        username: created.username,
        displayName: created.display_name,
        email: created.email_normalized,
        role: targetCanonical,
        status: 'invited',
      },
      // Shown once to the inviting administrator. The token itself is stored
      // only as a hash and cannot be recovered later; reissue instead.
      invitation: { link, expiresAt: created.invitation.expiresAt, delivered: delivery.delivered },
    }
  })

  // --- Default password and administrator resets -------------------------------
  // Only the argon2id hash of the default is stored; a reset copies it onto the
  // user's credential and requires a change at the next sign-in.

  app.get('/api/v1/users/default-password', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create')) return
    const row = await databases.withTenant(context, async (client) =>
      (await client.query<{ updated_at: Date }>('select updated_at from workspace_default_password where singleton')).rows[0],
    )
    return { success: true, configured: Boolean(row), updatedAt: row?.updated_at ?? null }
  })

  app.put('/api/v1/users/default-password', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.settings.manage') || !requireCsrf(request, reply, session)) return
    const { password } = z.object({ password: z.string().max(512) }).parse(request.body)
    const minLength = configInteger(await configs.forTenant(context), 'auth.password.min_length', 8)
    if (password.length < minLength) {
      return reply.code(400).send({ success: false, message: `The default password must be at least ${minLength} characters.` })
    }
    const hash = await argon2.hash(password, { type: argon2.argon2id, ...ARGON2ID_OPTIONS })
    await databases.withTenant(context, async (client) => {
      await client.query(
        `insert into workspace_default_password (singleton, password_hash, updated_by, updated_at) values (true, $1, $2, now())
         on conflict (singleton) do update set password_hash = excluded.password_hash, updated_by = excluded.updated_by, updated_at = now()`,
        [hash, session.userId],
      )
      await client.query(
        `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
         values ($1, 'workspace:default_password', 'workspace', null, 'success', $2)`,
        [session.userId, request.id],
      )
    })
    return { success: true }
  })

  app.post('/api/v1/users/:userId/reset-password', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      return reply.code(409).send({ success: false, message: 'Change your own password from your profile instead.' })
    }
    try {
      await databases.withTenant(context, async (client) => {
        const defaultHash = (await client.query<{ password_hash: string }>('select password_hash from workspace_default_password where singleton')).rows[0]?.password_hash
        if (!defaultHash) throw new ResetError(409, 'Set a default password for the workspace first.')
        const user = (await client.query<{ username: string; account_status: string }>(
          'select username, account_status from user_account where user_id = $1 for update',
          [userId],
        )).rows[0]
        if (!user || user.account_status === 'departed') throw new ResetError(404, 'User not found.')
        if (user.account_status === 'suspended') throw new ResetError(409, 'Resume this user before resetting their password.')
        const roles = await client.query<{ role_code: string }>(
          'select rd.role_code from role_assignment ra join role_definition rd on rd.role_id = ra.role_id where ra.user_id = $1',
          [userId],
        )
        const targetRole = getHighestCanonicalRole(roles.rows.map((r) => r.role_code))
        if (!canManageTargetUser(session.canonicalRole, targetRole)) {
          throw new ResetError(403, `As ${roleLabel(session.canonicalRole)}, you cannot reset the password of a user with role ${roleLabel(targetRole)}.`)
        }
        const updated = await client.query(
          `update user_identity set password_hash = $2 where user_id = $1 and credential_type = 'password'`,
          [userId, defaultHash],
        )
        if (!updated.rowCount) {
          // An invited user who never set a password gets one now.
          await client.query(
            `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash) values ($1, 'local', lower($2), 'password', $3)`,
            [userId, user.username, defaultHash],
          )
          await client.query('update user_invitation set revoked_at = now() where user_id = $1 and accepted_at is null and revoked_at is null', [userId])
        }
        await client.query(
          `update user_account set password_change_required = true, account_status = 'active', updated_at = now() where user_id = $1`,
          [userId],
        )
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user:password_reset', 'user_account', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
    } catch (error) {
      if (error instanceof ResetError) return reply.code(error.status).send({ success: false, message: error.message })
      throw error
    }
    // End the user's existing sessions so the new password takes effect everywhere.
    await databases.directQuery(
      context,
      `delete from ${quoteIdentifier(context.dataSchema)}.user_session where user_id = $1 and tenant_id = $2`,
      [userId, context.tenantId],
    )
    return { success: true, message: 'Password reset to the workspace default. The user must change it at their next sign-in.' }
  })

  // Bulk import from CSV (parsed in the browser). Each row succeeds or fails on
  // its own; the response reports every row. Rows with a password become active
  // accounts; rows without one are invited by email.
  const importRowSchema = z.object({
    displayName: z.string().trim().max(255).default(''),
    username: z.string().trim().max(255).default(''),
    email: z.string().trim().max(320).default(''),
    kind: z.string().trim().max(32).default('user'),
    category: z.string().trim().max(80).default(''),
    password: z.string().max(512).default(''),
  })
  const importSchema = z.object({ rows: z.array(importRowSchema).min(1).max(500) })
  type ImportResult = { row: number; username: string; status: 'created' | 'invited' | 'error'; message: string; invitationLink?: string; delivered?: boolean }

  app.post('/api/v1/users/import', { bodyLimit: 512 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create') || !requireCsrf(request, reply, session)) return
    const { rows } = importSchema.parse(request.body)
    const tenantConfig = await configs.forTenant(context)
    const minLength = configInteger(tenantConfig, 'auth.password.min_length', 8)
    const canInvite = invitationsEnabled(tenantConfig)
    const maximumUsers = configInteger(tenantConfig, 'limit.users.max', 0)
    const ttlHours = configInteger(tenantConfig, 'invitations.ttl_hours', 72)
    const canCreateCategories = session.permissions.has('tenant.settings.manage')
    const emailPattern = z.string().email()
    const defaultHash = await databases.withTenant(context, async (client) =>
      (await client.query<{ password_hash: string }>('select password_hash from workspace_default_password where singleton')).rows[0]?.password_hash ?? null,
    )

    // Validate and hash outside the transaction; hashing is the slow part.
    const prepared = await Promise.all(rows.map(async (row, index) => {
      const fail = (message: string) => ({ index, row, error: message })
      const kind = row.kind.toLowerCase()
      const roleCode = ['administrator', 'admin', 'tenant_admin'].includes(kind) ? 'tenant_admin' : ['user', 'member', 'tenant_member', ''].includes(kind) ? 'tenant_member' : null
      if (!row.displayName) return fail('Name is required.')
      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(row.username)) return fail('Username must be 3-64 letters, digits, dot, dash or underscore.')
      if (!roleCode) return fail(`Unknown kind "${row.kind}". Use administrator or user.`)
      if (!canAssignRole(session.canonicalRole, roleCode as never)) return fail(`As ${roleLabel(session.canonicalRole)}, you cannot add ${roleCode === 'tenant_admin' ? 'administrators' : 'users'}.`)
      if (row.email && !emailPattern.safeParse(row.email).success) return fail('Email is not valid.')
      if (row.password && row.password.length < minLength) return fail(`Password must be at least ${minLength} characters.`)
      if (!row.password && !defaultHash && !row.email) return fail('Provide a password or an email, or set a default password for the workspace.')
      if (!row.password && !defaultHash && !canInvite) return fail('Invitations are disabled for this workspace; provide a password.')
      // A blank password means the workspace default when one is set, else an invitation.
      const passwordHash = row.password ? await argon2.hash(row.password, { type: argon2.argon2id, ...ARGON2ID_OPTIONS }) : defaultHash
      return { index, row, roleCode, passwordHash, error: null as string | null }
    }))

    const results: ImportResult[] = []
    const invitations: Array<{ result: ImportResult; email: string; displayName: string; token: string }> = []
    await databases.withTenant(context, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-user-limit:${context.schemaName}`])
      let activeUsers = (await client.query<{ total: number }>(`select count(*)::int as total from user_account where account_status <> 'departed'`)).rows[0]?.total ?? 0
      const roleIds = new Map((await client.query<{ role_code: string; role_id: string }>(
        `select role_code, role_id::text from role_definition where role_code in ('tenant_admin', 'tenant_member')`,
      )).rows.map((r) => [r.role_code, r.role_id]))
      const categoryIds = new Map((await client.query<{ name: string; id: string }>(
        'select lower(name) as name, category_id::text as id from user_category',
      )).rows.map((r) => [r.name, r.id]))

      for (const item of prepared) {
        const username = item.row.username.toLowerCase()
        if (item.error !== null || !('roleCode' in item)) {
          results.push({ row: item.index + 1, username, status: 'error', message: item.error ?? 'Invalid row.' })
          continue
        }
        if (maximumUsers > 0 && activeUsers >= maximumUsers) {
          results.push({ row: item.index + 1, username, status: 'error', message: `This workspace has reached its limit of ${maximumUsers} users.` })
          continue
        }
        await client.query('savepoint import_row')
        try {
          let categoryId: string | null = null
          if (item.row.category) {
            categoryId = categoryIds.get(item.row.category.toLowerCase()) ?? null
            if (!categoryId) {
              if (!canCreateCategories) throw new Error(`Category "${item.row.category}" does not exist.`)
              categoryId = (await client.query<{ id: string }>(
                'insert into user_category (name, created_by) values ($1, $2) returning category_id::text as id',
                [item.row.category, session.userId],
              )).rows[0]!.id
              categoryIds.set(item.row.category.toLowerCase(), categoryId)
            }
          }
          const user = (await client.query<{ user_id: string }>(
            `insert into user_account (username, display_name, email_normalized, account_status, password_change_required)
             values ($1, $2, nullif(lower($3), ''), $4, $5) returning user_id::text`,
            [username, item.row.displayName, item.row.email, item.passwordHash ? 'active' : 'invited', Boolean(item.passwordHash)],
          )).rows[0]!
          await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [user.user_id, roleIds.get(item.roleCode!), session.userId])
          if (categoryId) await client.query('insert into user_category_member (user_id, category_id) values ($1, $2)', [user.user_id, categoryId])
          if (item.passwordHash) {
            await client.query(
              `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash) values ($1, 'local', $2, 'password', $3)`,
              [user.user_id, username, item.passwordHash],
            )
          }
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
             values ($1, $2, 'user_account', $3, 'success', $4)`,
            [session.userId, item.passwordHash ? 'user:create' : 'user:invite', user.user_id, request.id],
          )
          const result: ImportResult = { row: item.index + 1, username, status: item.passwordHash ? 'created' : 'invited', message: item.passwordHash ? 'Account created.' : 'Invitation created.' }
          if (!item.passwordHash) {
            const invitation = await issueUserInvitation(client, { userId: user.user_id, invitedBy: session.userId, ttlHours })
            invitations.push({ result, email: item.row.email.toLowerCase(), displayName: item.row.displayName, token: invitation.token })
          }
          await client.query('release savepoint import_row')
          activeUsers += 1
          results.push(result)
        } catch (error) {
          await client.query('rollback to savepoint import_row')
          const message = (error as { code?: string }).code === '23505' ? 'That username or email is already in use.' : (error as Error).message
          results.push({ row: item.index + 1, username, status: 'error', message })
        }
      }
    })
    // Links are delivered only after the accounts are committed.
    for (const invitation of invitations) {
      const { link, delivery } = await deliverInvitation(notifier, context, {
        to: invitation.email,
        token: invitation.token,
        type: 'tenant_user_invitation',
        displayName: invitation.displayName,
      })
      invitation.result.invitationLink = link
      invitation.result.delivered = delivery.delivered
    }
    results.sort((a, b) => a.row - b.row)
    return {
      success: true,
      summary: {
        created: results.filter((r) => r.status === 'created').length,
        invited: results.filter((r) => r.status === 'invited').length,
        failed: results.filter((r) => r.status === 'error').length,
      },
      results,
    }
  })

  app.post('/api/v1/users/:userId/invitation', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params)
    const tenantConfig = await configs.forTenant(context)
    if (!invitationsEnabled(tenantConfig)) {
      return reply.code(403).send({ success: false, message: 'User invitations are disabled for this workspace.' })
    }
    const ttlHours = configInteger(tenantConfig, 'invitations.ttl_hours', 72)
    const result = await databases.withTenant(context, async (client) => {
      const locked = await client.query(
        `select 1 from user_account where user_id = $1 and account_status = 'invited' for update`,
        [userId],
      )
      if (!locked.rowCount) return null
      const target = (
        await client.query<{ display_name: string; email_normalized: string | null; role_codes: string[] }>(
          `select u.display_name, u.email_normalized,
                  coalesce(array_agg(r.role_code) filter (where r.role_code is not null), '{}') as role_codes
             from user_account u
             left join role_assignment ra on ra.user_id = u.user_id
             left join role_definition r on r.role_id = ra.role_id
            where u.user_id = $1
            group by u.user_id`,
          [userId],
        )
      ).rows[0]
      if (!target) return null
      if (!canManageTargetUser(session.canonicalRole, getHighestCanonicalRole(target.role_codes))) return 'forbidden' as const
      const invitation = await issueUserInvitation(client, { userId, invitedBy: session.userId, ttlHours })
      await client.query(
        `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
         values ($1, 'user:invitation_reissued', 'user_account', $2, 'success', $3)`,
        [session.userId, userId, request.id],
      )
      return { ...target, invitation }
    })
    if (!result) return reply.code(404).send({ success: false, message: 'No pending invitation exists for this user.' })
    if (result === 'forbidden') return reply.code(403).send({ success: false, message: 'You cannot manage this user.' })
    const { link, delivery } = await deliverInvitation(notifier, context, {
      to: result.email_normalized,
      token: result.invitation.token,
      type: 'tenant_user_invitation',
      displayName: result.display_name,
    })
    return { success: true, invitation: { link, expiresAt: result.invitation.expiresAt, delivered: delivery.delivered } }
  })

  const updateRoleSchema = z.object({ role: z.enum(ALL_SUPPORTED_ROLES) })
  app.patch('/api/v1/users/:userId/role', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: 'You cannot change your own administrative role.',
      })
      return reply.code(409).send({ success: false, message: 'You cannot change your own administrative role.' })
    }
    const body = updateRoleSchema.parse(request.body)
    const newCanonicalRole = toCanonicalRole(body.role)
    if (!newCanonicalRole) {
      return reply.code(400).send({ success: false, message: 'Invalid role.' })
    }
    if (!canAssignRole(session.canonicalRole, newCanonicalRole)) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: `Your role (${session.canonicalRole}) is not permitted to assign ${newCanonicalRole}.`,
      })
      return reply.code(403).send({
        success: false,
        message: `As ${roleLabel(session.canonicalRole)}, you cannot add or assign the ${roleLabel(newCanonicalRole)} role.`,
      })
    }
    try {
      await databases.withTenant(context, async (client) => {
        const existingRolesRes = await client.query<{ role_code: string }>(
          `select rd.role_code
             from role_assignment ra
             join role_definition rd on rd.role_id = ra.role_id
            where ra.user_id = $1`,
          [userId],
        )
        const targetHighestRole = getHighestCanonicalRole(existingRolesRes.rows.map((r) => r.role_code))
        if (!canManageTargetUser(session.canonicalRole, targetHighestRole)) {
          throw new Error(
            `As ${roleLabel(session.canonicalRole)}, you cannot modify a user with role ${roleLabel(targetHighestRole)}.`,
          )
        }
        if (targetHighestRole === 'tenant_owner' && newCanonicalRole !== 'tenant_owner') {
          await assertNotDemotingLastOwner(client, context.schemaName, userId)
        }
        const role = await client.query<{ role_id: string }>(
          'select role_id::text from role_definition where role_code = $1 limit 1',
          [newCanonicalRole],
        )
        if (!role.rows[0]) throw new Error('Configured role is unavailable.')
        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          role.rows[0].role_id,
          session.userId,
        ])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, $2, 'role_assignment', $3, 'success', $4)`,
          [session.userId, `role:update:${newCanonicalRole}`, userId, request.id],
        )
      })
    } catch (error) {
      const msg = (error as Error).message
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: msg,
      })
      if (
        msg.includes('cannot modify a user with role') ||
        msg.includes('must keep at least one active Owner')
      ) {
        return reply.code(403).send({ success: false, message: msg })
      }
      throw error
    }
    return { success: true, role: newCanonicalRole }
  })

  app.post('/api/v1/users/:userId/grant-owner', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (session.canonicalRole !== 'tenant_owner') {
      return reply.code(403).send({ success: false, message: 'Only the Owner can grant the owner role.' })
    }
    if (!requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0] || userRes.rows[0].account_status !== 'active') {
          throw new Error('Target user must exist and be active.')
        }
        const role = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_owner'])).rows[0]
        if (!role) throw new Error('Role tenant_owner is missing.')
        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          role.role_id,
          session.userId,
        ])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'owner:grant', 'role_assignment', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      return { success: true, message: 'Owner role granted.' }
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message })
    }
  })

  app.post('/api/v1/users/:userId/transfer-ownership', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (session.canonicalRole !== 'tenant_owner') {
      return reply.code(403).send({ success: false, message: 'Only the Owner can transfer ownership.' })
    }
    if (!requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      return reply.code(409).send({ success: false, message: 'Cannot transfer ownership to yourself.' })
    }
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0] || userRes.rows[0].account_status !== 'active') {
          throw new Error('Target user must exist and be active.')
        }
        const ownerRole = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_owner'])).rows[0]
        const adminRole = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_admin'])).rows[0]
        if (!ownerRole || !adminRole) throw new Error('Required role definitions are missing.')

        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          ownerRole.role_id,
          session.userId,
        ])
        await client.query('delete from role_assignment where user_id = $1', [session.userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          session.userId,
          adminRole.role_id,
          session.userId,
        ])

        await assertNotDemotingLastOwner(client, context.schemaName, session.userId)
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'owner:transfer', 'role_assignment', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      return { success: true, message: 'Ownership transferred.' }
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message })
    }
  })

  app.post('/api/v1/users/:userId/suspend', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:suspend',
        resourceType: 'user_account',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: 'You cannot suspend your own account.',
      })
      return reply.code(409).send({ success: false, message: 'You cannot suspend your own account.' })
    }
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0]) throw new Error('User not found.')

        const rolesRes = await client.query<{ role_code: string }>(
          `select rd.role_code from role_assignment ra join role_definition rd on rd.role_id = ra.role_id where ra.user_id = $1`,
          [userId],
        )
        const targetRole = getHighestCanonicalRole(rolesRes.rows.map((r) => r.role_code))
        if (!canManageTargetUser(session.canonicalRole, targetRole)) {
          throw new Error(`As ${roleLabel(session.canonicalRole)}, you cannot modify a user with role ${roleLabel(targetRole)}.`)
        }
        if (targetRole === 'tenant_owner') {
          await assertNotDemotingLastOwner(client, context.schemaName, userId)
        }
        await client.query('update user_account set account_status = $1, updated_at = now() where user_id = $2', ['suspended', userId])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user:suspend', 'user_account', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      // user_session is reachable only by the login role (see the access
      // manifest). getSession also rejects non-active accounts, so a session
      // left behind by a failure here is already unusable.
      await databases.directQuery(
        context,
        `delete from ${quoteIdentifier(context.dataSchema)}.user_session where user_id = $1 and tenant_id = $2`,
        [userId, context.tenantId],
      )
      return { success: true, status: 'suspended' }
    } catch (error) {
      const msg = (error as Error).message
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:suspend',
        resourceType: 'user_account',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: msg,
      })
      if (
        msg.includes('cannot modify a user with role') ||
        msg.includes('must keep at least one active Owner')
      ) {
        return reply.code(403).send({ success: false, message: msg })
      }
      return reply.code(400).send({ success: false, message: msg })
    }
  })

  app.get('/api/v1/audit', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.audit.read')) return
    const logs = await databases.withTenant(context, async (client) =>
      (
        await client.query(
          `select a.event_id::text, a.action, a.resource_type, a.outcome, a.occurred_at,
                  coalesce(u.display_name, u.username, 'System') as actor
             from audit_event a
             left join user_account u on u.user_id = a.actor_user_id
            order by a.occurred_at desc limit 50`,
        )
      ).rows,
    )
    return {
      success: true,
      tenantId: context.tenantKey,
      total: logs.length,
      logs: logs.map((log) => ({
        id: log.event_id,
        action: log.action,
        resourceType: log.resource_type,
        outcome: log.outcome,
        occurredAt: log.occurred_at,
        actor: log.actor,
      })),
    }
  })

  app.get('/api/v1/stats', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.stats.read')) return
    const stats = await databases.withTenant(context, async (client) => {
      const total = await client.query<{ total_users: number }>('select count(*)::int as total_users from user_account')
      const roles = await client.query<{ role_code: string; role_count: number }>(
        `select r.role_code, count(distinct ra.user_id)::int as role_count
           from role_definition r left join role_assignment ra on ra.role_id = r.role_id
          group by r.role_code`,
      )
      return { total: total.rows[0]?.total_users || 0, roles: roles.rows }
    })
    return {
      success: true,
      tenantId: context.tenantKey,
      stats: { totalUsers: stats.total, roleBreakdown: stats.roles },
    }
  })

  await mountModule(createInvitationsModule({ registry }))
  await mountModule(createSettingsModule({ configs }))
  await mountModule(createTeamsModule())
  await mountModule(fileService.module)
  await mountModule(createIntegrationsModule({ registry, integrations }))
  for (const module of applicationModules) await mountModule(module)

  if (config.serveStatic) {
    await app.register(staticFiles, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: true,
      // Cache-Control is set per file below; the plugin's default would replace it.
      cacheControl: false,
      setHeaders(response, filePath) {
        response.raw.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests",
        )
        response.raw.setHeader('Referrer-Policy', 'no-referrer')
        response.raw.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        // Only content-hashed build assets are immutable. The page and other
        // fixed-name public files must revalidate so updates reach browsers.
        const relative = path.relative(config.staticRoot, filePath).split(path.sep)[0]
        response.raw.setHeader(
          'Cache-Control',
          filePath.endsWith('index.html') ? 'no-store' : relative === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache',
        )
      },
    })
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ success: false, message: 'API route not found.' })
      }
      const pathname = request.url.split('?', 1)[0] || '/'
      if (pathname.startsWith('/assets/') || path.posix.extname(pathname)) {
        // Never let the CDN cache a miss: a file can appear moments later (a deploy
        // in progress), and a cached 404 would break every open tab for hours.
        reply.header('Cache-Control', 'no-store')
        return reply.code(404).send({ success: false, message: 'Static asset not found.' })
      }
      reply.header('Cache-Control', 'no-store')
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
    await databases.close()
    await registry.end()
  })
  return app
}

export async function startServer() {
  const server = await createServer()
  await server.listen({ host: config.host, port: config.port })
  return server
}

async function main(): Promise<void> {
  const server = await startServer()
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const forcedExit = setTimeout(() => process.exit(1), 25_000)
    forcedExit.unref()
    try {
      await server.close()
      process.exit(0)
    } catch (error) {
      server.log.error({ error }, 'graceful shutdown failed')
      process.exit(1)
    }
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
