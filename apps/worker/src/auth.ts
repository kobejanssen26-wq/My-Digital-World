import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env.js';

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : buf)));
const b64url = (buf: Uint8Array) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const PBKDF2_ITERATIONS = 100_000; // Workers' WebCrypto maximum

export async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  // Always do the work, even when unconfigured, so timing does not reveal state.
  const parts = (stored ?? '').split('$');
  const ok = parts.length === 4 && parts[0] === 'pbkdf2';
  const iterations = ok ? Math.min(Number(parts[1]) || PBKDF2_ITERATIONS, PBKDF2_ITERATIONS) : PBKDF2_ITERATIONS;
  const salt = ok ? unb64(parts[2]!) : new Uint8Array(16);
  const expected = ok ? parts[3]! : 'x';
  const actual = b64(await pbkdf2(password, salt, iterations));
  return ok && timingSafeEqual(actual, expected);
}

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** Fixed-window rate limit stored in D1. Returns true when the call is allowed. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSec: number, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 1000 / windowSec) * windowSec;
  const r = await db
    .prepare('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key, window)
    .first<{ count: number }>();
  return (r?.count ?? 1) <= limit;
}

export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export function cookieName(url: URL) {
  return url.protocol === 'https:' ? '__Host-mdw_session' : 'mdw_session';
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function createSession(db: D1Database, now = Date.now()) {
  const token = randomToken();
  const csrf = randomToken(24);
  await db.prepare('INSERT INTO auth_sessions (id_hash, csrf, created_at, expires_at) VALUES (?,?,?,?)').bind(await sha256Hex(token), csrf, now, now + SESSION_TTL_MS).run();
  return { token, csrf };
}

export function sessionCookie(url: URL, token: string | null): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (url.protocol === 'https:') attrs.push('Secure');
  attrs.push(token ? `Max-Age=${SESSION_TTL_MS / 1000}` : 'Max-Age=0');
  return `${cookieName(url)}=${token ?? ''}; ${attrs.join('; ')}`;
}

export async function lookupSession(c: Context<{ Bindings: Env; Variables: any }>) {
  const url = new URL(c.req.url);
  const token = readCookie(c.req.header('cookie') ?? null, cookieName(url));
  if (!token) return null;
  const row = await c.env.DB.prepare('SELECT csrf, expires_at FROM auth_sessions WHERE id_hash = ?').bind(await sha256Hex(token)).first<{ csrf: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { csrf: row.csrf, token };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cookie session + CSRF header + same-origin check for unsafe methods. */
export const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: { csrf: string } }> = async (c, next) => {
  const sess = await lookupSession(c);
  if (!sess) return c.json({ error: 'unauthorized' }, 401);
  if (!SAFE.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'bad_origin' }, 403);
    if (!timingSafeEqual(c.req.header('x-csrf-token') ?? '', sess.csrf)) return c.json({ error: 'bad_csrf' }, 403);
  }
  c.set('csrf', sess.csrf);
  await next();
};

/** Bridge credential: `Authorization: Bearer mdw_...`; only the SHA-256 is stored, revocable. */
export const requireBridge: MiddlewareHandler<{ Bindings: Env; Variables: { tokenId: string; tokenName: string } }> = async (c, next) => {
  const h = c.req.header('authorization') ?? '';
  const m = /^Bearer (mdw_[A-Za-z0-9_-]{20,100})$/.exec(h);
  if (!m) return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare('SELECT id, name, revoked_at FROM bridge_tokens WHERE token_hash = ?').bind(await sha256Hex(m[1]!)).first<{ id: string; name: string; revoked_at: number | null }>();
  if (!row || row.revoked_at) return c.json({ error: 'unauthorized' }, 401);
  if (!(await rateLimit(c.env.DB, `bridge:${row.id}`, 600, 60))) return c.json({ error: 'rate_limited' }, 429);
  c.set('tokenId', row.id);
  c.set('tokenName', row.name);
  await next();
};
