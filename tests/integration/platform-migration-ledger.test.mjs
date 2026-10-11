import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// A fresh install must checksum every platform migration, including the ones
// that ran before migration 023 added the checksum column to the ledger.

const rootDirectory = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const migrateScript = path.join(rootDirectory, 'scripts/platform-migrate.mjs')

function runMigrate(databaseUrl, flag) {
  return spawnSync(process.execPath, [migrateScript, flag], {
    cwd: rootDirectory,
    env: { ...process.env, DATABASE_ADMIN_URL: databaseUrl },
    encoding: 'utf8',
  })
}

describe('Integration: Platform migration ledger', () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required for platform migration ledger tests')

  test('fresh database: --apply records a checksum for every migration and --verify passes', async () => {
    const database = `ledger_fresh_${crypto.randomBytes(4).toString('hex')}`
    const adminUrl = new URL(process.env.TEST_DATABASE_URL)
    const freshUrl = new URL(adminUrl)
    freshUrl.pathname = `/${database}`

    const admin = new pg.Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`create database ${database}`)
    try {
      const applied = runMigrate(freshUrl.toString(), '--apply')
      assert.equal(applied.status, 0, applied.stderr)

      const verified = runMigrate(freshUrl.toString(), '--verify')
      assert.equal(verified.status, 0, verified.stderr)
      assert.doesNotMatch(verified.stderr, /no recorded checksum/)

      const manifest = JSON.parse(await readFile(path.join(rootDirectory, 'database/migrations/manifest.json'), 'utf8'))
      const fresh = new pg.Client({ connectionString: freshUrl.toString() })
      await fresh.connect()
      try {
        const ledger = await fresh.query(
          `select count(*)::int as total, count(*) filter (where checksum is null)::int as unrecorded
             from platform.schema_migration`,
        )
        assert.equal(ledger.rows[0].total, manifest.migrations.length)
        assert.equal(ledger.rows[0].unrecorded, 0)
      } finally {
        await fresh.end()
      }
    } finally {
      await admin.query(`drop database if exists ${database} with (force)`)
      await admin.end()
    }
  })
})
