import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const common = { minify: true, bundle: true, platform: 'node', target: 'node20', format: 'esm', sourcemap: false, logLevel: 'info', banner: { js: '#!/usr/bin/env node' } };
await build({ ...common, entryPoints: { 'mdw-bridge': 'src/cli.ts', 'mdw-hook': 'src/hook.ts' }, outdir: 'dist' });
// `mdw-hook` is the marker the installer uses to recognise our hook entries.
for (const f of ['dist/mdw-bridge.js', 'dist/mdw-hook.js']) chmodSync(f, 0o755);
