# dsh-desktop-bridge

A token-authenticated HTTP API on `127.0.0.1` that drives the sessions of a
**running** DSH (DeepSeek Harness) host — the desktop app, or a `dsh web`
server. Any local program can call it: a script, a build tool, an agent from
another vendor, `curl`.

> **Security-sensitive.** While this plugin is enabled, any process that can read
> `<DSH_HOME>/desktop-bridge.json` can list your sessions, read their events,
> send messages into them, and create new ones — each new session starting an
> agent that runs with your permissions. Read [SECURITY.md](./SECURITY.md)
> before installing, and disable the plugin when you are not using it.
>
> 中文文档见 [README.zh.md](./README.zh.md)。

## Why this exists

DSH keeps session control inside the host process, as the `sessionController`
service. That is deliberate, and it is why the usual routes do not reach an
already-running app:

- `dsh --profile desktop …` refuses outright — `error: profile "desktop" is
  managed exclusively by the Electron application`. The CLI can neither boot nor
  install into the profile the desktop app owns.
- The SDK/ACP entry points boot *their own* host, so they cannot address the
  sessions of the instance you are already looking at.

This plugin runs *inside* that host and republishes its `sessionController` on a
loopback port behind a bearer token. Nothing else changes: no second profile, no
session file is written by the bridge itself, no remote access.

### How it differs from the other bridges

| Package | Mechanism | Who can drive DSH with it |
|---|---|---|
| **this plugin** | loopback HTTP + bearer token | any local process, any language, `curl` |
| `dsh-session-bridge` | agent-facing tools registered inside DSH | only a DSH agent, from its own prompt |
| `dsh-agent-bridge` | spawns coding-agent CLIs through recipes | other agent CLIs, not arbitrary programs |
| `dsh-desktop-bridge` (npm, another author) | read-only fetch route | read-only, no create/send |

The npm name `dsh-desktop-bridge` is taken by an unrelated read-only package,
which is why this one is published under a scope.

## Requirements

- A DSH build whose profile composes `@deepseek-ai/dsh-web-app` (both the
  desktop app and `dsh web` do). That bundle mounts
  `@deepseek-ai/dsh-api-session-controller`, which provides the
  `sessionController` service this plugin injects.
- Node.js ≥ 20 for the bundled command-line client. The plugin itself uses the
  host's runtime and has **no dependencies**.

## Install

### Ask your agent

If your session runs the `cordis` agent preset, the agent has a plugin-management
tool and can do the whole thing itself — just say:

```
安装插件 @ignotuss/dsh-desktop-bridge
```

The `standard` and `ptc` presets switch that tool off; on those presets the agent
has no way to install anything and must fall back to the commands below. In the
desktop app, switch the preset under Settings → Agent preset first if you want
the by-chat route.

### CLI-managed profiles (`web`, `tui`, `headless`)

```bash
dsh plugin --profile web add @ignotuss/dsh-desktop-bridge
```

The package is a bundle: its `cordis.patch.yml` mounts the plugin, so installing
is also enabling. Restart the profile (or rely on HMR where it is switched on),
then confirm the plugin is listed as active under Settings → Plugins.

### DSH Desktop

The desktop app owns its profile, so the CLI refuses it by design. Use
**Plugins → Add plugin** in the sidebar with the package name (or a local
checkout path) and choose **Enable now**. To pick up an edited source file later,
toggle that plugin's switch off and on again — a live profile recomposes in
place, no app restart needed.

## Use

Installing the package also installs a `dsh-desktop-bridge` command:

```bash
dsh-desktop-bridge list
dsh-desktop-bridge create ~/projects/demo "Release triage"
dsh-desktop-bridge events session-1f0e…-… 50
dsh-desktop-bridge send session-1f0e…-… "Please summarise the failing tests."
```

Every request needs the bearer token from `<DSH_HOME>/desktop-bridge.json`, which
the plugin writes on mount and deletes on unmount:

```json
{
  "version": 1,
  "address": "127.0.0.1",
  "port": 63339,
  "token": "…64 hex characters…",
  "pid": 30820,
  "startedAt": "2026-10-02T02:31:07.114Z"
}
```

The port and the token are regenerated on every mount, so re-read the file after
a reload instead of caching it.

| Method | Path | Body / query | Result |
|---|---|---|---|
| `GET` | `/v1/sessions` | — | `200 {items: […]}`, the host's session list with live projections |
| `POST` | `/v1/sessions` | `{cwd, title?}` | `201` with the created session, `400` on a bad `cwd`/`title`, `403` when disabled or outside the allowlist |
| `GET` | `/v1/sessions/{id}/events` | `?limit=1..100` (default 30) | `200 {sessionId, events: […]}` — the tail of the event log |
| `POST` | `/v1/sessions/{id}/messages` | `{text}` (1–4096 bytes) | `200 {accepted, requestId}`; the text is appended as a user turn |

With `curl`:

```bash
read -r PORT TOKEN < <(node -e '
  const d = require("node:fs").readFileSync(process.env.DSH_HOME + "/desktop-bridge.json", "utf8")
  const j = JSON.parse(d); console.log(j.port, j.token)')

curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/sessions"
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cwd":"/home/me/projects/demo","title":"Release triage"}' \
  "http://127.0.0.1:$PORT/v1/sessions"
```

Requests carrying a browser `Origin` header are refused, and `Host` must name the
loopback address and port, so a web page cannot reach the bridge even by DNS
rebinding.

### Wait for the turn

`send` returns after admission by default. Add `--wait` to wait for the turn
that belongs to this request, not merely for the session to become idle:

```bash
dsh-desktop-bridge send session-1f0e…-… --wait --timeout 45 "Keep going until the tests pass."
```

`--timeout` is in seconds, defaults to 30, and accepts 1–3600. The command prints
JSON with `status`:

- `replied` — the turn completed; `turn` and `reply` hold the assistant text.
- `input-required` — the host is waiting for a human; `pendingInput` names
  `approval`, `question` or `other`.
- `timeout` — the deadline passed; `timeoutSeconds` is echoed and the accepted
  prompt is left running, not cancelled or resent.
- `turn-ended` — the turn ended for another reason; `reason` records it.

Exit codes are `0` replied, `124` timeout, `3` input-required, `1` other
turn/HTTP failure, and `2` usage. Without `--wait`, `send` keeps the immediate
`{accepted, requestId}` response. The wait follows the request id and its turn,
so an earlier queued turn or another session cannot become the result. The same
wait is available as `?wait=1&timeout=<seconds>` on
`POST /v1/sessions/{id}/messages`.

## Configuration

The plugin reads an optional `config` block from its patch row; every key is
optional and the permissive value is the default:

```yaml
- id: desktop-bridge
  config:
    allowCreate: false        # default true — false rejects POST /v1/sessions
    auditLog: true            # default true — one JSON line per request
    cwdAllowlist:             # default [] — no restriction
      - 'C:\work'
```

- **`allowCreate`** — `false` leaves listing, reading and messaging working while
  removing the ability to start new agents.
- **`auditLog`** — appends one JSON line per request to
  `<DSH_HOME>/desktop-bridge.log`: time, method, path, route, status, duration and
  the target directory or session id. Never the token, never the message text.
- **`cwdAllowlist`** — when non-empty, a new session may only be created inside
  one of these directories (subdirectories included).

Paths given to `POST /v1/sessions` must already exist as directories; the bridge
does not create them.

## Compatibility

The bridge is checked against the published
`@deepseek-ai/dsh-api-session-controller` type contracts. DSH `0.2.0-rc.2`
exposes `inspect`; DSH `0.2.2-rc.5` exposes `events`. The bridge uses `events`
when present and falls back to `inspect` for older releases. Both contracts
document `prompt` mode `queue | steer`, so the bridge sends `queue`.

On macOS DSH NEXT 2.0.24-next (bundled DSH 0.2.2-rc.5), the desktop stayed
running, a CLI prompt reached the same session and its reply appeared in the UI,
and the CLI read it back.

The plugin is a thin layer over five `sessionController` methods — `list`,
`inspect`/`events`, `prompt`, `create`, `rename` — and depends on no other
internal API. If a DSH release renames them, the affected route answers `500 DSH
request failed` and the real message is written to the audit log; nothing else in
the app is disturbed.

An install that fails for a missing service reports
`sessionController is unavailable` in the plugin's startup log rather than
mounting a half-working bridge.

## Development

```bash
node --test          # 41 tests: routing, policy, audit, wait correlation, descriptor lifecycle
```

The tests bind ephemeral loopback ports and use a stub controller, so they need
no DSH running.

## License

MIT — see [LICENSE](./LICENSE).
