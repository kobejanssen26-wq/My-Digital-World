# Security & privacy

## Data that leaves your computer (per event)
Event id, timestamp, session id, source label (`claude-code-hook@<8 hex of hashed hostname>`), event type, project identity keys (salted path hash, normalized git remote), project name (repo/folder name), repo identity (`github.com/owner/repo`), project type (react/node/python…), deploy tooling names (cloudflare/vercel…), tool **name** and **category**, durations, notification type, subagent type, and — if enabled — a redacted summary (≤140 chars) of your request.

## Data that never leaves
Full prompts, assistant replies, source code, file contents or paths, shell commands and their output, environment variables, transcripts, absolute directory paths. The server's strict schema **rejects** events carrying unknown fields, so a bug cannot silently start uploading them.

Switches (`mdw-bridge config set sync.<name> false`): `promptSummaries`, `repoIdentity` (also replaces the remote key by a salted hash), `projectNames` (uses `project-xxxxxx`). Summaries pass through secret redaction (API keys, tokens, JWTs, private keys, `password=…`, long hex/base64), path and e-mail removal, code-block removal.

## Retention
Raw events: configurable (default 90 days), pruned every 15 min. Projects/tasks/sessions are kept until you delete them. Local: spool files are deleted on acknowledgement; `~/.mdw` can be wiped with `mdw-bridge purge`.

## Controls
* **Dashboard auth**: single admin password, PBKDF2-SHA256 (100k iterations, constant-time compare, work done even if unconfigured), login rate-limited, session token random 256-bit, only its SHA-256 stored, cookie `__Host-` `Secure; HttpOnly; SameSite=Strict`, 14-day expiry, server-side logout. All dashboard routes and the WebSocket upgrade require the session server-side.
* **CSRF**: SameSite=Strict + required `X-CSRF-Token` + `Origin` check on every unsafe method; no CORS headers at all (same origin only); WebSocket upgrade checks `Origin`.
* **Bridge credential**: separate random `mdw_…` bearer, stored hashed, per-credential rate limit, shown once, revocable instantly, cannot be used on dashboard routes (and vice-versa).
* **Local bridge**: no payload-accepting network port. The daemon listens on `127.0.0.1` only for `/wake` and `/status`, requires a local secret header and refuses requests with an `Origin` (so web pages can't call it). Hooks hand events over via a `0700` spool directory. The dashboard cannot execute anything on your machine: no terminal, no filesystem browsing, no commands channel exists.
* **Validation**: zod on every ingest field, 512 KB / 100-event limits, parameterized SQL everywhere, `LIKE` wildcards escaped, text sanitized, no `innerHTML`/`dangerouslySetInnerHTML` in the frontend.
* **Headers**: CSP (`default-src 'self'`, no inline script), `nosniff`, `no-referrer`, frame denial, `Cache-Control: no-store` on API.
* **Files**: authenticated only; private R2 (no public URL, no credentials in the browser); 25 MB cap and configurable quota; blocked executable extensions; magic-byte check for images/PDF; downloads are `attachment` + `application/octet-stream` + `nosniff` unless allow-listed (png/jpeg/gif/webp/plain/json/pdf) *and* requested inline, and then sandboxed by CSP; storage keys are random ids, never filenames. Authenticated Worker streaming is used instead of presigned URLs so no storage credential or long-lived URL exists.
* **Secrets**: nothing committed (`.dev.vars`, `.env`, `wrangler.generated.json` are git-ignored); only one Cloudflare secret exists.

## Revocation / rotation
Revoke a bridge credential in Settings, then `mdw-bridge disconnect` locally. Rotate the password with `setup-secrets --remote`. Remove all data: delete the D1 database and R2 bucket.
