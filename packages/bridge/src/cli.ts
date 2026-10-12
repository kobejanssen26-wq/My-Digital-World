import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, validateUrl, DEFAULT_SYNC, type BridgeConfig } from './config.js';
import { daemonRunning, runDaemon } from './daemon.js';
import { flushOnce, refreshCounts, type DeliveryStatus } from './deliver.js';
import { home, paths } from './paths.js';
import { hooksInstalled, installHooks, projectSettingsPath, uninstallHooks, userSettingsPath } from './settings-install.js';
import { installService, uninstallService } from './service.js';
import { queueDepth } from './spool.js';

const HELP = `mdw-bridge — forwards Claude Code activity to your My Digital World dashboard

Usage:
  mdw-bridge init --url <https://your-domain> --token <mdw_...>   Save credentials (token from Settings > Bridge)
  mdw-bridge install-hooks [--project <dir>]                      Add hooks to ~/.claude/settings.json (or <dir>/.claude/settings.local.json)
  mdw-bridge uninstall-hooks [--project <dir>]                    Remove only our hooks
  mdw-bridge install-service | uninstall-service                  Start the bridge at login (user service)
  mdw-bridge run                                                  Run the delivery daemon in the foreground
  mdw-bridge status                                               Show connection, queue and hook status
  mdw-bridge flush                                                Deliver queued events now
  mdw-bridge config get|set <sync.promptSummaries|sync.repoIdentity|sync.projectNames> [true|false]
  mdw-bridge disconnect                                           Remove the credential from this computer (revoke it in the dashboard too)
  mdw-bridge purge                                                Delete ALL local bridge data (${home()})

Environment: MDW_HOME overrides the data directory (use a separate one for local development).`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const hookJs = () => join(import.meta.dirname, 'mdw-hook.js');
const cliJs = () => join(import.meta.dirname, 'mdw-bridge.js');

async function ping(cfg: BridgeConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${cfg.url}/api/bridge/ping`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { ok: true, detail: 'authenticated' };
    return { ok: false, detail: r.status === 401 ? 'credential rejected (401)' : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: `unreachable: ${(e as Error).message}` };
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init': {
      const url = arg(args, '--url');
      const token = arg(args, '--token') ?? process.env.MDW_TOKEN;
      if (!url || !token) throw new Error('Usage: mdw-bridge init --url <https://...> --token <mdw_...>  (or set MDW_TOKEN)');
      if (!/^mdw_[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error('That does not look like a bridge token (expected mdw_...).');
      const prev = loadConfig();
      const cfg: BridgeConfig = {
        url: validateUrl(url),
        token,
        hostSalt: prev?.hostSalt ?? randomBytes(16).toString('hex'),
        port: prev?.port ?? Number(process.env.MDW_PORT ?? 47615),
        localToken: prev?.localToken ?? randomBytes(24).toString('hex'),
        sync: prev?.sync ?? { ...DEFAULT_SYNC },
      };
      const p = await ping(cfg);
      saveConfig(cfg);
      console.log(p.ok ? `Saved. Connected to ${cfg.url} (${p.detail}).` : `Saved, but the server check failed: ${p.detail}. Events will queue locally until it works.`);
      return p.ok ? 0 : 2;
    }
    case 'install-hooks': {
      if (!loadConfig()) throw new Error('Run `mdw-bridge init` first.');
      const proj = arg(args, '--project');
      const file = proj ? projectSettingsPath(proj) : userSettingsPath();
      const r = installHooks(file, hookJs());
      console.log(`Hooks installed in ${r.file}\n  events: ${r.events.join(', ')}\n  backup: ${r.backup ?? '(file did not exist)'}\nRestart running Claude Code sessions (or open /hooks) to load them.`);
      return 0;
    }
    case 'uninstall-hooks': {
      const proj = arg(args, '--project');
      const r = uninstallHooks(proj ? projectSettingsPath(proj) : userSettingsPath());
      console.log(r.changed ? `Removed our hooks from ${r.file} (backup: ${r.backup}).` : `No mdw hooks found in ${r.file}.`);
      return 0;
    }
    case 'install-service': {
      const r = installService(cliJs());
      console.log(r.message);
      return r.ok ? 0 : 1;
    }
    case 'uninstall-service': {
      const r = uninstallService();
      console.log(r.message);
      return r.ok ? 0 : 1;
    }
    case 'run':
      await runDaemon();
      return 0;
    case 'flush': {
      const cfg = loadConfig();
      if (!cfg) throw new Error('Run `mdw-bridge init` first.');
      const st = { health: 'idle', queued: 0, rejected: 0, lastSuccessAt: null, lastAttemptAt: null, lastError: null, delivered: 0, nextRetryAt: null, pid: process.pid, url: cfg.url, startedAt: Date.now() } as DeliveryStatus;
      const r = await flushOnce(cfg, st);
      refreshCounts(st);
      console.log(`Delivered ${r.sent}; ${st.queued} still queued${st.lastError ? ` (${st.lastError})` : ''}.`);
      return st.queued ? 1 : 0;
    }
    case 'status': {
      const cfg = loadConfig();
      if (!cfg) {
        console.log('Not configured. Run: mdw-bridge init --url <https://...> --token <mdw_...>');
        return 1;
      }
      const p = await ping(cfg);
      const user = hooksInstalled(userSettingsPath());
      let s: Partial<DeliveryStatus> = {};
      try {
        s = JSON.parse(readFileSync(paths.status(), 'utf8'));
      } catch {
        /* daemon never ran */
      }
      console.log(
        [
          `Cloud:    ${cfg.url} — ${p.ok ? 'reachable, ' + p.detail : p.detail}`,
          `Daemon:   ${daemonRunning() ? 'running' : 'not running (starts automatically with the next hook, or: mdw-bridge install-service)'}`,
          `Queue:    ${queueDepth()} event(s) waiting${s.rejected ? `, ${s.rejected} rejected (see ${paths.rejected()})` : ''}`,
          `Last OK:  ${s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : 'never'}`,
          `Hooks:    ${user.length ? `installed for ${user.length} events in ${userSettingsPath()}` : 'not installed in user settings'}`,
          `Privacy:  summaries=${cfg.sync.promptSummaries} repoIdentity=${cfg.sync.repoIdentity} projectNames=${cfg.sync.projectNames}`,
        ].join('\n'),
      );
      return p.ok ? 0 : 1;
    }
    case 'config': {
      const cfg = loadConfig();
      if (!cfg) throw new Error('Run `mdw-bridge init` first.');
      const [op, key, value] = args;
      const k = key?.replace(/^sync\./, '') as keyof BridgeConfig['sync'];
      if (op === 'get') {
        console.log(JSON.stringify(cfg.sync, null, 2));
        return 0;
      }
      if (op === 'set' && k in DEFAULT_SYNC && (value === 'true' || value === 'false')) {
        cfg.sync[k] = value === 'true';
        saveConfig(cfg);
        if (existsSync(paths.cache())) rmSync(paths.cache());
        console.log(`sync.${k} = ${value}`);
        return 0;
      }
      throw new Error('Usage: mdw-bridge config get | config set sync.<promptSummaries|repoIdentity|projectNames> <true|false>');
    }
    case 'disconnect': {
      const cfg = loadConfig();
      if (cfg) saveConfig({ ...cfg, token: '' });
      console.log('Credential removed from this computer. Also revoke it in the dashboard (Settings → Bridge). Queued events are kept.');
      return 0;
    }
    case 'purge': {
      rmSync(home(), { recursive: true, force: true });
      console.log(`Deleted ${home()}. Remember: mdw-bridge uninstall-hooks && mdw-bridge uninstall-service`);
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`mdw-bridge: ${(e as Error).message}`);
    process.exit(1);
  },
);
