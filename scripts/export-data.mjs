#!/usr/bin/env node
// Backup: downloads a JSON export of projects/tasks/events/settings/file metadata (no secrets, no file contents).
//   MDW_URL=https://your-domain MDW_PASSWORD=... node scripts/export-data.mjs [out.json]
// For a full SQL backup use: npx wrangler d1 export mdw --remote --output backup.sql
import { writeFileSync } from 'node:fs';

const url = process.env.MDW_URL;
const password = process.env.MDW_PASSWORD;
if (!url || !password) {
  console.error('Set MDW_URL and MDW_PASSWORD');
  process.exit(1);
}
const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
if (!login.ok) {
  console.error(`Login failed (${login.status})`);
  process.exit(1);
}
const cookie = login.headers.get('set-cookie').split(';')[0];
const res = await fetch(`${url}/api/export`, { headers: { cookie } });
if (!res.ok) {
  console.error(`Export failed (${res.status})`);
  process.exit(1);
}
const file = process.argv[2] ?? `mdw-export-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
console.log(`Wrote ${file}`);
