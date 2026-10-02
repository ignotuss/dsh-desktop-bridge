# Security model

This plugin deliberately hands a powerful capability to local programs. Read this
before installing it, and decide whether the trade is one you want.

## What the token grants

`<DSH_HOME>/desktop-bridge.json` holds a 32-byte random token. Whoever reads it
can, until the plugin is disabled:

- **list every session** on the host, with its live projections (titles, token
  usage, working directory, running state);
- **read the event log** of any session — that is the full transcript, including
  tool calls and their results;
- **send text into any session** as a user turn, which on a running session means
  steering an agent that has your tools and your permissions;
- **create sessions** in any existing directory (unless `cwdAllowlist` is set),
  each one an agent that starts working under your account.

Treat the token exactly like an SSH key for your agent sessions. The file is
written with mode `0600`, deleted when the plugin unloads, and regenerated — with
a new port — on every mount.

## Threat model

| Adversary | Reaches the bridge? |
|---|---|
| A program running as **you** on this machine | **Yes, by design.** It can read the descriptor. This plugin cannot defend against your own processes; nothing on a single-user machine can. |
| **Another user** on the same machine | Normally no. The listener binds `127.0.0.1`, and the descriptor sits under your home. On Windows the `0600` mode is *not* enforced (NTFS ignores POSIX permission bits), so protection rests on your profile directory's ACL. |
| A **web page** in your browser | No. Requests carrying an `Origin` header are refused, and `Host` must name the loopback address and port, which defeats DNS rebinding. |
| A host on your **network** | No. The listener never binds a non-loopback address and there is no remote mode. |
| A **malicious plugin or dependency** in your profile | Yes — it runs in the same process and could read the token or call the controller directly. Installing plugins is installing code. |

## What the plugin does *not* do

- No file operations, no configuration writes, no shell execution of its own.
- No access to credentials, account tokens or the DSH settings store.
- No network egress; it only answers on loopback.
- The audit log records method, path, route, status, duration and the target
  directory or session id — never the token, never message text.

## Reducing the blast radius

1. **Disable the plugin when you are done.** The listener and the descriptor go
   away together; a stale descriptor cannot be used against a fresh mount.
2. **Set `allowCreate: false`** if you only need to observe and steer sessions
   that already exist. That removes the ability to start new agents.
3. **Set `cwdAllowlist`** to the directories you actually work in, so a caller
   cannot plant a session anywhere on the disk.
4. **Run `curl`-driven automation as a short-lived task**, not a long-running
   daemon that keeps the descriptor in memory.
5. **Rotate by toggling.** Disabling and re-enabling the plugin mints a new token
   and port immediately.

## Reporting

Open an issue for anything that reads as a weakness in the model above. If you
believe you have found a way to reach the bridge from outside the three "No"
rows, say so plainly and include the DSH version, the platform and the exact
request sequence.
