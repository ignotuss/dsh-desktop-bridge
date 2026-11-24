import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/bridge-client.mjs', import.meta.url))
const SESSION = 'session-00000000-0000-0000-0000-000000000000'
const TOKEN = 'test-token'

async function withBridge(responseFor, run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-cli-'))
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      requests.push({ url: req.url, body, authorization: req.headers.authorization })
      const result = await responseFor(req.url, body)
      res.writeHead(result.statusCode ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await writeFile(join(home, 'desktop-bridge.json'), JSON.stringify({
    version: 1, address: '127.0.0.1', port, token: TOKEN,
  }), { mode: 0o600 })
  const runCli = async (args) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const [code, signal] = await once(child, 'close')
    return { code, signal, stdout, stderr }
  }
  try {
    await run({ runCli, requests })
  } finally {
    await new Promise((done) => server.close(done))
    await rm(home, { recursive: true, force: true })
  }
}

test('send without --wait keeps the immediate request', async () => {
  await withBridge(async () => ({ body: { accepted: true, requestId: 'request-1' } }), async ({ runCli, requests }) => {
    const result = await runCli(['send', SESSION, 'hello'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).accepted, true)
    const messageRequests = requests.filter((request) => request.url.includes('/messages'))
    assert.equal(messageRequests.length, 1)
    assert.equal(new URL('http://127.0.0.1' + messageRequests[0].url).searchParams.has('wait'), false)
    assert.equal(messageRequests[0].authorization, 'Bearer ' + TOKEN)
  })
})

test('send --wait exits 124 on a timeout response', async () => {
  await withBridge(async () => ({
    body: { status: 'timeout', sessionId: SESSION, requestId: 'request-1', timeoutSeconds: 1 },
  }), async ({ runCli, requests }) => {
    const result = await runCli(['send', SESSION, '--wait', '--timeout', '1', 'hello'])
    assert.equal(result.code, 124)
    assert.equal(JSON.parse(result.stdout).status, 'timeout')
    const messageRequests = requests.filter((request) => request.url.includes('/messages'))
    assert.equal(messageRequests.length, 1)
    assert.equal(new URL('http://127.0.0.1' + messageRequests[0].url).searchParams.get('timeout'), '1')
  })
})

test('send --wait exits 3 when human input is required', async () => {
  await withBridge(async () => ({
    body: { status: 'input-required', sessionId: SESSION, requestId: 'request-1', pendingInput: ['approval'] },
  }), async ({ runCli, requests }) => {
    const result = await runCli(['send', SESSION, '--wait', 'hello'])
    assert.equal(result.code, 3)
    assert.equal(JSON.parse(result.stdout).status, 'input-required')
    const messageRequests = requests.filter((request) => request.url.includes('/messages'))
    assert.equal(messageRequests.length, 1)
    assert.equal(new URL('http://127.0.0.1' + messageRequests[0].url).searchParams.get('timeout'), '30')
  })
})

test('send --wait exits 0 on a replied result', async () => {
  await withBridge(async () => ({
    body: { status: 'replied', sessionId: SESSION, requestId: 'request-1', turn: 1, reply: 'hello' },
  }), async ({ runCli }) => {
    const result = await runCli(['send', SESSION, '--wait', 'hello'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'replied')
  })
})

test('rejects --timeout without --wait before calling the bridge', async () => {
  await withBridge(async () => ({ body: { accepted: true } }), async ({ runCli, requests }) => {
    const result = await runCli(['send', SESSION, '--timeout', '5', 'hello'])
    assert.equal(result.code, 2)
    assert.equal(requests.length, 0)
    assert.match(result.stderr, /requires --wait/)
  })
})

test('wait transport tolerates delayed response headers', async () => {
  await withBridge(async () => {
    await new Promise((done) => setTimeout(done, 1200))
    return {
      body: { status: 'replied', sessionId: SESSION, requestId: 'request-1', turn: 1, reply: 'hello' },
    }
  }, async ({ runCli }) => {
    const result = await runCli(['send', SESSION, '--wait', '--timeout', '2', 'hello'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'replied')
  })
})
