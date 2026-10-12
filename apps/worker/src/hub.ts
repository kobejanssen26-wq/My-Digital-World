import { DurableObject } from 'cloudflare:workers';
import type { Delta, IngestResult, WsMessage } from '@mdw/shared';
import { ActionError, applyUserAction, maintenance, type UserAction } from './actions.js';
import type { Env } from './env.js';
import { currentCursor, ingestBatch } from './ingest.js';
import { loadSettings } from './rows.js';

/**
 * Single Hub instance: serializes every state mutation (ingest, user actions, maintenance)
 * and fans deltas out to authenticated dashboard WebSockets (hibernation API).
 * D1 remains the source of truth; the Hub holds no state of its own.
 */
export class Hub extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private broadcast(delta: Delta | null) {
    if (!delta) return;
    const msg = JSON.stringify(delta);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket closing */
      }
    }
  }

  async ingest(events: unknown[], source: string, tokenId: string): Promise<IngestResult[]> {
    return this.serial(async () => {
      const { results, delta } = await ingestBatch(this.env.DB, events);
      const now = Date.now();
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(now)),
        this.env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_source', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(source.slice(0, 80)),
        this.env.DB.prepare('UPDATE bridge_tokens SET last_used_at = ? WHERE id = ?').bind(now, tokenId),
      ]);
      if (delta) this.broadcast({ ...delta, bridge: { lastIngestAt: now, lastIngestSource: source } });
      return results;
    });
  }

  /** Errors are returned (not thrown) because class identity does not survive DO RPC. */
  async userAction(action: UserAction): Promise<{ ok: true; cursor: number } | { ok: false; status: number; error: string }> {
    return this.serial(async () => {
      try {
        const delta = await applyUserAction(this.env.DB, action);
        this.broadcast(delta);
        return { ok: true as const, cursor: delta.cursor };
      } catch (e) {
        if (e instanceof ActionError) return { ok: false as const, status: e.status, error: e.message };
        throw e;
      }
    });
  }

  async maintain(): Promise<void> {
    await this.serial(async () => {
      const s = await loadSettings(this.env.DB);
      this.broadcast(await maintenance(this.env.DB, s.retentionDays));
    });
  }

  async notify(delta: Delta): Promise<void> {
    this.broadcast(delta);
  }

  /** Called only by the Worker after the cookie session was verified. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const hello: WsMessage = { type: 'hello', cursor: await currentCursor(this.env.DB) };
    pair[1].send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === 'string' && message === 'ping') ws.send(JSON.stringify({ type: 'pong' } satisfies WsMessage));
  }
  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000, 'bye');
    } catch {
      /* already closed */
    }
  }
}
