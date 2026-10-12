# Implementation status

_Last updated: 2026-10-12. Everything below marked ✅ was executed in this repo; ⚠️ means not verified; ⛔ means blocked._

## Completed
* ✅ Monorepo: `packages/shared`, `packages/bridge`, `apps/worker`, `apps/web`.
* ✅ **Worker**: Hono API; D1 schema + migration (`apps/worker/migrations/0001_init.sql`, FKs, indexes); idempotent event ingestion with out-of-order handling; Durable Object `Hub` serializing mutations and broadcasting deltas over hibernatable WebSockets; session-cookie auth + CSRF + origin checks + rate limits; revocable hashed bridge credentials; search; settings; JSON export; R2-backed file library (upload/list/download/preview/delete/folders/quota); cron maintenance (stale sessions → lost/interrupted, retention).
* ✅ **Bridge**: hook entry (`mdw-hook`), normalizer/sanitizer/classifier, git-based project identity, durable spool, delivery daemon with backoff/dedupe/quarantine, safe settings merge/uninstall, start-at-login installers (systemd/launchd/schtasks — *code written; only the hook-autostart path was exercised on Linux*).
* ✅ **Web**: login, World (3D city: 9 districts, roads, trees, instanced details, vehicles/small buildings per project, animated along a road graph, orbit/zoom/pan, focus/reset, minimap, hover/click, filters, name search, project and building panels), Projects, Activity (filters, pagination), Tasks, Cloud, Settings (bridge credentials, display, retention, export); empty/loading/error states; reduced-motion + lightweight + list-view fallback when WebGL is missing or 3D is off.
* ✅ Docs: README, Installation, Cloudflare deployment, Claude Code integration, State mapping, Security & privacy, Troubleshooting, Uninstall; `.env.example`; CI/deploy workflows; `scripts/deploy.mjs`, `setup-secrets.mjs`, `export-data.mjs`, `e2e-browser.mjs`.

## Verification results (this environment)
| Check | Result |
|---|---|
| `npm run typecheck` (4 packages) | ✅ clean |
| `npm run lint` | ✅ clean |
| Unit/integration tests | ✅ **182 passing**: shared 68, bridge 37, web 25, worker 52 (the worker tests run inside real workerd via Miniflare: real D1, Durable Object, R2, WebSockets) |
| `npm run build` | ✅ frontend (three.js lazy-loaded chunk ≈ 176 kB gz) + bridge bundles |
| `scripts/deploy.mjs --dry-run` | ✅ Worker bundles, config valid |
| **Real Claude Code → bridge → backend** | ✅ Ran the real `claude -p` CLI (v2.1.296) with the hooks installed through `mdw-bridge install-hooks --project`; the auto-started daemon delivered `session.start, prompt.submit, tool.done(modify/shell), turn.stop, session.end` to a local `wrangler dev` Worker; a project (`e2e-demo`, react, `github.com/demo/e2e-demo`) and task were created automatically, ended `completed` with basis `claude_finished_session_closed`, building `completed`. Queue returned to 0. |
| Real-browser check (`scripts/e2e-browser.mjs`, headless Chromium + SwiftShader WebGL) | ✅ 9/9: wrong-password UI error, login, WebGL canvas, live WebSocket update of a new project (no reload), failing test → Repair Workshop, project details, activity feed, persistence across reload, zoom/reset without console errors. Screenshots were inspected: the city renders and the workshop beacon turns red. |
| Bugs found by the real run and fixed | duplicate shebang in the bundled hook (hook crashed); async `Stop` dropped in `claude -p` (end-of-turn hooks now sync); `node x.test.js` not recognized as a test run; folder uniqueness at root (NULL parent). |

## Not verified / blocked
* ⛔ **Production deployment, custom domain, Cloudflare bindings, production migrations**: no Cloudflare credentials, no domain name and no `wrangler login` are available in this sandbox. Nothing is deployed and **no URL is live**. Steps: `docs/CLOUDFLARE_DEPLOYMENT.md` (`node scripts/deploy.mjs --domain <yours>` then `setup-secrets --remote`). The generated config and bundle were validated with `--dry-run` only.
* ⚠️ Real-hook test was `claude -p` (print mode) on Linux. Interactive sessions, the `Notification`/`SubagentStart`/`SubagentStop`/`PreToolUse` hooks and Windows/macOS were covered by unit tests of the documented payload shapes, not by live runs.
* ⚠️ `install-service` was not executed here (no user systemd). Hooks start the daemon on demand regardless.
* ⚠️ R2 behaviour verified against Miniflare's R2 simulator, not real R2.
* ⚠️ The 3D scene was checked through software rendering screenshots at one viewport; no GPU performance measurement; large project counts (>16 per district) overlap slots (cosmetic).
* ⚠️ Cloudflare free-tier limits were not re-checked live; `docs/CLOUDFLARE_DEPLOYMENT.md` tells you to verify them.

## Known limitations / design decisions
* Single user, single password (no OAuth/SSO). Rotating the password does not invalidate existing sessions (documented SQL to do so).
* Completion is evidence-based, not proof: "Completed" only means Claude finished and the session was closed (or you marked it). Tests/deploy are separate fields; "deployed" never means the live site was verified.
* `UserPromptSubmit` also fires for scheduled/`/loop` prompts; they are treated as requests.
* Identity keys of a project include the git remote (salted-hashed when `repoIdentity=false`), so one repo cloned twice is one project by design.
* Uses Worker-streamed authenticated downloads rather than presigned R2 URLs (no storage credentials in the browser); uploads are buffered (25 MB cap).

## Costs
Workers + D1 + Durable Objects (SQLite) — free plan sufficient for one user (verify limits). R2 — free allowance but requires a payment method; use `--no-r2` to avoid it. Domain registration/DNS is yours. No other services.
