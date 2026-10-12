import { ack, peek, reject, queueDepth, rejectedCount } from './spool.js';
import type { BridgeConfig } from './config.js';
import { writeFileSync } from 'node:fs';
import { paths } from './paths.js';
import type { IngestResult } from '@mdw/shared';

export type Health = 'ok' | 'offline' | 'unauthorized' | 'idle' | 'error';

export interface DeliveryStatus {
  health: Health;
  queued: number;
  rejected: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  delivered: number;
  nextRetryAt: number | null;
  pid: number;
  url: string;
  startedAt: number;
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  batchSize?: number;
}

/**
 * Send queued events once. Returns the number delivered. Events leave the spool only on
 * acknowledgement; transient failures (network, 5xx, 429) keep them for the next attempt.
 */
export async function flushOnce(cfg: BridgeConfig, status: DeliveryStatus, opts: DeliverOptions = {}): Promise<{ sent: number; retry: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  let sent = 0;
  for (;;) {
    const batch = peek(opts.batchSize ?? 50);
    if (!batch.length) {
      status.health = status.lastError && status.health !== 'ok' ? status.health : 'ok';
      return { sent, retry: false };
    }
    status.lastAttemptAt = Date.now();
    let res: Response;
    try {
      res = await f(`${cfg.url}/api/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch.map((b) => b.event) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      status.health = 'offline';
      status.lastError = `network: ${(e as Error).message}`.slice(0, 200);
      return { sent, retry: true };
    }
    if (res.status === 401 || res.status === 403) {
      status.health = 'unauthorized';
      status.lastError = 'Credential rejected by the server (revoked or wrong). Run: mdw-bridge init';
      return { sent, retry: true };
    }
    if (res.status === 429 || res.status >= 500) {
      status.health = 'error';
      status.lastError = `server ${res.status}`;
      return { sent, retry: true };
    }
    if (!res.ok) {
      // A 4xx for the whole batch (e.g. 413/400): split to find the offender instead of looping forever.
      if (batch.length > 1) {
        const r = await flushOnce(cfg, status, { ...opts, batchSize: Math.max(1, Math.floor(batch.length / 2)) });
        return { sent: sent + r.sent, retry: r.retry };
      }
      reject(batch[0]!.file, `http_${res.status}`);
      continue;
    }
    const body = (await res.json()) as { results: IngestResult[] };
    const byId = new Map(body.results.map((r) => [r.id, r]));
    for (const q of batch) {
      const r = byId.get(q.event.id);
      if (!r) continue; // not acknowledged: keep it
      if (r.status === 'rejected') reject(q.file, r.reason);
      else {
        ack(q.file);
        sent++;
        status.delivered++;
      }
    }
    status.health = 'ok';
    status.lastError = null;
    status.lastSuccessAt = Date.now();
    if (!byId.size) return { sent, retry: true };
  }
}

export function refreshCounts(s: DeliveryStatus) {
  s.queued = queueDepth();
  s.rejected = rejectedCount();
}

export function writeStatus(s: DeliveryStatus) {
  refreshCounts(s);
  try {
    writeFileSync(paths.status(), JSON.stringify(s), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}
