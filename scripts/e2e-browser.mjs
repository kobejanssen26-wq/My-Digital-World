#!/usr/bin/env node
// Real-browser check against a running dashboard (local `wrangler dev` or a deployed URL).
//   MDW_URL=http://127.0.0.1:8787 MDW_PASSWORD=... MDW_TOKEN=mdw_... node scripts/e2e-browser.mjs [--shots <dir>]
// It logs in, opens the 3D world, injects ONE clearly-labelled test project through the real ingest API
// while the page is open, and asserts the page reacts live (WebSocket) and keeps state across reload.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.MDW_URL ?? 'http://127.0.0.1:8787';
const password = process.env.MDW_PASSWORD;
const token = process.env.MDW_TOKEN;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (!password || !token) throw new Error('Set MDW_PASSWORD and MDW_TOKEN');
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const shot = async (page, n) => shots && (await page.screenshot({ path: join(shots, `${n}.png`) }));

const id = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ingest = (events) =>
  fetch(`${url}/api/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ events }) }).then((r) => r.json());

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url);
await page.getByLabel('Password').fill('wrong-password');
await page.getByRole('button', { name: 'Sign in' }).click();
check('wrong password is rejected in the UI', await page.getByText('Wrong password.').waitFor({ timeout: 8000 }).then(() => true, () => false));
await page.getByLabel('Password').fill(password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByTestId('world-canvas').waitFor({ timeout: 30000 });
await page.getByText('Live', { exact: true }).waitFor({ timeout: 15000 });
check('signed in, 3D canvas mounted, websocket live', true);
await page.waitForTimeout(2500);
await shot(page, '01-world');

const webgl = (await page.locator('canvas').count()) > 0;
check('WebGL canvas present', webgl);

// --- live update: a brand-new project appears with no reload --------------------------------
const sid = id('browsercheck');
const name = `e2e-browser-${Date.now().toString(36).slice(-5)}`;
const project = { keys: [`path:${Date.now().toString(16).padStart(12, '0')}`], name };
const base = { v: 1, source: 'e2e-browser-test', sessionId: sid, project };
const t = Date.now();
await ingest([
  { ...base, id: id('ev'), ts: t, type: 'session.start', data: { source: 'startup' } },
  { ...base, id: id('ev'), ts: t + 1, type: 'prompt.submit', data: { promptKind: 'feature', confidence: 'medium', summary: 'E2E browser check task' } },
]);
await page.getByRole('combobox').first().isVisible().catch(() => {});
await page.getByLabel('Find a project in the world').fill(name);
await page.waitForTimeout(800);
await shot(page, '02-intake');
// the world canvas has no DOM for vehicles; the minimap + metrics are DOM and driven by the same store
const dots = await page.locator('svg.minimap circle').count();
check('new project reached the page live (minimap shows it)', dots >= 1, `${dots} dot(s)`);

await ingest([{ ...base, id: id('ev'), ts: t + 2, type: 'tool.done', data: { tool: 'Write', category: 'modify' } }]);
await page.waitForTimeout(500);
await ingest([{ ...base, id: id('ev'), ts: t + 3, type: 'tool.fail', data: { tool: 'Bash', category: 'test' } }]);
await page.waitForTimeout(4000);
await shot(page, '03-workshop');

// open the project via the Projects view and verify details are the real stored data
await page.getByRole('button', { name: 'Projects' }).first().click();
await page.getByLabel('Filter projects by name').fill(name);
await page.getByRole('button', { name: new RegExp(name) }).first().click();
await page.getByText('Last test run failed').waitFor({ timeout: 10000 });
check('project detail shows failing tests (Repair Workshop state)', true);
check('project is in the Repair Workshop', await page.getByText('Repair Workshop').first().isVisible());
await shot(page, '04-project');

// activity feed
await page.getByRole('button', { name: 'Activity' }).first().click();
await page.getByText('Tests failed').first().waitFor({ timeout: 10000 });
check('activity feed describes the failed test run', true);

// --- persistence: reload keeps everything -------------------------------------------------------
await page.reload();
await page.getByRole('button', { name: 'Projects' }).first().click();
await page.getByLabel('Filter projects by name').fill(name);
check('project survives a page reload (server-side persistence)', await page.getByRole('button', { name: new RegExp(name) }).first().isVisible());

// --- 3D camera controls don't swallow UI clicks ------------------------------------------------
await page.getByRole('button', { name: 'World' }).first().click();
await page.getByTestId('world-canvas').waitFor();
const box = await page.getByTestId('world-canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Reset camera' }).click();
await page.waitForTimeout(1500);
await shot(page, '05-camera');
check('zoom + reset camera work without page errors', errors.filter((e) => !/favicon|Failed to load resource/.test(e)).length === 0, errors.join(' | ').slice(0, 200));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
