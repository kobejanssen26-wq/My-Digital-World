#!/usr/bin/env node
// Generates the dashboard password hash and stores it where the Worker reads it.
//   node scripts/setup-secrets.mjs --local     -> apps/worker/.dev.vars (gitignored)
//   node scripts/setup-secrets.mjs --remote    -> `wrangler secret put ADMIN_PASSWORD_HASH` (Cloudflare secret store)
// Options: --password <pw> (otherwise a strong one is generated and shown ONCE), --config <wrangler config>
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(root, 'apps', 'worker');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);

if (!flag('--local') && !flag('--remote')) {
  console.error('Usage: node scripts/setup-secrets.mjs (--local | --remote) [--password <pw>] [--config <file>]');
  process.exit(1);
}

const generated = !opt('--password');
const password = opt('--password') ?? randomBytes(18).toString('base64url');
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
const ITER = 100_000; // maximum supported by the Workers WebCrypto implementation
const salt = randomBytes(16);
const hash = `pbkdf2$${ITER}$${salt.toString('base64')}$${pbkdf2Sync(password, salt, ITER, 32, 'sha256').toString('base64')}`;

if (flag('--local')) {
  const file = join(worker, '.dev.vars');
  const keep = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('ADMIN_PASSWORD_HASH=')) : [];
  writeFileSync(file, [...keep, `ADMIN_PASSWORD_HASH="${hash}"`].join('\n') + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  console.log(`Wrote ${file} (gitignored).`);
} else {
  const cfg = opt('--config');
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'ADMIN_PASSWORD_HASH', ...(cfg ? ['--config', cfg] : [])], { cwd: worker, input: hash, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error('wrangler secret put failed. Are you logged in (npx wrangler login) or is CLOUDFLARE_API_TOKEN set? The Worker must exist: run the first deploy once, then re-run this.');
    process.exit(r.status ?? 1);
  }
}
if (generated) console.log(`\nDashboard password (shown once, store it in a password manager):\n\n  ${password}\n`);
else console.log('Password hash stored. (The password you supplied is not saved anywhere.)');
