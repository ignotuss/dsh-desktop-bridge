import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export const name = 'desktop-bridge'
export const inject = ['sessionController']

/** Descriptor format version published in `<DSH_HOME>/desktop-bridge.json`. */
export const DESCRIPTOR_VERSION = 1

const MAX_BODY = 8 * 1024
const MAX_TEXT = 4 * 1024
const MAX_CWD = 2048
const MAX_TITLE = 200
const SESSION_ID = /^session-[0-9a-f-]{36}$/i
const WAIT_DEFAULT_SECONDS = 30
const WAIT_MAX_SECONDS = 3600
const WAIT_PAGE_MESSAGES = 200
const WAIT_POLL_MS = 250

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function isJson(req) {
  return req.headers['content-type']?.split(';')[0]?.trim() === 'application/json'
}

function authorized(value, token) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * A request is only served when its `Host` names the loopback address this
 * listener is bound to. Browsers cannot forge it, so a page that somehow
 * learned the token still cannot reach the bridge by DNS rebinding.
 */
function hostAllowed(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const port = req.socket?.localPort
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

async function bodyJson(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY) {
      const error = new Error('request too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch {
    const error = new Error('invalid JSON')
    error.status = 400
    throw error
  }
}

/**
 * Resolve the optional `config` block into the bridge's effective policy.
 * Absent or unreadable configuration yields the permissive defaults, so the
 * plugin still works on a DSH build that passes no config through.
 *
 * @param config - the patch entry's `config` object, if any.
 * @returns `allowCreate`, `auditLog` and the resolved `cwdAllowlist`.
 */
export function resolveOptions(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    allowCreate: source.allowCreate !== false,
    auditLog: source.auditLog !== false,
    cwdAllowlist: Array.isArray(source.cwdAllowlist)
      ? source.cwdAllowlist
        .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => resolve(entry))
      : [],
  }
}

function insideAllowlist(cwd, allowlist) {
  if (allowlist.length === 0) return true
  const target = resolve(cwd)
  return allowlist.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

/** `undefined` when `cwd` is an existing directory, otherwise the error text. */
async function cwdProblem(cwd) {
  let info
  try { info = await stat(cwd) } catch { return 'cwd must be an existing directory' }
  return info.isDirectory() ? undefined : 'cwd must be an existing directory'
}

function assistantText(event) {
  const content = event?.data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function joinedReplies(replies) {
  return [...replies.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .filter((text) => text !== '')
    .join('\n')
}

async function readSessionEvents(controller, sessionId, count, signal) {
  if (typeof controller.events === 'function') {
    const result = await controller.events({
      address: { kind: 'session', sessionId },
      maxMessages: count,
    }, signal)
    return result.records.slice(-count).map((record) => record.event)
  }
  const result = await controller.inspect(sessionId, signal)
  return result.events.slice(-count)
}

async function readSessionCursor(controller, sessionId, signal) {
  if (typeof controller.events === 'function') {
    const result = await controller.events({
      address: { kind: 'session', sessionId },
      maxMessages: 1,
    }, signal)
    if (Number.isSafeInteger(result.cursor)) return result.cursor
    return result.records.at(-1)?.event?.seq ?? 0
  }
  const result = await controller.inspect(sessionId, signal)
  return result.events.at(-1)?.seq ?? 0
}

async function readEventsAfter(controller, sessionId, afterSeq, signal) {
  if (typeof controller.events !== 'function') {
    const result = await controller.inspect(sessionId, signal)
    return result.events.filter((event) => Number.isInteger(event?.seq) && event.seq > afterSeq)
  }
  const collected = new Map()
  let throughSeq
  let beforeSeq
  while (true) {
    signal.throwIfAborted()
    const result = await controller.events({
      address: { kind: 'session', sessionId },
      maxMessages: WAIT_PAGE_MESSAGES,
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    }, signal)
    const events = (result.records ?? []).map((record) => record.event)
    if (throughSeq === undefined) {
      throughSeq = Number.isSafeInteger(result.cursor)
        ? result.cursor
        : (events.at(-1)?.seq ?? afterSeq)
    }
    for (const event of events) {
      if (Number.isInteger(event?.seq) && event.seq > afterSeq) collected.set(event.seq, event)
    }
    const first = events[0]?.seq
    if (first === undefined || first <= afterSeq || result.hasMore !== true) break
    if (beforeSeq !== undefined && first >= beforeSeq) break
    beforeSeq = first
    if (throughSeq <= afterSeq) break
  }
  return [...collected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, event]) => event)
}

/**
 * Wait for the turn carrying one request to finish, without cancelling or
 * resending it. Session-level quiescence is not enough: another queued turn can
 * end first, so the request id selects the user message and its turn.
 *
 * @param controller - the host's `sessionController` service.
 * @param sessionId - the Session that received the prompt.
 * @param requestId - the client-minted request id returned by `prompt`.
 * @param options - `timeoutMs`, `afterSeq` and `pollIntervalMs` (the latter for tests).
 * @returns a script-friendly wait result.
 */
export async function waitForRequest(controller, sessionId, requestId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : WAIT_DEFAULT_SECONDS * 1000
  const pollMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= 0
    ? options.pollIntervalMs
    : WAIT_POLL_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const waitController = new AbortController()
  const waitSignal = waitController.signal
  const deadlineTimer = setTimeout(() => waitController.abort(new Error('wait timeout')), timeoutMs)
  const assistantByTurn = new Map()
  let lastSeq = Number.isSafeInteger(options.afterSeq) ? options.afterSeq : -1
  let cursor = Math.max(0, lastSeq)
  let userSeq
  let turn
  let replies = new Map()

  const timeoutResult = () => {
    const partialReply = joinedReplies(replies)
    return {
      status: 'timeout',
      sessionId,
      requestId,
      timeoutSeconds: timeoutMs / 1000,
      ...(turn === undefined ? {} : { turn }),
      ...(partialReply === '' ? {} : { partialReply }),
      cursor,
      waitedMs: Date.now() - startedAt,
    }
  }

  try {
    while (true) {
      if (waitSignal.aborted || Date.now() >= deadline) return timeoutResult()
      let events
      try {
        events = await readEventsAfter(controller, sessionId, lastSeq, waitSignal)
      } catch (error) {
        if (waitSignal.aborted || Date.now() >= deadline) return timeoutResult()
        throw error
      }
      for (const event of events) {
        if (Number.isInteger(event?.seq) && event.seq > cursor) cursor = event.seq
        if (Number.isInteger(event?.seq) && event.seq > lastSeq) lastSeq = event.seq
        if (event?.type === 'assistant/message' && Number.isInteger(event?.data?.turn)) {
          let bySeq = assistantByTurn.get(event.data.turn)
          if (bySeq === undefined) {
            bySeq = new Map()
            assistantByTurn.set(event.data.turn, bySeq)
          }
          bySeq.set(event.seq, assistantText(event))
        }
      }

      const requestEvent = events.find((event) => event?.type === 'user/message'
        && event?.data?.source?.rpcId === requestId)
      if (requestEvent) userSeq = requestEvent.seq
      if (turn === undefined && userSeq !== undefined) {
        const turnEvent = events.find((event) => event?.seq > userSeq && Number.isInteger(event?.data?.turn))
        if (turnEvent) turn = turnEvent.data.turn
      }

      replies = turn === undefined ? new Map() : (assistantByTurn.get(turn) ?? new Map())
      if (turn !== undefined) {
        const end = events.find((event) => event?.type === 'turn/end' && event?.data?.turn === turn)
        if (end) {
          const reason = end.data?.reason
          const result = {
            status: reason?.kind === 'completed' ? 'replied' : 'turn-ended',
            sessionId,
            requestId,
            turn,
            reply: joinedReplies(replies),
            cursor,
            waitedMs: Date.now() - startedAt,
          }
          if (reason?.kind !== 'completed') result.reason = reason
          return result
        }
      }

      let state
      try {
        state = typeof controller.state === 'function'
          ? await controller.state({ sessionId }, waitSignal)
          : undefined
      } catch (error) {
        if (waitSignal.aborted || Date.now() >= deadline) return timeoutResult()
        throw error
      }
      if (Array.isArray(state?.pendingInput) && state.pendingInput.length > 0) {
        const partialReply = joinedReplies(replies)
        return {
          status: 'input-required',
          sessionId,
          requestId,
          ...(turn === undefined ? {} : { turn }),
          pendingInput: state.pendingInput,
          ...(partialReply === '' ? {} : { partialReply }),
          cursor,
          waitedMs: Date.now() - startedAt,
        }
      }
      if (waitSignal.aborted || Date.now() >= deadline) return timeoutResult()
      const remaining = deadline - Date.now()
      if (remaining <= 0) return timeoutResult()
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)))
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/**
 * Build the loopback listener. Exported for tests: everything but `apply()`
 * is pure request handling over an injected controller.
 *
 * @param controller - the host's `sessionController` service.
 * @param token - the bearer token every request must present.
 * @param options - `allowCreate`, `auditLog`, `cwdAllowlist`, `onAudit`.
 * @returns the not-yet-listening `node:http` server.
 */
export function createBridgeServer(controller, token, options = {}) {
  const allowCreate = options.allowCreate !== false
  const auditLog = options.auditLog !== false
  const cwdAllowlist = Array.isArray(options.cwdAllowlist) ? options.cwdAllowlist : []
  const onAudit = typeof options.onAudit === 'function' ? options.onAudit : undefined

  const server = createServer(async (req, res) => {
    const startedAt = Date.now()
    let status = 500
    let route = 'unmatched'
    let detail
    try {
      if (!hostAllowed(req)) {
        status = 403
        route = 'rejected/host'
        detail = req.headers.host
        return json(res, status, { error: 'Host header must name the loopback address and port' })
      }
      if (req.headers.origin) {
        status = 403
        route = 'rejected/origin'
        detail = req.headers.origin
        return json(res, status, { error: 'browser origins are not allowed' })
      }
      if (!authorized(req.headers.authorization, token)) {
        status = 401
        route = 'rejected/auth'
        return json(res, status, { error: 'unauthorized' })
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        route = 'sessions/create'
        if (!allowCreate) {
          status = 403
          return json(res, status, { error: 'session creation is disabled by configuration' })
        }
        if (!isJson(req)) {
          status = 415
          return json(res, status, { error: 'JSON required' })
        }
        const data = await bodyJson(req)
        if (typeof data?.cwd !== 'string' || data.cwd.trim() === '' || data.cwd.length > MAX_CWD) {
          status = 400
          return json(res, status, { error: `cwd is required (1-${MAX_CWD} characters)` })
        }
        if (data.title !== undefined
          && (typeof data.title !== 'string' || data.title.trim() === '' || data.title.length > MAX_TITLE)) {
          status = 400
          return json(res, status, { error: `title must be 1-${MAX_TITLE} characters when present` })
        }
        const cwd = resolve(data.cwd)
        detail = cwd
        if (!insideAllowlist(cwd, cwdAllowlist)) {
          status = 403
          return json(res, status, { error: 'cwd is outside the configured allowlist' })
        }
        const problem = await cwdProblem(cwd)
        if (problem !== undefined) {
          status = 400
          return json(res, status, { error: problem })
        }
        const created = await controller.create({ cwd })
        const payload = created && typeof created === 'object' ? { ...created } : { result: created }
        const sessionId = payload.sessionId ?? payload.id
        if (data.title !== undefined) {
          if (sessionId === undefined) {
            payload.warning = 'session created but its identity was not reported, so the title was not set'
          } else {
            try { await controller.rename({ sessionId, title: data.title }) }
            catch { payload.warning = 'session created but the title could not be set' }
          }
        }
        status = 201
        return json(res, status, payload)
      }

      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        route = 'sessions/list'
        const result = await controller.list({}, AbortSignal.timeout(10000))
        status = 200
        return json(res, status, { items: result.items })
      }

      const match = /^\/v1\/sessions\/([^/]+)\/(events|messages)$/.exec(url.pathname)
      if (!match || !SESSION_ID.test(match[1])) {
        status = 404
        route = 'unmatched'
        return json(res, status, { error: 'not found' })
      }
      const sessionId = match[1]
      detail = sessionId

      if (req.method === 'GET' && match[2] === 'events') {
        route = 'sessions/events'
        const count = Number(url.searchParams.get('limit') ?? 30)
        if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
          status = 400
          return json(res, status, { error: 'limit must be 1-100' })
        }
        const events = await readSessionEvents(controller, sessionId, count, AbortSignal.timeout(10000))
        status = 200
        return json(res, status, { sessionId, events })
      }

      if (req.method === 'POST' && match[2] === 'messages') {
        route = 'sessions/messages'
        if (!isJson(req)) {
          status = 415
          return json(res, status, { error: 'JSON required' })
        }
        const data = await bodyJson(req)
        if (typeof data?.text !== 'string' || data.text.trim() === '' || Buffer.byteLength(data.text, 'utf8') > MAX_TEXT) {
          status = 400
          return json(res, status, { error: `text must be 1-${MAX_TEXT} bytes` })
        }
        let waitSeconds
        const wait = url.searchParams.get('wait')
        if (wait !== null) {
          if (wait !== '1' && wait !== 'true') {
            status = 400
            return json(res, status, { error: 'wait must be 1 or true' })
          }
          const rawTimeout = url.searchParams.get('timeout')
          waitSeconds = rawTimeout === null ? WAIT_DEFAULT_SECONDS : Number(rawTimeout)
          if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > WAIT_MAX_SECONDS) {
            status = 400
            return json(res, status, { error: `timeout must be an integer from 1 to ${WAIT_MAX_SECONDS} seconds` })
          }
        }
        let waitBaseline
        if (waitSeconds !== undefined) {
          waitBaseline = await readSessionCursor(controller, sessionId, AbortSignal.timeout(10000))
        }
        const requestId = randomUUID()
        const result = await controller.prompt({
          sessionId,
          requestId,
          content: [{ type: 'text', text: data.text }],
          mode: 'queue',
        }, AbortSignal.timeout(15000))
        status = 200
        if (waitSeconds !== undefined) {
          // The response stays open until the wait resolves; the CLI uses
          // node:http for this request so undici's response-header default does
          // not cap long waits.
          const waited = await waitForRequest(controller, sessionId, requestId, {
            timeoutMs: waitSeconds * 1000,
            afterSeq: waitBaseline,
          })
          return json(res, status, { accepted: result.accepted, ...waited })
        }
        return json(res, status, { accepted: result.accepted, requestId })
      }

      status = 405
      route = 'unmatched'
      return json(res, status, { error: 'method not allowed' })
    } catch (error) {
      const code = error?.status ?? (error?.code === 'session/not-found' ? 404 : 500)
      status = code
      if (code === 500) detail = String(error?.message ?? error)
      return json(res, code, { error: code === 500 ? 'DSH request failed' : error.message })
    } finally {
      if (auditLog && onAudit) {
        try {
          onAudit({
            time: new Date(startedAt).toISOString(),
            method: req.method,
            path: req.url,
            route,
            status,
            ms: Date.now() - startedAt,
            ...(detail === undefined ? {} : { detail }),
          })
        } catch { /* auditing must never break a response */ }
      }
    }
  })
  // The wait route holds its response until the requested deadline; keep the
  // server's socket inactivity timeout out of long waits.
  server.timeout = 0
  return server
}

/**
 * Mount the bridge: bind a loopback listener, publish the descriptor, and
 * release both when the plugin unloads.
 *
 * @param ctx - the Cordis plugin context; `sessionController` must be present.
 * @param config - the patch entry's `config` object, if any.
 */
export async function apply(ctx, config) {
  const controller = ctx.sessionController
  if (!controller) throw new Error('sessionController is unavailable')
  const options = resolveOptions(config)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const descriptorPath = join(home, 'desktop-bridge.json')
  const logPath = join(home, 'desktop-bridge.log')
  const token = randomBytes(32).toString('hex')

  const server = createBridgeServer(controller, token, {
    ...options,
    onAudit: options.auditLog
      ? (entry) => { void appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {}) }
      : undefined,
  })

  await new Promise((ready, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', ready)
  })

  try {
    const descriptor = JSON.stringify({
      version: DESCRIPTOR_VERSION,
      address: '127.0.0.1',
      port: server.address().port,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
    await mkdir(dirname(descriptorPath), { recursive: true })
    const temporary = `${descriptorPath}.${process.pid}.tmp`
    await writeFile(temporary, descriptor, { mode: 0o600 })
    await rename(temporary, descriptorPath)
  } catch (error) {
    server.close()
    throw error
  }

  ctx.effect(() => async () => {
    await new Promise((closed) => server.close(closed))
    await unlink(descriptorPath).catch(() => {})
  }, 'desktop-bridge listener')

  ctx.logger?.info?.(
    `desktop-bridge: listening on 127.0.0.1:${server.address().port}`
    + ` (create=${options.allowCreate ? 'enabled' : 'disabled'}, audit=${options.auditLog ? 'on' : 'off'})`,
  )
}