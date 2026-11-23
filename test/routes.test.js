import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBridgeServer, resolveOptions } from '../src/index.js'

const TOKEN = 'test-token'
const SESSION = 'session-00000000-0000-0000-0000-000000000000'

function stubController(overrides = {}) {
  const calls = []
  return {
    calls,
    create: async (payload) => { calls.push(['create', payload]); return { sessionId: SESSION, agentPreset: 'standard' } },
    rename: async (payload) => { calls.push(['rename', payload]); return { title: payload.title, seq: 7 } },
    list: async () => ({ items: [{ sessionId: SESSION }] }),
    inspect: async (sessionId) => { calls.push(['inspect', sessionId]); return { events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } },
    prompt: async (payload) => { calls.push(['prompt', payload]); return { accepted: true } },
    ...overrides,
  }
}

async function start(options = {}) {
  const controller = options.controller ?? stubController()
  const audits = []
  const server = createBridgeServer(controller, TOKEN, {
    ...options,
    onAudit: (entry) => audits.push(entry),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    controller,
    audits,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(done)),
  }
}

function call(base, path, init = {}) {
  return fetch(`${base}${path}`, init)
}

function post(base, path, body, headers = {}) {
  return call(base, path, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function rawRequest(port, { method = 'GET', path = '/v1/sessions', headers = {} } = {}) {
  return new Promise((done, failed) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => done({ status: res.statusCode, body }))
    })
    req.on('error', failed)
    req.end()
  })
}

test('rejects a request without the bearer token', async () => {
  const s = await start()
  try {
    assert.equal((await call(s.base, '/v1/sessions')).status, 401)
  } finally { await s.close() }
})

test('rejects a request that carries a browser Origin', async () => {
  const s = await start()
  try {
    const response = await call(s.base, '/v1/sessions', {
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://example.com' },
    })
    assert.equal(response.status, 403)
  } finally { await s.close() }
})

test('rejects a spoofed Host header (DNS rebinding)', async () => {
  const s = await start()
  try {
    const response = await rawRequest(s.port, {
      headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 403)
  } finally { await s.close() }
})

test('lists sessions with the token', async () => {
  const s = await start()
  try {
    const response = await call(s.base, '/v1/sessions', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).items, [{ sessionId: SESSION }])
  } finally { await s.close() }
})

test('creates a session in an existing directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-cwd-'))
  const s = await start()
  try {
    const response = await post(s.base, '/v1/sessions', { cwd: directory })
    assert.equal(response.status, 201)
    assert.equal((await response.json()).sessionId, SESSION)
    assert.deepEqual(s.controller.calls, [['create', { cwd: resolve(directory) }]])
  } finally { await s.close(); await rm(directory, { recursive: true, force: true }) }
})

test('applies a requested title through rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-cwd-'))
  const s = await start()
  try {
    const response = await post(s.base, '/v1/sessions', { cwd: directory, title: 'Bridge smoke' })
    assert.equal(response.status, 201)
    assert.deepEqual(s.controller.calls.at(-1), ['rename', { sessionId: SESSION, title: 'Bridge smoke' }])
    assert.equal((await response.json()).warning, undefined)
  } finally { await s.close(); await rm(directory, { recursive: true, force: true }) }
})

test('still answers 201 with a warning when the title cannot be set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-cwd-'))
  const controller = stubController({ rename: async () => { throw new Error('no session-title service') } })
  const s = await start({ controller })
  try {
    const response = await post(s.base, '/v1/sessions', { cwd: directory, title: 'Bridge smoke' })
    assert.equal(response.status, 201)
    assert.match((await response.json()).warning, /title could not be set/)
  } finally { await s.close(); await rm(directory, { recursive: true, force: true }) }
})

test('rejects a create request without a usable cwd', async () => {
  const s = await start()
  try {
    assert.equal((await post(s.base, '/v1/sessions', {})).status, 400)
    assert.equal((await post(s.base, '/v1/sessions', { cwd: '   ' })).status, 400)
    assert.equal((await post(s.base, '/v1/sessions', { cwd: 'x'.repeat(4096) })).status, 400)
    const missing = join(tmpdir(), `dsh-bridge-missing-${Date.now()}`)
    assert.equal((await post(s.base, '/v1/sessions', { cwd: missing })).status, 400)
    assert.equal(s.controller.calls.length, 0)
  } finally { await s.close() }
})

test('enforces the cwd allowlist', async () => {
  const allowed = await mkdtemp(join(tmpdir(), 'dsh-bridge-allowed-'))
  const denied = await mkdtemp(join(tmpdir(), 'dsh-bridge-denied-'))
  const s = await start({ cwdAllowlist: [resolve(allowed)] })
  try {
    assert.equal((await post(s.base, '/v1/sessions', { cwd: allowed })).status, 201)
    assert.equal((await post(s.base, '/v1/sessions', { cwd: denied })).status, 403)
    assert.equal((await post(s.base, '/v1/sessions', { cwd: join(allowed, 'nested') })).status, 400)
  } finally { await s.close(); await rm(allowed, { recursive: true, force: true }); await rm(denied, { recursive: true, force: true }) }
})

test('refuses to create when the feature is switched off', async () => {
  const s = await start({ allowCreate: false })
  try {
    const response = await post(s.base, '/v1/sessions', { cwd: tmpdir() })
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /disabled/)
  } finally { await s.close() }
})

test('requires a JSON content type for writes', async () => {
  const s = await start()
  try {
    const response = await call(s.base, `/v1/sessions/${SESSION}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
      body: 'hello',
    })
    assert.equal(response.status, 415)
  } finally { await s.close() }
})

test('bounds and forwards a message', async () => {
  const s = await start()
  try {
    assert.equal((await post(s.base, `/v1/sessions/${SESSION}/messages`, { text: '  ' })).status, 400)
    assert.equal((await post(s.base, `/v1/sessions/${SESSION}/messages`, { text: 'x'.repeat(4097) })).status, 400)
    const ok = await post(s.base, `/v1/sessions/${SESSION}/messages`, { text: 'ping' })
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.equal(body.accepted, true)
    assert.match(body.requestId, /^[0-9a-f-]{36}$/)
    const [, payload] = s.controller.calls.at(-1)
    assert.equal(payload.sessionId, SESSION)
    assert.deepEqual(payload.content, [{ type: 'text', text: 'ping' }])
    assert.equal(payload.mode, 'queue')
  } finally { await s.close() }
})

test('bounds the events read and honours the limit', async () => {
  const s = await start()
  try {
    assert.equal((await call(s.base, `/v1/sessions/${SESSION}/events?limit=0`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400)
    assert.equal((await call(s.base, `/v1/sessions/${SESSION}/events?limit=101`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 400)
    const response = await call(s.base, `/v1/sessions/${SESSION}/events?limit=2`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).events, [{ seq: 2 }, { seq: 3 }])
    assert.deepEqual(s.controller.calls.at(-1), ['inspect', SESSION], 'older hosts keep using inspect')
  } finally { await s.close() }
})

test('reads events through the current events API when the host provides it', async () => {
  const calls = []
  const controller = stubController({
    inspect: async () => { throw new Error('legacy inspect must not be used when events exists') },
    events: async (payload) => {
      calls.push(payload)
      return {
        records: [
          { type: 'event', event: { seq: 1, type: 'one' } },
          { type: 'event', event: { seq: 2, type: 'two' } },
          { type: 'event', event: { seq: 3, type: 'three' } },
        ],
        hasMore: false,
        cursor: 3,
      }
    },
  })
  const s = await start({ controller })
  try {
    const response = await call(s.base, `/v1/sessions/${SESSION}/events?limit=2`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).events, [{ seq: 2, type: 'two' }, { seq: 3, type: 'three' }])
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: SESSION }, maxMessages: 2 }])
  } finally { await s.close() }
})

test('answers unknown routes with 404 and unknown verbs with 405', async () => {
  const s = await start()
  try {
    const headers = { authorization: `Bearer ${TOKEN}` }
    assert.equal((await call(s.base, '/v1/other', { headers })).status, 404)
    assert.equal((await call(s.base, '/v1/sessions/not-a-session/events', { headers })).status, 404)
    assert.equal((await call(s.base, `/v1/sessions/${SESSION}/events`, { method: 'PUT', headers })).status, 405)
  } finally { await s.close() }
})

test('maps a missing session to 404 and hides internal failures', async () => {
  const missing = stubController({ inspect: async () => { const error = new Error('gone'); error.code = 'session/not-found'; throw error } })
  const s1 = await start({ controller: missing })
  try {
    const response = await call(s1.base, `/v1/sessions/${SESSION}/events`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.status, 404)
  } finally { await s1.close() }

  const broken = stubController({ list: async () => { throw new Error('secret detail: C:\\private\\path') } })
  const s2 = await start({ controller: broken })
  try {
    const response = await call(s2.base, '/v1/sessions', { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error, 'DSH request failed')
    assert.equal(JSON.stringify(s2.audits.at(-1)).includes('private'), true, 'the detail stays in the local audit trail')
  } finally { await s2.close() }
})

test('audits one line per request without leaking the token', async () => {
  const s = await start()
  try {
    await post(s.base, '/v1/sessions', { cwd: tmpdir() })
    await call(s.base, '/v1/sessions')
    const entries = s.audits.map((entry) => JSON.stringify(entry))
    assert.equal(entries.length, 2)
    assert.match(entries[0], /"route":"sessions\/create"/)
    assert.match(entries[0], /"status":201/)
    assert.match(entries[1], /"status":401/)
    for (const entry of entries) {
      assert.equal(entry.includes(TOKEN), false)
      assert.equal(entry.includes('authorization'), false)
    }
  } finally { await s.close() }
})

test('stops auditing when the audit log is switched off', async () => {
  const s = await start({ auditLog: false })
  try {
    await call(s.base, '/v1/sessions')
    assert.equal(s.audits.length, 0)
  } finally { await s.close() }
})

test('resolveOptions keeps the documented defaults', () => {
  assert.deepEqual(resolveOptions(undefined), { allowCreate: true, auditLog: true, cwdAllowlist: [] })
  assert.deepEqual(resolveOptions(null), { allowCreate: true, auditLog: true, cwdAllowlist: [] })
  assert.deepEqual(resolveOptions('nonsense'), { allowCreate: true, auditLog: true, cwdAllowlist: [] })
  assert.deepEqual(resolveOptions({ allowCreate: false, auditLog: false }), { allowCreate: false, auditLog: false, cwdAllowlist: [] })
  assert.deepEqual(resolveOptions({ cwdAllowlist: ['/work', '', 42, '  '] }), { allowCreate: true, auditLog: true, cwdAllowlist: [resolve('/work')] })
})
