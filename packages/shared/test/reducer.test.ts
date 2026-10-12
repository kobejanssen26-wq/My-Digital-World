import { describe, expect, it } from 'vitest';
import { applyEvent, deriveBuilding, deriveLifecycle, markStale, type Model, type ProjectAggregates } from '../src/reducer.js';
import type { Envelope } from '../src/events.js';
import { ev, model, T0 } from './helpers.js';

function run(events: Envelope[], start: Model = model()): Model {
  return events.reduce((m, e) => applyEvent(m, e).model, start);
}
const prompt = (ts: number, kind = 'feature', conf: 'low' | 'medium' | 'high' = 'medium') =>
  ev('prompt.submit', ts, { promptKind: kind as never, confidence: conf, summary: 'add dark mode' });
const tool = (ts: number, category: string, ok = true, type?: Envelope['type']) =>
  ev(type ?? (ok ? 'tool.done' : 'tool.fail'), ts, { tool: 'X', category: category as never });

describe('task state machine', () => {
  it('creates a received task on a feature prompt and marks the project developing', () => {
    const m = run([ev('session.start', T0), prompt(T0 + 1)]);
    expect(m.tasks).toHaveLength(1);
    expect(m.tasks[0]!.status).toBe('received');
    expect(m.facts.activityLevel).toBe('developing');
  });

  it('keeps a question as observed and completes it when answered', () => {
    const m = run([ev('session.start', T0), prompt(T0 + 1, 'question', 'high'), ev('turn.stop', T0 + 5)]);
    expect(m.facts.activityLevel).toBe('observed');
    expect(m.tasks[0]!.status).toBe('completed');
    expect(m.tasks[0]!.completionBasis).toBe('answered');
  });

  it('read-only tools mean planning, modifying tools mean in_development', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'read')]);
    expect(m.tasks[0]!.status).toBe('planning');
    m = run([tool(T0 + 2, 'modify')], m);
    expect(m.tasks[0]!.status).toBe('in_development');
  });

  it('test lifecycle: running -> failing -> needs_attention -> passing', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'modify'), tool(T0 + 2, 'test', true, 'tool.start')]);
    expect(m.tasks[0]!.status).toBe('testing');
    expect(m.facts.testStatus).toBe('running');
    m = run([tool(T0 + 3, 'test', false)], m);
    expect(m.facts.testStatus).toBe('failing');
    expect(m.tasks[0]!.status).toBe('needs_attention');
    // editing does not clear failing tests
    m = run([tool(T0 + 4, 'modify')], m);
    expect(m.tasks[0]!.status).toBe('needs_attention');
    m = run([tool(T0 + 5, 'test', true)], m);
    expect(m.facts.testStatus).toBe('passing');
    expect(m.tasks[0]!.status).toBe('in_development');
  });

  it('a single generic tool failure is not an attention state, three in a row are', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'modify'), tool(T0 + 2, 'shell', false), tool(T0 + 3, 'shell', false)]);
    expect(m.tasks[0]!.status).toBe('in_development');
    m = run([tool(T0 + 4, 'shell', false)], m);
    expect(m.tasks[0]!.status).toBe('needs_attention');
  });

  it('deploy success is recorded as command_succeeded, never as live', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'deploy')]);
    expect(m.facts.deployStatus).toBe('command_succeeded');
  });

  it('Stop makes the task ready_for_review, not completed', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('turn.stop', T0 + 2)]);
    expect(m.tasks[0]!.status).toBe('ready_for_review');
    expect(m.session.status).toBe('idle');
  });

  it('Stop with failing tests stays in needs_attention', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'test', false), ev('turn.stop', T0 + 2)]);
    expect(m.tasks[0]!.status).toBe('needs_attention');
  });

  it('session end alone does not complete in-flight work; it marks it interrupted', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('session.end', T0 + 2, { reason: 'other' })]);
    expect(m.tasks[0]!.status).toBe('interrupted');
    expect(m.session.status).toBe('ended');
  });

  it('clean finish followed by session close completes with an explicit basis', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('turn.stop', T0 + 2), ev('session.end', T0 + 3)]);
    expect(m.tasks[0]!.status).toBe('completed');
    expect(m.tasks[0]!.completionBasis).toBe('claude_finished_session_closed');
  });

  it('notifications that need the user move the task to waiting_input', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('notification', T0 + 2, { notificationType: 'permission_prompt' })]);
    expect(m.tasks[0]!.status).toBe('waiting_input');
  });

  it('turn failure marks the task failed', () => {
    const m = run([prompt(T0), ev('turn.fail', T0 + 1, { reason: 'rate_limit' })]);
    expect(m.tasks[0]!.status).toBe('failed');
  });

  it('a continuation prompt attaches to the open task instead of creating a new one', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('turn.stop', T0 + 2)]);
    m = run([ev('prompt.submit', T0 + 3, { promptKind: 'continuation', confidence: 'high' })], m);
    expect(m.tasks).toHaveLength(1);
    expect(m.tasks[0]!.status).toBe('received');
  });

  it('an ambiguous (other/low) prompt attaches to an existing open task', () => {
    let m = run([prompt(T0)]);
    m = run([ev('prompt.submit', T0 + 1, { promptKind: 'other', confidence: 'low' })], m);
    expect(m.tasks).toHaveLength(1);
  });

  it('an ambiguous prompt with no open task becomes its own task', () => {
    const m = run([ev('prompt.submit', T0, { promptKind: 'other', confidence: 'low' })]);
    expect(m.tasks).toHaveLength(1);
    expect(m.tasks[0]!.kind).toBe('other');
  });

  it('a distinct confident request creates a second task', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('turn.stop', T0 + 2)]);
    m = run([prompt(T0 + 3, 'bugfix')], m);
    expect(m.tasks).toHaveLength(2);
  });

  it('tool use without an observed prompt creates an implicit activity task, later adopted by the prompt', () => {
    const m = run([tool(T0 + 5, 'modify')]);
    expect(m.tasks[0]!.kind).toBe('activity');
    // the prompt event arrives late (out of order) but was sent earlier
    const o = applyEvent(m, prompt(T0 + 1, 'bugfix'));
    expect(o.model.tasks).toHaveLength(1);
    expect(o.model.tasks[0]!.kind).toBe('bugfix');
    expect(o.model.tasks[0]!.summary).toBe('add dark mode');
  });
});

describe('interrupts', () => {
  it('an interrupted test run does not count as a failure and does not stay "testing"', () => {
    let m = run([prompt(T0), tool(T0 + 1, 'modify'), tool(T0 + 2, 'test', true, 'tool.start')]);
    expect(m.facts.testStatus).toBe('running');
    m = run([ev('tool.fail', T0 + 3, { category: 'test', errorKind: 'interrupt' })], m);
    expect(m.facts.testStatus).toBe('unknown');
    expect(m.tasks[0]!.status).toBe('waiting_input');
    expect(m.tasks[0]!.failStreak).toBe(0);
  });
});

describe('out-of-order handling', () => {
  it('an old event never overwrites newer task state', () => {
    let m = run([prompt(T0), tool(T0 + 10, 'modify'), ev('turn.stop', T0 + 20)]);
    expect(m.tasks[0]!.status).toBe('ready_for_review');
    // late tool event from before the stop
    const o = applyEvent(m, tool(T0 + 12, 'test', false));
    expect(o.model.tasks[0]!.status).toBe('ready_for_review');
    expect(o.model.facts.testStatus).toBe('failing'); // facts have their own clock (T0+12 > 0)
    m = o.model;
    expect(m.tasks[0]!.stateTs).toBe(T0 + 20);
  });

  it('a late session.end does not close a session that has newer activity', () => {
    let m = run([ev('session.start', T0), prompt(T0 + 1), tool(T0 + 30, 'modify')]);
    const o = applyEvent(m, ev('session.end', T0 + 10));
    m = o.model;
    expect(o.late).toBe(true);
    expect(m.session.status).toBe('active');
  });

  it('events newer than a session end reactivate (resume)', () => {
    let m = run([ev('session.start', T0), prompt(T0 + 1), ev('turn.stop', T0 + 2), ev('session.end', T0 + 3)]);
    expect(m.session.status).toBe('ended');
    m = run([ev('session.start', T0 + 100, { source: 'resume' })], m);
    expect(m.session.status).toBe('active');
    expect(m.session.endedAt).toBeNull();
  });

  it('flags events older than the session state as late and applies no state change', () => {
    const m = run([ev('session.start', T0), ev('session.end', T0 + 50)]);
    const o = applyEvent(m, prompt(T0 + 10));
    expect(o.late).toBe(true);
    expect(o.model.session.status).toBe('ended');
  });
});

describe('stale sessions', () => {
  it('marks idle-too-long sessions lost and interrupts in-flight tasks', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify')]);
    expect(markStale(m, T0 + 10 * 60_000)).toBeNull();
    const r = markStale(m, T0 + 31 * 60_000)!;
    expect(r.model.session.status).toBe('lost');
    expect(r.model.tasks[0]!.status).toBe('interrupted');
  });
  it('leaves ready_for_review and needs_attention untouched', () => {
    const m = run([prompt(T0), tool(T0 + 1, 'modify'), ev('turn.stop', T0 + 2)]);
    const r = markStale(m, T0 + 60 * 60_000)!;
    expect(r.model.tasks[0]!.status).toBe('ready_for_review');
  });
});

describe('project derivation', () => {
  const base: ProjectAggregates = {
    focusTaskStatus: null,
    openTasks: 0,
    completedTasks: 0,
    liveSessions: 0,
    testStatus: 'unknown',
    deployStatus: 'none',
    deployHints: [],
    userPaused: false,
    activityLevel: 'developing',
    currentBuilding: 'intake',
  };
  const b = (o: Partial<ProjectAggregates>) => deriveBuilding({ ...base, ...o });
  it('routes deterministically by real status', () => {
    expect(b({ focusTaskStatus: 'received' })).toBe('intake');
    expect(b({ focusTaskStatus: 'planning' })).toBe('planning');
    expect(b({ focusTaskStatus: 'waiting_input' })).toBe('planning');
    expect(b({ focusTaskStatus: 'in_development' })).toBe('development');
    expect(b({ focusTaskStatus: 'testing' })).toBe('testing');
    expect(b({ focusTaskStatus: 'needs_attention' })).toBe('workshop');
    expect(b({ focusTaskStatus: 'in_development', testStatus: 'failing' })).toBe('workshop');
    expect(b({ focusTaskStatus: 'failed' })).toBe('workshop');
  });
  it('ready_for_review goes to deployment only with passing tests and deploy tooling', () => {
    expect(b({ focusTaskStatus: 'ready_for_review' })).toBe('development');
    expect(b({ focusTaskStatus: 'ready_for_review', testStatus: 'passing' })).toBe('development');
    expect(b({ focusTaskStatus: 'ready_for_review', testStatus: 'passing', deployHints: ['wrangler'] })).toBe('deployment');
  });
  it('completed projects move to the completed district once no session is live', () => {
    expect(b({ completedTasks: 2 })).toBe('completed');
    expect(b({ completedTasks: 2, liveSessions: 1, currentBuilding: 'development' })).toBe('development');
  });
  it('a paused project does not move', () => {
    expect(b({ userPaused: true, focusTaskStatus: 'testing', currentBuilding: 'development' })).toBe('development');
    expect(deriveLifecycle({ ...base, userPaused: true })).toBe('paused');
  });
  it('lifecycle', () => {
    expect(deriveLifecycle({ ...base, activityLevel: 'observed' })).toBe('new');
    expect(deriveLifecycle({ ...base, openTasks: 1, focusTaskStatus: 'in_development' })).toBe('active');
    expect(deriveLifecycle({ ...base, openTasks: 1, focusTaskStatus: 'needs_attention' })).toBe('attention');
    expect(deriveLifecycle({ ...base, completedTasks: 1 })).toBe('completed');
    expect(deriveLifecycle({ ...base })).toBe('idle');
  });
});
