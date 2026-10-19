import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import Fastify from 'fastify'
import { createFileService } from '../../backend/tenant/dist/modules/files.js'

test('chunked uploads are authenticated before parsing and limited by actual bytes', async () => {
  const app = Fastify({ bodyLimit: 65536 })
  let authenticated = false, parsedBytes = 0
  app.addHook('preValidation', async (request) => { parsedBytes = Buffer.isBuffer(request.body) ? request.body.length : 0 })
  const kit = {
    config: async () => ({ values: { 'limit.storage.max_file_mb': 1 } }),
    requireSession: async (_request, reply) => authenticated ? { userId: 'test-only' } : (reply.code(401).send({ success: false }), null),
    requirePermission: async () => true,
    requireCsrf: () => true,
  }
  await createFileService({}).module.register(app, kit)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const upload = () => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: app.server.address().port, method: 'POST', path: '/api/v1/files', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    request.on('error', reject)
    for (let i = 0; i < 32; i++) request.write(Buffer.alloc(65536))
    request.end()
  })
  try {
    assert.equal(await upload(), 401)
    assert.equal(parsedBytes, 0, 'unauthenticated body must not reach the parser')
    authenticated = true
    assert.equal(await upload(), 413)
    assert.equal(parsedBytes, 0, 'oversized body must fail before preValidation')
  } finally { await app.close() }
})
