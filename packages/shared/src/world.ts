import type { BuildingId, ProjectBuilding } from './model.js';

/**
 * World layout shared by the server (slot assignment), and the client (rendering,
 * minimap and route planning). All coordinates are in world units on the XZ plane.
 */

export interface BuildingSpec {
  id: BuildingId;
  center: [number, number];
  label: string;
}

const SPACING = 22;
export const LANES = [-33, -11, 11, 33];
const cell = (col: number, row: number): [number, number] => [(col - 1) * SPACING, (row - 1) * SPACING];

export const BUILDING_SPECS: Record<BuildingId, BuildingSpec> = {
  intake: { id: 'intake', center: cell(0, 0), label: 'Project Intake' },
  planning: { id: 'planning', center: cell(1, 0), label: 'Planning Office' },
  development: { id: 'development', center: cell(2, 0), label: 'Development District' },
  cloud: { id: 'cloud', center: cell(0, 1), label: 'Personal Cloud' },
  hq: { id: 'hq', center: cell(1, 1), label: 'Headquarters' },
  testing: { id: 'testing', center: cell(2, 1), label: 'Testing Center' },
  completed: { id: 'completed', center: cell(0, 2), label: 'Completed Projects' },
  deployment: { id: 'deployment', center: cell(1, 2), label: 'Deployment Center' },
  workshop: { id: 'workshop', center: cell(2, 2), label: 'Repair Workshop' },
};

export type Vec2 = [number, number];

/** Road graph: 4x4 lattice of intersections + one gate node per building on its south lane. */
export interface RoadGraph {
  nodes: Record<string, Vec2>;
  edges: Record<string, string[]>;
}

function buildGraph(): RoadGraph {
  const nodes: Record<string, Vec2> = {};
  const edges: Record<string, Set<string>> = {};
  const add = (id: string, p: Vec2) => {
    nodes[id] = p;
    edges[id] ??= new Set();
  };
  const link = (a: string, b: string) => {
    edges[a]!.add(b);
    edges[b]!.add(a);
  };
  const li = (i: number, j: number) => `i${i}${j}`;
  LANES.forEach((x, i) => LANES.forEach((z, j) => add(li(i, j), [x, z])));
  const split = new Map<string, string[]>(); // lane edge -> gates on it
  for (const spec of Object.values(BUILDING_SPECS)) {
    const [cx, cz] = spec.center;
    const laneZ = cz + 11; // south lane of the cell
    const j = LANES.indexOf(laneZ);
    const i = LANES.findIndex((x, k) => x < cx && (LANES[k + 1] ?? Infinity) > cx);
    const gate = `g_${spec.id}`;
    add(gate, [cx, laneZ]);
    split.set(`${i}-${j}`, [gate]);
  }
  for (let i = 0; i < LANES.length; i++)
    for (let j = 0; j < LANES.length; j++) {
      if (i + 1 < LANES.length) {
        const gates = split.get(`${i}-${j}`);
        if (gates) {
          link(li(i, j), gates[0]!);
          link(gates[0]!, li(i + 1, j));
        } else link(li(i, j), li(i + 1, j));
      }
      if (j + 1 < LANES.length) link(li(i, j), li(i, j + 1));
    }
  return { nodes, edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, [...v]])) };
}
export const ROADS: RoadGraph = buildGraph();

/** Parking slots live in a yard south of each building's gate, away from the road. */
export const SLOT_COLUMNS = 4;
export function slotPosition(building: ProjectBuilding | BuildingId, slot: number): Vec2 {
  const [cx, cz] = BUILDING_SPECS[building].center;
  const block = Math.floor(slot / 8);
  const i = slot % 8;
  const col = i % SLOT_COLUMNS;
  const row = Math.floor(i / SLOT_COLUMNS);
  const x = cx - 4.5 + col * 3;
  if (block === 0) return [x, cz + 6.6 + row * 1.8];
  return [x, cz - 6.6 - (row + 2 * (block - 1)) * 1.8];
}

function dijkstra(from: string, to: string): string[] {
  const dist: Record<string, number> = { [from]: 0 };
  const prev: Record<string, string> = {};
  const todo = new Set(Object.keys(ROADS.nodes));
  while (todo.size) {
    let u: string | null = null;
    for (const n of todo) if (dist[n] !== undefined && (u === null || dist[n]! < dist[u]!)) u = n;
    if (u === null) break;
    todo.delete(u);
    if (u === to) break;
    for (const v of ROADS.edges[u] ?? []) {
      const a = ROADS.nodes[u]!;
      const b = ROADS.nodes[v]!;
      const d = dist[u]! + Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (dist[v] === undefined || d < dist[v]!) {
        dist[v] = d;
        prev[v] = u;
      }
    }
  }
  const path = [to];
  while (path[0] !== from) {
    const p = prev[path[0]!];
    if (!p) return [from, to];
    path.unshift(p);
  }
  return path;
}

/**
 * Deterministic route between two parking slots: slot -> own gate -> roads -> destination gate -> slot.
 * Always follows valid road edges; never a straight line through buildings.
 */
export function planRoute(from: { building: ProjectBuilding; slot: number }, to: { building: ProjectBuilding; slot: number }): Vec2[] {
  const a = slotPosition(from.building, from.slot);
  const b = slotPosition(to.building, to.slot);
  if (from.building === to.building) return [a, b];
  const ids = dijkstra(`g_${from.building}`, `g_${to.building}`);
  return [a, ...ids.map((id) => ROADS.nodes[id]!), b];
}

export const routeLength = (r: Vec2[]) => r.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - r[i]![0], p[1] - r[i]![1]), 0);

export interface Actor {
  pos: Vec2;
  heading: number;
  route: Vec2[];
  idx: number; // next waypoint
  building: ProjectBuilding;
  slot: number;
}

export function actorAt(building: ProjectBuilding, slot: number): Actor {
  return { pos: slotPosition(building, slot), heading: 0, route: [], idx: 0, building, slot };
}

/**
 * Start a transition for an actor whose persisted location changed. If the actor is still driving,
 * it first finishes its current leg (so it never cuts across buildings), then continues to the new destination.
 */
export function retarget(actor: Actor, to: { building: ProjectBuilding; slot: number }, instant = false): Actor {
  if (instant) return actorAt(to.building, to.slot);
  const rest = actor.route.length ? actor.route.slice(actor.idx) : [];
  const plan = planRoute({ building: actor.building, slot: actor.slot }, to).slice(1);
  const route = [actor.pos, ...rest, ...plan];
  return { ...actor, route, idx: 1, building: to.building, slot: to.slot };
}

/** Advance along the route by dt seconds at `speed` units/sec. Pure. */
export function advance(actor: Actor, dt: number, speed = 9): Actor {
  if (actor.idx >= actor.route.length) return actor;
  let remaining = speed * dt;
  let pos: Vec2 = [...actor.pos];
  let idx = actor.idx;
  let heading = actor.heading;
  while (remaining > 0 && idx < actor.route.length) {
    const tgt = actor.route[idx]!;
    const dx = tgt[0] - pos[0];
    const dz = tgt[1] - pos[1];
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) heading = Math.atan2(dx, dz);
    if (d <= remaining) {
      pos = [tgt[0], tgt[1]];
      remaining -= d;
      idx++;
    } else {
      pos = [pos[0] + (dx / d) * remaining, pos[1] + (dz / d) * remaining];
      remaining = 0;
    }
  }
  const done = idx >= actor.route.length;
  return { ...actor, pos, idx, heading, route: done ? [] : actor.route };
}

/** Visual identity: stable hue/shape from the project id. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const hueFor = (id: string) => hashString(id) % 360;
export const shapeFor = (id: string) => (hashString(id + 'shape') % 3) as 0 | 1 | 2;
