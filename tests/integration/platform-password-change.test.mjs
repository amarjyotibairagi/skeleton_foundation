import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import argon2 from 'argon2'
import pg from 'pg'

// An operator changes their own password: the current password is required,
// the operator floor applies, step-up is enforced, the stored hash changes,
// and every other session of that operator ends while this one survives.

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')

const { createServer } = await import('../../backend/dist/server.js')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
const csrf = 'password-change-csrf'

describe('Integration: operator password change', () => {
  let app
  let pool
  let userId
  const username = `zzpw${crypto.randomBytes(4).toString('hex')}`
  const oldPassword = 'old-operator-password-1'
  const newPassword = 'new-operator-password-22'
  const sessions = {}

  async function mintSession(name, mfaRecent) {
    const token = crypto.randomBytes(32).toString('base64url')
    const row = (await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '15 minutes', ${mfaRecent ? 'now()' : 'null'}) returning id::text`,
      [userId, sha256(token), sha256(csrf)],
    )).rows[0]
    sessions[name] = { id: row.id, cookie: `__Host-platform_session=${token}` }
  }

  const change = (session, payload) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: session.cookie, 'x-csrf-token': csrf, origin, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL })
    const hash = await argon2.hash(oldPassword, { type: argon2.argon2id })
    userId = (await pool.query(
      `insert into platform.platform_user (username, password_hash, role, display_name) values ($1, $2, 'platform_viewer', 'Password Test') returning id::text`,
      [username, hash],
    )).rows[0].id
    await mintSession('current', true)
    await mintSession('other', true)
    await mintSession('stale', false)
    app = await createServer()
  })

  after(async () => {
    await pool.query('delete from platform.platform_user where id = $1', [userId]).catch(() => undefined)
    if (app) await app.close()
    if (pool) await pool.end()
  })

  test('rejects without step-up, with a wrong current password, or a short new one', async () => {
    const stale = await change(sessions.stale, { currentPassword: oldPassword, newPassword })
    assert.equal(stale.statusCode, 403)
    assert.equal(JSON.parse(stale.payload).code, 'MFA_STEP_UP_REQUIRED')
    const wrong = await change(sessions.current, { currentPassword: 'not-the-password', newPassword })
    assert.equal(wrong.statusCode, 400)
    const short = await change(sessions.current, { currentPassword: oldPassword, newPassword: 'short-pass' })
    assert.equal(short.statusCode, 400)
    const same = await change(sessions.current, { currentPassword: oldPassword, newPassword: oldPassword })
    assert.equal(same.statusCode, 400)
  })

  test('changes the hash and ends only the other sessions', async () => {
    const response = await change(sessions.current, { currentPassword: oldPassword, newPassword })
    assert.equal(response.statusCode, 200, JSON.parse(response.payload).message)
    const stored = (await pool.query('select password_hash from platform.platform_user where id = $1', [userId])).rows[0].password_hash
    assert.ok(await argon2.verify(stored, newPassword))
    assert.equal(await argon2.verify(stored, oldPassword), false)
    const remaining = (await pool.query('select id::text from platform.platform_session where user_id = $1', [userId])).rows.map((row) => row.id)
    assert.deepEqual(remaining, [sessions.current.id])
    const audited = await pool.query(
      `select 1 from platform.platform_audit where user_id = $1 and action = 'operator_password_changed'`,
      [userId],
    )
    assert.equal(audited.rowCount, 1)
  })
})
