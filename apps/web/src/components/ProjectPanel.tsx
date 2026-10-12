import { useEffect, useState } from 'react';
import { BUILDING_LABEL, STATUS_LABEL, type EventRow, type ProjectRow, type TaskRow } from '@mdw/shared';
import { api } from '../api.js';
import { COMPLETION_BASIS_LABEL, ago, describeEvent, fmtTime, sessionLabel } from '../lib/format.js';
import { isLive, isStale, projectStatus, tasksOf } from '../lib/metrics.js';
import { useStore } from '../store.js';
import { ErrorBanner, Pill, Swatch } from './ui.js';

const TEST_LABEL = { unknown: 'Not observed', running: 'Running…', passing: 'Last test run passed', failing: 'Last test run failed' } as const;
const DEPLOY_LABEL = {
  none: 'No deployment observed',
  ready: 'Ready to deploy (tests passed; deploy tooling detected) — not deployed',
  running: 'Deploy command running…',
  command_succeeded: 'Deploy command exited successfully — live site not verified',
  failed: 'Deploy command failed',
} as const;

export function ProjectPanel({ project, onClose }: { project: ProjectRow; onClose?: () => void }) {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const focus = useStore((s) => s.focus);
  const status = projectStatus(project, data, now);
  const [history, setHistory] = useState<EventRow[] | null>(null);
  const [allTasks, setAllTasks] = useState<TaskRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = project.version;

  useEffect(() => {
    let live = true;
    api.project(project.id).then((r) => live && (setHistory(r.events), setAllTasks(r.tasks), setErr(null))).catch(() => live && setErr('Could not load history.'));
    return () => {
      live = false;
    };
  }, [project.id, version]);

  const tasks = allTasks ?? tasksOf(data, project.id);
  const sessions = Object.values(data.sessions).filter((s) => s.projectId === project.id && isLive(s));
  const act = async (a: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.action(a);
      setErr(null);
    } catch {
      setErr('That action failed. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-head">
        <Swatch id={project.id} />
        <div className="grow">
          <h2>{project.name}</h2>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <Pill tone={status.tone} pulse={status.tone === 'ok'}>{status.label}</Pill>
            <span className="muted">{BUILDING_LABEL[project.building]}</span>
          </div>
        </div>
        {onClose && <button className="btn sm" onClick={onClose} aria-label="Close project details">Close</button>}
      </div>
      <div className="panel-body">
        {err && <ErrorBanner>{err}</ErrorBanner>}
        {project.summary && <p style={{ margin: 0 }}>{project.summary}</p>}
        <dl className="kv">
          <dt>Repository</dt><dd>{project.repo ?? <span className="muted">not shared / none</span>}</dd>
          <dt>Type</dt><dd>{project.projectType ?? <span className="muted">unknown</span>}</dd>
          <dt>Tests</dt><dd>{TEST_LABEL[project.testStatus]}</dd>
          <dt>Deployment</dt><dd>{DEPLOY_LABEL[project.deployStatus]}</dd>
          <dt>Sessions</dt>
          <dd>{sessions.length ? sessions.map((s) => <div key={s.id}>{sessionLabel(s, isStale(s, now))} · {ago(s.lastEventAt, now)}</div>) : <span className="muted">none active</span>}</dd>
          <dt>First seen</dt><dd>{fmtTime(project.firstSeen)}</dd>
          <dt>Last active</dt><dd>{fmtTime(project.lastActive)} ({ago(project.lastActive, now)})</dd>
        </dl>
        <div className="row wrap">
          <button className="btn sm" onClick={() => focus(project.x, project.z)}>Focus in world</button>
          {project.userPaused ? (
            <button className="btn sm" disabled={busy} onClick={() => act({ action: 'resume_project', projectId: project.id })}>Resume tracking</button>
          ) : (
            <button className="btn sm" disabled={busy} onClick={() => act({ action: 'pause_project', projectId: project.id })}>Pause</button>
          )}
        </div>

        <section>
          <h3>Task history</h3>
          {!tasks.length && <p className="muted">No tasks yet.</p>}
          <div className="list" style={{ marginTop: 8 }}>
            {tasks.slice(0, 20).map((t) => (
              <div key={t.id} className="card flat" style={{ padding: 10 }}>
                <div className="row wrap">
                  <b className="grow">{t.summary || <span className="muted">(prompt summary not shared)</span>}</b>
                  <Pill tone={t.status === 'completed' ? 'done' : t.status === 'needs_attention' || t.status === 'failed' ? 'bad' : t.status === 'ready_for_review' ? 'info' : 'ok'}>{STATUS_LABEL[t.status]}</Pill>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t.kind} · {ago(t.updatedAt, now)}
                  {t.completionBasis && <> · {COMPLETION_BASIS_LABEL[t.completionBasis] ?? t.completionBasis}</>}
                </div>
                {t.status === 'ready_for_review' || t.status === 'interrupted' || t.status === 'paused' ? (
                  <button className="btn sm" style={{ marginTop: 6 }} disabled={busy} onClick={() => act({ action: 'complete_task', taskId: t.id })}>Mark complete</button>
                ) : t.status === 'completed' ? (
                  <button className="btn sm" style={{ marginTop: 6 }} disabled={busy} onClick={() => act({ action: 'reopen_task', taskId: t.id })}>Reopen</button>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h3>Recent events</h3>
          <div className="timeline" style={{ marginTop: 6 }}>
            {(history ?? []).slice(0, 25).map((ev) => (
              <div className={`tl${ev.late ? ' late' : ''}`} key={ev.seq}>
                <time title={fmtTime(ev.ts)}>{ago(ev.ts, now)}</time>
                <span>{describeEvent(ev, project)}{ev.late ? ' (arrived late)' : ''}</span>
              </div>
            ))}
            {history && !history.length && <p className="muted">No events.</p>}
            {!history && !err && <p className="muted">Loading…</p>}
          </div>
        </section>
      </div>
    </>
  );
}
