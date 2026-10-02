import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, DESCRIPTOR_VERSION } from '../src/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000000'

function stubController() {
  return {
    create: async () => ({ sessionId: SESSION }),
    rename: async (payload) => ({ title: payload.title }),
    list: async () => ({ items: [] }),
    inspect: async () => ({ events: [] }),
    prompt: async () => ({ accepted: true }),
  }
}

function fakeContext(controller = stubController(), config = {}) {
  const logs = []
  let disposer
  return {
    sessionController: controller,
    config,
    logger: { info: (line) => logs.push(line) },
    logs,
    effect(factory) { disposer = factory() },
    unload: () => disposer(),
  }
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { await run(home) } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('apply publishes a descriptor, serves, and cleans up on unload', async () => {
  await withHome(async (home) => {
    const ctx = fakeContext()
    await apply(ctx)

    const descriptorPath = join(home, 'desktop-bridge.json')
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
    assert.equal(descriptor.version, DESCRIPTOR_VERSION)
    assert.equal(descriptor.address, '127.0.0.1')
    assert.equal(descriptor.pid, process.pid)
    assert.ok(Number.isInteger(descriptor.port) && descriptor.port > 0)
    assert.match(descriptor.token, /^[0-9a-f]{64}$/)
    assert.match(descriptor.startedAt, /^\d{4}-\d{2}-\d{2}T/)

    const headers = { authorization: `Bearer ${descriptor.token}` }
    const listed = await fetch(`http://127.0.0.1:${descriptor.port}/v1/sessions`, { headers })
    assert.equal(listed.status, 200)
    assert.equal((await listed.json()).items.length, 0)

    const rejected = await fetch(`http://127.0.0.1:${descriptor.port}/v1/sessions`)
    assert.equal(rejected.status, 401)

    await ctx.unload()
    await assert.rejects(stat(descriptorPath), 'the descriptor is removed with the listener')
    await assert.rejects(fetch(`http://127.0.0.1:${descriptor.port}/v1/sessions`, { headers }))
  })
})

test('apply writes one audit line per request when auditing is on', async () => {
  await withHome(async (home) => {
    const ctx = fakeContext()
    await apply(ctx)
    const descriptor = JSON.parse(await readFile(join(home, 'desktop-bridge.json'), 'utf8'))
    await fetch(`http://127.0.0.1:${descriptor.port}/v1/sessions`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    await new Promise((done) => setTimeout(done, 50))
    const log = await readFile(join(home, 'desktop-bridge.log'), 'utf8')
    const lines = log.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].route, 'sessions/list')
    assert.equal(lines[0].status, 200)
    assert.equal(log.includes(descriptor.token), false)
    await ctx.unload()
  })
})

test('apply honours allowCreate=false and writes no audit log when off', async () => {
  await withHome(async (home) => {
    const ctx = fakeContext(undefined, { allowCreate: false, auditLog: false })
    await apply(ctx)
    const descriptor = JSON.parse(await readFile(join(home, 'desktop-bridge.json'), 'utf8'))
    const headers = { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' }
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd: tmpdir() }),
    })
    assert.equal(response.status, 403)
    await new Promise((done) => setTimeout(done, 50))
    await assert.rejects(stat(join(home, 'desktop-bridge.log')))
    await ctx.unload()
  })
})

test('apply refuses to start without the session controller', async () => {
  const ctx = fakeContext()
  ctx.sessionController = undefined
  await assert.rejects(apply(ctx), /sessionController is unavailable/)
})

test('a second mount replaces the descriptor instead of leaking the first', async () => {
  await withHome(async (home) => {
    const first = fakeContext()
    await apply(first)
    const before = JSON.parse(await readFile(join(home, 'desktop-bridge.json'), 'utf8'))

    const second = fakeContext()
    await apply(second)
    const after = JSON.parse(await readFile(join(home, 'desktop-bridge.json'), 'utf8'))
    assert.notEqual(after.token, before.token, 'every mount mints a fresh token')
    assert.notEqual(after.port, before.port)

    await second.unload()
    await first.unload()
  })
})
