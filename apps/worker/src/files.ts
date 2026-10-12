import { Hono } from 'hono';
import { cleanText } from '@mdw/shared';
import { MAX_UPLOAD_BYTES, type Env } from './env.js';
import { requireSession } from './auth.js';
import { loadSettings } from './rows.js';

export const files = new Hono<{ Bindings: Env; Variables: { csrf: string } }>();
files.use('*', requireSession);

const unavailable = (c: { json: (b: unknown, s: number) => Response }) => c.json({ error: 'storage_unavailable', hint: 'Enable R2 and create the bucket; see docs/CLOUDFLARE_DEPLOYMENT.md' }, 503);

/** MIME types that may be rendered inline in a sandboxed context. Everything else is download-only. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'application/pdf', 'application/json']);
const MAGIC: Record<string, number[][]> = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};
const BLOCKED_EXT = /\.(exe|dll|bat|cmd|com|scr|msi|ps1|vbs|jar|app|sh)$/i;

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return cleanText(base, 160).replace(/^\.+/, '');
}

export function validateUpload(name: string, mime: string, bytes: Uint8Array): string | null {
  if (!name) return 'invalid_name';
  if (BLOCKED_EXT.test(name)) return 'blocked_file_type';
  const sigs = MAGIC[mime];
  if (sigs && !sigs.some((sig) => sig.every((b, i) => bytes[i] === b))) return 'content_does_not_match_type';
  return null;
}

files.get('/', async (c) => {
  const folder = c.req.query('folder') || null;
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const fileQ = q
    ? c.env.DB.prepare(`SELECT id, name, mime, size, folder_id, created_at FROM files WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100`).bind(like)
    : c.env.DB.prepare(`SELECT id, name, mime, size, folder_id, created_at FROM files WHERE folder_id IS ? ORDER BY name LIMIT 500`).bind(folder);
  const folderQ = q
    ? c.env.DB.prepare(`SELECT id, name, parent_id, created_at FROM folders WHERE name LIKE ? ESCAPE '\\' LIMIT 50`).bind(like)
    : c.env.DB.prepare('SELECT id, name, parent_id, created_at FROM folders WHERE parent_id IS ? ORDER BY name').bind(folder);
  const [f, d, usage, settings] = await Promise.all([
    fileQ.all<Record<string, unknown>>(),
    folderQ.all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT COALESCE(SUM(size),0) b, COUNT(*) n FROM files').first<{ b: number; n: number }>(),
    loadSettings(c.env.DB),
  ]);
  return c.json({
    available: !!c.env.FILES,
    files: f.results.map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, folderId: r.folder_id, createdAt: r.created_at })),
    folders: d.results.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at })),
    usage: { bytes: usage?.b ?? 0, files: usage?.n ?? 0, limitBytes: settings.storageLimitMb * 1024 * 1024, maxUploadBytes: MAX_UPLOAD_BYTES },
  });
});

files.post('/folders', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string; parentId?: string | null } | null;
  const name = cleanText(body?.name ?? '', 80);
  if (!name || /[\\/]/.test(name)) return c.json({ error: 'invalid_name' }, 400);
  const parent = body?.parentId ?? null;
  if (parent && !(await c.env.DB.prepare('SELECT 1 FROM folders WHERE id=?').bind(parent).first())) return c.json({ error: 'parent_not_found' }, 404);
  const id = 'fo_' + crypto.randomUUID();
  try {
    await c.env.DB.prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?,?,?,?)').bind(id, name, parent, Date.now()).run();
  } catch {
    return c.json({ error: 'folder_exists' }, 409);
  }
  return c.json({ id, name, parentId: parent }, 201);
});

files.delete('/folders/:id', async (c) => {
  const id = c.req.param('id');
  const used = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM files WHERE folder_id=?1) + (SELECT COUNT(*) FROM folders WHERE parent_id=?1) AS n').bind(id).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) return c.json({ error: 'folder_not_empty' }, 409);
  await c.env.DB.prepare('DELETE FROM folders WHERE id=?').bind(id).run();
  return c.json({ ok: true });
});

/** Raw-body upload: PUT /api/files?name=...&folder=... (Content-Type = file MIME type). */
files.put('/', async (c) => {
  if (!c.env.FILES) return unavailable(c);
  const name = safeName(c.req.query('name') ?? '');
  const folder = c.req.query('folder') || null;
  const declared = Number(c.req.header('content-length') ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0) return c.json({ error: 'length_required' }, 411);
  if (declared > MAX_UPLOAD_BYTES) return c.json({ error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }, 413);
  if (folder && !(await c.env.DB.prepare('SELECT 1 FROM folders WHERE id=?').bind(folder).first())) return c.json({ error: 'folder_not_found' }, 404);

  const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase().slice(0, 100);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength !== declared || buf.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: 'file_too_large', maxBytes: MAX_UPLOAD_BYTES }, 413);
  const bad = validateUpload(name, mime, buf);
  if (bad) return c.json({ error: bad }, 415);

  const settings = await loadSettings(c.env.DB);
  const usage = await c.env.DB.prepare('SELECT COALESCE(SUM(size),0) b FROM files').first<{ b: number }>();
  if ((usage?.b ?? 0) + buf.byteLength > settings.storageLimitMb * 1024 * 1024) return c.json({ error: 'storage_limit_reached' }, 507);

  const id = 'f_' + crypto.randomUUID();
  const key = `files/${id}`;
  await c.env.FILES.put(key, buf, { httpMetadata: { contentType: 'application/octet-stream' } });
  try {
    await c.env.DB.prepare('INSERT INTO files (id, object_key, name, mime, size, folder_id, created_at) VALUES (?,?,?,?,?,?,?)').bind(id, key, name, mime, buf.byteLength, folder, Date.now()).run();
  } catch (e) {
    await c.env.FILES.delete(key); // no orphan objects
    throw e;
  }
  return c.json({ id, name, mime, size: buf.byteLength, folderId: folder }, 201);
});

files.get('/:id/download', async (c) => {
  if (!c.env.FILES) return unavailable(c);
  const row = await c.env.DB.prepare('SELECT object_key, name, mime, size FROM files WHERE id=?').bind(c.req.param('id')).first<{ object_key: string; name: string; mime: string; size: number }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const obj = await c.env.FILES.get(row.object_key);
  if (!obj) return c.json({ error: 'object_missing' }, 410);
  const inline = c.req.query('inline') === '1' && INLINE.has(row.mime);
  const headers = new Headers({
    'content-type': inline ? row.mime : 'application/octet-stream',
    'content-length': String(row.size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    'cache-control': 'private, no-store',
  });
  return new Response(obj.body, { headers });
});

files.delete('/:id', async (c) => {
  if (!c.env.FILES) return unavailable(c);
  const row = await c.env.DB.prepare('SELECT object_key FROM files WHERE id=?').bind(c.req.param('id')).first<{ object_key: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  await c.env.FILES.delete(row.object_key);
  await c.env.DB.prepare('DELETE FROM files WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
