import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { identify, normalizeRemote } from '../src/identity.js';
import { config, git, makeRepo, tmp, useHome } from './helpers.js';

beforeEach(() => {
  useHome();
});

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:Me/Repo.git', 'github.com/me/repo'],
    ['https://github.com/me/repo.git', 'github.com/me/repo'],
    ['https://user:ghp_secrettoken@github.com/me/repo', 'github.com/me/repo'],
    ['ssh://git@gitlab.com/group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    ['', null],
  ])('%s', (input, out) => expect(normalizeRemote(input)).toBe(out));
});

describe('identify', () => {
  it('git repo with remote: remote key first, path hash, root commit; no absolute path leaks', () => {
    const cfg = config();
    const dir = makeRepo({ remote: 'git@github.com:me/my-app.git' });
    const ref = identify(dir, cfg);
    expect(ref.keys[0]).toBe('remote:github.com/me/my-app');
    expect(ref.keys.some((k) => k.startsWith('path:'))).toBe(true);
    expect(ref.keys.some((k) => k.startsWith('root:'))).toBe(true);
    expect(ref.name).toBe('my-app');
    expect(ref.repo).toBe('github.com/me/my-app');
    expect(JSON.stringify(ref)).not.toContain(dir);
  });

  it('subdirectory and git worktree resolve to the same remote project', () => {
    const cfg = config();
    const dir = makeRepo({ remote: 'https://github.com/me/wt.git', name: 'wt' });
    mkdirSync(join(dir, 'src'));
    const wt = join(tmp('mdw-wt-'), 'feature');
    git(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const a = identify(join(dir, 'src'), cfg);
    const b = identify(wt, cfg);
    expect(a.keys[0]).toBe(b.keys[0]);
    expect(a.keys[1]).not.toBe(b.keys[1]); // different checkout directory
  });

  it('repo without commits is flagged new and still identifiable', () => {
    const dir = makeRepo({ commit: false });
    const ref = identify(dir, config());
    expect(ref.isNew).toBe(true);
    expect(ref.keys).toHaveLength(1);
    expect(ref.keys[0]).toMatch(/^path:/);
  });

  it('plain directories and standalone scripts use a hashed path only', () => {
    const cfg = config();
    const dir = tmp('mdw-script-');
    writeFileSync(join(dir, 'tool.py'), 'print(1)');
    const ref = identify(dir, cfg);
    expect(ref.keys).toHaveLength(1);
    expect(ref.keys[0]).toMatch(/^path:[0-9a-f]{24}$/);
    expect(ref.isNew).toBe(true);
    const other = identify(tmp('mdw-script2-'), cfg);
    expect(other.keys[0]).not.toBe(ref.keys[0]);
  });

  it('path hashes are salted per machine', () => {
    const dir = tmp('mdw-salt-');
    const a = identify(dir, config({ hostSalt: 'A' }));
    process.env.MDW_HOME = tmp('mdw-home2-');
    const b = identify(dir, config({ hostSalt: 'B' }));
    expect(a.keys[0]).not.toBe(b.keys[0]);
  });

  it('detects project type and deploy tooling', () => {
    const dir = makeRepo({});
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18' }, scripts: { deploy: 'wrangler deploy' } }));
    writeFileSync(join(dir, 'wrangler.json'), '{}');
    const ref = identify(dir, config());
    expect(ref.type).toBe('react');
    expect(ref.deployHints).toEqual(expect.arrayContaining(['cloudflare', 'npm-deploy']));
  });

  it('honours privacy switches', () => {
    const dir = makeRepo({ remote: 'git@github.com:me/private-thing.git', name: 'private-thing' });
    const cfg = config({ sync: { promptSummaries: false, repoIdentity: false, projectNames: false } });
    const ref = identify(dir, cfg);
    expect(ref.repo).toBeUndefined();
    expect(ref.name).toMatch(/^project-/);
    expect(ref.name).not.toContain('private');
    expect(ref.keys.join()).not.toContain('private-thing');
    expect(ref.keys[0]).toMatch(/^remote:h[0-9a-f]{32}$/);
  });
});
