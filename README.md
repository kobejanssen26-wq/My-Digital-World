# My Digital World

A private, personal command center that **automatically** turns your real Claude Code activity into an interactive 3D city — plus a project/task/activity dashboard and a small personal cloud.

You keep using Claude Code exactly as before. A tiny local *bridge* listens to Claude Code's documented hooks, strips everything private, and forwards compact events to your own Cloudflare Worker. Projects, tasks and statuses are derived from those events; nothing is entered by hand and nothing is simulated.

```
Claude Code ──hooks──▶ mdw-hook ──▶ ~/.mdw/spool (durable queue) ──▶ mdw-bridge daemon ──HTTPS+bearer──▶ Worker /api/ingest
                                                                                                       │ (validate, dedupe, reduce, persist in D1)
Browser ◀──WebSocket (Durable Object Hub)◀── delta ◀─────────────────────────────────────────────────┘
```

| Part | Path | Stack |
|---|---|---|
| Shared domain (event schema, classifier, state machine, world layout) | `packages/shared` | TypeScript, zod |
| Local bridge + hook + installer | `packages/bridge` | Node ≥ 20, esbuild |
| API, realtime, storage | `apps/worker` | Cloudflare Workers, Hono, D1, Durable Objects, R2 |
| Dashboard + 3D city | `apps/web` | React, Vite, three.js / React Three Fiber, zustand |

## Quick start (local)
```bash
npm ci --legacy-peer-deps
npm run build
node scripts/setup-secrets.mjs --local            # prints a generated dashboard password once
npm -w @mdw/worker run migrate:local
npm run dev:worker                                 # http://localhost:8787 (API + built frontend)
```
Then follow [docs/INSTALLATION.md](docs/INSTALLATION.md) to connect Claude Code, and [docs/CLOUDFLARE_DEPLOYMENT.md](docs/CLOUDFLARE_DEPLOYMENT.md) to go live on your domain.

## Documentation
[Installation](docs/INSTALLATION.md) · [Cloudflare deployment](docs/CLOUDFLARE_DEPLOYMENT.md) · [Claude Code integration](docs/CLAUDE_CODE_INTEGRATION.md) · [State mapping rules](docs/STATE_MAPPING.md) · [Security & privacy](docs/SECURITY_PRIVACY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Uninstall](docs/UNINSTALL.md) · [Status](IMPLEMENTATION_STATUS.md)

## Commands
`npm run verify` (typecheck + lint + all tests + build) · `npm run deploy` · `npm run setup:secrets` · `npm run export`
