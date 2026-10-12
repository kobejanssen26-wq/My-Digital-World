import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { cleanText, type ProjectRef } from '@mdw/shared';
import type { BridgeConfig } from './config.js';
import { paths } from './paths.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

/** git@github.com:me/repo.git, https://user:tok@github.com/me/repo.git, ssh://... -> github.com/me/repo */
export function normalizeRemote(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scp) u = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
    if (!path) return null;
    return `${parsed.hostname.toLowerCase()}/${path}`; // credentials in the URL are dropped
  } catch {
    return null;
  }
}

function detectType(root: string): string | undefined {
  const has = (f: string) => existsSync(join(root, f));
  try {
    if (has('package.json')) {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
      if (deps['next']) return 'nextjs';
      if (deps['react-native'] || deps['expo']) return 'mobile';
      if (deps['react']) return 'react';
      if (deps['vue']) return 'vue';
      if (deps['svelte']) return 'svelte';
      if (deps['astro']) return 'astro';
      return 'node';
    }
  } catch {
    /* fall through */
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) return 'python';
  if (has('Cargo.toml')) return 'rust';
  if (has('go.mod')) return 'go';
  if (has('pubspec.yaml')) return 'flutter';
  if (has('Package.swift')) return 'swift';
  if (has('index.html')) return 'website';
  return undefined;
}

function detectDeployHints(root: string): string[] {
  const hints: string[] = [];
  const has = (f: string) => existsSync(join(root, f));
  if (has('wrangler.toml') || has('wrangler.json') || has('wrangler.jsonc')) hints.push('cloudflare');
  if (has('vercel.json') || has('.vercel')) hints.push('vercel');
  if (has('netlify.toml')) hints.push('netlify');
  if (has('fly.toml')) hints.push('fly');
  if (has('firebase.json')) hints.push('firebase');
  if (has('Dockerfile')) hints.push('docker');
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.deploy) hints.push('npm-deploy');
  } catch {
    /* none */
  }
  return hints;
}

interface CacheEntry {
  at: number;
  ref: ProjectRef;
}
const TTL = 10 * 60 * 1000;

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(paths.cache(), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Derive a project identity for a working directory. No absolute path ever leaves the machine:
 * the `path:` key is a salted hash. Results are cached briefly so hooks stay fast.
 */
export function identify(cwd: string, cfg: BridgeConfig, now = Date.now()): ProjectRef {
  const cache = readCache();
  const hit = cache[cwd];
  if (hit && now - hit.at < TTL) return applySync(hit.ref, cfg, cwd);

  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* directory vanished */
  }
  const top = git(real, ['rev-parse', '--show-toplevel']);
  const root = top ?? real;
  const remote = top ? git(top, ['remote', 'get-url', 'origin']) ?? git(top, ['remote', 'get-url', (git(top, ['remote']) ?? '').split('\n')[0] ?? 'origin']) : null;
  const repo = remote ? normalizeRemote(remote) : null;
  const firstCommit = top ? git(top, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').pop() ?? null : null;

  const keys: string[] = [];
  if (repo) keys.push(`remote:${repo}`);
  keys.push(`path:${sha(cfg.hostSalt + '\0' + root).slice(0, 24)}`);
  if (firstCommit) keys.push(`root:${firstCommit.slice(0, 40)}`);

  let isNew = false;
  try {
    if (top && !firstCommit) isNew = true; // git init but no commits yet
    else if (!top) isNew = readdirSync(root).filter((f) => !f.startsWith('.')).length <= 2;
  } catch {
    /* ignore */
  }
  const isHome = root === homedir();
  const ref: ProjectRef = {
    keys,
    name: cleanText(isHome ? 'Home directory' : (repo ? repo.split('/').pop()! : basename(root)) || 'project', 80),
    ...(repo ? { repo } : {}),
    ...(detectType(root) ? { type: detectType(root)! } : {}),
    ...(isNew ? { isNew: true } : {}),
    ...(detectDeployHints(root).length ? { deployHints: detectDeployHints(root) } : {}),
  };
  cache[cwd] = { at: now, ref };
  try {
    for (const k of Object.keys(cache)) if (now - cache[k]!.at > 24 * 3600_000) delete cache[k];
    writeFileSync(paths.cache(), JSON.stringify(cache), { mode: 0o600 });
  } catch {
    /* cache is optional */
  }
  return applySync(ref, cfg, cwd);
}

/** Apply the user's privacy switches to the (cached) identity. */
function applySync(ref: ProjectRef, cfg: BridgeConfig, _cwd: string): ProjectRef {
  const out: ProjectRef = { ...ref };
  if (!cfg.sync.repoIdentity) {
    delete out.repo;
    // Keep grouping working without revealing the remote: replace it with a salted hash.
    out.keys = ref.keys.map((k) => (k.startsWith('remote:') ? `remote:h${sha(cfg.hostSalt + k).slice(0, 32)}` : k));
  }
  if (!cfg.sync.projectNames) out.name = `project-${(ref.keys.find((k) => k.startsWith('path:')) ?? ref.keys[0]!).slice(-6)}`;
  return out;
}
