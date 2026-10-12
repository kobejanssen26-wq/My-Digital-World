import { env, exports } from 'cloudflare:workers';
import { hashPassword } from '../src/auth.js';
import type { Env } from '../src/env.js';

export const e = env as unknown as Env & { ADMIN_PASSWORD_HASH?: string };
export const PASSWORD = 'correct horse battery staple';
let hash: string | undefined;

export async function configurePassword() {
  hash ??= await hashPassword(PASSWORD);
  (e as { ADMIN_PASSWORD_HASH?: string }).ADMIN_PASSWORD_HASH = hash;
}

export async function call(path: string, init: RequestInit & { json?: unknown; cookie?: string; csrf?: string; bearer?: string; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.json);
  }
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.csrf) headers.set('x-csrf-token', init.csrf);
  if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
  if (init.ip) headers.set('cf-connecting-ip', init.ip);
  const res = await ((exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default).fetch(new Request(`https://mdw.test${path}`, { ...init, headers }));
  return res;
}

export async function login(ip = '10.0.0.1') {
  await configurePassword();
  const res = await call('/api/auth/login', { method: 'POST', json: { password: PASSWORD }, ip });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  const body = (await res.json()) as { csrf: string };
  return { cookie, csrf: body.csrf, res };
}

export async function makeToken(session: { cookie: string; csrf: string }, name = 'test-bridge') {
  const res = await call('/api/bridge/tokens', { method: 'POST', json: { name }, ...session });
  return (await res.json()) as { id: string; token: string };
}

let n = 0;
export const T0 = 1_800_000_000_000;
export function event(type: string, ts: number, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: `ev_${Date.now().toString(36)}_${String(++n).padStart(6, '0')}`,
    ts,
    source: 'test',
    type,
    sessionId: 'sess-1',
    project: { keys: ['remote:github.com/me/demo', 'path:aaaabbbbcc'], name: 'demo', repo: 'github.com/me/demo' },
    data,
    ...extra,
  };
}

export async function ingest(bearer: string, events: unknown[]) {
  const res = await call('/api/ingest', { method: 'POST', json: { events }, bearer });
  return { res, body: (await res.json()) as { results: { id: string; status: string; reason?: string; late?: boolean }[] } };
}
