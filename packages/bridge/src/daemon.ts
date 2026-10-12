import { createServer } from 'node:http';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig, type BridgeConfig } from './config.js';
import { flushOnce, refreshCounts, writeStatus, type DeliveryStatus } from './deliver.js';
import { ensureDirs, paths } from './paths.js';
import { queueDepth } from './spool.js';

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function acquireLock(): boolean {
  ensureDirs();
  try {
    const fd = openSync(paths.lock(), 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      const pid = Number(readFileSync(paths.lock(), 'utf8'));
      process.kill(pid, 0); // throws if dead
      return false;
    } catch {
      try {
        unlinkSync(paths.lock());
      } catch {
        /* race */
      }
      return acquireLock();
    }
  }
}

export function daemonRunning(): boolean {
  try {
    process.kill(Number(readFileSync(paths.lock(), 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Long-running delivery service. The only network listener is bound to 127.0.0.1 and exposes
 * `POST /wake` and `GET /status` behind a local secret; it accepts no event payloads and serves
 * no files, so nothing on the network (or any web page) can inject events or read local data.
 */
export async function runDaemon(cfgIn?: BridgeConfig): Promise<void> {
  const cfg = cfgIn ?? loadConfig();
  if (!cfg || !cfg.token || !cfg.url) throw new Error('Not configured. Run: mdw-bridge init --url <https://...> --token <mdw_...>');
  if (!acquireLock()) {
    console.log('mdw-bridge: already running');
    return;
  }
  const status: DeliveryStatus = {
    health: 'idle', queued: queueDepth(), rejected: 0, lastSuccessAt: null, lastAttemptAt: null, lastError: null, delivered: 0, nextRetryAt: null,
    pid: process.pid, url: cfg.url, startedAt: Date.now(),
  };
  let flushing = false;
  let backoff = 0;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    status.nextRetryAt = Date.now() + ms;
    timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    if (flushing) return;
    flushing = true;
    try {
      if (queueDepth() > 0) {
        const r = await flushOnce(cfg, status);
        backoff = r.retry ? Math.min(backoff ? backoff * 2 : 2000, 5 * 60_000) : 0; // exponential backoff, max 5 min
      } else {
        backoff = 0;
        if (status.health !== 'ok' && status.health !== 'idle') status.health = 'idle';
      }
    } catch (e) {
      status.health = 'error';
      status.lastError = (e as Error).message.slice(0, 200);
      backoff = Math.min(backoff ? backoff * 2 : 2000, 5 * 60_000);
    } finally {
      flushing = false;
      writeStatus(status);
      schedule(backoff || 3000);
    }
  };

  const server = createServer((req, res) => {
    const ok = eq(String(req.headers['x-mdw-local-token'] ?? ''), cfg.localToken) && !req.headers.origin;
    if (!ok) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/wake') {
      res.writeHead(204).end();
      backoff = status.health === 'unauthorized' ? backoff : 0;
      void tick();
    } else if (req.method === 'GET' && req.url === '/status') {
      refreshCounts(status);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...status, version: 1 }));
    } else res.writeHead(404).end();
  });
  server.on('error', (e) => console.error('mdw-bridge: local endpoint error:', (e as Error).message));
  server.listen(cfg.port, '127.0.0.1');

  const stop = () => {
    try {
      unlinkSync(paths.lock());
    } catch {
      /* ignore */
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`mdw-bridge: running (pid ${process.pid}), delivering to ${cfg.url}`);
  void tick();
  await new Promise(() => undefined);
}

export function lockExists() {
  return existsSync(paths.lock());
}
