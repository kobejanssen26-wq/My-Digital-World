#!/usr/bin/env node
// Builds the bridge and publishes its hook file as a public static asset of the dashboard
// (https://<domain>/mdw-hook.js). It contains no secrets: credentials come from environment variables.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npm', ['run', 'build', '-w', '@mdw/bridge'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status ?? 1);
copyFileSync(join(root, 'packages/bridge/dist/mdw-hook.js'), join(root, 'apps/web/public/mdw-hook.js'));
console.log('published apps/web/public/mdw-hook.js');
