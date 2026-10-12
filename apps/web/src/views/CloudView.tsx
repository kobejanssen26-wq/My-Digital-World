import type { FileRow, FolderRow } from '@mdw/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Empty, ErrorBanner } from '../components/ui.js';
import { fmtBytes, fmtTime } from '../lib/format.js';

type Listing = Awaited<ReturnType<typeof api.files>>;
const ERRORS: Record<string, string> = {
  file_too_large: 'That file is larger than the upload limit.',
  blocked_file_type: 'That file type is not allowed.',
  content_does_not_match_type: 'The file contents do not match its type.',
  storage_limit_reached: 'Your storage limit would be exceeded.',
  folder_exists: 'A folder with that name already exists here.',
  folder_not_empty: 'The folder is not empty.',
  storage_unavailable: 'Cloud storage (R2) is not enabled for this deployment.',
};
const previewable = (m: string) => m.startsWith('image/') && m !== 'image/svg+xml';

export default function CloudView() {
  const [folder, setFolder] = useState<FolderRow | null>(null);
  const [trail, setTrail] = useState<FolderRow[]>([]);
  const [q, setQ] = useState('');
  const [list, setList] = useState<Listing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ file: FileRow; text?: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.files({ folder: folder?.id ?? null, q: q.trim() }));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? ERRORS[e.code] ?? 'Could not load files.' : 'Could not load files.');
    }
  }, [folder, q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const fail = (e: unknown) => setErr(e instanceof ApiError ? ERRORS[e.code] ?? `Failed (${e.code}).` : 'Network error.');

  async function upload(files: FileList | File[]) {
    setBusy(true);
    setErr(null);
    for (const f of Array.from(files)) {
      try {
        await api.upload(f, folder?.id ?? null);
      } catch (e) {
        fail(e);
      }
    }
    setBusy(false);
    await load();
  }

  async function open(f: FileRow) {
    if (previewable(f.mime)) return setPreview({ file: f });
    if (f.mime === 'text/plain' || f.mime === 'application/json') {
      const r = await fetch(`/api/files/${f.id}/download?inline=1`);
      return setPreview({ file: f, text: (await r.text()).slice(0, 100_000) });
    }
    location.href = `/api/files/${f.id}/download`;
  }

  const usage = list?.usage;
  return (
    <div className="page" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
      <div className="page-head">
        <div><h1>Cloud</h1><p className="muted" style={{ margin: 0 }}>Files you upload here live in private storage. Your computer's folders are never synced automatically.</p></div>
        <div className="row">
          <input type="search" aria-label="Search files" placeholder="Search files…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {err && <ErrorBanner>{err}</ErrorBanner>}
      {list && !list.available && <ErrorBanner>Cloud storage is not enabled for this deployment (R2 bucket missing). See docs/CLOUDFLARE_DEPLOYMENT.md.</ErrorBanner>}
      {usage && (
        <div className="card flat">
          <div className="row"><b className="grow">{fmtBytes(usage.bytes)} used of {fmtBytes(usage.limitBytes)}</b><span className="muted">{usage.files} file(s) · max upload {fmtBytes(usage.maxUploadBytes)}</span></div>
          <div className="bar" style={{ marginTop: 8 }} role="progressbar" aria-valuemin={0} aria-valuemax={usage.limitBytes} aria-valuenow={usage.bytes}><i style={{ width: `${Math.min(100, (usage.bytes / Math.max(1, usage.limitBytes)) * 100)}%` }} /></div>
        </div>
      )}
      <div className="row wrap">
        <nav className="row muted" aria-label="Folder path">
          <button className="chip" onClick={() => (setFolder(null), setTrail([]))}>All files</button>
          {trail.map((f, i) => <button key={f.id} className="chip" onClick={() => (setFolder(f), setTrail(trail.slice(0, i + 1)))}>{f.name}</button>)}
        </nav>
        <div className="grow" />
        <button className="btn" onClick={async () => { const name = prompt('Folder name'); if (name) await api.createFolder(name, folder?.id ?? null).then(load, fail); }}>New folder</button>
        <button className="btn primary" disabled={busy || list?.available === false} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Upload'}</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
      </div>
      {!list ? <div className="muted" role="status">Loading…</div> : !list.files.length && !list.folders.length ? (
        <Empty title={q ? 'No matches' : 'This folder is empty'}>{q ? 'Try another search.' : 'Drop files here or use Upload.'}</Empty>
      ) : (
        <div className="list">
          {list.folders.map((f) => (
            <div key={f.id} className="item">
              <button className="btn sm" onClick={() => (setFolder(f), setTrail([...trail, f]), setQ(''))}>📁 {f.name}</button>
              <span className="grow" />
              <button className="btn sm danger" onClick={async () => { if (confirm(`Delete folder “${f.name}”?`)) await api.deleteFolder(f.id).then(load, fail); }}>Delete</button>
            </div>
          ))}
          {list.files.map((f) => (
            <div key={f.id} className="item">
              <span className="grow"><b>{f.name}</b><br /><span className="muted">{fmtBytes(f.size)} · {f.mime} · {fmtTime(f.createdAt)}</span></span>
              <button className="btn sm" onClick={() => void open(f)}>{previewable(f.mime) || f.mime === 'text/plain' || f.mime === 'application/json' ? 'Preview' : 'Download'}</button>
              <a className="btn sm" href={`/api/files/${f.id}/download`} download>Download</a>
              <button className="btn sm danger" onClick={async () => { if (confirm(`Permanently delete “${f.name}”? This cannot be undone.`)) await api.deleteFile(f.id).then(load, fail); }}>Delete</button>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div className="card" role="dialog" aria-label={`Preview of ${preview.file.name}`}>
          <div className="row"><b className="grow">{preview.file.name}</b><button className="btn sm" onClick={() => setPreview(null)}>Close</button></div>
          {preview.text !== undefined ? <pre style={{ marginTop: 10, maxHeight: 420 }}>{preview.text}</pre> : <img alt={preview.file.name} src={`/api/files/${preview.file.id}/download?inline=1`} style={{ maxWidth: '100%', marginTop: 10, borderRadius: 10 }} />}
        </div>
      )}
    </div>
  );
}
