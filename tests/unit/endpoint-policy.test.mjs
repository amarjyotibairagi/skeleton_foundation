import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, resolveAllowedAddress } from '../../dependency/platform/ServerKit/dist/network.js'
import { externalPostgresConfig } from '../../dependency/platform/ServerKit/dist/integrations.js'

test('equivalent IPv6 spellings cannot bypass the public endpoint boundary', async () => {
  const denied = ['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'fc00::1', 'fe80::1%eth0', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']
  const policy = { allowPrivateEndpoints: false, allowInsecureTransport: false }
  for (const address of denied) {
    assert.equal(isPrivateAddress(address), true, address)
    await assert.rejects(resolveAllowedAddress(address, policy), /Private endpoints/)
  }
  for (const address of ['8.8.8.8', '::ffff:808:808', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address)
    assert.ok(await resolveAllowedAddress(address, policy))
  }
})

test('production endpoint policy rejects unauthenticated database TLS', async () => {
  const settings = { host: '8.8.8.8', port: 5432, database: 'test', schema: 'app', sslMode: 'require' }
  const credentials = { user: 'test', password: 'test-only' }
  const policy = { allowPrivateEndpoints: false, allowInsecureTransport: false }
  await assert.rejects(externalPostgresConfig(settings, credentials, policy, 'test'), /certificate verification/)
  const config = await externalPostgresConfig({ ...settings, sslMode: 'verify-full' }, credentials, policy, 'test')
  assert.equal(config.ssl.rejectUnauthorized, true)
})
