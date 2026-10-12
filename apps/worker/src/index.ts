import { Hono } from 'hono';
import { z } from 'zod';
import { cleanText, DEFAULT_SETTINGS, IngestBodySchema, type Snapshot } from '@mdw/shared';
import { createSession, lookupSession, rateLimit, randomToken, requireBridge, requireSession, sessionCookie, sha256Hex, verifyPassword } from './auth.js';
import { HUB_NAME, type Env } from './env.js';
import { files } from './files.js';
import { currentCursor } from './ingest.js';
import { eventRow, loadSettings, PROJECT_SELECT, projectRow, sessionRow, taskRow } from './rows.js';
import type { UserAction } from './actions.js';
import { ActionError } from './actions.js';

export { Hub } from './hub.js';

type App = { Bindings: Env; Variables: { csrf: string; tokenId: string; tokenName: string } };
const app = new Hono<App>();
const hub = (env: Env) => env.HUB.get(env.HUB.idFromName(HUB_NAME));

// ---- headers for every API response -------------------------------------------------------
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (!c.res.headers.has('Content-Security-Policy')) c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
});
app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: new URL(c.req.url).pathname, err: err.message }));
  if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
  return c.json({ error: 'internal_error' }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true }));

// ---- auth --------------------------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const ipKey = await sha256Hex(ip);
  if (!(await rateLimit(c.env.DB, `login:${ipKey}`, 8, 15 * 60)) || !(await rateLimit(c.env.DB, 'login:global', 40, 15 * 60)))
    return c.json({ error: 'rate_limited' }, 429);
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'bad_origin' }, 403);
  const body = z.object({ password: z.string().min(1).max(256) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  if (!c.env.ADMIN_PASSWORD_HASH) return c.json({ error: 'not_configured', hint: 'Run npm run setup:secrets' }, 503);
  if (!(await verifyPassword(body.data.password, c.env.ADMIN_PASSWORD_HASH))) return c.json({ error: 'invalid_credentials' }, 401);
  const { token, csrf } = await createSession(c.env.DB);
  c.header('Set-Cookie', sessionCookie(new URL(c.req.url), token));
  return c.json({ ok: true, csrf });
});

app.post('/api/auth/logout', async (c) => {
  const s = await lookupSession(c);
  if (s) await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').bind(await sha256Hex(s.token)).run();
  c.header('Set-Cookie', sessionCookie(new URL(c.req.url), null));
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const s = await lookupSession(c);
  return c.json(s ? { authenticated: true, csrf: s.csrf } : { authenticated: false, configured: !!c.env.ADMIN_PASSWORD_HASH });
});

// ---- bridge (bearer auth) ------------------------------------------------------------------
app.get('/api/bridge/ping', requireBridge, async (c) => c.json({ ok: true, serverTime: Date.now(), cursor: await currentCursor(c.env.DB), token: c.get('tokenName') }));

app.post('/api/ingest', requireBridge, async (c) => {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > 512 * 1024) return c.json({ error: 'payload_too_large' }, 413);
  const text = await c.req.text();
  if (text.length > 512 * 1024) return c.json({ error: 'payload_too_large' }, 413);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const body = IngestBodySchema.safeParse(json);
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const results = await hub(c.env).ingest(body.data.events, c.get('tokenName'), c.get('tokenId'));
  return c.json({ results });
});

// ---- dashboard API (cookie auth) ---------------------------------------------------------
const api = new Hono<App>();
api.use('*', requireSession);

async function snapshot(env: Env): Promise<Snapshot> {
  const db = env.DB;
  const [projects, sessions, tasks, events, settings, tokens, meta, usage, cursor] = await Promise.all([
    db.prepare(`${PROJECT_SELECT} ORDER BY p.last_active DESC LIMIT 500`).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM sessions WHERE status IN ('active','idle') OR last_event_at > ? ORDER BY last_event_at DESC LIMIT 300`).bind(Date.now() - 7 * 86_400_000).all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM tasks WHERE status NOT IN ('completed','failed','interrupted') OR updated_at > ? ORDER BY updated_at DESC LIMIT 600`).bind(Date.now() - 30 * 86_400_000).all<Record<string, unknown>>(),
    db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 150').all<Record<string, unknown>>(),
    loadSettings(db),
    db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM bridge_tokens ORDER BY created_at DESC').all<Record<string, unknown>>(),
    db.prepare(`SELECT key, value FROM meta WHERE key IN ('last_ingest_at','last_ingest_source')`).all<{ key: string; value: string }>(),
    db.prepare('SELECT COALESCE(SUM(size),0) b, COUNT(*) n FROM files').first<{ b: number; n: number }>(),
    currentCursor(db),
  ]);
  const m = Object.fromEntries(meta.results.map((r) => [r.key, r.value]));
  return {
    cursor,
    serverTime: Date.now(),
    projects: projects.results.map(projectRow),
    sessions: sessions.results.map(sessionRow),
    tasks: tasks.results.map(taskRow),
    events: events.results.map(eventRow),
    stats: { files: usage?.n ?? 0, storageBytes: usage?.b ?? 0, storageLimitBytes: settings.storageLimitMb * 1024 * 1024, r2: !!env.FILES },
    bridge: {
      tokens: tokens.results.map((t) => ({ id: String(t.id), name: String(t.name), createdAt: Number(t.created_at), lastUsedAt: t.last_used_at == null ? null : Number(t.last_used_at), revokedAt: t.revoked_at == null ? null : Number(t.revoked_at) })),
      lastIngestAt: m.last_ingest_at ? Number(m.last_ingest_at) : null,
      lastIngestSource: m.last_ingest_source ?? null,
    },
    settings,
  };
}

api.get('/snapshot', async (c) => c.json(await snapshot(c.env)));

api.get('/events', async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.before) {
    where.push('seq < ?');
    args.push(Number(q.before));
  }
  if (q.after) {
    where.push('seq > ?');
    args.push(Number(q.after));
  }
  if (q.project) {
    where.push('project_id = ?');
    args.push(q.project);
  }
  if (q.type) {
    where.push('type = ?');
    args.push(q.type);
  }
  if (q.since) {
    where.push('ts >= ?');
    args.push(Number(q.since));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const order = q.after ? 'ASC' : 'DESC';
  const { results } = await c.env.DB.prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT ?`)
    .bind(...args, limit + 1)
    .all<Record<string, unknown>>();
  const rows = results.slice(0, limit).map(eventRow);
  return c.json({ events: rows, hasMore: results.length > limit, cursor: await currentCursor(c.env.DB) });
});

api.get('/projects/:id', async (c) => {
  const id = c.req.param('id');
  const p = await c.env.DB.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!p) return c.json({ error: 'not_found' }, 404);
  const [tasks, sessions, events] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 200').bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT * FROM sessions WHERE project_id=? ORDER BY started_at DESC LIMIT 50').bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq DESC LIMIT 100').bind(id).all<Record<string, unknown>>(),
  ]);
  return c.json({ project: projectRow(p), tasks: tasks.results.map(taskRow), sessions: sessions.results.map(sessionRow), events: events.results.map(eventRow) });
});

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause_project'), projectId: z.string().max(80) }),
  z.object({ action: z.literal('resume_project'), projectId: z.string().max(80) }),
  z.object({ action: z.literal('complete_task'), taskId: z.string().max(120) }),
  z.object({ action: z.literal('reopen_task'), taskId: z.string().max(120) }),
  z.object({ action: z.literal('rename_project'), projectId: z.string().max(80), name: z.string().min(1).max(80) }),
]);
api.post('/actions', async (c) => {
  const body = ActionSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const r = await hub(c.env).userAction(body.data as UserAction);
  return r.ok ? c.json({ ok: true, cursor: r.cursor }) : c.json({ error: r.error }, r.status as 400);
});

api.get('/search', async (c) => {
  const q = cleanText(c.req.query('q') ?? '', 80);
  if (q.length < 1) return c.json({ projects: [], tasks: [], files: [] });
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const [projects, tasks, fl] = await Promise.all([
    c.env.DB.prepare(`${PROJECT_SELECT} WHERE p.name LIKE ?1 ESCAPE '\\' OR p.summary LIKE ?1 ESCAPE '\\' OR p.repo LIKE ?1 ESCAPE '\\' OR p.project_type LIKE ?1 ESCAPE '\\' ORDER BY p.last_active DESC LIMIT 20`).bind(like).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT * FROM tasks WHERE summary LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20`).bind(like).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT id, name, mime, size, folder_id, created_at FROM files WHERE name LIKE ?1 ESCAPE '\\' ORDER BY name LIMIT 20`).bind(like).all<Record<string, unknown>>(),
  ]);
  return c.json({
    projects: projects.results.map(projectRow),
    tasks: tasks.results.map(taskRow),
    files: fl.results.map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, folderId: r.folder_id, createdAt: r.created_at })),
  });
});

const SettingsSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(3650),
    reducedMotion: z.boolean(),
    lightweight: z.boolean(),
    storageLimitMb: z.number().int().min(1).max(10240),
  })
  .partial()
  .strict();
api.put('/settings', async (c) => {
  const body = SettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const stmts = Object.entries(body.data).map(([k, v]) =>
    c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, JSON.stringify(v)),
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ settings: { ...DEFAULT_SETTINGS, ...(await loadSettings(c.env.DB)) } });
});

api.post('/bridge/tokens', async (c) => {
  const body = z.object({ name: z.string().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const active = await c.env.DB.prepare('SELECT COUNT(*) n FROM bridge_tokens WHERE revoked_at IS NULL').first<{ n: number }>();
  if ((active?.n ?? 0) >= 10) return c.json({ error: 'too_many_tokens' }, 409);
  const token = 'mdw_' + randomToken(32);
  const id = 'bt_' + crypto.randomUUID().slice(0, 12);
  await c.env.DB.prepare('INSERT INTO bridge_tokens (id, name, token_hash, created_at) VALUES (?,?,?,?)').bind(id, cleanText(body.data.name, 60), await sha256Hex(token), Date.now()).run();
  return c.json({ id, name: body.data.name, token }, 201); // the only time the token is ever shown
});
api.delete('/bridge/tokens/:id', async (c) => {
  const r = await c.env.DB.prepare('UPDATE bridge_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id')).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
});

/** Full JSON export for backups (no credentials, no file contents). */
api.get('/export', async (c) => {
  const tables = ['projects', 'project_locations', 'project_aliases', 'sessions', 'tasks', 'events', 'settings', 'folders', 'files'];
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), schema: 1 };
  for (const t of tables) out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="mdw-export.json"', 'cache-control': 'no-store' } });
});

app.route('/api', api);
app.route('/api/files', files);

// ---- WebSocket (cookie session verified here, then handed to the Hub) --------------------------
app.get('/api/ws', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.json({ error: 'expected_websocket' }, 426);
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'bad_origin' }, 403);
  if (!(await lookupSession(c))) return c.json({ error: 'unauthorized' }, 401);
  return hub(c.env).fetch(c.req.raw);
});

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
// Everything else is served by the static assets binding (run_worker_first only routes /api/* here).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_evt: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(hub(env).maintain());
  },
} satisfies ExportedHandler<Env>;
