import { describe, expect, it } from 'vitest';
import { classifyPrompt, categorizeTool } from '../src/classify.js';
import { redactSecrets, summarizePrompt } from '../src/sanitize.js';
import { resolveProject } from '../src/project-identity.js';
import { parseEnvelope } from '../src/events.js';
import { actorAt, advance, planRoute, retarget, routeLength, ROADS, BUILDING_SPECS, slotPosition } from '../src/world.js';

describe('classifyPrompt', () => {
  it.each([
    ['Build me a portfolio website with a dark theme', { isNewProject: true }, 'build', 'high'],
    ['Create a CLI tool that converts csv to json', {}, 'build', 'medium'],
    ['Fix the crash when the user logs out', {}, 'bugfix', 'medium'],
    ['Refactor the auth module to use async/await', {}, 'refactor', 'medium'],
    ['Add pagination to the activity feed', {}, 'feature', 'medium'],
    ['How does the reducer decide which task is current?', {}, 'question', 'high'],
    ['Just try a quick prototype of the idea', {}, 'experiment', 'medium'],
    ['Create a file called hello.js that prints hello world', {}, 'feature', 'medium'],
    ['continue', { hasOpenTask: true }, 'continuation', 'high'],
    ['hmm?', { hasOpenTask: true }, 'continuation', 'medium'],
    ['hmm interesting thoughts overall about things', {}, 'other', 'low'],
  ])('%s', (text, ctx, kind, conf) => {
    expect(classifyPrompt(text, ctx)).toEqual({ kind, confidence: conf });
  });
  it('does not treat a new feature in an existing repo as a new project', () => {
    expect(classifyPrompt('Build a settings page app for this', { isNewProject: false }).confidence).toBe('medium');
  });
});

describe('categorizeTool', () => {
  it.each([
    ['Edit', {}, 'modify'],
    ['Read', {}, 'read'],
    ['Bash', { command: 'npm test -- --run' }, 'test'],
    ['Bash', { command: 'cd x && pytest -q' }, 'test'],
    ['Bash', { command: 'node math.test.js' }, 'test'],
    ['Bash', { command: 'npx wrangler deploy' }, 'deploy'],
    ['Bash', { command: 'npm run build' }, 'build'],
    ['Bash', { command: 'ls -la' }, 'shell'],
    ['Bash', { command: 'mkdir foo' }, 'modify'],
    ['WebFetch', {}, 'web'],
  ])('%s %j -> %s', (tool, input, cat) => expect(categorizeTool(tool, input)).toBe(cat));
});

describe('sanitize', () => {
  it('redacts credentials and paths', () => {
    const s = summarizePrompt('use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and read /home/kobe/secret/file.ts, mail me@x.com');
    expect(s).not.toMatch(/ghp_/);
    expect(s).not.toMatch(/kobe/);
    expect(s).not.toMatch(/me@x/);
    expect(s).toContain('[path]');
  });
  it('removes code blocks and clamps length', () => {
    const s = summarizePrompt('please ```const apiKey = "AKIA1234567890ABCDEF"``` ' + 'x '.repeat(200));
    expect(s.length).toBeLessThanOrEqual(140);
    expect(s).not.toContain('AKIA');
  });
  it('redacts key=value secrets', () => expect(redactSecrets('password: hunter2 ok')).toBe('[redacted] ok'));
});

describe('resolveProject', () => {
  const A = { id: 'pA', keys: ['remote:github.com/me/a', 'path:aaa', 'root:r1'] };
  const B = { id: 'pB', keys: ['path:bbb'] };
  it('same remote => same project even from another directory', () => {
    const r = resolveProject(['remote:github.com/me/a', 'path:zzz', 'root:r1'], [A, B]);
    expect(r).toEqual({ kind: 'existing', projectId: 'pA', addKeys: ['path:zzz'] });
  });
  it('renamed remote, same directory => same project', () => {
    const r = resolveProject(['remote:github.com/me/a2', 'path:aaa', 'root:r1'], [A]);
    expect(r.kind === 'existing' && r.projectId).toBe('pA');
  });
  it('a fork (different remote, different path, same root) is a new project', () => {
    expect(resolveProject(['remote:github.com/other/a', 'path:fff', 'root:r1'], [A]).kind).toBe('new');
  });
  it('moved directory without remote keeps identity via root commit', () => {
    const local = { id: 'pL', keys: ['path:old', 'root:r9'] };
    const r = resolveProject(['path:new', 'root:r9'], [local]);
    expect(r.kind === 'existing' && r.projectId).toBe('pL');
  });
  it('non-git directory is identified by path only', () => {
    expect(resolveProject(['path:bbb'], [A, B])).toEqual({ kind: 'existing', projectId: 'pB', addKeys: [] });
    expect(resolveProject(['path:ccc'], [A, B]).kind).toBe('new');
  });
});

describe('parseEnvelope', () => {
  const good = { v: 1, id: 'abcdefgh12', ts: 1_700_000_000_000, source: 'x', type: 'prompt.submit', sessionId: 's', data: { promptKind: 'feature' } };
  it('accepts valid', () => expect(parseEnvelope(good).ok).toBe(true));
  it('rejects unknown type', () => {
    const r = parseEnvelope({ ...good, type: 'file.upload' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown_event_type' });
  });
  it('rejects unknown data keys (no raw content smuggling)', () => {
    expect(parseEnvelope({ ...good, data: { prompt: 'full text' } }).ok).toBe(false);
  });
  it('rejects bad ids / timestamps / versions', () => {
    expect(parseEnvelope({ ...good, id: 'a b' }).ok).toBe(false);
    expect(parseEnvelope({ ...good, ts: 5 }).ok).toBe(false);
    expect(parseEnvelope({ ...good, v: 2 }).ok).toBe(false);
  });
});

describe('world routing', () => {
  it('every building gate exists on the road graph and routes follow edges', () => {
    for (const id of Object.keys(BUILDING_SPECS)) expect(ROADS.nodes[`g_${id}`]).toBeDefined();
    const r = planRoute({ building: 'intake', slot: 0 }, { building: 'workshop', slot: 2 });
    expect(r.length).toBeGreaterThan(3);
    expect(r[0]).toEqual(slotPosition('intake', 0));
    expect(r[r.length - 1]).toEqual(slotPosition('workshop', 2));
    // interior nodes are real road nodes
    const nodes = new Set(Object.values(ROADS.nodes).map((p) => p.join(',')));
    for (const p of r.slice(1, -1)) expect(nodes.has(p.join(','))).toBe(true);
  });
  it('is deterministic', () => {
    const a = planRoute({ building: 'intake', slot: 1 }, { building: 'testing', slot: 0 });
    const b = planRoute({ building: 'intake', slot: 1 }, { building: 'testing', slot: 0 });
    expect(a).toEqual(b);
  });
  it('an actor reaches its destination in bounded time and then stops', () => {
    let a = retarget(actorAt('intake', 0), { building: 'development', slot: 1 });
    const len = routeLength(a.route);
    let t = 0;
    while (a.route.length && t < 100) {
      a = advance(a, 0.1);
      t += 0.1;
    }
    expect(a.route).toHaveLength(0);
    expect(a.pos[0]).toBeCloseTo(slotPosition('development', 1)[0], 5);
    expect(t).toBeLessThanOrEqual(len / 9 + 0.2);
  });
  it('retargeting mid-flight finishes the current leg first, so routes stay on roads', () => {
    let a = retarget(actorAt('intake', 0), { building: 'development', slot: 0 });
    a = advance(a, 0.8);
    expect(a.route.length).toBeGreaterThan(0);
    const b = retarget(a, { building: 'workshop', slot: 0 });
    const nodes = new Set(Object.values(ROADS.nodes).map((p) => p.join(',')));
    const finalDriveway = slotPosition('workshop', 0).join(',');
    const interior = b.route.slice(2, -1).map((p) => p.join(','));
    expect(interior.every((p) => nodes.has(p) || p === slotPosition('development', 0).join(','))).toBe(true);
    expect(b.route[b.route.length - 1]!.join(',')).toBe(finalDriveway);
  });
  it('instant retarget (reduced motion / first load) teleports', () => {
    const a = retarget(actorAt('intake', 0), { building: 'completed', slot: 3 }, true);
    expect(a.route).toHaveLength(0);
    expect(a.pos).toEqual(slotPosition('completed', 3));
  });
});
