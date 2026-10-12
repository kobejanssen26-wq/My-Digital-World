import type { Envelope } from '../src/events.js';
import type { Model } from '../src/reducer.js';

let n = 0;
export function ev(type: Envelope['type'], ts: number, data: Envelope['data'] = {}, sessionId = 's1'): Envelope {
  return { v: 1, id: `evt_${String(++n).padStart(8, '0')}`, ts, source: 'test', type, sessionId, data };
}
export function model(): Model {
  return {
    facts: { testStatus: 'unknown', deployStatus: 'none', testTs: 0, deployTs: 0, activityLevel: 'observed', lastActive: 0 },
    session: { id: 's1', projectId: 'p1', startedAt: 1_700_000_000_000, endedAt: null, status: 'active', lastEventAt: 1_700_000_000_000, stateTs: 0, permissionMode: null },
    tasks: [],
  };
}
export const T0 = 1_700_000_000_000;
