import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import argon2 from 'argon2'
import pg from 'pg'
import { chromium } from 'playwright'
import { createServer } from '../../backend/dist/server.js'

// Real browser-generated, cryptographically verified ceremonies: the old suite
// rejected fake credentials but did not test key-management authorization.
test('additional MFA keys need an existing factor and challenges belong to their session', async () => {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.ok(process.env.TEST_DATABASE_URL)
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL })
  const username = `key.lifecycle.${crypto.randomBytes(6).toString('hex')}`
  const password = 'isolated-key-lifecycle-password'
  const origin = process.env.PLATFORM_PUBLIC_ORIGIN
  let app, browser, userId
  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 })
    userId = (await admin.query("insert into platform.platform_user(username,password_hash,role,is_active) values($1,$2,'platform_owner',true) returning id", [username, hash])).rows[0].id
    app = await createServer()
    browser = await chromium.launch({ headless: true })
    const login = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password, turnstileToken: 'test-only-turnstile-token-with-valid-length' } })
      assert.equal(response.statusCode, 200, response.payload)
      const cookie = response.cookies.find((c) => c.name.includes('platform_session'))
      return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': response.json().csrfToken }
    }
    const call = (session, url, payload) => app.inject({ method: 'POST', url, headers: session, ...(payload ? { payload } : {}) })
    const authenticator = async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Isolated key test</title>' }))
      await page.goto(origin)
      const cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })
      return page
    }
    const create = (page, options) => page.evaluate(async (options) => (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) })).toJSON(), options)
    const sessionA = await login(), sessionB = await login()
    await admin.query("update platform.platform_session set created_at=now()-interval '6 minutes' where user_id=$1", [userId])
    const expired = await call(sessionA, '/api/auth/mfa/registration/options')
    assert.equal(expired.statusCode, 403)
    assert.equal(expired.json().code, 'MFA_REAUTH_REQUIRED')
    await admin.query('update platform.platform_session set created_at=now() where user_id=$1', [userId])
    const pageA = await authenticator()
    const options = await call(sessionA, '/api/auth/mfa/registration/options')
    assert.equal(options.statusCode, 200)
    const registration = { challengeId: options.json().challengeId, response: await create(pageA, options.json().options) }
    assert.equal((await call(sessionB, '/api/auth/mfa/registration/verify', registration)).statusCode, 400, 'registration cannot move between sessions')
    assert.equal((await call(sessionA, '/api/auth/mfa/registration/verify', registration)).statusCode, 200)
    assert.equal((await call(sessionB, '/api/auth/mfa/registration/options')).statusCode, 403, 'a password alone cannot add a second key')
    assert.equal((await call(sessionB, '/api/auth/mfa/registration/verify', registration)).statusCode, 403, 'consumption also rechecks key-management authorization')
    const optionsB = await call(sessionB, '/api/auth/mfa/assertion/options')
    assert.equal(optionsB.statusCode, 200)
    const assertion = await pageA.evaluate(async (options) => (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) })).toJSON(), optionsB.json().options)
    const verify = { challengeId: optionsB.json().challengeId, response: assertion }
    assert.equal((await call(sessionA, '/api/auth/mfa/assertion/verify', verify)).statusCode, 400, 'authentication cannot move between sessions')
    assert.equal((await call(sessionB, '/api/auth/mfa/assertion/verify', verify)).statusCode, 200)
    assert.equal((await call(sessionB, '/api/auth/mfa/assertion/verify', verify)).statusCode, 400, 'challenges are single use')
    const second = await call(sessionB, '/api/auth/mfa/registration/options')
    assert.equal(second.statusCode, 200, 'an existing factor authorizes adding another key')
    const pageB = await authenticator()
    const response = await create(pageB, second.json().options)
    assert.equal((await call(sessionB, '/api/auth/mfa/registration/verify', { challengeId: second.json().challengeId, response })).statusCode, 200)
    assert.equal((await admin.query('select count(*)::int as n from platform.platform_webauthn_credential where user_id=$1', [userId])).rows[0].n, 2)
  } finally {
    await browser?.close()
    await app?.close()
    if (userId) await admin.query('delete from platform.platform_user where id=$1', [userId])
    await admin.end()
  }
})
