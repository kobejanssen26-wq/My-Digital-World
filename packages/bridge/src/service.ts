import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Start-at-login integration, per platform. Only installs a *user* service; never needs root. */

const LABEL = 'dev.mydigitalworld.bridge';

export function serviceFile(): string | null {
  switch (platform()) {
    case 'linux':
      return join(homedir(), '.config', 'systemd', 'user', 'mdw-bridge.service');
    case 'darwin':
      return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    default:
      return null;
  }
}

export function installService(cliJs: string): { ok: boolean; message: string } {
  const node = process.execPath;
  const file = serviceFile();
  try {
    if (platform() === 'linux' && file) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `[Unit]\nDescription=My Digital World bridge\n\n[Service]\nExecStart="${node}" "${cliJs}" run\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'mdw-bridge.service'], { stdio: 'ignore' });
      return { ok: true, message: `systemd user service enabled (${file}). Check: systemctl --user status mdw-bridge` };
    }
    if (platform() === 'darwin' && file) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${node}</string><string>${cliJs}</string><string>run</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n`);
      try {
        execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      execFileSync('launchctl', ['load', file], { stdio: 'ignore' });
      return { ok: true, message: `launchd agent loaded (${file}).` };
    }
    if (platform() === 'win32') {
      execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'MyDigitalWorldBridge', '/TR', `"${node}" "${cliJs}" run`], { stdio: 'ignore' });
      return { ok: true, message: 'Scheduled task "MyDigitalWorldBridge" created (runs at logon).' };
    }
    return { ok: false, message: `Unsupported platform ${platform()}. The hook starts the bridge on demand anyway.` };
  } catch (e) {
    return { ok: false, message: `Could not install the service: ${(e as Error).message}. The hook still starts the bridge on demand.` };
  }
}

export function uninstallService(): { ok: boolean; message: string } {
  const file = serviceFile();
  try {
    if (platform() === 'linux' && file) {
      try {
        execFileSync('systemctl', ['--user', 'disable', '--now', 'mdw-bridge.service'], { stdio: 'ignore' });
      } catch {
        /* not enabled */
      }
      if (existsSync(file)) unlinkSync(file);
      return { ok: true, message: 'systemd user service removed.' };
    }
    if (platform() === 'darwin' && file) {
      try {
        execFileSync('launchctl', ['unload', file], { stdio: 'ignore' });
      } catch {
        /* not loaded */
      }
      if (existsSync(file)) unlinkSync(file);
      return { ok: true, message: 'launchd agent removed.' };
    }
    if (platform() === 'win32') {
      execFileSync('schtasks', ['/Delete', '/F', '/TN', 'MyDigitalWorldBridge'], { stdio: 'ignore' });
      return { ok: true, message: 'Scheduled task removed.' };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  return { ok: true, message: 'Nothing to remove.' };
}
