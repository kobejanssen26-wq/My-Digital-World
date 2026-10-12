import { STATUS_LABEL, type TaskRow, type TaskStatus } from '@mdw/shared';
import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, Empty, Pill, Swatch } from '../components/ui.js';
import { COMPLETION_BASIS_LABEL, ago } from '../lib/format.js';
import { useStore } from '../store.js';

const GROUPS: [string, TaskStatus[]][] = [
  ['Needs attention', ['needs_attention', 'failed']],
  ['Waiting for you', ['waiting_input']],
  ['In progress', ['received', 'planning', 'in_development', 'testing']],
  ['Ready for review', ['ready_for_review']],
  ['Interrupted / paused', ['interrupted', 'paused']],
  ['Completed', ['completed']],
];

export default function TasksView() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const go = useStore((s) => s.go);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const tasks = Object.values(data.tasks).filter((t) => data.projects[t.projectId]?.activityLevel === 'developing' || t.kind !== 'question');
  const act = async (t: TaskRow, action: 'complete_task' | 'reopen_task') => {
    setBusy(t.id);
    try {
      await api.action({ action, taskId: t.id });
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page">
      <div className="page-head"><div><h1>Tasks</h1><p className="muted" style={{ margin: 0 }}>Created and moved automatically from real Claude Code activity. Statuses are evidence-based; “Ready for review” is not “done”.</p></div></div>
      {err && <ErrorBanner>That action failed. Nothing was changed.</ErrorBanner>}
      {!data.loaded ? <div className="muted" role="status">Loading…</div> : tasks.length === 0 ? <Empty title="No tasks yet">Tasks appear when you give Claude Code a request.</Empty> : GROUPS.map(([title, statuses]) => {
        const rows = tasks.filter((t) => statuses.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
        if (!rows.length) return null;
        return (
          <section key={title}>
            <h3 style={{ marginBottom: 8 }}>{title} · {rows.length}</h3>
            <div className="list">
              {rows.slice(0, 50).map((t) => {
                const p = data.projects[t.projectId];
                return (
                  <div key={t.id} className="item">
                    <Swatch id={t.projectId} />
                    <span className="grow">
                      <b>{t.summary || <span className="muted">(prompt summary not shared)</span>}</b><br />
                      <span className="muted">
                        <button className="chip" onClick={() => go('world', t.projectId)}>{p?.name ?? 'project'}</button> {t.kind} · {ago(t.updatedAt, now)}
                        {t.completionBasis && ` · ${COMPLETION_BASIS_LABEL[t.completionBasis] ?? t.completionBasis}`}
                      </span>
                    </span>
                    <Pill tone={t.status === 'completed' ? 'done' : t.status === 'needs_attention' || t.status === 'failed' ? 'bad' : t.status === 'waiting_input' ? 'warn' : t.status === 'ready_for_review' ? 'info' : 'ok'}>{STATUS_LABEL[t.status]}</Pill>
                    {['ready_for_review', 'interrupted', 'paused'].includes(t.status) && <button className="btn sm" disabled={busy === t.id} onClick={() => act(t, 'complete_task')}>Mark complete</button>}
                    {t.status === 'completed' && <button className="btn sm" disabled={busy === t.id} onClick={() => act(t, 'reopen_task')}>Reopen</button>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
