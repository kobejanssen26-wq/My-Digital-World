# Installation

Requirements: Node ≥ 20, git, a Cloudflare account (free plan works for the Worker + D1; R2 needs a payment method on file even though its free tier is generous).

## 1. Build
```bash
npm ci --legacy-peer-deps
npm run verify          # typecheck, lint, tests, build
```

## 2. Run the backend
*Local development* (separate, disposable database — never mixes with production):
```bash
node scripts/setup-secrets.mjs --local
npm -w @mdw/worker run migrate:local
npm run dev:worker
```
*Production:* see [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md).

## 3. Connect your computer
1. Open the dashboard → **Settings → Claude Code bridge → Create bridge credential**. Copy the shown command (the credential is displayed once).
2. Make the CLI available (from the repo): `node packages/bridge/dist/mdw-bridge.js …` or `npm link -w @mdw/bridge` to get `mdw-bridge` on your PATH.
3. ```bash
   mdw-bridge init --url https://your-domain --token mdw_xxx   # saves ~/.mdw/config.json (0600) and tests the connection
   mdw-bridge install-hooks                                       # merges into ~/.claude/settings.json (backup first)
   mdw-bridge install-service                                     # optional: start at login (systemd --user / launchd / schtasks)
   mdw-bridge status
   ```
4. Restart any running Claude Code session (hooks load at session start) and use Claude Code normally.

You do **not** need the service: the hook starts the daemon on demand if it is not running. The service only guarantees queued events are delivered even when you are not using Claude Code.

> Don't claim it works until `mdw-bridge status` shows "reachable, authenticated" and the dashboard shows "Receiving events" after a real prompt.

## Local development without contaminating real data
Use a separate data dir and a local Worker: `MDW_HOME=~/.mdw-dev mdw-bridge init --url http://127.0.0.1:8787 --token …` and `mdw-bridge install-hooks --project <test-project-dir>` (writes `.claude/settings.local.json` only in that project).
