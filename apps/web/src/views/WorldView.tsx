import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { BUILDING_LABEL, BUILDINGS } from '@mdw/shared';
import { BuildingPanel } from '../components/BuildingPanel.js';
import { Metrics, ConnectHelp } from '../components/Overview.js';
import { ProjectPanel } from '../components/ProjectPanel.js';
import { Pill, Swatch } from '../components/ui.js';
import { filterProjects, projectStatus } from '../lib/metrics.js';
import { useStore } from '../store.js';
import { Minimap } from '../world/Minimap.js';
import { FilterBar } from './ProjectsView.js';

const Scene = lazy(() => import('../world/Scene.js'));

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** 2D list of districts: the always-available, accessible version of the city. */
function ListWorld({ reason }: { reason: string }) {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const select = useStore((s) => s.select);
  const projects = Object.values(data.projects).filter((p) => p.activityLevel === 'developing');
  return (
    <div className="page">
      <p className="muted" role="status">{reason}</p>
      <div className="metrics-wrap"><Metrics /></div>
      {!projects.length ? <ConnectHelp /> : BUILDINGS.filter((b) => b !== 'hq' && b !== 'cloud').map((b) => {
        const here = projects.filter((p) => p.building === b);
        return (
          <section key={b} className="card flat">
            <h3>{BUILDING_LABEL[b]} · {here.length}</h3>
            <div className="list" style={{ marginTop: 8 }}>
              {here.map((p) => <button key={p.id} className="item" onClick={() => select(p.id)}><Swatch id={p.id} /><span className="grow"><b>{p.name}</b></span><Pill tone={projectStatus(p, data, now).tone}>{projectStatus(p, data, now).label}</Pill></button>)}
              {!here.length && <span className="muted">Empty</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function WorldView() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const { filter, query, selectedId, selectedBuilding, world3d } = useStore();
  const setQuery = useStore((s) => s.setQuery);
  const select = useStore((s) => s.select);
  const selectBuilding = useStore((s) => s.selectBuilding);
  const resetCamera = useStore((s) => s.resetCamera);
  const [gl] = useState(webglAvailable);
  const reduced = data.settings.reducedMotion || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const all = useMemo(() => Object.values(data.projects).filter((p) => p.activityLevel === 'developing'), [data.projects]);
  const visible = useMemo(() => {
    const f = filterProjects(data, filter, query);
    const sel = selectedId ? data.projects[selectedId] : undefined;
    return sel && !f.includes(sel) ? [...f, sel] : f;
  }, [data, filter, query, selectedId]);
  const selected = selectedId ? data.projects[selectedId] : undefined;

  if (!world3d) return <ListWorld reason="3D view is switched off (Settings → Display)." />;
  if (!gl) return <ListWorld reason="3D graphics are not available in this browser, showing the list view instead." />;

  return (
    <div className="world">
      <Boundary fallback={<ListWorld reason="The 3D view could not start on this device, showing the list view instead." />}>
        <Suspense fallback={<div className="page muted" role="status">Loading the city…</div>}>
          <Scene visible={visible} all={all} data={data} now={now} reduced={reduced} light={data.settings.lightweight} />
        </Suspense>
      </Boundary>
      <div className="hud">
        <div className="hud-tl">
          <div className="glass" style={{ padding: 12 }}><Metrics /></div>
          {data.loaded && !all.length && <div className="glass" style={{ padding: 4 }}><ConnectHelp /></div>}
        </div>
        <div className="hud-tr glass" style={{ padding: 8 }}>
          <input type="search" aria-label="Find a project in the world" placeholder="Find project…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 150 }} />
          <FilterBar />
          <button className="btn sm" onClick={resetCamera}>Reset camera</button>
        </div>
        {!selected && !selectedBuilding && (
          <div className="hud-bl"><Minimap projects={visible} data={data} now={now} /></div>
        )}
        {selected && (
          <aside className="panel glass" aria-label="Project details"><ProjectPanel project={selected} onClose={() => select(null)} /></aside>
        )}
        {selectedBuilding && !selected && (
          <aside className="panel glass" aria-label="Building details"><BuildingPanel id={selectedBuilding} onClose={() => selectBuilding(null)} /></aside>
        )}
        {(selected || selectedBuilding) && <div className="hud-bl"><Minimap projects={visible} data={data} now={now} /></div>}
      </div>
    </div>
  );
}
