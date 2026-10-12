# Cloudflare deployment

One Worker serves the API, the WebSocket Hub (Durable Object) **and** the static frontend (Workers Static Assets), so the app is same-origin: no CORS, simple cookies. Resources used (all named in `apps/worker/wrangler.json`, nothing else is touched): Worker `my-digital-world`, D1 `mdw`, R2 `mdw-files`, Durable Object class `Hub`, a 15-minute cron.

## Prerequisites
* `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts Edit, D1 Edit, R2 Edit; add Zone → DNS/Workers Routes Edit for a custom domain) and `CLOUDFLARE_ACCOUNT_ID` — or `npx wrangler login`.
* For the personal cloud: enable R2 in the dashboard once. Without R2 use `--no-r2` (file features report "unavailable", everything else works).

## Deploy
```bash
node scripts/deploy.mjs --domain world.example.com      # --no-r2 to skip storage, --dry-run to validate only
node scripts/setup-secrets.mjs --remote --config wrangler.generated.json   # first deploy only: sets ADMIN_PASSWORD_HASH
```
`deploy.mjs` builds the frontend, creates/reuses D1 and R2, writes `apps/worker/wrangler.generated.json` (git-ignored, contains your database id), applies migrations (`wrangler d1 migrations apply --remote`), and deploys. `database_id` in the committed `wrangler.json` is a placeholder on purpose.

## Custom domain
`--domain` adds a Workers **Custom Domain** (`custom_domain: true`): Cloudflare creates the DNS record and certificate automatically **if the zone is on the same Cloudflare account**. If the domain's DNS lives elsewhere, either move the zone to Cloudflare, or create a CNAME to the `*.workers.dev` hostname through a Cloudflare-proxied zone — Cloudflare cannot issue the certificate otherwise. Verify with `curl -sI https://world.example.com/api/health` (expect `200`, `{"ok":true}`). The domain is not "live" until you have done that.

## Git-based deployment
`.github/workflows/ci.yml` runs verification on every push. `.github/workflows/deploy.yml` deploys on push to `main` (set secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, optional variable `MDW_DOMAIN`). Alternatively connect the repo in Cloudflare → Workers → *Builds* with build command `npm ci --legacy-peer-deps && npm run build` and deploy command `node scripts/deploy.mjs`.

## Secrets & rotation
* `ADMIN_PASSWORD_HASH` — the only Worker secret (PBKDF2-SHA256, 100k iterations, the Workers maximum). Rotate: run `setup-secrets --remote` again; existing sessions stay valid until they expire (14 days) — to force logout run `DELETE FROM auth_sessions` via `wrangler d1 execute mdw --remote --command "DELETE FROM auth_sessions"`.
* Bridge credentials live in D1 (hashed). Revoke in **Settings**; effective immediately.

## Backups
`npm run export` (JSON of projects/tasks/events/settings/file metadata) or full SQL: `npx wrangler d1 export mdw --remote --output backup.sql`. R2 file contents are not included in either; use `rclone`/R2 tooling for those.

## Limits & cost (verify current numbers at developers.cloudflare.com — they change)
Everything above is designed for the free tiers of Workers, D1 and Durable Objects (SQLite-backed class) for a single user; R2 has a free allowance but requires a payment method. A very chatty session emits one event per tool call; the event log is pruned by the retention setting. Rate limits: 600 bridge requests/min per credential, 8 login attempts / 15 min per IP.
