#!/usr/bin/env node
// Command-line client for the DSH desktop bridge.
//
// It only reads the descriptor the plugin publishes under $DSH_HOME and speaks
// the loopback HTTP API; it never touches a profile or a session file.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE = `Usage:
  dsh-desktop-bridge list
  dsh-desktop-bridge create <directory> [title...]
  dsh-desktop-bridge events <session-id> [limit]
  dsh-desktop-bridge send <session-id> <text...>
  dsh-desktop-bridge send <session-id> --wait [--timeout <seconds>] <text...>

The bridge must be enabled in DSH; the descriptor it publishes at
$DSH_HOME/desktop-bridge.json carries the port and the bearer token.`

const DEFAULT_WAIT_SECONDS = 30

function usageError(message) {
  if (message !== undefined) console.error(message)
  console.error(USAGE)
  process.exit(2)
}

function parseWaitTimeout(raw) {
  if (!/^[1-9][0-9]*$/.test(raw ?? '')) return undefined
  const seconds = Number(raw)
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : undefined
}

const [command, ...rest] = process.argv.slice(2)

if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE)
  process.exit(command === undefined ? 2 : 0)
}

const descriptorPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'desktop-bridge.json')

let connection
try {
  connection = JSON.parse(await readFile(descriptorPath, 'utf8'))
} catch {
  console.error(`The DSH desktop bridge is not running (no readable ${descriptorPath}).`)
  console.error('Enable the desktop-bridge plugin, then retry.')
  process.exit(1)
}

if (connection.address !== '127.0.0.1' || !Number.isInteger(connection.port) || typeof connection.token !== 'string') {
  console.error(`Invalid bridge descriptor at ${descriptorPath}.`)
  process.exit(1)
}

const root = `http://127.0.0.1:${connection.port}/v1/sessions`
let url
let init = { headers: { authorization: `Bearer ${connection.token}` } }
let waitMode = false

if (command === 'list') {
  url = root
} else if (command === 'create' && rest.length > 0) {
  const [directory, ...title] = rest
  url = root
  init = {
    method: 'POST',
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: directory, ...(title.length > 0 ? { title: title.join(' ') } : {}) }),
  }
} else if (command === 'events' && rest.length > 0) {
  const [sessionId, limit] = rest
  url = `${root}/${encodeURIComponent(sessionId)}/events${limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`}`
} else if (command === 'send') {
  let sessionId
  let wait = false
  let timeout = DEFAULT_WAIT_SECONDS
  let timeoutGiven = false
  let options = true
  const text = []
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (options && argument === '--') { options = false; continue }
    if (options && argument === '--wait') { wait = true; continue }
    if (options && argument === '--timeout') {
      if (index + 1 >= rest.length) usageError('--timeout requires a value')
      const parsed = parseWaitTimeout(rest[index + 1])
      if (parsed === undefined) usageError('--timeout must be an integer from 1 to 3600 seconds')
      timeout = parsed
      timeoutGiven = true
      index += 1
      continue
    }
    if (options && argument.startsWith('--timeout=')) {
      const parsed = parseWaitTimeout(argument.slice('--timeout='.length))
      if (parsed === undefined) usageError('--timeout must be an integer from 1 to 3600 seconds')
      timeout = parsed
      timeoutGiven = true
      continue
    }
    if (options && argument.startsWith('--')) usageError(`unknown option: ${argument}`)
    if (sessionId === undefined) { sessionId = argument; continue }
    text.push(argument)
  }
  if (sessionId === undefined || text.length === 0) usageError()
  if (timeoutGiven && !wait) usageError('--timeout requires --wait')
  waitMode = wait
  url = `${root}/${encodeURIComponent(sessionId)}/messages${wait ? `?wait=1&timeout=${timeout}` : ''}`
  init = {
    method: 'POST',
    headers: { ...init.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text: text.join(' ') }),
  }
} else {
  console.error(USAGE)
  process.exit(2)
}

try {
  const response = await fetch(url, init)
  const body = await response.text()
  let parsed
  try {
    parsed = JSON.parse(body)
    console.log(JSON.stringify(parsed, null, 2))
  } catch {
    console.log(body)
  }
  if (waitMode && parsed !== undefined && typeof parsed.status === 'string') {
    if (parsed.status === 'timeout') process.exitCode = 124
    else if (parsed.status === 'input-required') process.exitCode = 3
    else if (parsed.status === 'turn-ended') process.exitCode = 1
  }
  if (!response.ok) process.exitCode = 1
} catch {
  console.error('Cannot reach the DSH desktop bridge.')
  console.error('If the plugin was just reloaded, its port and token changed — rerun to pick them up.')
  process.exitCode = 1
}
