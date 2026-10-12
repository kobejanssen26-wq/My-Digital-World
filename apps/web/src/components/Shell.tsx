import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FileRow, ProjectRow, TaskRow } from '@mdw/shared';
import { api } from '../api.js';
import { integrationHealth } from '../lib/metrics.js';
import { ago } from '../lib/format.js';
import { ROUTES, useStore, type Route } from '../store.js';
import { Icon, ICONS, Pill, Swatch } from './ui.js';

const LABEL: Record<Route, string> = { world: 'World', projects: 'Projects', activity: 'Activity', tasks: 'Tasks', cloud: 'Cloud', settings: 'Settings' };

export function Shell({ children }: { children: ReactNode }) {
  const route = useStore((s) => s.route);
  const go = useStore((s) => s.go);
  const ws = useStore((s) => s.ws);
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const health = integrationHealth(data, now);
  const tone = { none: 'idle', waiting: 'warn', ok: 'ok', quiet: 'idle', stale: 'warn' }[health.level] as 'idle' | 'warn' | 'ok';

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <i><svg viewBox="0 0 32 32"><path d="M7 22V12l9-5 9 5v10l-9 4z" /></svg></i>
          My Digital World
        </div>
        {ROUTES.map((r) => (
          <button key={r} className="nav-btn" aria-current={route === r ? 'page' : undefined} onClick={() => go(r)}>
            <Icon d={ICONS[r === 'world' ? 'world' : r === 'projects' ? 'projects' : r === 'activity' ? 'activity' : r === 'tasks' ? 'tasks' : r === 'cloud' ? 'cloud' : 'settings']} />
            {LABEL[r]}
          </button>
        ))}
        <div className="nav-spacer" />
      </nav>
      <header className="topbar">
        <GlobalSearch />
        <div className="grow" />
        <span title={health.detail}>
          <Pill tone={tone} pulse={health.level === 'ok'}>{health.label}</Pill>
        </span>
        <span title="Live connection to the dashboard backend">
          <Pill tone={ws === 'open' ? 'ok' : ws === 'connecting' ? 'warn' : 'bad'}>{ws === 'open' ? 'Live' : ws === 'connecting' ? 'Connecting' : 'Offline — retrying'}</Pill>
        </span>
        <span className="muted" style={{ fontSize: 12 }} title="Last event received from your computer">
          Synced {ago(data.bridge.lastIngestAt, now)}
        </span>
      </header>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}

type Results = { projects: ProjectRow[]; tasks: TaskRow[]; files: FileRow[] };

/** Global search: queries the server's stored records (debounced). */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Results | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const go = useStore((s) => s.go);
  const projects = useStore((s) => s.data.projects);

  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    const t = setTimeout(() => {
      api.search(q.trim()).then((r) => (setRes(r), setErr(false))).catch(() => setErr(true));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const total = res ? res.projects.length + res.tasks.length + res.files.length : 0;
  return (
    <div ref={box} style={{ position: 'relative', width: 'min(380px, 50vw)' }}>
      <input type="search" placeholder="Search projects, tasks, files…" aria-label="Global search" value={q} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} style={{ width: '100%' }} />
      {open && q.trim() && (
        <div className="card" role="listbox" aria-label="Search results" style={{ position: 'absolute', top: 42, left: 0, right: 0, zIndex: 20, display: 'grid', gap: 6, maxHeight: '60vh', overflow: 'auto' }}>
          {err && <span className="muted">Search failed. Try again.</span>}
          {res && !total && <span className="muted">No matches.</span>}
          {res?.projects.map((p) => (
            <button key={p.id} role="option" aria-selected="false" className="item" onClick={() => (go('world', p.id), useStore.getState().focus(p.x, p.z), setOpen(false))}>
              <Swatch id={p.id} /><span className="grow"><b>{p.name}</b><br /><span className="muted">{p.summary || p.repo || 'project'}</span></span>
            </button>
          ))}
          {res?.tasks.map((t) => (
            <button key={t.id} role="option" aria-selected="false" className="item" onClick={() => (go('world', t.projectId), setOpen(false))}>
              <Swatch id={t.projectId} /><span className="grow"><b>{t.summary || '(no summary)'}</b><br /><span className="muted">{projects[t.projectId]?.name ?? 'task'} · {t.status.replace(/_/g, ' ')}</span></span>
            </button>
          ))}
          {res?.files.map((f) => (
            <button key={f.id} role="option" aria-selected="false" className="item" onClick={() => (go('cloud'), setOpen(false))}>
              <span className="grow"><b>{f.name}</b><br /><span className="muted">file</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
