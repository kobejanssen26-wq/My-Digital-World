import { EVENT_TYPES, type EventRow } from '@mdw/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, Empty, Swatch } from '../components/ui.js';
import { ago, describeEvent, fmtTime } from '../lib/format.js';
import { useStore } from '../store.js';

const RANGES: [string, number][] = [['Any time', 0], ['Last hour', 3600_000], ['Last 24 hours', 86_400_000], ['Last 7 days', 7 * 86_400_000]];

export default function ActivityView() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const go = useStore((s) => s.go);
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [range, setRange] = useState(0);
  const [older, setOlder] = useState<EventRow[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    setOlder([]);
    setMore(null);
  }, [project, type, range]);

  const live = useMemo(
    () => data.events.filter((e) => (!project || e.projectId === project) && (!type || e.type === type) && (!range || e.ts >= now - range)),
    [data.events, project, type, range, now],
  );
  const rows = useMemo(() => {
    const seen = new Set(live.map((e) => e.seq));
    return [...live, ...older.filter((e) => !seen.has(e.seq))];
  }, [live, older]);

  async function loadOlder() {
    setBusy(true);
    setErr(false);
    try {
      const last = rows[rows.length - 1];
      const r = await api.events({ before: last?.seq, project, type, limit: 50 });
      setOlder((o) => [...o, ...r.events.filter((e) => !range || e.ts >= now - range)]);
      setMore(r.hasMore);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  const projects = Object.values(data.projects).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="page">
      <div className="page-head"><div><h1>Activity</h1><p className="muted" style={{ margin: 0 }}>Every event received from your computer, newest first.</p></div></div>
      <div className="row wrap">
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="Event type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All event types</option>
          {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select aria-label="Time range" value={range} onChange={(e) => setRange(Number(e.target.value))}>
          {RANGES.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
        </select>
      </div>
      {err && <ErrorBanner>Could not load older events.</ErrorBanner>}
      {!data.loaded ? <div className="muted" role="status">Loading…</div> : rows.length === 0 ? (
        <Empty title="No events">{data.events.length ? 'No events match these filters.' : 'Nothing has been received yet. Events appear here as soon as Claude Code activity reaches the dashboard.'}</Empty>
      ) : (
        <div className="card timeline" role="feed" aria-label="Event feed">
          {rows.map((e) => {
            const p = e.projectId ? data.projects[e.projectId] : undefined;
            return (
              <div className={`tl${e.late ? ' late' : ''}`} key={e.seq} role="article">
                <time title={fmtTime(e.ts)}>{ago(e.ts, now)}</time>
                <span>
                  {p && <button className="chip" style={{ marginRight: 8 }} onClick={() => go('world', p.id)}><Swatch id={p.id} /> {p.name}</button>}
                  {describeEvent(e, p)}
                  {e.late && <span className="muted"> (arrived out of order)</span>}
                </span>
              </div>
            );
          })}
          <div style={{ paddingTop: 12 }}>
            {more !== false && <button className="btn" disabled={busy} onClick={loadOlder}>{busy ? 'Loading…' : 'Load older events'}</button>}
            {more === false && <span className="muted">That's everything we have stored.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
