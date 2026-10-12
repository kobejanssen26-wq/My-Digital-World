import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBanner, Pill } from '../components/ui.js';
import { ago } from '../lib/format.js';
import { integrationHealth } from '../lib/metrics.js';
import { useStore } from '../store.js';

export default function SettingsView() {
  const data = useStore((s) => s.data);
  const now = useStore((s) => s.now) + data.serverSkew;
  const { world3d, setWorld3d, replaceSettings, logout } = useStore();
  const [name, setName] = useState('my-laptop');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const health = integrationHealth(data, now);
  const origin = location.origin;
  const s = data.settings;

  const save = async (patch: Partial<typeof s>) => {
    try {
      replaceSettings((await api.saveSettings(patch)).settings);
      setErr(null);
    } catch {
      setErr('Could not save settings.');
    }
  };
  const command = fresh ? `mdw-bridge init --url ${origin} --token ${fresh.token}` : '';

  return (
    <div className="page">
      <div className="page-head"><h1>Settings</h1></div>
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <section className="card" aria-labelledby="bridge-h">
        <div className="row"><h2 id="bridge-h" className="grow">Claude Code bridge</h2><Pill tone={health.level === 'ok' ? 'ok' : health.level === 'none' ? 'idle' : 'warn'}>{health.label}</Pill></div>
        <p className="muted">{health.detail} Last event received: {ago(data.bridge.lastIngestAt, now)}{data.bridge.lastIngestSource ? ` from ${data.bridge.lastIngestSource}` : ''}.</p>
        <div className="list">
          {data.bridge.tokens.map((t) => (
            <div className="item" key={t.id}>
              <span className="grow"><b>{t.name}</b><br /><span className="muted">created {ago(t.createdAt, now)} · {t.revokedAt ? `revoked ${ago(t.revokedAt, now)}` : t.lastUsedAt ? `last used ${ago(t.lastUsedAt, now)}` : 'never used'}</span></span>
              {t.revokedAt ? <Pill tone="idle">Revoked</Pill> : <button className="btn sm danger" onClick={async () => { if (confirm(`Revoke “${t.name}”? The bridge using it will stop syncing immediately.`)) { await api.revokeToken(t.id).then(() => useStore.getState().resync(), () => setErr('Could not revoke.')); } }}>Revoke</button>}
            </div>
          ))}
        </div>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <input type="text" aria-label="Credential name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <button className="btn primary" disabled={!name.trim()} onClick={async () => { try { const r = await api.createToken(name.trim()); setFresh({ token: r.token, name: r.name }); setCopied(false); await useStore.getState().resync(); } catch { setErr('Could not create a credential (limit reached?).'); } }}>Create bridge credential</button>
        </div>
        {fresh && (
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            <div className="banner">This credential is shown <b>once</b>. Copy it now; it cannot be retrieved later (revoke and create a new one if lost).</div>
            <pre aria-label="Setup command">{command}</pre>
            <div className="row"><button className="btn sm" onClick={async () => { await navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? 'Copied' : 'Copy command'}</button><button className="btn sm" onClick={() => setFresh(null)}>I saved it</button></div>
            <p className="muted" style={{ margin: 0 }}>Then run <code>mdw-bridge install-hooks</code> and (optionally) <code>mdw-bridge install-service</code>. See docs/CLAUDE_CODE_INTEGRATION.md.</p>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="display-h">
        <h2 id="display-h">Display</h2>
        <div className="list" style={{ marginTop: 10 }}>
          <label className="row"><input type="checkbox" checked={world3d} onChange={(e) => setWorld3d(e.target.checked)} /> Show the 3D world (this browser). Off = list view only.</label>
          <label className="row"><input type="checkbox" checked={s.reducedMotion} onChange={(e) => void save({ reducedMotion: e.target.checked })} /> Reduced motion (vehicles teleport, no ambient animation)</label>
          <label className="row"><input type="checkbox" checked={s.lightweight} onChange={(e) => void save({ lightweight: e.target.checked })} /> Lightweight mode (no shadows, fewer details, lower resolution)</label>
        </div>
      </section>

      <section className="card" aria-labelledby="data-h">
        <h2 id="data-h">Data &amp; retention</h2>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <label className="row">Keep events for
            <select value={s.retentionDays} onChange={(e) => void save({ retentionDays: Number(e.target.value) })}>
              {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
          <label className="row">Storage limit
            <select value={s.storageLimitMb} onChange={(e) => void save({ storageLimitMb: Number(e.target.value) })}>
              {[100, 512, 1024, 5120, 10240].map((d) => <option key={d} value={d}>{d >= 1024 ? `${d / 1024} GB` : `${d} MB`}</option>)}
            </select>
          </label>
          <a className="btn" href="/api/export" download>Export all data (JSON)</a>
        </div>
        <p className="muted">Projects, tasks and sessions are kept; only the raw event log is pruned. What leaves your computer is controlled on the bridge side: <code>mdw-bridge config get</code>.</p>
      </section>

      <section className="card" aria-labelledby="acct-h">
        <h2 id="acct-h">Account</h2>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => void logout()}>Sign out</button>
      </section>
    </div>
  );
}
