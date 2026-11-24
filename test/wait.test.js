import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForRequest } from '../src/index.js'

const SESSION = 'session-00000000-0000-0000-0000-000000000000'
const REQUEST = 'request-0000'

function fakeController(snapshots, states = []) {
  let eventsCalls = 0
  return {
    events: async () => {
      const events = snapshots[Math.min(eventsCalls, snapshots.length - 1)]
      eventsCalls += 1
      return {
        records: events.map((event) => ({ type: 'event', event })),
        cursor: events.at(-1)?.seq ?? 0,
        hasMore: false,
      }
    },
    state: async () => states[Math.min(eventsCalls - 1, states.length - 1)] ?? { pendingInput: [] },
  }
}

function completedReply(text, turn = 1, requestId = REQUEST) {
  return [
    { seq: 1, type: 'turn/start', data: { turn } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: requestId } } },
    { seq: 3, type: 'assistant/message', data: { turn, message: { content: [
      { type: 'reasoning', text: 'not returned' },
      { type: 'text', text },
    ] } } },
    { seq: 4, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

test('waits for the request turn and returns its complete text', async () => {
  const controller = fakeController([completedReply('hello')])
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 })
  assert.equal(result.status, 'replied')
  assert.equal(result.sessionId, SESSION)
  assert.equal(result.requestId, REQUEST)
  assert.equal(result.turn, 1)
  assert.equal(result.reply, 'hello')
})

test('ignores a prior turn that ends before the queued request starts', async () => {
  const prior = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: 'other-request' } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'old reply' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, type: 'agent/inbox/spliced', data: { inserted: [{ source: { rpcId: REQUEST } }] } },
  ]
  const ours = [
    ...prior,
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 8, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'new reply' }] } } },
    { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const controller = fakeController([prior, ours])
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 })
  assert.equal(result.status, 'replied')
  assert.equal(result.turn, 2)
  assert.equal(result.reply, 'new reply')
})

test('returns timeout with a partial reply and does not need another request', async () => {
  const partial = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'partial' }] } } },
  ]
  const controller = fakeController([partial])
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 30, pollIntervalMs: 1 })
  assert.equal(result.status, 'timeout')
  assert.equal(result.turn, 1)
  assert.equal(result.partialReply, 'partial')
  assert.equal(result.timeoutSeconds, 0.03)
})

test('reports input-required when the host is waiting for a human', async () => {
  const partial = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'need approval' }] } } },
  ]
  const controller = fakeController([partial], [{ pendingInput: ['approval'] }])
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 })
  assert.equal(result.status, 'input-required')
  assert.deepEqual(result.pendingInput, ['approval'])
  assert.equal(result.partialReply, 'need approval')
})

test('keeps two sessions independent in parallel', async () => {
  const first = fakeController([completedReply('first')])
  const second = fakeController([completedReply('second', 1, 'request-1111')])
  const [a, b] = await Promise.all([
    waitForRequest(first, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 }),
    waitForRequest(second, 'session-11111111-1111-1111-1111-111111111111', 'request-1111', { timeoutMs: 1000, pollIntervalMs: 1 }),
  ])
  assert.equal(a.reply, 'first')
  assert.equal(b.reply, 'second')
  assert.notEqual(a.sessionId, b.sessionId)
})

test('keeps the inspect fallback for older hosts', async () => {
  const controller = {
    inspect: async () => ({ events: completedReply('legacy') }),
    state: async () => ({ pendingInput: [] }),
  }
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 })
  assert.equal(result.status, 'replied')
  assert.equal(result.reply, 'legacy')
})

test('reports a non-completed turn reason', async () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'stopped' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
  ]
  const controller = fakeController([events])
  const result = await waitForRequest(controller, SESSION, REQUEST, { timeoutMs: 1000, pollIntervalMs: 1 })
  assert.equal(result.status, 'turn-ended')
  assert.deepEqual(result.reason, { kind: 'error' })
  assert.equal(result.reply, 'stopped')
})

test('pages back to the request instead of trusting a fixed tail window', async () => {
  const events = Array.from({ length: 300 }, (_, seq) => ({ seq, type: 'noise', data: {} }))
  events[5] = { seq: 5, type: 'user/message', data: { source: { rpcId: REQUEST } } }
  events[6] = { seq: 6, type: 'turn/start', data: { turn: 1 } }
  events[297] = { seq: 297, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'late reply' }] } } }
  events[298] = { seq: 298, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  const controller = {
    events: async (request) => {
      const end = request.beforeSeq ?? events.length
      const start = Math.max(0, end - (request.maxMessages ?? 200))
      const page = events.slice(start, end)
      return {
        records: page.map((event) => ({ type: 'event', event })),
        cursor: page.at(-1)?.seq ?? 0,
        hasMore: start > 0,
      }
    },
    state: async () => ({ pendingInput: [] }),
  }
  const result = await waitForRequest(controller, SESSION, REQUEST, {
    timeoutMs: 1000, afterSeq: 0, pollIntervalMs: 1,
  })
  assert.equal(result.status, 'replied')
  assert.equal(result.turn, 1)
  assert.equal(result.reply, 'late reply')
})

test('bounds a hanging events RPC by the remaining wait timeout', async () => {
  const controller = {
    events: async (request, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }),
    state: async () => ({ pendingInput: [] }),
  }
  const started = Date.now()
  const result = await waitForRequest(controller, SESSION, REQUEST, {
    timeoutMs: 30, afterSeq: 0, pollIntervalMs: 1,
  })
  assert.equal(result.status, 'timeout')
  assert.ok(Date.now() - started < 500, 'the observation must not outlive the wait deadline')
})

test('bounds a hanging state RPC by the remaining wait timeout', async () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'partial' }] } } },
  ]
  const controller = {
    events: async () => ({
      records: events.map((event) => ({ type: 'event', event })),
      cursor: 3,
      hasMore: false,
    }),
    state: async (request, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }),
  }
  const started = Date.now()
  const result = await waitForRequest(controller, SESSION, REQUEST, {
    timeoutMs: 30, afterSeq: 0, pollIntervalMs: 1,
  })
  assert.equal(result.status, 'timeout')
  assert.ok(Date.now() - started < 500, 'the state read must not outlive the wait deadline')
})

test('rechecks the request turn before reporting a later turn pending input', async () => {
  let calls = 0
  const partial = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { rpcId: REQUEST } } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } } },
  ]
  const completed = [
    ...partial,
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const controller = {
    events: async () => {
      const events = calls === 0 ? partial : completed
      calls += 1
      return {
        records: events.map((event) => ({ type: 'event', event })),
        cursor: events.at(-1)?.seq ?? 0,
        hasMore: false,
      }
    },
    state: async () => ({ pendingInput: ['question'] }),
  }
  const result = await waitForRequest(controller, SESSION, REQUEST, {
    timeoutMs: 1000, pollIntervalMs: 1,
  })
  assert.equal(result.status, 'replied')
  assert.equal(result.turn, 1)
  assert.equal(result.reply, 'done')
})
