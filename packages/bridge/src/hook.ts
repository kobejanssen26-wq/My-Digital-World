/**
 * Claude Code hook entry point. Reads the hook JSON from stdin, writes a sanitized event to the
 * durable spool, then nudges (or starts) the local delivery daemon. It must never fail loudly or
 * block Claude Code: every path exits 0 with no stdout.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { envConfig, loadConfig } from './config.js';
import { flushOnce, type DeliveryStatus } from './deliver.js';
import { hooksInstalled, installHooks, userSettingsPath } from './settings-install.js';
import { fileURLToPath } from 'node:url';
import { daemonRunning } from './daemon.js';
import { normalize, type HookInput } from './normalize.js';
import { ensureDirs, paths } from './paths.js';
import { enqueue } from './spool.js';
import { join } from 'node:path';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 3000).unref();
  });
}

function wake(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/wake', method: 'POST', headers: { 'x-mdw-local-token': token }, timeout: 400 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => (req.destroy(), resolve(false)));
    req.end();
  });
}

/** Start the daemon detached if it is not running (at most once per 30s). */
function ensureDaemon() {
  try {
    if (process.env.MDW_NO_AUTOSTART === '1' || daemonRunning()) return;
    const marker = join(paths.state(), 'spawn.marker');
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 30_000) return;
    writeFileSync(marker, String(Date.now()));
    const cli = join(import.meta.dirname, 'mdw-bridge.js');
    spawn(process.execPath, [cli, 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  } catch {
    /* best effort */
  }
}

/**
 * Cloud mode (credentials in MDW_URL / MDW_TOKEN, e.g. a Claude Code cloud environment): there is no
 * long-running daemon, so the hook delivers directly with a short timeout. Anything that fails stays in
 * the spool and is retried by the next hook in the same VM.
 */
async function deliverNow(cfg: NonNullable<ReturnType<typeof envConfig>>) {
  const st: DeliveryStatus = { health: 'idle', queued: 0, rejected: 0, lastSuccessAt: null, lastAttemptAt: null, lastError: null, delivered: 0, nextRetryAt: null, pid: process.pid, url: cfg.url, startedAt: Date.now() };
  await flushOnce(cfg, st, { timeoutMs: 4000 });
}

async function main() {
  if (process.argv.includes('--install')) {
    // `node mdw-hook.js --install`: register this file as a user-level hook (used by the cloud setup script).
    const r = installHooks(userSettingsPath(), fileURLToPath(import.meta.url));
    console.log(`mdw: hooks installed in ${r.file} (${hooksInstalled(r.file).length} events)`);
    return;
  }
  const cloud = envConfig();
  const cfg = cloud ?? loadConfig();
  if (!cfg || !cfg.token) return; // not set up: do nothing, silently
  ensureDirs();
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    return;
  }
  const ev = normalize(input, cfg);
  if (!ev) return;
  enqueue(ev);
  if (cloud) await deliverNow(cloud);
  else if (!(await wake(cfg.port, cfg.localToken))) ensureDaemon();
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
