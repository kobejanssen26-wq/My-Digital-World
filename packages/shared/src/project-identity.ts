/**
 * Project identity resolution. The bridge supplies identity keys (never paths):
 *   remote:<host/owner/repo>   — canonical git remote
 *   path:<sha256 of machine+toplevel>   — stable across renames of the remote
 *   root:<first commit sha>    — stable across directory moves (but shared by forks)
 *
 * `resolveProject` decides which existing project (if any) the keys refer to.
 */

export interface Candidate {
  id: string;
  /** All alias keys already bound to this project. */
  keys: string[];
}

export type Resolution =
  | { kind: 'existing'; projectId: string; addKeys: string[] }
  | { kind: 'new'; keys: string[] };

const prefix = (k: string) => k.slice(0, k.indexOf(':'));

export function resolveProject(keys: string[], candidates: Candidate[]): Resolution {
  const byKey = (k: string) => candidates.find((c) => c.keys.includes(k));
  const remote = keys.find((k) => prefix(k) === 'remote');
  const path = keys.find((k) => prefix(k) === 'path');
  const root = keys.find((k) => prefix(k) === 'root');

  const bind = (c: Candidate): Resolution => ({
    kind: 'existing',
    projectId: c.id,
    addKeys: keys.filter((k) => !c.keys.includes(k)),
  });

  // 1. Same remote => same project (clones, worktrees, other dirs).
  if (remote) {
    const c = byKey(remote);
    if (c) return bind(c);
  }
  // 2. Same directory => same project (remote renamed/added/changed).
  if (path) {
    const c = byKey(path);
    if (c) return bind(c);
  }
  // 3. Same root commit: directory moved. A different known remote means a fork => new project.
  if (root) {
    const c = byKey(root);
    if (c) {
      const candidateRemote = c.keys.find((k) => prefix(k) === 'remote');
      if (!remote || !candidateRemote) {
        // Moved directory (no conflicting remotes). Only adopt if the old path no longer collides.
        return bind(c);
      }
    }
  }
  return { kind: 'new', keys };
}
