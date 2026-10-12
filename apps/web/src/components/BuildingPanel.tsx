import { BUILDING_LABEL, type BuildingId } from '@mdw/shared';
import { computeMetrics, integrationHealth, projectStatus } from '../lib/metrics.js';
import { fmtBytes, ago } from '../lib/format.js';
import { useStore } from '../store.js';
import { Pill, Swatch } from './ui.js';

const ABOUT: Record<BuildingId, string> = {
  hq: 'Command center: overview of everything the bridge has reported.',
  intake: 'New requests arrive here. Work waits until Claude acts on it.',
  planning: 'Claude is reading/investigating, or is waiting for your input.',
  development: 'Claude is modifying files for these projects, or finished and awaits your review.',
  testing: 'A test run is in progress (observed from Claude Code tool events).',
  workshop: 'Failing tests/builds or repeated tool failures need fixing.',
  deployment: 'Tests passed and deploy tooling exists. Ready is not deployed.',
  completed: 'Projects whose work is finished and whose sessions are closed.',
  cloud: 'Files you uploaded to private storage.',
};

export function BuildingPanel({ id, onClose }: { id: BuildingId; onClose: () => void }) {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const projects = Object.values(data.projects).filter((p) => p.activityLevel === 'developing' && p.building === id);
  const m = computeMetrics(data, now);
  const h = integrationHealth(data, now);
  return (
    <>
      <div className="panel-head">
        <div className="grow"><h2>{BUILDING_LABEL[id]}</h2><p className="muted" style={{ margin: '4px 0 0' }}>{ABOUT[id]}</p></div>
        <button className="btn sm" onClick={onClose} aria-label="Close building details">Close</button>
      </div>
      <div className="panel-body">
        {id === 'hq' && (
          <dl className="kv">
            <dt>Integration</dt><dd>{h.label} — {h.detail}</dd>
            <dt>Last sync</dt><dd>{ago(m.lastSync, now)}</dd>
            <dt>Live sessions</dt><dd>{m.connectedSessions}</dd>
            <dt>Active projects</dt><dd>{m.activeProjects}</dd>
            <dt>Need attention</dt><dd>{m.tasksNeedingAttention}</dd>
          </dl>
        )}
        {id === 'cloud' && (
          <>
            <dl className="kv"><dt>Files</dt><dd>{data.stats.files}</dd><dt>Used</dt><dd>{fmtBytes(data.stats.storageBytes)} of {fmtBytes(data.stats.storageLimitBytes)}</dd><dt>Storage</dt><dd>{data.stats.r2 ? 'Private R2 bucket' : 'Not enabled'}</dd></dl>
            <button className="btn primary" onClick={() => go('cloud')}>Open file library</button>
          </>
        )}
        {id !== 'hq' && id !== 'cloud' && (
          projects.length ? (
            <div className="list">
              {projects.map((p) => {
                const st = projectStatus(p, data, now);
                return (
                  <button key={p.id} className="item" onClick={() => (select(p.id), useStore.getState().focus(p.x, p.z))}>
                    <Swatch id={p.id} /><span className="grow"><b>{p.name}</b></span><Pill tone={st.tone}>{st.label}</Pill>
                  </button>
                );
              })}
            </div>
          ) : <p className="muted">No projects here right now.</p>
        )}
      </div>
    </>
  );
}
