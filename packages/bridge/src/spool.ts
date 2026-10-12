import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from '@mdw/shared';
import { ensureDirs, paths } from './paths.js';

/**
 * Durable on-disk queue. One file per event, written atomically (tmp + rename), so a crash or
 * network outage can never lose or corrupt queued events. Events leave the spool only after the
 * server acknowledged them (accepted/duplicate) or permanently rejected them (moved to rejected/).
 */
export function enqueue(ev: Envelope): string {
  ensureDirs();
  const name = `${String(ev.ts).padStart(15, '0')}-${ev.id}.json`;
  const tmp = join(paths.spool(), `.${name}.${randomBytes(3).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(ev), { mode: 0o600 });
  renameSync(tmp, join(paths.spool(), name));
  return name;
}

export interface Queued {
  file: string;
  event: Envelope;
}

export function peek(limit: number): Queued[] {
  ensureDirs();
  const files = readdirSync(paths.spool())
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .slice(0, limit);
  const out: Queued[] = [];
  for (const file of files) {
    try {
      out.push({ file, event: JSON.parse(readFileSync(join(paths.spool(), file), 'utf8')) as Envelope });
    } catch {
      // Corrupt file: quarantine rather than block the queue or silently delete it.
      try {
        renameSync(join(paths.spool(), file), join(paths.rejected(), file + '.corrupt'));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export function ack(file: string) {
  try {
    unlinkSync(join(paths.spool(), file));
  } catch {
    /* already gone */
  }
}

export function reject(file: string, reason: string) {
  try {
    writeFileSync(join(paths.rejected(), file + '.reason'), reason);
    renameSync(join(paths.spool(), file), join(paths.rejected(), file));
  } catch {
    /* ignore */
  }
}

export const queueDepth = () => {
  try {
    return readdirSync(paths.spool()).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length;
  } catch {
    return 0;
  }
};
export const rejectedCount = () => {
  try {
    return readdirSync(paths.rejected()).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
};
