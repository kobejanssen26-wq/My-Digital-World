import { create } from 'zustand';
import type { BuildingId, Delta, Snapshot } from '@mdw/shared';
import { api, setCsrf } from './api.js';
import { applyDelta, EMPTY_DATA, fromSnapshot, needsResync, type Data } from './lib/data.js';
import type { Filter } from './lib/metrics.js';

export type Route = 'world' | 'projects' | 'activity' | 'tasks' | 'cloud' | 'settings';
export const ROUTES: Route[] = ['world', 'projects', 'activity', 'tasks', 'cloud', 'settings'];
export type CameraCmd = { kind: 'focus' | 'reset'; x: number; z: number; tick: number };

const safe = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

export const routeFromHash = (hash: string): { route: Route; id: string | null } => {
  const [, r, id] = hash.replace(/^#/, '').split('/');
  return { route: (ROUTES as string[]).includes(r ?? '') ? (r as Route) : 'world', id: id ? decodeURIComponent(id) : null };
};

export interface State {
  auth: 'loading' | 'anon' | 'authed' | 'unconfigured' | 'error';
  loadError: string | null;
  data: Data;
  ws: 'connecting' | 'open' | 'closed';
  now: number;
  route: Route;
  selectedId: string | null;
  hoveredId: string | null;
  selectedBuilding: BuildingId | null;
  filter: Filter;
  query: string;
  showObserved: boolean;
  camera: CameraCmd | null;
  world3d: boolean; // per-viewer convenience (localStorage)

  boot(): Promise<void>;
  login(password: string): Promise<void>;
  logout(): Promise<void>;
  resync(): Promise<void>;
  receive(delta: Delta): 'applied' | 'resync';
  setWs(s: State['ws']): void;
  tick(): void;
  go(route: Route, id?: string | null): void;
  select(id: string | null): void;
  hover(id: string | null): void;
  selectBuilding(b: BuildingId | null): void;
  setFilter(f: Filter): void;
  setQuery(q: string): void;
  setShowObserved(v: boolean): void;
  focus(x: number, z: number): void;
  resetCamera(): void;
  setWorld3d(v: boolean): void;
  replaceSettings(s: Data['settings']): void;
}

export const useStore = create<State>((set, get) => ({
  auth: 'loading',
  loadError: null,
  data: EMPTY_DATA,
  ws: 'closed',
  now: Date.now(),
  route: routeFromHash(typeof location !== 'undefined' ? location.hash : '').route,
  selectedId: routeFromHash(typeof location !== 'undefined' ? location.hash : '').id,
  hoveredId: null,
  selectedBuilding: null,
  filter: 'all',
  query: '',
  showObserved: false,
  camera: null,
  world3d: safe.get('mdw.world3d') !== 'off',

  async boot() {
    try {
      const me = await api.me();
      if (me.authenticated && me.csrf) {
        setCsrf(me.csrf);
        set({ auth: 'authed' });
        await get().resync();
      } else set({ auth: me.configured === false ? 'unconfigured' : 'anon' });
    } catch (e) {
      set({ auth: 'error', loadError: (e as Error).message });
    }
  },
  async login(password) {
    const r = await api.login(password);
    setCsrf(r.csrf);
    set({ auth: 'authed' });
    await get().resync();
  },
  async logout() {
    await api.logout().catch(() => undefined);
    setCsrf(null);
    set({ auth: 'anon', data: EMPTY_DATA });
  },
  async resync() {
    try {
      const snap: Snapshot = await api.snapshot();
      set({ data: fromSnapshot(snap), loadError: null });
    } catch (e) {
      if ((e as { status?: number }).status === 401) set({ auth: 'anon' });
      else set({ loadError: (e as Error).message });
    }
  },
  receive(delta) {
    const d = get().data;
    if (needsResync(d, delta)) return 'resync';
    set({ data: applyDelta(d, delta) });
    return 'applied';
  },
  setWs: (ws) => set({ ws }),
  tick: () => set({ now: Date.now() }),
  go(route, id = null) {
    if (typeof location !== 'undefined') location.hash = `#/${route}${id ? `/${encodeURIComponent(id)}` : ''}`;
    set({ route, selectedId: id ?? get().selectedId });
  },
  select: (selectedId) => set({ selectedId, selectedBuilding: selectedId ? null : get().selectedBuilding }),
  selectBuilding: (selectedBuilding) => set({ selectedBuilding, selectedId: selectedBuilding ? null : get().selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  setFilter: (filter) => set({ filter }),
  setQuery: (query) => set({ query }),
  setShowObserved: (showObserved) => set({ showObserved }),
  focus: (x, z) => set({ camera: { kind: 'focus', x, z, tick: (get().camera?.tick ?? 0) + 1 } }),
  resetCamera: () => set({ camera: { kind: 'reset', x: 0, z: 0, tick: (get().camera?.tick ?? 0) + 1 } }),
  setWorld3d(v) {
    safe.set('mdw.world3d', v ? 'on' : 'off');
    set({ world3d: v });
  },
  replaceSettings: (settings) => set({ data: { ...get().data, settings } }),
}));
