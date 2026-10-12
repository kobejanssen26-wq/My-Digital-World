import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** All bridge state lives under one private directory. MDW_HOME overrides it (tests, dev profiles). */
export function home(): string {
  return process.env.MDW_HOME || join(homedir(), '.mdw');
}
export const paths = {
  config: () => join(home(), 'config.json'),
  spool: () => join(home(), 'spool'),
  rejected: () => join(home(), 'rejected'),
  state: () => join(home(), 'state'),
  cache: () => join(home(), 'cache.json'),
  status: () => join(home(), 'status.json'),
  lock: () => join(home(), 'daemon.lock'),
  log: () => join(home(), 'bridge.log'),
};

export function ensureDirs() {
  for (const d of [home(), paths.spool(), paths.rejected(), paths.state()]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      chmodSync(d, 0o700);
    } catch {
      /* best effort on platforms without chmod */
    }
  }
}
