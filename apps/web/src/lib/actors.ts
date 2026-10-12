import { actorAt, advance, retarget, type Actor, type ProjectRow } from '@mdw/shared';

/**
 * Reconcile animated actors with persisted project locations. The database is authoritative:
 * an actor only moves when the persisted (building, slot) changed, and always along the road graph.
 * On first sight (page load / reconnect) actors are placed instantly — no replayed animation.
 */
export function reconcileActors(actors: Map<string, Actor>, projects: ProjectRow[], opts: { instant: boolean }): { actors: Map<string, Actor>; moved: string[] } {
  const next = new Map<string, Actor>();
  const moved: string[] = [];
  for (const p of projects) {
    const prev = actors.get(p.id);
    if (!prev) {
      next.set(p.id, actorAt(p.building, p.slot));
    } else if (prev.building !== p.building || prev.slot !== p.slot) {
      next.set(p.id, retarget(prev, { building: p.building, slot: p.slot }, opts.instant));
      moved.push(p.id);
    } else next.set(p.id, prev);
  }
  return { actors: next, moved };
}

export const stepActors = (actors: Map<string, Actor>, dt: number) => {
  let changed = false;
  for (const [id, a] of actors) {
    if (a.route.length) {
      actors.set(id, advance(a, dt));
      changed = true;
    }
  }
  return changed;
};
