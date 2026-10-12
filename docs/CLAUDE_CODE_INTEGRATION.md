# Claude Code integration

Verified against https://code.claude.com/docs/en/hooks (Claude Code 2.1.x). Nothing is invented: only documented hook names and input fields are read.

## What is installed
`mdw-bridge install-hooks` merges (never overwrites) these entries into `~/.claude/settings.json` (or `<project>/.claude/settings.local.json` with `--project`), after writing `settings.json.mdw-backup-<timestamp>`. Entries are identified by the `mdw-hook` file name in the command and are the only ones ever removed by `uninstall-hooks`. Invalid JSON is never touched.

| Claude Code hook | Bridge event | Notes |
|---|---|---|
| `SessionStart` (`source`) | `session.start` | startup / resume / clear / compact / fork |
| `UserPromptSubmit` (`prompt`) | `prompt.submit` | classified locally; only a redacted ≤140-char summary may leave the machine |
| `PreToolUse` matcher `Bash` | `tool.start` | emitted **only** for test/deploy-class commands (so "testing" is visible while running) |
| `PostToolUse` | `tool.done` | tool name + category only |
| `PostToolUseFailure` (`is_interrupt`) | `tool.fail` | interrupts flagged, not counted as failures |
| `Notification` (`notification_type`) | `notification` | `permission_prompt`, `idle_prompt`, … |
| `SubagentStart` / `SubagentStop` | `subagent.start/stop` | activity only |
| `Stop` | `turn.stop` | |
| `StopFailure` (`error`) | `turn.fail` | API errors |
| `SessionEnd` (`reason`) | `session.end` | |

`PostToolUse`, `PostToolUseFailure`, `Notification`, `PreToolUse`, `UserPromptSubmit`, `SessionStart`, `SubagentStart` run `async` (never delay Claude). `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd` run synchronously because the process may exit right after them (observed in `claude -p`, where async end-of-turn hooks were dropped). The hook takes tens of milliseconds, writes one file to the spool and exits 0 with no output, always.

Global hooks cover every project on the machine; the hook does nothing (silently) until `mdw-bridge init` has been run.

## Project detection
Identity keys, never raw paths: `remote:<host/owner/repo>` (normalized, credentials stripped) → `path:<salted hash of the git toplevel>` → `root:<first commit>`.
* same remote ⇒ same project (clones, worktrees, subfolders, concurrent sessions);
* same directory, remote renamed ⇒ same project (aliases are learned);
* same root commit, moved directory, no conflicting remote ⇒ same project; same root commit but a *different* remote and directory ⇒ a fork ⇒ new project;
* non-git directories and scripts ⇒ a project per directory hash; repos with no commits are flagged "new".
A project is created from the first event but stays **observed-only** (hidden from the world and metrics) until real development is seen: a non-question request or a modifying tool call.

## Tasks
Each request is classified conservatively (`question`, `bugfix`, `feature`, `refactor`, `experiment`, `build`, `continuation`, `other`). `continuation` and low-confidence `other` attach to the open task of that session instead of creating work; tool use without a prompt creates an `activity` task that a late-arriving prompt adopts. A new experiment in an existing repo is a task, never a new project. Details: [STATE_MAPPING.md](STATE_MAPPING.md).

## Reliability
Events have a unique id, timestamp, schema version, session id, source and sanitized data. They are written atomically to `~/.mdw/spool/` first; the daemon delivers in order with exponential backoff (2 s → 5 min), removes a file only after the server acknowledged it, treats duplicates as success, moves permanently rejected events to `~/.mdw/rejected/` (with a `.reason`), and bisects a failing batch so one bad event cannot block others. The server dedupes by event id, serializes processing through a Durable Object, orders by event time (an older event never overwrites newer state) and assigns a replay cursor. After a disconnect the browser refetches a snapshot and `/api/events?after=<cursor>` is available for replay.

## CLI
`mdw-bridge init | install-hooks | uninstall-hooks | install-service | uninstall-service | run | status | flush | config get/set | disconnect | purge`.

## Cloud sessions (Claude Code on the web / desktop app "Cloud")
Cloud sessions run on Anthropic's servers and do **not** read your PC's `~/.claude/settings.json`, so the local bridge cannot see them. Instead, register the hook inside the cloud environment (works for every repository using that environment):

1. Dashboard → Settings → *Create bridge credential* (name it e.g. `cloud`). Keep the `mdw_…` value.
2. Cloud environment menu (session title bar) → **Edit**:
   * **Environment variables:** `MDW_URL=https://your-domain` and `MDW_TOKEN=mdw_…`
   * **Network access:** allow the domain `your-domain` (Allowed domains).
   * **Setup script:** `curl -fsSL https://your-domain/install-cloud.sh | bash`
3. Start a **new** cloud session. The setup script downloads `https://your-domain/mdw-hook.js` (a public file without secrets) and registers it as a user-level hook in the VM. There is no daemon: each hook delivers directly (4 s timeout); events that cannot be delivered stay in the VM's `~/.mdw/spool` and are retried by the next hook, but are lost when the VM is reclaimed.
Project identity comes from the checkout's git remote, so the same repository is one project whether it ran locally or in the cloud.
