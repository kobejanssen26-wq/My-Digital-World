import { BUILDING_LABEL } from '@mdw/shared';
import { useDeferredValue } from 'react';
import { ConnectHelp } from '../components/Overview.js';
import { ProjectPanel } from '../components/ProjectPanel.js';
import { Empty, Pill, Swatch } from '../components/ui.js';
import { ago } from '../lib/format.js';
import { filterProjects, projectStatus, type Filter } from '../lib/metrics.js';
import { useStore } from '../store.js';

export const FILTERS: [Filter, string][] = [['all', 'All'], ['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed'], ['failed', 'Failed / attention']];

export function FilterBar() {
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  return (
    <div className="tabs" role="group" aria-label="Project filter">
      {FILTERS.map(([k, label]) => (
        <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
      ))}
    </div>
  );
}

export default function ProjectsView() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const { filter, query, showObserved, selectedId } = useStore();
  const setQuery = useStore((s) => s.setQuery);
  const select = useStore((s) => s.select);
  const setShowObserved = useStore((s) => s.setShowObserved);
  const deferred = useDeferredValue(query);
  const rows = filterProjects(data, filter, deferred, showObserved);
  const selected = selectedId ? data.projects[selectedId] : undefined;
  const total = Object.keys(data.projects).length;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Projects</h1><p className="muted" style={{ margin: 0 }}>Detected automatically from Claude Code activity.</p></div>
        <input type="search" aria-label="Filter projects by name" placeholder="Filter by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="row wrap">
        <FilterBar />
        <label className="row muted" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" checked={showObserved} onChange={(e) => setShowObserved(e.target.checked)} /> Include observed-only sessions
        </label>
      </div>
      {!data.loaded ? <div className="muted" role="status">Loading…</div> : total === 0 ? <ConnectHelp /> : rows.length === 0 ? (
        <Empty title="No projects match">Try another filter or clear the search.</Empty>
      ) : (
        <div className="list">
          {rows.map((p) => {
            const st = projectStatus(p, data, now);
            return (
              <button key={p.id} className="item" onClick={() => select(p.id)} aria-pressed={selectedId === p.id}>
                <Swatch id={p.id} />
                <span className="grow"><b>{p.name}</b><br /><span className="muted">{p.summary || p.repo || 'No summary'}</span></span>
                <span className="muted" style={{ fontSize: 12 }}>{BUILDING_LABEL[p.building]} · {ago(p.lastActive, now)}</span>
                <Pill tone={st.tone}>{st.label}</Pill>
              </button>
            );
          })}
        </div>
      )}
      {selected && (
        <div className="card" style={{ padding: 0 }}>
          <ProjectPanel project={selected} onClose={() => select(null)} />
        </div>
      )}
    </div>
  );
}
