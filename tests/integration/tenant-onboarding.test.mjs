import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'

// Onboarding a tenant with a default administrator login and modules chosen
// up front: the account exists inside the new tenant schema with the owner
// role, can sign in as soon as the tenant is active, the staged password hash
// is cleared, and only the selected modules answer.

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')
assert.ok(process.env.TENANT_PROVISIONER_DATABASE_URL, 'TENANT_PROVISIONER_DATABASE_URL is required')
assert.ok(process.env.TENANT_REGISTRY_DATABASE_URL, 'TENANT_REGISTRY_DATABASE_URL is required')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-onboarding-'))
process.env.TENANT_CREDENTIALS_DIR = path.join(tempDir, 'credentials')
process.env.TENANT_PGBOUNCER_AUTH_FILE = path.join(tempDir, 'tenant-users.txt')
fs.mkdirSync(process.env.TENANT_CREDENTIALS_DIR, { recursive: true })
fs.writeFileSync(process.env.TENANT_PGBOUNCER_AUTH_FILE, '')
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'
process.env.TENANT_CONFIG_CACHE_TTL_MS = '0'
const dbUrl = new URL(process.env.DATABASE_URL)
process.env.TENANT_PGBOUNCER_HOST = dbUrl.hostname
process.env.TENANT_PGBOUNCER_PORT = dbUrl.port || '5432'

const { createServer: createPlatformServer } = await import('../../backend/dist/server.js')
const { createServer: createTenantServer } = await import('../../backend/tenant/dist/server.js')
const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const rootDomain = process.env.TENANT_ROOT_DOMAIN || 'sandbox.test'
const platformOrigin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
const csrf = 'onboarding-csrf'

describe('Integration: tenant onboarding with a default administrator', () => {
  let platform
  let tenantApp
  let pool
  let worker
  let timer
  let sessionHash
  let platformHeaders
  let tenantKey
  const subdomain = `zzonboard${crypto.randomBytes(4).toString('hex')}`
  const host = `${subdomain}.${rootDomain}`
  const tenantHeaders = (extra = {}) => ({ host, origin: `https://${host}`, ...extra })
  const ownerPassword = 'Initial-Admin-Pass-2026'

  async function platformCall(method, url, payload) {
    const response = await platform.inject({
      method,
      url,
      headers: payload === undefined ? platformHeaders.action : platformHeaders.json,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
    return { status: response.statusCode, body: JSON.parse(response.payload) }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL })
    const admin = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    assert.ok(admin, 'a seeded platform owner is required')
    const token = crypto.randomBytes(32).toString('base64url')
    sessionHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '15 minutes', now())`,
      [admin.id, sessionHash, sha256(csrf)],
    )
    const cookie = `__Host-platform_session=${token}`
    platformHeaders = {
      json: { cookie, 'x-csrf-token': csrf, origin: platformOrigin, 'content-type': 'application/json' },
      action: { cookie, 'x-csrf-token': csrf, origin: platformOrigin },
    }
    platform = await createPlatformServer()
    tenantApp = await createTenantServer()
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    timer = setInterval(() => worker.tick().catch((error) => console.error('[onboarding] worker tick failed', error)), 250)
  })

  after(async () => {
    if (tenantKey) {
      await platformCall('POST', `/api/tenants/${tenantKey}/suspend`).catch(() => undefined)
      const removal = await platformCall('POST', `/api/tenants/${tenantKey}/deprovision`).catch(() => null)
      if (removal?.body?.jobId) {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const { body } = await platformCall('GET', `/api/tenant-provisioning/${removal.body.jobId}`)
          if (['succeeded', 'failed'].includes(body.job?.status)) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    }
    if (timer) clearInterval(timer)
    if (worker) await worker.close()
    await pool.query('delete from platform.platform_session where token_hash = $1', [sessionHash]).catch(() => undefined)
    if (tenantApp) await tenantApp.close()
    if (platform) await platform.close()
    if (pool) await pool.end()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('rejects incomplete administrator details and unknown modules before reserving anything', async () => {
    const base = { displayName: 'Rejected Tenant', subdomain: `zzreject${crypto.randomBytes(4).toString('hex')}` }
    const noUsername = await platformCall('POST', '/api/tenants', { ...base, owner: { displayName: 'A', password: ownerPassword } })
    assert.equal(noUsername.status, 400)
    const short = await platformCall('POST', '/api/tenants', { ...base, owner: { displayName: 'A', username: 'admin', password: 'short' } })
    assert.equal(short.status, 400)
    const unknownModule = await platformCall('POST', '/api/tenants', { ...base, modules: ['module.nonexistent'] })
    assert.equal(unknownModule.status, 400)
    const reserved = await pool.query('select 1 from platform.tenant_registry where slug = $1', [base.subdomain])
    assert.equal(reserved.rowCount, 0, 'a rejected request must not reserve the subdomain')
  })

  test('creates the administrator inside the tenant and enables only the chosen modules', async () => {
    const created = await platformCall('POST', '/api/tenants', {
      displayName: 'Onboarding Test Tenant',
      subdomain,
      owner: { displayName: 'Tenant Admin', username: 'Tenant.Admin', password: ownerPassword, email: 'admin@onboarding.test' },
      modules: ['module.delegations'],
    })
    assert.equal(created.status, 202, created.body.message)
    tenantKey = created.body.tenant.tenantId
    assert.equal(created.body.ownerAccount.username, 'tenant.admin')
    assert.equal(created.body.ownerInvitation, undefined, 'no invitation when a login is set')

    const deadline = Date.now() + 60_000
    for (;;) {
      const { body } = await platformCall('GET', `/api/tenant-provisioning/${created.body.jobId}`)
      if (body.job.status === 'succeeded') {
        assert.equal(body.job.steps.find((step) => step.stepCode === 'CREATE_TENANT_OWNER')?.status, 'succeeded')
        break
      }
      if (body.job.status === 'failed') throw new Error(`provisioning failed: ${body.job.errorMessage}`)
      if (Date.now() > deadline) throw new Error('provisioning timed out')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    // The staged hash is gone once applied.
    const bootstrap = (await pool.query(
      `select b.password_hash, b.applied_at from platform.tenant_owner_bootstrap b
         join platform.tenant_registry t on t.tenant_id = b.tenant_id where t.tenant_key = $1`,
      [tenantKey],
    )).rows[0]
    assert.equal(bootstrap.password_hash, null)
    assert.ok(bootstrap.applied_at)

    const detail = await platformCall('GET', `/api/tenants/${tenantKey}`)
    assert.equal(detail.body.ownerAccount.username, 'tenant.admin')
    assert.ok(detail.body.ownerAccount.createdInTenantAt)
    assert.equal(detail.body.effectiveConfig.values['module.delegations'], true)

    // The administrator signs in with the credentials set at onboarding.
    const login = await tenantApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ username: 'tenant.admin', password: ownerPassword, turnstileToken: 'x'.repeat(24) }),
    })
    const session = JSON.parse(login.payload)
    assert.equal(login.statusCode, 200, session.message)
    assert.equal(session.user.canonicalRole, 'tenant_owner')

    const wrong = await tenantApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ username: 'tenant.admin', password: 'not-the-password', turnstileToken: 'x'.repeat(24) }),
    })
    assert.equal(wrong.statusCode, 401)

    // Module tables live in the tenant's own schema.
    const schema = (await pool.query('select schema_identifier from platform.tenant_registry where tenant_key = $1', [tenantKey])).rows[0].schema_identifier
    const moduleTables = await pool.query(`select 1 from pg_tables where schemaname = $1 and tablename = 'capability_delegation'`, [schema])
    assert.equal(moduleTables.rowCount, 1)
  })

  test('first-login setup: password, categories and users, then setup is done', async () => {
    assert.ok(tenantKey, 'depends on the previous test')
    const login = async (username, password) => {
      const response = await tenantApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: tenantHeaders({ 'content-type': 'application/json' }),
        payload: JSON.stringify({ username, password, turnstileToken: 'x'.repeat(24) }),
      })
      const body = JSON.parse(response.payload)
      assert.equal(response.statusCode, 200, body.message)
      const cookie = response.cookies.find((item) => item.name.endsWith('tenant_session'))
      return { cookie: `${cookie.name}=${cookie.value}`, csrfToken: body.csrfToken }
    }
    const call = async (session, method, url, payload) => {
      const headers = tenantHeaders({ cookie: session.cookie, 'x-csrf-token': session.csrfToken })
      if (payload !== undefined) headers['content-type'] = 'application/json'
      const response = await tenantApp.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) })
      return { status: response.statusCode, body: JSON.parse(response.payload) }
    }

    const admin = await login('tenant.admin', ownerPassword)
    const other = await login('tenant.admin', ownerPassword)
    assert.equal((await call(admin, 'GET', '/api/v1/setup')).body.pending, true, 'a fresh workspace offers setup')

    // Step 1: own password. Other sessions end, this one stays.
    const newPassword = 'Changed-Admin-Pass-2026'
    assert.equal((await call(admin, 'POST', '/api/v1/auth/password', { currentPassword: 'wrong-password', newPassword })).status, 400)
    const changed = await call(admin, 'POST', '/api/v1/auth/password', { currentPassword: ownerPassword, newPassword })
    assert.equal(changed.status, 200, changed.body.message)
    assert.equal((await call(other, 'GET', '/api/v1/setup')).status, 401, 'other sessions are signed out')
    assert.equal((await call(admin, 'GET', '/api/v1/setup')).status, 200, 'this session stays signed in')

    // Step 2: categories.
    const inspector = await call(admin, 'POST', '/api/v1/user-categories', { name: 'Inspector', description: 'Field inspections' })
    assert.equal(inspector.status, 201, inspector.body.message)
    assert.equal((await call(admin, 'POST', '/api/v1/user-categories', { name: 'inspector' })).status, 409, 'names are unique ignoring case')
    const supervisor = await call(admin, 'POST', '/api/v1/user-categories', { name: 'Supervisor' })

    // Step 3: users of both kinds, one with a password and a category.
    const user = await call(admin, 'POST', '/api/v1/users', {
      displayName: 'Field User', username: 'field.user', role: 'tenant_member',
      password: 'Field-User-Pass-1', categoryId: inspector.body.category.id,
    })
    assert.equal(user.status, 200, user.body.message)
    assert.equal(user.body.user.status, 'active')
    assert.equal(user.body.invitation, undefined)
    const adminUser = await call(admin, 'POST', '/api/v1/users', {
      displayName: 'Second Admin', username: 'second.admin', email: 'second@onboarding.test', role: 'tenant_admin',
    })
    assert.equal(adminUser.status, 200, adminUser.body.message)
    assert.ok(adminUser.body.invitation.link, 'without a password the user is invited')
    assert.equal((await call(admin, 'POST', '/api/v1/users', { displayName: 'X', username: 'no.access', role: 'tenant_member' })).status, 400)

    await login('field.user', 'Field-User-Pass-1')

    let listed = await call(admin, 'GET', '/api/v1/users?limit=100')
    assert.equal(listed.body.users.find((u) => u.username === 'field.user').category.name, 'Inspector')
    const moved = await call(admin, 'PATCH', `/api/v1/users/${user.body.user.id}/category`, { categoryId: supervisor.body.category.id })
    assert.equal(moved.status, 200, moved.body.message)
    listed = await call(admin, 'GET', '/api/v1/users?limit=100')
    assert.equal(listed.body.users.find((u) => u.username === 'field.user').category.name, 'Supervisor')

    const categories = await call(admin, 'GET', '/api/v1/user-categories')
    assert.deepEqual(categories.body.categories.map((c) => [c.name, c.userCount]), [['Inspector', 0], ['Supervisor', 1]])
    assert.equal((await call(admin, 'DELETE', `/api/v1/user-categories/${supervisor.body.category.id}`)).status, 200)
    listed = await call(admin, 'GET', '/api/v1/users?limit=100')
    assert.equal(listed.body.users.find((u) => u.username === 'field.user').category, null, 'removing a category uncategorises its users')

    // A regular user can neither manage categories nor see setup. Their
    // password was set by an administrator, so they change it first.
    const fieldUser = await login('field.user', 'Field-User-Pass-1')
    const blocked = await call(fieldUser, 'GET', '/api/v1/setup')
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal((await call(fieldUser, 'POST', '/api/v1/auth/password', { currentPassword: 'Field-User-Pass-1', newPassword: 'Field-User-Own-2' })).status, 200)
    assert.equal((await call(fieldUser, 'GET', '/api/v1/setup')).body.pending, false)
    assert.equal((await call(fieldUser, 'POST', '/api/v1/user-categories', { name: 'Nope' })).status, 403)

    assert.equal((await call(admin, 'POST', '/api/v1/setup/complete')).status, 200)
    assert.equal((await call(admin, 'GET', '/api/v1/setup')).body.pending, false)

    // Bulk import: rows succeed or fail individually; unknown categories are created.
    const imported = await call(admin, 'POST', '/api/v1/users/import', {
      rows: [
        { displayName: 'Csv One', username: 'csv.one', kind: 'user', category: 'Drivers', password: 'Csv-One-Pass-1' },
        { displayName: 'Csv Two', username: 'csv.two', email: 'two@onboarding.test', kind: 'administrator' },
        { displayName: 'Csv Bad', username: 'csv.bad', kind: 'superuser', password: 'Csv-Bad-Pass-1' },
        { displayName: 'Dup', username: 'field.user', kind: 'user', password: 'Dup-User-Pass-1' },
        { displayName: 'No Access', username: 'csv.none', kind: 'user' },
      ],
    })
    assert.equal(imported.status, 200, imported.body.message)
    assert.deepEqual(imported.body.summary, { created: 1, invited: 1, failed: 3 })
    assert.deepEqual(imported.body.results.map((r) => r.status), ['created', 'invited', 'error', 'error', 'error'])
    assert.ok(imported.body.results[1].invitationLink)
    await login('csv.one', 'Csv-One-Pass-1')
    listed = await call(admin, 'GET', '/api/v1/users?limit=100')
    assert.equal(listed.body.users.find((u) => u.username === 'csv.one').category.name, 'Drivers')
    assert.equal(listed.body.users.find((u) => u.username === 'csv.two').role, 'admin')
  })

  test('default password: reset forces a change at next sign-in, enforced by the server', async () => {
    // A separate client address keeps this test under the per-IP login rate limit.
    const login = async (username, password, expectStatus = 200) => {
      const response = await tenantApp.inject({
        method: 'POST', url: '/api/auth/login', headers: tenantHeaders({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }),
        payload: JSON.stringify({ username, password, turnstileToken: 'x'.repeat(24) }),
      })
      const body = JSON.parse(response.payload)
      assert.equal(response.statusCode, expectStatus, body.message)
      if (expectStatus !== 200) return null
      const cookie = response.cookies.find((item) => item.name.endsWith('tenant_session'))
      return { cookie: `${cookie.name}=${cookie.value}`, csrfToken: body.csrfToken, user: body.user }
    }
    const call = async (session, method, url, payload) => {
      const headers = tenantHeaders({ cookie: session.cookie, 'x-csrf-token': session.csrfToken })
      if (payload !== undefined) headers['content-type'] = 'application/json'
      const response = await tenantApp.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) })
      return { status: response.statusCode, body: JSON.parse(response.payload) }
    }
    const admin = await login('tenant.admin', 'Changed-Admin-Pass-2026')
    const users = (await call(admin, 'GET', '/api/v1/users?limit=100')).body.users
    const fieldUserId = users.find((u) => u.username === 'field.user').id

    assert.equal((await call(admin, 'GET', '/api/v1/users/default-password')).body.configured, false)
    assert.equal((await call(admin, 'POST', `/api/v1/users/${fieldUserId}/reset-password`)).status, 409, 'no default yet')
    assert.equal((await call(admin, 'PUT', '/api/v1/users/default-password', { password: 'short' })).status, 400)
    assert.equal((await call(admin, 'PUT', '/api/v1/users/default-password', { password: 'Workspace-Default-1' })).status, 200)
    assert.equal((await call(admin, 'GET', '/api/v1/users/default-password')).body.configured, true)
    const schema = (await pool.query('select schema_identifier from platform.tenant_registry where tenant_key = $1', [tenantKey])).rows[0].schema_identifier
    const stored = (await pool.query(`select password_hash from ${schema}.workspace_default_password`)).rows[0].password_hash
    assert.match(stored, /^\$argon2id\$/, 'only the hash is stored')

    // The user is signed in elsewhere; a reset ends that session.
    const before = await login('field.user', 'Field-User-Own-2')
    const reset = await call(admin, 'POST', `/api/v1/users/${fieldUserId}/reset-password`)
    assert.equal(reset.status, 200, reset.body.message)
    assert.equal((await call(before, 'GET', '/api/v1/users?limit=5')).status, 401)
    assert.equal((await call(admin, 'POST', `/api/v1/users/${(await call(admin, 'GET', '/api/v1/users?limit=100')).body.users.find((u) => u.username === 'tenant.admin').id}/reset-password`)).status, 409, 'not your own')
    await login('field.user', 'Field-User-Own-2', 401)

    const forced = await login('field.user', 'Workspace-Default-1')
    assert.equal(forced.user.mustChangePassword, true)
    const sessionInfo = await tenantApp.inject({ method: 'GET', url: '/api/v1/auth/session', headers: tenantHeaders({ cookie: forced.cookie }) })
    assert.equal(JSON.parse(sessionInfo.payload).user.mustChangePassword, true)
    const denied = await call(forced, 'GET', '/api/v1/users?limit=5')
    assert.equal(denied.status, 403)
    assert.equal(denied.body.code, 'PASSWORD_CHANGE_REQUIRED')
    const moduleCall = await call(forced, 'GET', `/api/v1/managers/${forced.user.id}/delegations`)
    assert.equal(moduleCall.status, 403, 'module routes are blocked too')
    assert.equal(moduleCall.body.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal((await call(admin, 'GET', '/api/v1/users?limit=100')).body.users.find((u) => u.username === 'field.user').passwordChangeRequired, true)
    assert.equal((await call(forced, 'POST', '/api/v1/auth/password', { currentPassword: 'Workspace-Default-1', newPassword: 'Field-User-Own-3' })).status, 200)
    assert.equal((await call(forced, 'GET', '/api/v1/setup')).status, 200, 'unlocked after the change')
    const directory = await call(forced, 'GET', '/api/v1/users?limit=5')
    assert.equal(directory.status, 403, 'regular users cannot list all users')
    assert.notEqual(directory.body.code, 'PASSWORD_CHANGE_REQUIRED')

    // New users can be given the default; blank CSV passwords use it too.
    const added = await call(admin, 'POST', '/api/v1/users', { displayName: 'Default User', username: 'default.user', role: 'tenant_member', useDefaultPassword: true })
    assert.equal(added.status, 200, added.body.message)
    assert.equal((await login('default.user', 'Workspace-Default-1')).user.mustChangePassword, true)
    const imported = await call(admin, 'POST', '/api/v1/users/import', { rows: [{ displayName: 'Csv Default', username: 'csv.default', kind: 'user' }] })
    assert.equal(imported.body.results[0].status, 'created', imported.body.results[0].message)
    assert.equal((await login('csv.default', 'Workspace-Default-1')).user.mustChangePassword, true)
  })

  test('shared app host: company sign-in reveals nothing, remembers the company until sign-out', async () => {
    const appHost = `app.${rootDomain}`
    // A new client address per request keeps this test under the per-IP rate limit, so the
    // per-company lockout is what is exercised.
    let ip = 0
    const appHeaders = (extra = {}) => ({ host: appHost, origin: `https://${appHost}`, 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}`, ...extra })
    const cookieOf = (response, suffix) => response.cookies.find((c) => c.name.endsWith(suffix))
    const signIn = (body, cookies = '') =>
      tenantApp.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: appHeaders({ 'content-type': 'application/json', ...(cookies ? { cookie: cookies } : {}) }),
        payload: JSON.stringify({ turnstileToken: 'x'.repeat(24), ...body }),
      })

    const fresh = JSON.parse((await tenantApp.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: appHeaders() })).payload)
    assert.deepEqual([fresh.app?.company, fresh.tenant], [null, null], 'no company until someone signs in')
    assert.equal((await tenantApp.inject({ method: 'GET', url: '/api/v1/users', headers: appHeaders() })).statusCode, 401)

    // Unknown company, unknown user and wrong password: one indistinguishable answer.
    const answers = []
    for (const body of [
      { company: 'no-such-company-zz', username: 'tenant.admin', password: 'Changed-Admin-Pass-2026' },
      { company: subdomain, username: 'nobody.here', password: 'Changed-Admin-Pass-2026' },
      { company: subdomain, username: 'tenant.admin', password: 'definitely-wrong-1' },
    ]) {
      const r = await signIn(body)
      answers.push([r.statusCode, JSON.parse(r.payload).message, !!cookieOf(r, 'tenant_company')])
    }
    assert.deepEqual(answers, Array(3).fill([401, 'Invalid company, username or password.', false]))

    for (const company of [subdomain, `${subdomain}.${rootDomain}`, 'Onboarding Test Tenant']) {
      const ok = await signIn({ company, username: 'tenant.admin', password: 'Changed-Admin-Pass-2026' })
      assert.equal(ok.statusCode, 200, `${company}: ${ok.payload}`)
    }
    const ok = await signIn({ company: subdomain.toUpperCase(), username: 'tenant.admin', password: 'Changed-Admin-Pass-2026' })
    const session = cookieOf(ok, 'tenant_session')
    const remembered = cookieOf(ok, 'tenant_company')
    assert.ok(session && remembered, 'session and remembered company are set')
    const both = `${session.name}=${session.value}; ${remembered.name}=${remembered.value}`
    const users = await tenantApp.inject({ method: 'GET', url: '/api/v1/users?limit=5', headers: appHeaders({ cookie: both }) })
    assert.equal(users.statusCode, 200, 'requests on the shared host reach the remembered company')
    const known = JSON.parse((await tenantApp.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: appHeaders({ cookie: both }) })).payload)
    assert.equal(known.app.company, 'Onboarding Test Tenant')
    assert.equal(known.tenant.tenantId, tenantKey)

    // Session gone, company remembered: no company needed.
    const again = await signIn({ username: 'tenant.admin', password: 'Changed-Admin-Pass-2026' }, `${remembered.name}=${remembered.value}`)
    assert.equal(again.statusCode, 200, again.payload)

    // A hand-made company cookie is ignored.
    const forged = JSON.parse((await tenantApp.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: appHeaders({ cookie: `${remembered.name}=${tenantKey}.forged` }) })).payload)
    assert.equal(forged.tenant, null)

    // Manual sign-out forgets the company.
    const csrf = JSON.parse(ok.payload).csrfToken
    const out = await tenantApp.inject({ method: 'POST', url: '/api/auth/logout', headers: appHeaders({ cookie: both, 'x-csrf-token': csrf }) })
    assert.equal(out.statusCode, 200)
    const cleared = cookieOf(out, 'tenant_company')
    assert.ok(cleared && (cleared.value === '' || cleared.maxAge === 0 || (cleared.expires && cleared.expires.getTime() < Date.now())), 'company cookie cleared')

    // Lockout looks the same for a real and a made-up company.
    const lockout = async (company) => {
      let last
      for (let i = 0; i < 11; i++) last = await signIn({ company, username: 'lockout.probe', password: 'wrong-password-1' }, '')
      return [last.statusCode, JSON.parse(last.payload).message]
    }
    assert.deepEqual(await lockout(subdomain), await lockout('made-up-company-zz'))
  })
})
