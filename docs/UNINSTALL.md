# Uninstall

```bash
mdw-bridge uninstall-hooks            # removes only our entries from ~/.claude/settings.json (backup written)
mdw-bridge uninstall-hooks --project <dir>
mdw-bridge uninstall-service          # stop start-at-login
mdw-bridge disconnect                 # forget the credential (then revoke it in Settings)
mdw-bridge purge                      # delete ~/.mdw (config, queue, caches)
```
Cloud side: revoke credentials in Settings; `npx wrangler delete --config apps/worker/wrangler.generated.json`, `npx wrangler d1 delete mdw`, `npx wrangler r2 bucket delete mdw-files` (empty it first). Remove the Custom Domain in the Cloudflare dashboard.
