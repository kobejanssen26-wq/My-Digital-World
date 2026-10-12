# Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard says "Not connected" | No bridge credential yet: Settings → Create bridge credential, `mdw-bridge init`. |
| "Waiting for first event" | `mdw-bridge status`; confirm hooks (`Hooks: installed…`) and **restart Claude Code** (hooks load at session start). In Claude Code run `/hooks` to see them. |
| Status shows `credential rejected (401)` | Credential revoked or mistyped → create a new one, `mdw-bridge init`. |
| Queue grows, "offline" | Network/URL problem; events are safe in `~/.mdw/spool`. `mdw-bridge flush` retries now. HTTPS is required except for localhost. |
| Events in `~/.mdw/rejected/` | Each has a `.reason`; schema mismatch means bridge and Worker versions differ → update both. |
| Project doesn't appear | It is *observed-only* until real work is seen (questions alone don't create visible projects). Projects → "Include observed-only sessions". |
| Project shows "Disconnected" | No event for 30+ min while a session was open (laptop slept, Claude Code killed). It's honest; new activity revives it. |
| Two projects for one repo | The remote differs between clones and directories differ. Add/standardize `origin`; same-remote clones merge automatically. |
| Login says "not configured" | Run `npm run setup:secrets` (`--remote` for production). |
| 3D view blank / list view shown | WebGL unavailable → automatic list view. Toggle 3D in Settings → Display; try Lightweight mode. |
| `wrangler dev` returns 404 for `/` after rebuilding the frontend | Restart `wrangler dev` (asset manifest is read at start). |
| R2 errors on deploy | Enable R2 in the dashboard or deploy with `--no-r2`. |
| Hook seems slow | `PostToolUse` etc. are async; check `~/.mdw/cache.json` is writable (identity cache). |
| Debug a hook | `echo '{"session_id":"x","cwd":"'$PWD'","hook_event_name":"Stop"}' | node dist/mdw-hook.js; ls ~/.mdw/spool` |
