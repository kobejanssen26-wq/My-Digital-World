import type { BridgeHealth, Delta, EventRow, ProjectRow, SessionRow, Settings, Snapshot, TaskRow } from '@mdw/shared';
import { DEFAULT_SETTINGS } from '@mdw/shared';

/** Client-side mirror of persisted server state. The server is authoritative. */
export interface Data {
  loaded: boolean;
  cursor: number;
  serverSkew: number; // serverTime - clientTime at snapshot
  projects: Record<string, ProjectRow>;
  sessions: Record<string, SessionRow>;
  tasks: Record<string, TaskRow>;
  events: EventRow[]; // newest first
  bridge: BridgeHealth;
  settings: Settings;
  stats: Snapshot['stats'];
}

export const EMPTY_DATA: Data = {
  loaded: false,
  cursor: 0,
  serverSkew: 0,
  projects: {},
  sessions: {},
  tasks: {},
  events: [],
  bridge: { tokens: [], lastIngestAt: null, lastIngestSource: null },
  settings: DEFAULT_SETTINGS,
  stats: { files: 0, storageBytes: 0, storageLimitBytes: 0, r2: false },
};

const MAX_EVENTS = 500;
const byId = <T extends { id: string }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

export function fromSnapshot(s: Snapshot, clientNow = Date.now()): Data {
  return {
    loaded: true,
    cursor: s.cursor,
    serverSkew: s.serverTime - clientNow,
    projects: byId(s.projects),
    sessions: byId(s.sessions),
    tasks: byId(s.tasks),
    events: [...s.events].sort((a, b) => b.seq - a.seq),
    bridge: s.bridge,
    settings: s.settings,
    stats: s.stats,
  };
}

/** True when a delta cannot be applied contiguously (a message was missed) and a resync is required. */
export function needsResync(d: Data, delta: Delta): boolean {
  if (!d.loaded) return true;
  const first = delta.events.length ? Math.min(...delta.events.map((e) => e.seq)) : delta.cursor;
  return first > d.cursor + 1;
}

/** Apply a delta. Versioned entities never move backwards; duplicate deltas are no-ops. */
export function applyDelta(d: Data, delta: Delta): Data {
  if (delta.cursor <= d.cursor && delta.events.every((e) => d.events.some((x) => x.seq === e.seq))) return d;
  const projects = { ...d.projects };
  for (const p of delta.projects) if (!projects[p.id] || p.version >= projects[p.id]!.version) projects[p.id] = p;
  const tasks = { ...d.tasks };
  for (const t of delta.tasks) if (!tasks[t.id] || t.version >= tasks[t.id]!.version) tasks[t.id] = t;
  const sessions = { ...d.sessions };
  for (const s of delta.sessions) if (!sessions[s.id] || s.lastEventAt >= sessions[s.id]!.lastEventAt) sessions[s.id] = s;
  const seen = new Set(d.events.map((e) => e.seq));
  const events = [...delta.events.filter((e) => !seen.has(e.seq)), ...d.events].sort((a, b) => b.seq - a.seq).slice(0, MAX_EVENTS);
  return {
    ...d,
    cursor: Math.max(d.cursor, delta.cursor),
    projects,
    tasks,
    sessions,
    events,
    bridge: delta.bridge ? { ...d.bridge, ...delta.bridge } : d.bridge,
  };
}
