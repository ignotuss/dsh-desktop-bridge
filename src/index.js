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

  return createServer(async (req, res) => {
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
        const result = await controller.inspect(sessionId, AbortSignal.timeout(10000))
        status = 200
        return json(res, status, { sessionId, events: result.events.slice(-count) })
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
        const requestId = randomUUID()
        const result = await controller.prompt({
          sessionId,
          requestId,
          content: [{ type: 'text', text: data.text }],
          mode: 'followup',
        }, AbortSignal.timeout(15000))
        status = 200
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
}

/**
 * Mount the bridge: bind a loopback listener, publish the descriptor, and
 * release both when the plugin unloads.
 *
 * @param ctx - the Cordis plugin context; `sessionController` must be present.
 */
export async function apply(ctx) {
  const controller = ctx.sessionController
  if (!controller) throw new Error('sessionController is unavailable')
  const options = resolveOptions(ctx.config)
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
