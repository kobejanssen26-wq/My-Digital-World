import { describe, expect, it } from 'vitest';
import { call, configurePassword, e, event, ingest, login, makeToken, PASSWORD, T0 } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

describe('authentication', () => {
  it('rejects all dashboard endpoints without a session', async () => {
    for (const path of ['/api/snapshot', '/api/events', '/api/projects/x', '/api/search?q=a', '/api/files', '/api/export']) {
      expect((await call(path)).status, path).toBe(401);
    }
    expect((await call('/api/settings', { method: 'PUT', json: {} })).status).toBe(401);
    expect((await call('/api/ws', { headers: { upgrade: 'websocket' } })).status).toBe(401);
  });

  it('refuses login with a wrong password and never sets a cookie', async () => {
    await configurePassword();
    const res = await call('/api/auth/login', { method: 'POST', json: { password: 'nope' }, ip: '10.2.0.1' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('login sets an HttpOnly, Secure, SameSite=Strict, __Host- cookie on https', async () => {
    const { res } = await login('10.2.0.2');
    const c = res.headers.get('set-cookie')!;
    expect(c).toMatch(/^__Host-mdw_session=/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\//);
  });

  it('is rate limited after repeated failures', async () => {
    await configurePassword();
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await call('/api/auth/login', { method: 'POST', json: { password: 'x' + i }, ip: '10.2.0.99' })).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
  });

  it('returns 503 (not a default password) when no password has been configured', async () => {
    const prev = e.ADMIN_PASSWORD_HASH;
    (e as { ADMIN_PASSWORD_HASH?: string }).ADMIN_PASSWORD_HASH = undefined;
    const res = await call('/api/auth/login', { method: 'POST', json: { password: 'anything' }, ip: '10.2.0.3' });
    expect(res.status).toBe(503);
    (e as { ADMIN_PASSWORD_HASH?: string }).ADMIN_PASSWORD_HASH = prev;
  });

  it('logout invalidates the session server-side', async () => {
    const s = await login('10.2.0.4');
    expect((await call('/api/snapshot', { cookie: s.cookie })).status).toBe(200);
    await call('/api/auth/logout', { method: 'POST', cookie: s.cookie, csrf: s.csrf });
    expect((await call('/api/snapshot', { cookie: s.cookie })).status).toBe(401);
  });

  it('a forged cookie is rejected', async () => {
    expect((await call('/api/snapshot', { cookie: '__Host-mdw_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status).toBe(401);
  });

  it('password hashing round trips and rejects wrong input / malformed hashes', async () => {
    const h = await hashPassword('s3cret');
    expect(await verifyPassword('s3cret', h)).toBe(true);
    expect(await verifyPassword('s3cret!', h)).toBe(false);
    expect(await verifyPassword('s3cret', 'garbage')).toBe(false);
    expect(await verifyPassword('s3cret', undefined)).toBe(false);
    expect(h).not.toContain('s3cret');
  });
});

describe('CSRF and origin protection', () => {
  it('rejects unsafe requests without the CSRF header or with a wrong one', async () => {
    const s = await login('10.3.0.1');
    expect((await call('/api/settings', { method: 'PUT', json: { lightweight: true }, cookie: s.cookie })).status).toBe(403);
    expect((await call('/api/settings', { method: 'PUT', json: { lightweight: true }, cookie: s.cookie, csrf: 'wrong' })).status).toBe(403);
    expect((await call('/api/settings', { method: 'PUT', json: { lightweight: true }, cookie: s.cookie, csrf: s.csrf })).status).toBe(200);
  });
  it('rejects cross-origin unsafe requests even with valid credentials', async () => {
    const s = await login('10.3.0.2');
    const res = await call('/api/settings', { method: 'PUT', json: {}, cookie: s.cookie, csrf: s.csrf, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
  it('rejects cross-origin websocket upgrades', async () => {
    const s = await login('10.3.0.3');
    const res = await call('/api/ws', { cookie: s.cookie, headers: { upgrade: 'websocket', origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
  it('sends no CORS headers (same-origin only)', async () => {
    const s = await login('10.3.0.4');
    const res = await call('/api/snapshot', { cookie: s.cookie, headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('bridge credentials', () => {
  it('ingest rejects missing, malformed and unknown tokens', async () => {
    const body = { events: [event('session.start', T0)] };
    expect((await call('/api/ingest', { method: 'POST', json: body })).status).toBe(401);
    expect((await call('/api/ingest', { method: 'POST', json: body, bearer: 'mdw_short' })).status).toBe(401);
    expect((await call('/api/ingest', { method: 'POST', json: body, bearer: 'mdw_' + 'a'.repeat(43) })).status).toBe(401);
    expect((await call('/api/ingest', { method: 'POST', json: body, bearer: 'notmdw' })).status).toBe(401);
  });
  it('a dashboard session cookie cannot be used as a bridge credential, and vice versa', async () => {
    const s = await login('10.4.0.1');
    const t = await makeToken(s);
    expect((await call('/api/ingest', { method: 'POST', json: { events: [] }, cookie: s.cookie, csrf: s.csrf })).status).toBe(401);
    expect((await call('/api/snapshot', { bearer: t.token })).status).toBe(401);
  });
  it('tokens are stored only as hashes', async () => {
    const s = await login('10.4.0.2');
    const t = await makeToken(s, 'hash-check');
    const rows = await e.DB.prepare('SELECT token_hash FROM bridge_tokens').all<{ token_hash: string }>();
    expect(rows.results.some((r) => r.token_hash === t.token)).toBe(false);
    expect(t.token.startsWith('mdw_')).toBe(true);
  });
  it('revocation takes effect immediately', async () => {
    const s = await login('10.4.0.3');
    const t = await makeToken(s, 'revoke-me');
    expect((await ingest(t.token, [event('session.start', T0)])).res.status).toBe(200);
    expect((await call(`/api/bridge/tokens/${t.id}`, { method: 'DELETE', cookie: s.cookie, csrf: s.csrf })).status).toBe(200);
    expect((await ingest(t.token, [event('session.start', T0 + 1)])).res.status).toBe(401);
    expect((await call('/api/bridge/ping', { bearer: t.token })).status).toBe(401);
  });
  it('enforces a request size limit', async () => {
    const s = await login('10.4.0.4');
    const t = await makeToken(s, 'big');
    const res = await call('/api/ingest', { method: 'POST', body: JSON.stringify({ events: [{ pad: 'x'.repeat(600 * 1024) }] }), bearer: t.token, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(413);
  });
});

describe('secret exposure', () => {
  it('API responses never contain the password hash or bridge token hashes', async () => {
    const s = await login('10.5.0.1');
    await makeToken(s, 'exposure');
    const body = await (await call('/api/snapshot', { cookie: s.cookie })).text();
    const exp = await (await call('/api/export', { cookie: s.cookie })).text();
    for (const text of [body, exp, JSON.stringify(await (await call('/api/me', { cookie: s.cookie })).json())]) {
      expect(text).not.toContain('pbkdf2$');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toMatch(/token_hash/);
    }
  });
  it('unknown API paths are 401 unauthenticated (no route probing) and JSON 404 when authenticated', async () => {
    expect((await call('/api/does-not-exist')).status).toBe(401);
    const s = await login('10.5.0.2');
    const res = await call('/api/does-not-exist', { cookie: s.cookie });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
