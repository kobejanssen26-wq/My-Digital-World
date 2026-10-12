#!/usr/bin/env node
// One-command production deploy to Cloudflare (Worker + static assets + D1 + R2 + Durable Object).
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/deploy.mjs [--domain mdw.example.com] [--no-r2] [--dry-run]
// It never touches other Workers/DNS records: it only creates/updates resources named in apps/worker/wrangler.json
// (worker "my-digital-world", D1 "mdw", R2 "mdw-files") and, with --domain, one Custom Domain for this Worker.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(root, 'apps', 'worker');
const args = process.argv.slice(2);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const dry = args.includes('--dry-run');
const domain = opt('--domain') ?? process.env.MDW_DOMAIN;
const noR2 = args.includes('--no-r2');

const run = (cmd, a, cwd = root, input) => {
  console.log(`\n$ ${cmd} ${a.join(' ')}`);
  return spawnSync(cmd, a, { cwd, encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'inherit'] : ['inherit', 'pipe', 'inherit'] });
};
const must = (r, what) => {
  if (r.status !== 0) {
    console.error(`\n✖ ${what} failed.`);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
};

if (!dry && !process.env.CLOUDFLARE_API_TOKEN) {
  const who = run('npx', ['wrangler', 'whoami'], worker);
  if (who.status !== 0 || /not authenticated/i.test(who.stdout)) {
    console.error('Not authenticated. Set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) or run `npx wrangler login`.');
    process.exit(1);
  }
}

must(run('npm', ['run', 'build', '-w', '@mdw/web']), 'frontend build');

const cfg = JSON.parse(readFileSync(join(worker, 'wrangler.json'), 'utf8'));
const out = join(worker, 'wrangler.generated.json');

if (!dry) {
  // D1: reuse if it exists, create otherwise.
  const list = must(run('npx', ['wrangler', 'd1', 'list', '--json'], worker), 'listing D1 databases');
  let db = JSON.parse(list).find((d) => d.name === cfg.d1_databases[0].database_name);
  if (!db) {
    console.log('Creating D1 database…');
    must(run('npx', ['wrangler', 'd1', 'create', cfg.d1_databases[0].database_name], worker), 'creating D1 database');
    db = JSON.parse(must(run('npx', ['wrangler', 'd1', 'list', '--json'], worker), 'listing D1 databases')).find((d) => d.name === cfg.d1_databases[0].database_name);
  }
  cfg.d1_databases[0].database_id = db.uuid;
}
if (noR2) delete cfg.r2_buckets;
else if (!dry) {
  const r = run('npx', ['wrangler', 'r2', 'bucket', 'create', cfg.r2_buckets[0].bucket_name], worker);
  if (r.status !== 0 && !/already exists/i.test(r.stdout + (r.stderr ?? ''))) {
    console.error('\n⚠ Could not create the R2 bucket (R2 must be enabled in the Cloudflare dashboard first). Re-run with --no-r2 to deploy without the personal cloud.');
    process.exit(1);
  }
}
if (domain) cfg.routes = [{ pattern: domain, custom_domain: true }];
writeFileSync(out, JSON.stringify(cfg, null, 2));

if (dry) {
  must(run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', '.wrangler/dry', '--config', 'wrangler.generated.json'], worker), 'dry-run bundle');
  console.log('\n✔ Dry run OK: the Worker bundles and the config is valid. Nothing was deployed.');
  process.exit(0);
}

must(run('npx', ['wrangler', 'd1', 'migrations', 'apply', cfg.d1_databases[0].database_name, '--remote', '--config', 'wrangler.generated.json'], worker), 'applying D1 migrations');
const dep = must(run('npx', ['wrangler', 'deploy', '--config', 'wrangler.generated.json'], worker), 'deploy');
console.log(dep);
console.log('\n✔ Deployed. Next:');
console.log('  1. node scripts/setup-secrets.mjs --remote --config wrangler.generated.json   (sets the dashboard password; first deploy only)');
console.log('  2. Open the URL above, sign in, Settings → Create bridge credential, then run `mdw-bridge init` on your computer.');
if (domain) console.log(`  3. Verify https://${domain} resolves (Custom Domains need the zone on this Cloudflare account) — see docs/CLOUDFLARE_DEPLOYMENT.md.`);
