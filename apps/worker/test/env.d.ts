/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as AppEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: never;
    }
    interface Exports {
      default: { fetch(request: Request): Promise<Response> };
    }
  }
}
