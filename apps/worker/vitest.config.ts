import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export default defineConfig(async () => {
  mkdirSync(path.resolve(import.meta.dirname, '../web/dist'), { recursive: true }); // assets dir must exist
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.json' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 20000 },
  };
});
