import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@mdw/shared';
import { flushOnce, type DeliveryStatus } from '../src/deliver.js';
import { paths } from '../src/paths.js';
import { ack, enqueue, peek, queueDepth } from '../src/spool.js';
import { config, useHome } from './helpers.js';

let n = 0;
const mk = (ts: number): Envelope => ({ v: 1, id: `ev_test_${String(++n).padStart(6, '0')}`, ts, source: 't', type: 'tool.done', sessionId: 's', data: {} });
const status = (): DeliveryStatus => ({ health: 'idle', queued: 0, rejected: 0, lastSuccessAt: null, lastAttemptAt: null, lastError: null, delivered: 0, nextRetryAt: null, pid: 1, url: 'x', startedAt: 0 });
const T = 1_800_000_000_000;

beforeEach(() => {
  useHome();
});

const okFetch = (log: Envelope[][] = [], statuses: Record<string, string> = {}) =>
  (async (_u: unknown, init: RequestInit) => {
    const evs = JSON.parse(init.body as string).events as Envelope[];
    log.push(evs);
    return new Response(JSON.stringify({ results: evs.map((e) => (statuses[e.id] === 'rejected' ? { id: e.id, status: 'rejected', reason: 'invalid' } : { id: e.id, status: statuses[e.id] ?? 'accepted', seq: 1, late: false })) }), { status: 200 });
  }) as unknown as typeof fetch;

describe('spool', () => {
  it('keeps events in timestamp order and survives re-reads', () => {
    enqueue(mk(T + 5));
    enqueue(mk(T + 1));
    enqueue(mk(T + 3));
    expect(peek(10).map((q) => q.event.ts)).toEqual([T + 1, T + 3, T + 5]);
    expect(queueDepth()).toBe(3);
  });
  it('quarantines corrupt files instead of blocking the queue', async () => {
    const { writeFileSync } = await import('node:fs');
    enqueue(mk(T));
    writeFileSync(`${paths.spool()}/000000000000001-bad.json`, '{not json');
    expect(peek(10)).toHaveLength(1);
    expect(readdirSync(paths.rejected()).some((f) => f.endsWith('.corrupt'))).toBe(true);
  });
});

describe('delivery', () => {
  it('delivers in order, authenticated, and empties the queue on acknowledgement', async () => {
    const cfg = config();
    const log: Envelope[][] = [];
    [T + 2, T + 1].forEach((t) => enqueue(mk(t)));
    let auth = '';
    const f = (async (u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization!;
      return okFetch(log)(u, init);
    }) as unknown as typeof fetch;
    const st = status();
    const r = await flushOnce(cfg, st, { fetchImpl: f });
    expect(r.sent).toBe(2);
    expect(auth).toBe(`Bearer ${cfg.token}`);
    expect(log[0]!.map((e) => e.ts)).toEqual([T + 1, T + 2]);
    expect(queueDepth()).toBe(0);
    expect(st.health).toBe('ok');
  });

  it('keeps every event when the network is down, then retries with the SAME ids (no duplicates)', async () => {
    const cfg = config();
    enqueue(mk(T));
    enqueue(mk(T + 1));
    const st = status();
    const down = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const r1 = await flushOnce(cfg, st, { fetchImpl: down });
    expect(r1).toEqual({ sent: 0, retry: true });
    expect(st.health).toBe('offline');
    expect(queueDepth()).toBe(2);
    const idsBefore = peek(10).map((q) => q.event.id);
    const log: Envelope[][] = [];
    const r2 = await flushOnce(cfg, st, { fetchImpl: okFetch(log) });
    expect(r2.sent).toBe(2);
    expect(log[0]!.map((e) => e.id)).toEqual(idsBefore);
    expect(queueDepth()).toBe(0);
  });

  it.each([500, 503, 429])('server error %i keeps events queued', async (code) => {
    enqueue(mk(T));
    const st = status();
    const r = await flushOnce(config(), st, { fetchImpl: (async () => new Response('x', { status: code })) as unknown as typeof fetch });
    expect(r.retry).toBe(true);
    expect(queueDepth()).toBe(1);
    expect(st.health).toBe('error');
  });

  it('401 marks the bridge unauthorized and keeps events (nothing is silently dropped)', async () => {
    enqueue(mk(T));
    const st = status();
    await flushOnce(config(), st, { fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch });
    expect(st.health).toBe('unauthorized');
    expect(queueDepth()).toBe(1);
  });

  it('permanently rejected events move to rejected/ with a reason; duplicates are acknowledged', async () => {
    const cfg = config();
    const a = mk(T);
    const b = mk(T + 1);
    const c = mk(T + 2);
    [a, b, c].forEach(enqueue);
    const st = status();
    await flushOnce(cfg, st, { fetchImpl: okFetch([], { [a.id]: 'rejected', [b.id]: 'duplicate' }) });
    expect(queueDepth()).toBe(0);
    const rej = readdirSync(paths.rejected());
    expect(rej.some((f) => f.includes(a.id) && f.endsWith('.json'))).toBe(true);
    expect(rej.some((f) => f.includes(a.id) && f.endsWith('.reason'))).toBe(true);
    expect(st.delivered).toBe(2);
  });

  it('events missing from the server response stay queued', async () => {
    enqueue(mk(T));
    const f = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;
    await flushOnce(config(), status(), { fetchImpl: f });
    expect(queueDepth()).toBe(1);
  });

  it('a 4xx on a batch is bisected so one poison event cannot block the others', async () => {
    const cfg = config();
    const poison = mk(T + 1);
    [mk(T), poison, mk(T + 2)].forEach(enqueue);
    const f = (async (_u: unknown, init: RequestInit) => {
      const evs = JSON.parse(init.body as string).events as Envelope[];
      if (evs.some((e) => e.id === poison.id)) return evs.length > 1 ? new Response('{}', { status: 400 }) : new Response('{}', { status: 400 });
      return okFetch()(_u as string, init);
    }) as unknown as typeof fetch;
    await flushOnce(cfg, status(), { fetchImpl: f });
    expect(queueDepth()).toBe(0);
    expect(readdirSync(paths.rejected()).filter((x) => x.endsWith('.json'))).toHaveLength(1);
  });

  it('ack of a missing file is harmless', () => ack('nope.json'));
});
