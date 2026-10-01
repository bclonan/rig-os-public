/**
 * Record one real browser-fixture run in a disposable local runtime.
 * Prerequisites: Node 24.17-24.x; npm ci && npm run build in computer-use-runtime;
 * npm install in website; Playwright Chromium installed.
 * Run from computer-use-runtime:
 *   node --import tsx ../website/scripts/record-runtime.mjs
 * No native desktop, language-model generation, or external provider is used.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '../node_modules/playwright/index.mjs';
import { Store } from '../../computer-use-runtime/src/storage/index.ts';
import { Runtime } from '../../computer-use-runtime/src/runtime/index.ts';
import { BrowserAdapter } from '../../computer-use-runtime/src/adapters/browser.ts';
import { AdaptiveSelector } from '../../computer-use-runtime/src/learner/selector.ts';
import { seedForm } from '../../computer-use-runtime/src/skills/index.ts';
import { service } from '../../computer-use-runtime/src/service/index.ts';

const website = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(website, '../computer-use-runtime');
const media = resolve(website, 'public/media');
const ffmpegModule = await import('../node_modules/ffmpeg-static/index.js');
const ffmpeg = process.env.FFMPEG_PATH || ffmpegModule.default;
assert.ok(existsSync(ffmpeg), 'Install website dependencies to get ffmpeg-static');
const scratch = mkdtempSync(join(tmpdir(), 'rig-os-recording-'));
process.chdir(runtimeRoot);
mkdirSync(media, { recursive: true });

const store = new Store(join(scratch, 'store'));
const token = store.token();
let browser, adapter, selector, app, context, page, rawVideo;
const pageErrors = [];
const chapters = [];
let captureStart = 0;
let trimStart = 0;
let duration = 0;
let report;

function mark(text) {
  chapters.push({ seconds: Math.round((Date.now() - captureStart) / 100) / 10, text });
}
async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(50);
  }
}
function transcode(binary, args) {
  const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Video conversion failed');
}
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

try {
  adapter = await new BrowserAdapter(store).start();
  selector = new AdaptiveSelector(store);
  const runtime = new Runtime(store, adapter, undefined, undefined, selector.select.bind(selector));
  runtime.registry.put(seedForm());
  app = await service(runtime);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: join(scratch, 'video'), size: { width: 1600, height: 900 } },
  });
  const recordingStart = Date.now();
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(url + '/#runs');
  await page.getByLabel('Local service token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser fixture task', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Live fixture', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 0));
  // Start the published clip after authentication and below the host identity.
  await page.getByRole('navigation').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 18));
  await delay(500);
  captureStart = Date.now();
  trimStart = (captureStart - recordingStart) / 1000;
  mark('The local console starts with a disposable browser fixture.');
  await delay(1600);
  await page.getByLabel('Goal', { exact: true }).fill('Set the display name to Rig OS demo');
  await page.getByLabel('Display name', { exact: true }).fill('');
  await page.getByLabel('Display name', { exact: true }).pressSequentially('Rig OS demo', { delay: 105 });
  await delay(900);
  mark('Submit a structured task to the local runtime.');
  const submittedAt = Date.now();
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await until(() => store.runs().length === 1 && store.runs()[0].status === 'succeeded', 'Fixture task did not succeed');
  const succeededAt = Date.now();
  await page.locator('button.run small').filter({ hasText: 'succeeded' }).waitFor();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth > 0));
  await page.getByRole('navigation').evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 18, behavior: 'smooth' }));
  mark('The runtime reports success after independent completion verification.');
  await delay(3400);
  await page.screenshot({ path: join(media, 'runtime-poster.png') });
  const run = store.runs()[0];
  const journal = store.events(0, run.id);
  const verification = journal.findLast(event => event.type === 'verification');
  const completed = journal.findLast(event => event.type === 'completed');
  assert.equal(completed?.data.status, 'succeeded');
  assert.ok(verification?.data.evidence.length > 0);
  assert.ok(verification.data.evidence.every(evidence => evidence.kind === 'completion' && evidence.truth === 'TRUE'));
  assert.ok(journal.some(event => event.type === 'dispatched'));
  assert.deepEqual(pageErrors, []);

  const completedPanel = page.locator('.timeline details').filter({ has: page.locator('summary', { hasText: 'completed' }) });
  await completedPanel.locator('summary').click();
  await page.getByRole('heading', { name: 'Action and evidence timeline', exact: true }).evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 32, behavior: 'smooth' }));
  mark('Open the completion event in the action and evidence timeline.');
  await delay(3200);
  const verificationPanel = page.locator('.timeline details').filter({ has: page.locator('summary', { hasText: /\bverification\b/ }) }).first();
  await verificationPanel.locator('summary').click();
  await delay(1800);
  mark('The verification entry records the observation and completion predicates.');
  await verificationPanel.evaluate(el => {
    const timeline = el.closest('.timeline');
    timeline.scrollTop += el.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
  });
  await verificationPanel.locator('pre').evaluate(el => {
    const lines = el.textContent.split('\n');
    const evidenceLine = lines.findIndex(line => line.includes('"evidence"'));
    if (evidenceLine >= 0) el.scrollTop = Math.max(0, evidenceLine * 19.5 - 30);
  });
  await page.screenshot({ path: join(media, 'runtime-evidence.png') });
  await delay(3600);
  await page.locator('.timeline').evaluate(el => { el.scrollTop = 0; });
  await completedPanel.locator('summary').evaluate(el => window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 48, behavior: 'smooth' }));
  await delay(1000);
  duration = (Date.now() - captureStart) / 1000;
  rawVideo = page.video();
  report = {
    status: 'PASS', recordedAt: new Date().toISOString(),
    evidenceLevel: 'Real Vue console, Fastify service, SQLite Store and Chromium browser fixture. No native desktop, model text generation or external provider.',
    capture: { width: 1600, height: 900, durationSeconds: duration, authenticationTrimmed: true, tokensInPublishedFiles: false },
    run: { id: run.id, status: run.status, skill: run.skill, model: run.model, goal: run.contract.goal, observedCompletionMs: succeededAt - submittedAt },
    checks: {
      runsInFreshStore: store.runs().length,
      dispatchedActions: journal.filter(event => event.type === 'dispatched').length,
      acknowledgements: journal.filter(event => event.type === 'acknowledged').length,
      completionEvidence: verification.data.evidence.map(item => ({ kind: item.kind, truth: item.truth, predicate: item.predicate })),
      completedEventStatus: completed.data.status,
      pageErrors,
    },
    journal: journal.map(event => ({ seq: event.seq, type: event.type, elapsedMs: event.at - submittedAt })),
    chapters,
    limits: ['One deterministic disposable browser form task.', 'This clip does not demonstrate general desktop control, external model reasoning, training, or cross-platform support.'],
    reproduction: 'cd computer-use-runtime && node --import tsx ../website/scripts/record-runtime.mjs',
  };
  assert.ok(!JSON.stringify(report).includes(token));
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (selector) await selector.close();
  if (app) await app.close();
  else {
    if (adapter) await adapter.close();
    store.close();
  }
}

if (!report || !rawVideo) throw new Error('Recording did not finish');
const rawPath = await rawVideo.path();
writeFileSync(join(scratch, 'recording-evidence.json'), JSON.stringify(report, null, 2));
const mp4 = join(media, 'runtime-demo.mp4');
const webm = join(media, 'runtime-demo.webm');
const base = ['-ss', trimStart.toFixed(3), '-i', rawPath, '-t', duration.toFixed(3), '-an'];
transcode(ffmpeg, [...base, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
transcode(ffmpeg, [...base, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', webm]);
transcode(ffmpeg, ['-i', mp4, '-f', 'null', '-']);
transcode(ffmpeg, ['-i', webm, '-f', 'null', '-']);
report.validation = { mp4DecodedWithoutErrors: true, webmDecodedWithoutErrors: true };
report.files = ['runtime-demo.mp4', 'runtime-demo.webm', 'runtime-poster.png', 'runtime-evidence.png'].map(name => ({ name, bytes: readFileSync(join(media, name)).byteLength, sha256: digest(join(media, name)) }));
writeFileSync(join(media, 'runtime-recording-evidence.json'), JSON.stringify(report, null, 2) + '\n');
const stamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
const vtt = 'WEBVTT\n\n' + chapters.map((chapter, index) => `${index + 1}\n${stamp(chapter.seconds)} --> ${stamp(chapters[index + 1]?.seconds ?? duration)}\n${chapter.text}\n`).join('\n');
writeFileSync(join(media, 'runtime-demo.vtt'), vtt);
writeFileSync(join(media, 'runtime-demo-transcript.txt'), chapters.map(chapter => `${chapter.seconds.toFixed(1)}s  ${chapter.text}`).join('\n') + '\n\n' + report.evidenceLevel + '\n');
// Remove only this script's generated temporary directory, never an existing store.
assert.ok(scratch.startsWith(resolve(tmpdir()) + '\\') || scratch.startsWith(resolve(tmpdir()) + '/'));
assert.ok(scratch.includes('rig-os-recording-'));
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
