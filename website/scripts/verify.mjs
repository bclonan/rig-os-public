import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const website = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.QA_URL || 'http://127.0.0.1:4337').replace(/\/$/, '');
const output = path.join(website, 'qa');
await fs.mkdir(output, { recursive: true });
const report = { at: new Date().toISOString(), base, checks: [], failures: [], accessibility: [], screenshots: [], pageErrors: [], pendingMedia: [] };
const browser = await chromium.launch();
async function check(name, callback) {
  try { const details = await callback(); report.checks.push({ name, status: 'PASS', ...details }); console.log('PASS ' + name); }
  catch (error) { report.failures.push({ name, error: String(error), stack: error.stack }); console.log('FAIL ' + name + ': ' + String(error)); }
}
async function visit(page, route) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await page.goto(base + route, { waitUntil: 'networkidle' });
    if (response?.ok()) return response;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(response?.ok(), `${route} returned ${response?.status()}`);
}
async function overflow(page, label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.width + 1, `${label}: ${JSON.stringify(dimensions)}`);
  return dimensions;
}
async function accessibility(page, label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const violations = results.violations.map(item => ({ id: item.id, impact: item.impact, description: item.description, help: item.help, helpUrl: item.helpUrl, nodes: item.nodes.map(node => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })) }));
  report.accessibility.push({ label, violations, incomplete: results.incomplete.map(item => ({ id: item.id, nodes: item.nodes.length })), passRules: results.passes.length });
  console.log(`AXE ${label}: ${violations.length} violations`);
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: false });
  report.screenshots.push(name + '.png');
}
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push({ viewport: viewport.name, url: page.url(), message: String(error) }));
    await check(`${viewport.name}: landing layout and six diagram source links`, async () => {
      await visit(page, '/');
      const bounds = await overflow(page, 'Landing');
      assert.equal(await page.locator('[data-node]').count(), 6);
      const links = [];
      for (const button of await page.locator('[data-node]').all()) {
        await button.click();
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        const link = await page.locator('#detail-link').getAttribute('href');
        assert.ok(link.startsWith('/source/computer-use-runtime/'));
        assert.equal((await context.request.get(base + link)).status(), 200);
        links.push(link);
      }
      assert.equal(new Set(links).size, 6);
      await page.locator('[data-node="console"]').click();
      await page.evaluate(() => scrollTo(0, 0));
      await screenshot(page, `landing-${viewport.name}`);
      await accessibility(page, `landing-${viewport.name}`);
      return { bounds, links };
    });
    await check(`${viewport.name}: documentation search and keyboard escape`, async () => {
      await visit(page, '/docs/');
      const bounds = await overflow(page, 'Docs');
      await screenshot(page, `docs-${viewport.name}`);
      await accessibility(page, `docs-${viewport.name}`);
      await page.keyboard.press('/');
      await page.locator('#doc-query').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#doc-query').evaluate(element => element === document.activeElement), true);
      await page.locator('#doc-query').fill('provider');
      await page.waitForFunction(() => document.querySelector('#search-results').children.length > 0);
      const matches = await page.locator('#search-results a').count();
      const resultUrl = await page.locator('#search-results a').first().getAttribute('href');
      assert.equal((await context.request.get(base + resultUrl)).status(), 200);
      await page.locator('#doc-query').fill('zzzznocodexdocument987654321');
      await page.waitForFunction(() => document.querySelector('#search-status').textContent.includes('No documents found'));
      assert.equal(await page.locator('#search-results a').count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#docs-search').evaluate(element => element.open), false);
      if (viewport.name === 'mobile') {
        await page.locator('.menu-toggle').click();
        assert.equal(await page.locator('.menu-toggle').getAttribute('aria-expanded'), 'true');
        await page.locator('.menu-toggle').click();
      }
      return { bounds, matches };
    });
    await check(`${viewport.name}: source filter and line anchors`, async () => {
      await visit(page, '/source/');
      await page.locator('#source-filter').fill('src/runtime/policy.ts');
      const visible = page.locator('[data-source-path]:visible');
      assert.equal(await visible.count(), 1);
      await visible.click();
      await page.locator('#L10 .line-number').click();
      assert.equal(new URL(page.url()).hash, '#L10');
      assert.ok(await page.locator('#L10').isVisible());
      await overflow(page, 'Source');
    });
    await check(`${viewport.name}: architecture Mermaid diagrams`, async () => {
      await visit(page, '/docs/computer-use-runtime/ARCHITECTURE/');
      await page.waitForFunction(() => document.querySelectorAll('.mermaid svg').length === 2);
      assert.equal(await page.locator('.mermaid[data-processed="true"]').count(), 2);
      assert.equal(await page.locator('.mermaid .error-icon').count(), 0);
      await overflow(page, 'Architecture document');
      await screenshot(page, `architecture-${viewport.name}`);
      await accessibility(page, `architecture-${viewport.name}`);
    });
    await check(`${viewport.name}: map journeys, source dialog, and index`, async () => {
      await visit(page, '/map/');
      await page.locator('[data-flow="desktop-task"]').waitFor();
      const bounds = await overflow(page, 'Map');
      await screenshot(page, `map-${viewport.name}`);
      if (viewport.name === 'mobile') {
        await page.locator('#canvas-viewport').scrollIntoViewIfNeeded();
        await screenshot(page, 'map-mobile-canvas');
      }
      await accessibility(page, `map-${viewport.name}`);
      await page.locator('[data-flow="desktop-task"]').click();
      assert.match(await page.locator('#step-progress').innerText(), /Step 1 of 9/);
      await page.locator('#next-step').click();
      assert.match(await page.locator('#step-progress').innerText(), /Step 2 of 9/);
      await page.locator('#previous-step').click();
      assert.match(await page.locator('#step-progress').innerText(), /Step 1 of 9/);
      await page.locator('#list-mode').click();
      await page.locator('#list-view [data-node]').first().click();
      assert.equal(await page.locator('#inspector').isVisible(), true);
      await page.locator('#component-sources button').first().click();
      assert.equal(await page.locator('#source-dialog').evaluate(element => element.open), true);
      assert.equal(await page.locator('#source-code .highlighted').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#source-dialog').evaluate(element => element.open), false);
      await page.locator('#files-button').click();
      await page.locator('#file-search').fill('src/runtime/policy.ts');
      assert.equal(await page.locator('#file-index button').count(), 1);
      await page.locator('#file-index button').click();
      assert.match(await page.locator('#source-title').innerText(), /src\/runtime\/policy\.ts:1/);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      return { bounds };
    });
    await check(`${viewport.name}: video controls, caption tracks, and downloads`, async () => {
      await visit(page, '/');
      const assets = [];
      for (const key of ['tour', 'runtime']) {
        await page.locator(`[data-video="${key}"]`).click();
        const asset = await page.locator('#demo-video source').getAttribute('src');
        const track = await page.locator('#demo-video track').getAttribute('src');
        const transcript = await page.locator('#transcript-link').getAttribute('href');
        const responses = await Promise.all([asset, track, transcript].map(url => context.request.get(base + url)));
        const missing = responses.flatMap((response, index) => response.ok() ? [] : [[asset, track, transcript][index]]);
        if (missing.length && process.env.QA_ALLOW_PENDING_MEDIA === '1') { report.pendingMedia.push(...missing); continue; }
        assert.deepEqual(missing, []);
        assert.equal(await page.locator('#video-download').getAttribute('href'), asset);
        assert.ok((await responses[0].body()).byteLength > 10000, 'Video file is empty or too small');
        assert.ok((await responses[1].text()).startsWith('WEBVTT'), 'Caption file is not WebVTT');
        assert.ok((await responses[2].text()).trim().length > 80, 'Transcript is empty');
        await page.waitForFunction(() => document.querySelector('#demo-video').readyState >= 1);
        const details = await page.locator('#demo-video').evaluate(async video => { video.muted = true; video.textTracks[0].mode = 'showing'; await video.play(); return { controls: video.controls, paused: video.paused, duration: video.duration, width: video.videoWidth, height: video.videoHeight, startedAt: video.currentTime }; });
        assert.equal(details.controls, true); assert.equal(details.paused, false); assert.ok(details.duration > 3); assert.ok(details.width > 0);
        await page.waitForFunction(startedAt => document.querySelector('#demo-video').currentTime >= startedAt + 0.25, details.startedAt);
        await page.waitForFunction(() => document.querySelector('#demo-video track').readyState === 2 && document.querySelector('#demo-video').textTracks[0].cues?.length > 0);
        details.progressedTo = await page.locator('#demo-video').evaluate(video => video.currentTime);
        details.captionCues = await page.locator('#demo-video').evaluate(video => video.textTracks[0].cues.length);
        await page.locator('#demo-video').evaluate(video => video.pause());
        assets.push({ key, asset, track, transcript, ...details });
      }
      return { assets };
    });
    await context.close();
  }
  await check('all published document routes', async () => {
    const manifest = await (await fetch(base + '/publication.json')).json();
    const results = await Promise.all(manifest.documents.map(async document => {
      const response = await fetch(base + document.url);
      const html = await response.text();
      return { path: document.path, url: document.url, status: response.status, main: html.includes('id="content"'), title: html.match(/<title>(.*?)<\/title>/)?.[1] };
    }));
    report.documentRoutes = results;
    assert.equal(results.length, 51);
    assert.deepEqual(results.filter(result => result.status !== 200 || !result.main), []);
    return { count: results.length };
  });
  await check('published HTML local file and fragment links', async () => {
    const dist = path.join(website, 'dist');
    const files = [];
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (directory === dist && ['raw', 'vendor', 'repository-assets'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && entry.name.endsWith('.html')) files.push(file);
      }
    }
    await walk(dist);
    const checked = new Set(); const broken = []; const pending = []; let total = 0;
    const cache = new Map();
    const targetCache = new Map();
    for (const file of files) {
      const html = await fs.readFile(file, 'utf8');
      const relative = '/' + path.relative(dist, file).replaceAll(path.sep, '/').replace(/index\.html$/, '');
      for (const match of html.matchAll(/\b(?:href|src|poster)="([^"]+)"/g)) {
        const href = match[1].replaceAll('&amp;', '&');
        if (/^(?:https?:|mailto:|data:|javascript:|\/\/)/i.test(href)) continue;
        const url = new URL(href, 'http://qa.invalid' + relative);
        const key = url.pathname + url.hash;
        if (checked.has(key)) continue;
        checked.add(key); total++;
        try {
          if (!targetCache.has(url.pathname)) {
            let resolved = path.join(dist, decodeURIComponent(url.pathname));
            try {
              if ((await fs.stat(resolved)).isDirectory()) resolved = path.join(resolved, 'index.html');
              if (!(await fs.stat(resolved)).isFile()) throw new Error('Not a file');
              targetCache.set(url.pathname, resolved);
            } catch { targetCache.set(url.pathname, null); }
          }
          const target = targetCache.get(url.pathname);
          if (!target) throw new Error('Missing file');
          if (url.hash && target.endsWith('.html')) {
            if (!cache.has(target)) cache.set(target, new Set([...(await fs.readFile(target, 'utf8')).matchAll(/\b(?:id|name)="([^"]+)"/g)].map(match => match[1])));
            const ids = cache.get(target);
            const id = decodeURIComponent(url.hash.slice(1));
            if (!ids.has(id)) broken.push({ from: relative, href, reason: 'Missing fragment ' + id });
          }
        } catch (error) {
          const issue = { from: relative, href, reason: 'Missing local file' };
          if (url.pathname.startsWith('/media/') && process.env.QA_ALLOW_PENDING_MEDIA === '1') pending.push(issue);
          else broken.push(issue);
        }
      }
    }
    report.linkCrawl = { pages: files.length, uniqueLinks: total, broken, pending };
    assert.deepEqual(broken, []);
    return { pages: files.length, uniqueLinks: total, pending: pending.length };
  });
} finally {
  await browser.close();
  report.pendingMedia = [...new Set(report.pendingMedia)];
  report.status = report.failures.length || report.pageErrors.length || report.accessibility.some(item => item.violations.length) ? 'FAIL' : report.pendingMedia.length ? 'PASS_WITH_PENDING_MEDIA' : 'PASS';
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failures: report.failures.map(item => ({ name: item.name, error: item.error })), accessibility: report.accessibility.map(item => ({ label: item.label, violations: item.violations.map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length })) })), pageErrors: report.pageErrors, pendingMedia: report.pendingMedia }, null, 2));
  if (report.status === 'FAIL') process.exitCode = 1;
}
