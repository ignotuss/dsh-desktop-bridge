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

The bridge must be enabled in DSH; the descriptor it publishes at
$DSH_HOME/desktop-bridge.json carries the port and the bearer token.`

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
} else if (command === 'send' && rest.length > 1) {
  const [sessionId, ...text] = rest
  url = `${root}/${encodeURIComponent(sessionId)}/messages`
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
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2))
  } catch {
    console.log(body)
  }
  if (!response.ok) process.exitCode = 1
} catch {
  console.error('Cannot reach the DSH desktop bridge.')
  console.error('If the plugin was just reloaded, its port and token changed — rerun to pick them up.')
  process.exitCode = 1
}
