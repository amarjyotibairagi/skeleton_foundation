import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { chromium } from 'playwright'

// Drives the built platform console in a real browser against the platform BFF:
// every page renders for an owner, a tenant is created, managed, suspended and
// removed through the UI, the viewer role only sees what it may open, and the
// layout holds at phone width. Point PLATFORM_STATIC_ROOT at a preview build to
// test it before deploying; by default the console's own dist is used.

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-platform-console-'))
process.env.TENANT_CREDENTIALS_DIR = path.join(tempDir, 'credentials')
process.env.TENANT_PGBOUNCER_AUTH_FILE = path.join(tempDir, 'tenant-users.txt')
fs.mkdirSync(process.env.TENANT_CREDENTIALS_DIR, { recursive: true })
fs.writeFileSync(process.env.TENANT_PGBOUNCER_AUTH_FILE, '')
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'
const dbUrl = new URL(process.env.DATABASE_URL)
process.env.TENANT_PGBOUNCER_HOST = dbUrl.hostname
process.env.TENANT_PGBOUNCER_PORT = dbUrl.port || '5432'
process.env.SERVE_PLATFORM_STATIC = 'true'
process.env.PLATFORM_STATIC_ROOT ||= path.resolve('frontend/platform/dist')
const staticReady = fs.existsSync(path.join(process.env.PLATFORM_STATIC_ROOT, 'index.html'))

const { createServer: createPlatformServer } = await import('../../backend/dist/server.js')
const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')

const HOST = new URL(process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test').host
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

describe('Integration: platform console in a browser', { skip: !staticReady && 'no platform console build' }, () => {
  let platform
  let pool
  let worker
  let timer
  const sessionHashes = []
  let viewerId
  const subdomain = `zzconsole${crypto.randomBytes(3).toString('hex')}`

  async function seedSession(userId, { verified = true } = {}) {
    const token = crypto.randomBytes(32).toString('base64url')
    sessionHashes.push(sha256(token))
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '30 minutes', case when $4 then now() end)`,
      [userId, sha256(token), sha256(crypto.randomBytes(16).toString('hex')), verified],
    )
    return token
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL })
    platform = await createPlatformServer()
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    timer = setInterval(() => worker.tick().catch((error) => console.error('[platform-console] worker tick failed', error)), 250)
  })

  after(async () => {
    clearInterval(timer)
    await pool.query('delete from platform.platform_session where token_hash = any($1)', [sessionHashes]).catch(() => undefined)
    if (viewerId) await pool.query('delete from platform.platform_user where id = $1', [viewerId]).catch(() => undefined)
    await platform?.close()
    await pool?.end()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  async function openBrowser(token, viewport) {
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: '__Host-platform_session', value: token, domain: HOST, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }])
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      // Cloudflare is not configured in the test cluster; its 5xx answers are expected.
      if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text())
    })
    // Third-party scripts and fonts stay offline; everything else goes to the BFF.
    await context.route(/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|challenges\.cloudflare\.com)\//, (route) => route.abort())
    await context.route(`https://${HOST}/**`, async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const response = await platform.inject({
        method: request.method(),
        url: url.pathname + url.search,
        headers: { ...request.headers(), host: HOST },
        ...(request.postDataBuffer() ? { payload: request.postDataBuffer() } : {}),
      })
      const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => [key, String(value)]))
      await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload })
    })
    return { browser, page, errors }
  }

  const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true })
  const noOverflow = async (page, label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(overflow, false, `${label}: no horizontal page overflow`)
  }

  test('owner: every page, and a tenant created, managed and removed through the UI', async () => {
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    assert.ok(owner, 'a seeded platform owner is required')
    const { browser, page, errors } = await openBrowser(await seedSession(owner.id), { width: 1440, height: 960 })
    try {
      await page.goto(`https://${HOST}/`)
      await heading(page, 'Dashboard').waitFor()
      await page.getByRole('heading', { name: 'Needs attention' }).waitFor()
      await page.getByText('Active tenants').waitFor()
      await noOverflow(page, 'dashboard')

      // Sidebar navigation, breadcrumb and browser history.
      await page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: /^Tenants/ }).click()
      await heading(page, 'Tenants').waitFor()
      assert.equal(await page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Tenants').count(), 1)
      await page.goBack()
      await heading(page, 'Dashboard').waitFor()
      await page.goForward()
      await heading(page, 'Tenants').waitFor()

      // Create a tenant; the subdomain is suggested from the name.
      await page.getByRole('link', { name: 'New tenant' }).first().click()
      await heading(page, 'New tenant').waitFor()
      await page.getByLabel('Display name').fill('Console Test Co')
      assert.equal(await page.getByLabel('Subdomain').inputValue(), 'console-test-co')
      await page.getByLabel('Subdomain').fill(subdomain)
      await page.getByRole('textbox', { name: /^Full name/ }).fill('Casey Console')
      await page.getByRole('textbox', { name: /^Username/ }).fill('casey')
      await page.getByLabel('Initial password').fill('Console-Test-2026')
      await page.getByLabel('Confirm password').fill('Console-Test-2026')
      await page.getByRole('button', { name: 'Create tenant' }).click()
      await page.getByRole('heading', { level: 1, name: 'Console Test Co is ready' }).waitFor({ timeout: 90_000 })
      await page.getByText('Administrator login').waitFor()

      // Manage it: every tab renders, and the profile saves.
      await page.getByRole('link', { name: 'Manage this tenant' }).click()
      await heading(page, 'Console Test Co').waitFor()
      const tabs = [
        ['Profile & branding', 'Save profile'],
        ['Plan & modules', 'Assign plan'],
        ['Administrator access', 'Issue invitation'],
        ['Storage & data', 'Test connection|Connect S3-compatible bucket'],
        ['Configuration', 'Only values set here'],
        ['Jobs', 'Provisioning and maintenance jobs'],
        ['Overview', 'Database schema'],
      ]
      for (const [tab, marker] of tabs) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.getByText(new RegExp(marker)).first().waitFor()
      }
      await page.getByRole('tab', { name: 'Profile & branding', exact: true }).click()
      await page.getByLabel('Legal name').fill('Console Test Company Limited')
      await page.getByRole('button', { name: 'Save profile' }).click()
      await page.getByText('Profile saved.').waitFor()

      // Suspend through the confirmation dialog.
      await page.getByRole('button', { name: 'Suspend', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Suspend tenant' }).click()
      await page.getByText('Console Test Co suspended.').waitFor()
      await page.locator('.page-title-row .badge', { hasText: 'Suspended' }).waitFor()

      // Removal needs the subdomain typed before it can be confirmed.
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      const confirmRemove = dialog.getByRole('button', { name: 'Remove permanently' })
      assert.equal(await confirmRemove.isDisabled(), true, 'removal stays disabled until the subdomain is typed')
      await dialog.getByRole('textbox').fill(subdomain)
      await confirmRemove.click()
      await page.getByText(/Removing Console Test Co/).waitFor()

      // Every other page renders with its own heading.
      const pages = [
        ['individuals', 'Individuals'],
        ['plans', 'Plans'],
        ['domains', 'Domains'],
        ['fleet', 'Fleet & schema'],
        ['server', 'Server'],
        ['server/services', 'Server'],
        ['configuration', 'Configuration'],
        ['operators', 'Operators'],
        ['audit', 'Audit log'],
        ['security', 'My security'],
      ]
      for (const [route, title] of pages) {
        await page.goto(`https://${HOST}/#/${route}`)
        await heading(page, title).waitFor()
        if (route === 'server/services') await page.getByText('Listening services').waitFor()
        if (route === 'server') await page.getByRole('meter', { name: 'Load, last minute' }).waitFor()
        await noOverflow(page, route)
      }
      await page.goto(`https://${HOST}/#/audit`)
      await page.getByText('tenant', { exact: false }).first().waitFor()
      await page.goto(`https://${HOST}/#/nowhere`)
      await page.getByText('Page not found').waitFor()

      // Appearance and account menus.
      await page.getByRole('button', { name: 'Appearance' }).click()
      await page.getByRole('menuitemradio', { name: 'Dark' }).click()
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
      await page.getByRole('button', { name: 'Account' }).click()
      await page.getByRole('menuitem', { name: 'Password & security keys' }).click()
      await heading(page, 'My security').waitFor()

      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })

  test('phone width: navigation drawer and pages fit the screen', async () => {
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    const { browser, page, errors } = await openBrowser(await seedSession(owner.id), { width: 390, height: 844 })
    try {
      await page.goto(`https://${HOST}/`)
      await heading(page, 'Dashboard').waitFor()
      await noOverflow(page, 'phone dashboard')
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await page.getByRole('navigation', { name: 'Platform navigation' }).getByRole('link', { name: /^Server/ }).click()
      await heading(page, 'Server').waitFor()
      // The drawer slides away once the new page is open.
      const deadline = Date.now() + 3000
      let right = Infinity
      while (Date.now() < deadline && right > 1) {
        right = await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().right)
        if (right > 1) await page.waitForTimeout(100)
      }
      assert.ok(right <= 1, 'the drawer closes after navigating')
      for (const route of ['tenants', 'tenants/new', 'domains', 'audit']) {
        await page.goto(`https://${HOST}/#/${route}`)
        await page.locator('h1').first().waitFor()
        await noOverflow(page, `phone ${route}`)
      }
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })

  test('without a recent security-key check, server data asks for one instead of failing', async () => {
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    const { browser, page, errors } = await openBrowser(await seedSession(owner.id, { verified: false }), { width: 1440, height: 960 })
    try {
      await page.goto(`https://${HOST}/`)
      await heading(page, 'Dashboard').waitFor()
      await page.getByRole('button', { name: 'Verify with security key' }).waitFor()
      await page.getByText('Services need a security-key check').waitFor()
      await page.goto(`https://${HOST}/#/server/services`)
      await heading(page, 'Server').waitFor()
      await page.getByRole('button', { name: 'Verify with security key' }).waitFor()
      assert.equal(await page.getByText(/requires recent step-up/).count(), 0, 'the raw server message is never shown')
      assert.equal(await page.getByText('No listening services found.').count(), 0, 'no misleading empty table')

      // A (virtual) security key completes the check and the data loads.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      })
      await page.getByRole('button', { name: 'Verify with security key' }).click()
      await page.getByText('Listening services').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Verify with security key' }).count(), 0, 'the prompt goes away once verified')
      await page.getByRole('tab', { name: 'Resources' }).click()
      await page.getByRole('meter', { name: 'Load, last minute' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })

  test('viewer: only read-only pages are offered', async () => {
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    const ownerToken = await seedSession(owner.id)
    const csrf = 'platform-console-csrf'
    await pool.query('update platform.platform_session set csrf_hash = $1 where token_hash = $2', [sha256(csrf), sha256(ownerToken)])
    const username = `zzviewer${crypto.randomBytes(3).toString('hex')}`
    const invited = await platform.inject({
      method: 'POST',
      url: '/api/platform/users',
      headers: { cookie: `__Host-platform_session=${ownerToken}`, 'x-csrf-token': csrf, origin: `https://${HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ username, displayName: 'Viewer Test', email: '', role: 'platform_viewer' }),
    })
    assert.equal(invited.statusCode, 201, invited.payload)
    const link = JSON.parse(invited.payload).invitation.link
    const accepted = await platform.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      headers: { origin: `https://${HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ token: decodeURIComponent(new URL(link).hash.replace(/^#token=/, '')), password: `Viewer-${crypto.randomBytes(12).toString('hex')}` }),
    })
    assert.equal(accepted.statusCode, 200, accepted.payload)
    viewerId = (await pool.query('select id::text from platform.platform_user where username = $1', [username])).rows[0].id

    const { browser, page, errors } = await openBrowser(await seedSession(viewerId), { width: 1280, height: 900 })
    try {
      await page.goto(`https://${HOST}/`)
      await heading(page, 'Dashboard').waitFor()
      await page.getByText('You have read-only access.').waitFor()
      const nav = page.getByRole('navigation', { name: 'Platform navigation' })
      assert.equal(await nav.getByRole('link', { name: /^Tenants/ }).count(), 0, 'no tenants link for viewers')
      assert.equal(await nav.getByRole('link', { name: 'Operators' }).count(), 0, 'no operators link for viewers')
      await nav.getByRole('link', { name: 'Plans' }).waitFor()
      await page.goto(`https://${HOST}/#/tenants`)
      await page.getByText('Not available for your role').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
    }
  })
})
