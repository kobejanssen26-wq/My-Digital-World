import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig, DEFAULT_SYNC, type BridgeConfig } from '../src/config.js';

export function tmp(prefix = 'mdw-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function useHome() {
  const h = tmp('mdw-home-');
  process.env.MDW_HOME = h;
  process.env.MDW_NO_AUTOSTART = '1';
  return h;
}
export function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  const cfg: BridgeConfig = { url: 'https://mdw.test', token: 'mdw_' + 'a'.repeat(43), hostSalt: 'salt1', port: 47999, localToken: 'lt', sync: { ...DEFAULT_SYNC }, ...over };
  saveConfig(cfg);
  return cfg;
}
export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
export function makeRepo(opts: { remote?: string; commit?: boolean; name?: string } = {}) {
  const dir = join(tmp('mdw-repo-'), opts.name ?? 'my-app');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'README.md'), 'hi');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}
