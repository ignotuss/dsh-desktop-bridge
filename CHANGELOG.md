# Changelog

## Unreleased

**Fixed**

- Pass the plugin config through Cordis's `apply(ctx, config)` contract instead
  of reading `ctx.config`.
- Read session events through `sessionController.events` on current DSH releases,
  keeping the `inspect` fallback for older releases.
- Send prompts with the documented `queue` mode.

**Added**

- `send --wait [--timeout <seconds>]` waits for the turn carrying the request
  and returns script-friendly JSON; without `--wait`, `send` keeps its immediate
  `{accepted, requestId}` response. The wait uses the request id and turn, pages
  back to a pre-send cursor so a busy log cannot hide the request or reply,
  bounds observation calls by the remaining timeout, leaves an accepted prompt
  running on timeout, reports `input-required` separately, and exits 4 rather
  than 0 when an older host returns only an immediate acceptance. Option parsing
  stops at the first text word, so literal `--help` prompts keep working; `--`
  escapes a leading reserved option. A waiting client disconnect stops observation
  without cancelling the accepted prompt, and `input-required` is reported only
  after rechecking the request turn's terminal state.

## 0.1.0 — 2026-10-02

First public release (`npm publish` at 2026-10-02T02:54:12Z, shasum
`21a7e9a98276c65483800132bf2ea91b600871c1`). Grown from a private single-file
bridge; the wire behaviour stays compatible with that original.

**Added**

- `POST /v1/sessions` — create a session in an existing directory, with an
  optional title applied through `sessionController.rename`.
- `dsh-desktop-bridge create|events|send|list` client, installed as a `bin`.
- Optional `config`: `allowCreate`, `auditLog`, `cwdAllowlist`.
- Per-request audit log at `<DSH_HOME>/desktop-bridge.log` (no token, no message
  text).
- CI on Ubuntu and Windows, Node 20 and 22; 23 tests covering routing, policy,
  auditing and the descriptor lifecycle.

**Hardened**

- `Host` must name the loopback address and port, closing DNS rebinding.
- `cwd` must be an existing directory, and must fall inside `cwdAllowlist` when
  one is configured.
- Internal failures answer a generic `500 DSH request failed`; the real message
  goes only to the local audit log.
- The descriptor is written through a unique temporary file and an atomic rename,
  and carries `startedAt` alongside `version`, `address`, `port`, `token`, `pid`.

**Documented**

- `SECURITY.md` states plainly what the token grants and against which adversary
  each control does and does not help.
- READMEs explain how the plugin differs from the other DSH bridges, and how the
  live-profile reload works.
