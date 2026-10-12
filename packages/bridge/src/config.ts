import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ensureDirs, paths } from './paths.js';

export interface BridgeConfig {
  /** https://mdw.example.com (no trailing slash) */
  url: string;
  /** Revocable bridge credential issued by the dashboard (mdw_...). */
  token: string;
  /** Random per-machine salt so project path hashes cannot be reversed or correlated elsewhere. */
  hostSalt: string;
  /** Loopback port of the daemon's status/wake endpoint. */
  port: number;
  /** Shared secret protecting the loopback endpoint from other local web pages/processes. */
  localToken: string;
  /** What may leave this computer. Everything defaults to the privacy-conscious minimum useful set. */
  sync: {
    promptSummaries: boolean; // short redacted task summary (never the full prompt)
    repoIdentity: boolean; // normalized remote like github.com/owner/repo
    projectNames: boolean; // directory/repo name; if false a hashed label is used
  };
}

export const DEFAULT_SYNC: BridgeConfig['sync'] = { promptSummaries: true, repoIdentity: true, projectNames: true };

/** Cloud sessions (no ~/.mdw, no daemon): credentials come from environment variables of the cloud environment. */
export function envConfig(env = process.env): BridgeConfig | null {
  const url = env.MDW_URL;
  const token = env.MDW_TOKEN;
  if (!url || !token) return null;
  return {
    url: validateUrl(url),
    token,
    // Stable salt derived from the credential so project ids stay consistent across short-lived VMs.
    hostSalt: createHash('sha256').update('mdw-salt:' + token).digest('hex').slice(0, 32),
    port: 0,
    localToken: '',
    sync: { ...DEFAULT_SYNC, ...(env.MDW_SYNC_SUMMARIES === 'false' ? { promptSummaries: false } : {}) },
  };
}

export function loadConfig(): BridgeConfig | null {
  if (!existsSync(paths.config())) return null;
  const raw = JSON.parse(readFileSync(paths.config(), 'utf8')) as Partial<BridgeConfig>;
  return {
    url: String(raw.url ?? ''),
    token: String(raw.token ?? ''),
    hostSalt: String(raw.hostSalt ?? randomBytes(16).toString('hex')),
    port: Number(raw.port ?? 47615),
    localToken: String(raw.localToken ?? randomBytes(24).toString('hex')),
    sync: { ...DEFAULT_SYNC, ...(raw.sync ?? {}) },
  };
}

export function saveConfig(cfg: BridgeConfig) {
  ensureDirs();
  const tmp = paths.config() + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.config());
  try {
    chmodSync(paths.config(), 0o600);
  } catch {
    /* ignore */
  }
}

export function validateUrl(u: string): string {
  const url = new URL(u);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The cloud URL must use https:// (http:// is only allowed for localhost development).');
  return url.origin;
}
