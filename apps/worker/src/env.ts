import type { Hub } from './hub.js';

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
  /** Optional: absent until R2 is enabled for the account. */
  FILES?: R2Bucket;
  ASSETS: Fetcher;
  /** pbkdf2$<iterations>$<salt b64>$<hash b64>; created by `npm run setup:secrets`. */
  ADMIN_PASSWORD_HASH?: string;
}

export const HUB_NAME = 'main';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
