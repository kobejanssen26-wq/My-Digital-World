import { computeMetrics, integrationHealth } from '../lib/metrics.js';
import { ago } from '../lib/format.js';
import { useStore } from '../store.js';
import { Empty } from './ui.js';

export function Metrics() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const m = computeMetrics(data, now);
  const items: [string, number | string][] = [
    ['Active projects', m.activeProjects],
    ['Tasks in progress', m.tasksInProgress],
    ['Need attention', m.tasksNeedingAttention],
    ['Completed tasks', m.completedTasks],
    ['Connected sessions', m.connectedSessions],
    ['Last sync', ago(m.lastSync, now)],
  ];
  return (
    <div className="metrics" role="list" aria-label="Overview metrics">
      {items.map(([label, v]) => (
        <div className="metric" role="listitem" key={label}>
          <b>{v}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectHelp() {
  const go = useStore((s) => s.go);
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const h = integrationHealth(data, now);
  return (
    <Empty
      title="No Claude Code activity recorded yet"
      action={<button className="btn primary" onClick={() => go('settings')}>Open bridge setup</button>}
    >
      <p style={{ margin: 0, maxWidth: 520 }}>{h.detail} Projects appear here automatically as soon as Claude Code does real work — you never create them by hand.</p>
      <ol className="steps">
        <li>Create a bridge credential in <b>Settings → Bridge</b>.</li>
        <li>On your computer run <code>mdw-bridge init</code> with that credential, then <code>mdw-bridge install-hooks</code>.</li>
        <li>Use Claude Code as usual. The first prompt that does real work creates its project.</li>
      </ol>
    </Empty>
  );
}
