import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createBridgeServer } from '../src/index.js'

const TOKEN = 'test-token'
const SESSION = 'session-00000000-0000-0000-0000-000000000000'

async function start(controller) {
  const server = createBridgeServer(controller, TOKEN)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    base: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((done) => server.close(done)),
  }
}

function post(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('keeps send without --wait immediate and unchanged', async () => {
  const calls = []
  const controller = {
    prompt: async (payload) => { calls.push(payload); return { accepted: true } },
    events: async () => { throw new Error('send without --wait must not read events') },
  }
  const server = await start(controller)
  try {
    const response = await post(server.base, '/v1/sessions/' + SESSION + '/messages', { text: 'ping' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.accepted, true)
    assert.match(body.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].mode, 'queue')
  } finally { await server.close() }
})

test('send with wait returns the completed turn result', async () => {
  let requestId
  let promptCalls = 0
  const controller = {
    prompt: async (payload) => { promptCalls += 1; requestId = payload.requestId; return { accepted: true } },
    events: async () => ({
      records: [
        { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
        { type: 'event', event: { seq: 2, type: 'user/message', data: { source: { rpcId: requestId } } } },
        { type: 'event', event: { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'reply' }] } } } },
        { type: 'event', event: { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
      ],
      cursor: 4,
      hasMore: false,
    }),
    state: async () => ({ pendingInput: [] }),
  }
  const server = await start(controller)
  try {
    const response = await post(server.base, '/v1/sessions/' + SESSION + '/messages?wait=1&timeout=5', { text: 'ping' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.accepted, true)
    assert.equal(body.status, 'replied')
    assert.equal(body.turn, 1)
    assert.equal(body.reply, 'reply')
    assert.equal(promptCalls, 1)
  } finally { await server.close() }
})

test('send with wait reports input-required without cancelling', async () => {
  let requestId
  let promptCalls = 0
  const controller = {
    prompt: async (payload) => { promptCalls += 1; requestId = payload.requestId; return { accepted: true } },
    events: async () => ({
      records: [
        { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
        { type: 'event', event: { seq: 2, type: 'user/message', data: { source: { rpcId: requestId } } } },
        { type: 'event', event: { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'need approval' }] } } } },
      ],
      cursor: 3,
      hasMore: false,
    }),
    state: async () => ({ pendingInput: ['approval'] }),
  }
  const server = await start(controller)
  try {
    const response = await post(server.base, '/v1/sessions/' + SESSION + '/messages?wait=1&timeout=5', { text: 'ping' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'input-required')
    assert.deepEqual(body.pendingInput, ['approval'])
    assert.equal(promptCalls, 1)
  } finally { await server.close() }
})

test('send with wait reports timeout and keeps the accepted request', async () => {
  let requestId
  let promptCalls = 0
  const controller = {
    prompt: async (payload) => { promptCalls += 1; requestId = payload.requestId; return { accepted: true } },
    events: async () => ({
      records: [
        { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
        { type: 'event', event: { seq: 2, type: 'user/message', data: { source: { rpcId: requestId } } } },
      ],
      cursor: 2,
      hasMore: false,
    }),
    state: async () => ({ pendingInput: [] }),
  }
  const server = await start(controller)
  try {
    const response = await post(server.base, '/v1/sessions/' + SESSION + '/messages?wait=1&timeout=1', { text: 'ping' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'timeout')
    assert.equal(body.timeoutSeconds, 1)
    assert.equal(promptCalls, 1)
  } finally { await server.close() }
})

test('rejects an invalid wait timeout before sending', async () => {
  let promptCalls = 0
  const controller = {
    prompt: async () => { promptCalls += 1; return { accepted: true } },
  }
  const server = await start(controller)
  try {
    assert.equal((await post(server.base, '/v1/sessions/' + SESSION + '/messages?wait=1&timeout=0', { text: 'ping' })).status, 400)
    assert.equal(promptCalls, 0)
  } finally { await server.close() }
})
