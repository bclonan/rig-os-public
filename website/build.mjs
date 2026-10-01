import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { siteUrl, metadataTags, applyMetadata, homeMetadata, mapMetadata, docsMetadata, sourceMetadata, documentMetadata, fileMetadata } from './metadata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'dist');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const repository = 'https://github.com/bclonan/rig-os-public';
const tracked = git('ls-files', '-z').split('\0').filter(Boolean).filter(file => !file.startsWith('website/'));
const known = new Set(tracked);
const documents = tracked.filter(file => /\.md$/i.test(file));
const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const enc = file => file.split('/').map(encodeURIComponent).join('/');
const docUrl = file => '/docs/' + enc(file.replace(/\.md$/i, '')) + '/';
const sourceUrl = file => '/source/' + enc(file) + '/';
const rawUrl = file => '/raw/' + enc(file);
const githubUrl = file => `${repository}/blob/${commit}/${enc(file)}`;
const slug = text => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
const write = async (file, contents) => { const target = path.join(out, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents); };
const copy = async (file, target = file) => { await fs.mkdir(path.dirname(path.join(out, target)), { recursive: true }); await fs.copyFile(path.join(root, file), path.join(out, target)); };

// Never publish a worktree by recursively copying it. Git is the source allowlist.
if (out !== path.resolve(root, 'website', 'dist')) throw new Error('Unexpected output directory');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const file of ['index.html', 'styles.css', 'main.js', 'favicon.svg', 'docs.css', 'docs.js']) {
  try { await copy(`website/${file}`, file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
try { await fs.cp(path.join(here, 'public'), out, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await write('index.html', applyMetadata(await fs.readFile(path.join(here, 'index.html'), 'utf8'), homeMetadata));

const textFiles = new Map();
const sourceHashes = new Map();
const sourceFiles = [];
const binaryFiles = [];
for (const file of tracked) {
  const bytes = await fs.readFile(path.join(root, file));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { binaryFiles.push(file); continue; }
  if (bytes.includes(0)) { binaryFiles.push(file); continue; }
  textFiles.set(file, text);
  sourceHashes.set(file, crypto.createHash('sha256').update(bytes).digest('hex'));
  await write('raw/' + file, bytes);
  // Large evidence records remain available as raw files without giant HTML pages.
  if (bytes.length <= 1024 * 1024) sourceFiles.push(file);
}
const sourceSet = new Set(sourceFiles);
const missingLinks = [];
const rebasedSnapshotLinks = [];
const usedImages = new Set();
function resolveLink(href, file, image = false) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  const match = href.match(/^([^?#]*)([?#].*)?$/);
  const tail = match?.[2] || '';
  let decoded;
  try { decoded = decodeURIComponent(match?.[1] || href); } catch { decoded = match?.[1] || href; }
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded)).replace(/^\.\//, '');
  if (target === 'docs/system-map/index.html' || target === 'docs/system-map') return '/map/' + tail;
  if (!known.has(target) && known.has(target + '/README.md')) target += '/README.md';
  if (!known.has(target) && tracked.some(file => file.startsWith(target.replace(/\/$/, '') + '/'))) return '/source/?q=' + encodeURIComponent(target.replace(/\/$/, '') + '/');
  if (!known.has(target) && file === 'computer-use-runtime/docs/completion-contract-v1/docs__DEFINITION_OF_DONE.md') {
    const originalTarget = path.posix.normalize(path.posix.join('computer-use-runtime/docs', decoded));
    if (known.has(originalTarget)) { rebasedSnapshotLinks.push({ document: file, href, target: originalTarget }); target = originalTarget; }
  }
  if (!known.has(target)) {
    missingLinks.push({ document: file, href, target });
    return href;
  }
  if (image) { usedImages.add(target); return '/repository-assets/' + enc(target) + tail; }
  if (/\.md$/i.test(target)) return (/^#L\d+(?:-L?\d+)?$/.test(tail) ? sourceUrl(target) : docUrl(target)) + tail;
  if (sourceSet.has(target)) return sourceUrl(target) + tail;
  return (textFiles.has(target) ? rawUrl(target) : githubUrl(target)) + tail;
}
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, highlight: (code, language) => language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : esc(code) });
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  if (tokens[index].info.trim() === 'mermaid') {
    env.hasMermaid = true;
    let diagram = tokens[index].content;
    // Mermaid treats an unescaped semicolon in a sequence label as a new statement.
    // Encode the character for display without changing the repository Markdown.
    if (/^sequenceDiagram/m.test(diagram)) diagram = diagram.replace(/^([^\n]*?:)([^\n]*)$/gm, (_line, prefix, label) => prefix + label.replace(/;/g, '#59;'));
    return `<div class="diagram"><pre class="mermaid" tabindex="0" role="region" aria-label="Architecture diagram. Use arrow keys to scroll.">${esc(diagram)}</pre></div>`;
  }
  return fence(tokens, index, options, env, self);
};
const link = md.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet('href');
  token.attrSet('href', resolveLink(href, env.file));
  if (/^https?:/.test(href || '')) token.attrSet('rel', 'noreferrer');
  return link(tokens, index, options, env, self);
};
const image = md.renderer.rules.image;
md.renderer.rules.image = (tokens, index, options, env, self) => {
  tokens[index].attrSet('src', resolveLink(tokens[index].attrGet('src'), env.file, true));
  tokens[index].attrSet('loading', 'lazy');
  return image(tokens, index, options, env, self);
};
const pageData = documents.map(file => {
  const text = textFiles.get(file);
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(file, '.md');
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`>|]/g, '').replace(/\s+/g, ' ').trim();
  return { file, title, text, plain, url: docUrl(file) };
});
const byFile = new Map(pageData.map(item => [item.file, item]));
const groups = [
  { title: 'Start here', files: ['README.md', 'docs/open-source/SYSTEM_OVERVIEW.md', 'docs/open-source/USAGE.md', 'computer-use-runtime/docs/RUNNING.md', 'computer-use-runtime/docs/PROVIDERS.md', 'computer-use-runtime/PLATFORMS.md'] },
  { title: 'Architecture and code', files: ['docs/system-map/README.md', 'docs/system-map/TRACE.md', 'computer-use-runtime/ARCHITECTURE.md', 'computer-use-runtime/CAPABILITIES.md', 'computer-use-runtime/examples/ports/README.md', 'computer-use-runtime/docs/QUICK_REFERENCE.md', 'computer-use-runtime/docs/CODE_STYLE.md', ...documents.filter(file => file.includes('/adr/'))] },
  { title: 'Evidence and limits', files: ['docs/open-source/VERIFICATION.md', 'docs/open-source/PORTABLE_EVIDENCE.md', 'docs/open-source/EVIDENCE.md', 'docs/open-source/SECURITY_AUDIT.md', 'docs/system-map/VERIFICATION.md', 'docs/system-review/README.md', 'docs/system-review/CHECKLIST.md', 'computer-use-runtime/docs/FEATURE_MATRIX.md', 'computer-use-runtime/docs/REPAIR_STATUS.md', 'computer-use-runtime/docs/VERIFICATION.md', 'computer-use-runtime/evaluation/linux-portal-profile.md'] },
  { title: 'Project and contributing', files: ['AUTHOR.md', 'CONTRIBUTING.md', 'SECURITY.md', 'computer-use-runtime/SECURITY.md', 'computer-use-runtime/THIRD_PARTY.md', 'docs/open-source/README.md'] },
];
const grouped = new Set(groups.flatMap(group => group.files));
groups.push({ title: 'Engineering records', files: documents.filter(file => !grouped.has(file)) });
const nav = active => groups.map(group => `<details class="nav-group" ${group.files.includes(active) || group.title === 'Start here' ? 'open' : ''}><summary>${esc(group.title)}</summary>${group.files.map(file => { const page = byFile.get(file); return page ? `<a href="${page.url}" ${active === file ? 'aria-current="page"' : ''}>${esc(page.title)}</a>` : ''; }).join('')}</details>`).join('');
function shell({ title, description = 'Read the rig-os documentation, trace the architecture, and inspect the source code.', active = '', content, toc = '', wide = false, mermaid = false, route }) {
  const metadata = active ? documentMetadata(active, title, route || docUrl(active), description) : title === 'Documentation' ? docsMetadata : title === 'Browse source' ? sourceMetadata : fileMetadata(title, route || sourceUrl(title));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">${metadataTags(metadata)}<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/docs.css"><script src="/docs.js" defer></script>${mermaid ? '<script type="module">import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:"dark",fontFamily:"system-ui, sans-serif"});</script>' : ''}</head><body><a href="#content" class="skip-link">Skip to content</a><header class="docs-header"><a class="wordmark" href="/" aria-label="rig-os home"><span class="brand-mark" aria-hidden="true">r.</span>rig-os<span class="docs-label">/ docs</span></a><nav aria-label="Site navigation"><a href="/map/">System map <span aria-hidden="true">↗</span></a><a href="/source/">Source</a><a href="${repository}" class="github-link">GitHub <span aria-hidden="true">↗</span></a><button type="button" class="search-trigger" data-open-search>Search docs <kbd>/</kbd></button><button type="button" class="menu-toggle" aria-expanded="false" aria-controls="docs-nav">Menu</button></nav></header><div class="docs-layout ${wide ? 'wide-layout' : ''}"><aside class="docs-sidebar" id="docs-nav"><a class="library-link" href="/docs/">Documentation library <span>${documents.length}</span></a>${nav(active)}<div class="sidebar-foot"><span class="status-dot"></span> Experimental, open source<br><a href="${repository}/tree/${commit}">Source ${commit.slice(0, 7)}</a></div></aside><main id="content" class="docs-main" tabindex="-1">${content}<footer class="docs-footer"><a href="/">rig-os</a><span>Built by <a href="https://www.linkedin.com/in/bclonan">Brad Clonan</a></span><a href="${sourceUrl('LICENSE')}">MIT license</a></footer></main>${toc ? `<aside class="page-toc" aria-label="On this page"><p>On this page</p>${toc}</aside>` : ''}</div><dialog class="search-dialog" id="docs-search" aria-labelledby="search-title"><div class="search-top"><label id="search-title" for="doc-query">Search all ${documents.length} documents</label><button type="button" data-close-search aria-label="Close search">Esc</button></div><input id="doc-query" type="search" autocomplete="off" placeholder="Try provider, permissions, or verification"><p id="search-status" role="status">Type a word or a source path to search the full documentation.</p><div id="search-results"></div></dialog></body></html>`;
}
for (const page of pageData) {
  const env = { file: page.file, hasMermaid: false };
  const tokens = md.parse(page.text, env);
  const headings = [];
  const seen = new Map();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== 'heading_open') continue;
    const heading = tokens[index + 1].content.replace(/[`*]/g, '');
    const base = slug(heading); const count = seen.get(base) || 0; seen.set(base, count + 1);
    const id = base + (count ? '-' + count : '');
    tokens[index].attrSet('id', id);
    if (tokens[index].tag !== 'h1') headings.push({ title: heading, id, level: tokens[index].tag });
  }
  const body = md.renderer.render(tokens, md.options, env);
  const group = groups.find(group => group.files.includes(page.file));
  const content = `<div class="document-meta"><a href="/docs/">Documentation</a><span>/</span><span>${esc(group?.title || 'Library')}</span></div><div class="source-tools"><span>${esc(page.file)}</span><a href="${rawUrl(page.file)}">Raw Markdown</a><a href="${githubUrl(page.file)}">GitHub ↗</a></div><article class="prose">${body}</article><div class="document-end"><p>This page is rendered from the repository source. Historical results retain the scope and dates recorded in the document.</p><a href="/docs/">Browse all documents →</a></div>`;
  await write(`docs/${page.file.replace(/\.md$/i, '')}/index.html`, shell({ title: page.title, description: page.plain.slice(page.title.length).trim(), active: page.file, content, toc: headings.map(heading => `<a href="#${esc(heading.id)}" class="toc-${heading.level}">${esc(heading.title)}</a>`).join(''), mermaid: env.hasMermaid }));
}
await write('docs/index.html', shell({ title: 'Documentation', wide: true, content: `<div class="document-meta">INSIDE RIG-OS</div><h1 class="library-title">Read the system.<br><span>Then follow the code.</span></h1><p class="library-intro">Setup, architecture, operating guides, and the evidence behind the claims. All ${documents.length} Markdown documents from the public repository, with links back to their source.</p><div class="start-cards"><a href="${docUrl('docs/open-source/USAGE.md')}"><span>01 / USE IT</span><h2>Run rig-os locally</h2><p>Install the runtime, connect the console, and try a bounded task.</p><b aria-hidden="true">↗</b></a><a href="/map/"><span>02 / UNDERSTAND IT</span><h2>Open the system map</h2><p>Follow a user journey through the code and its control boundaries.</p><b aria-hidden="true">↗</b></a><a href="${docUrl('docs/open-source/VERIFICATION.md')}"><span>03 / CHECK IT</span><h2>Read the evidence</h2><p>See what passed, what failed, and which platform gates remain open.</p><b aria-hidden="true">↗</b></a></div>${groups.map(group => `<section class="library-section"><div class="section-heading"><h2>${esc(group.title)}</h2><span>${group.files.length} documents</span></div><div class="document-list">${group.files.map(file => { const page = byFile.get(file); return `<a href="${page.url}"><span>${esc(page.title)}</span><small>${esc(page.file)}</small><b aria-hidden="true">↗</b></a>`; }).join('')}</div></section>`).join('')}` }));
await write('search-index.json', JSON.stringify(pageData.map(page => ({ title: page.title, path: page.file, url: page.url, text: page.plain }))));
await write('source/index.html', shell({ title: 'Browse source', wide: true, content: `<div class="document-meta">READ THE IMPLEMENTATION</div><h1 class="library-title">The code, in context.</h1><p class="library-intro">Browse ${sourceFiles.length} text files from the public checkout. The system map also opens its embedded source snapshots at the exact lines cited by each component.</p><a class="inline-action" href="/map/">Explore the source-linked map ↗</a><label class="source-filter-label" for="source-filter">Filter files</label><input class="source-filter" id="source-filter" type="search" placeholder="Try src/runtime, providers, or .py" autocomplete="off"><p class="source-count" id="source-count">${sourceFiles.length} files</p><div class="source-file-list">${sourceFiles.map(file => `<a href="${sourceUrl(file)}" data-source-path="${esc(file.toLowerCase())}"><span>${esc(file)}</span><small>${textFiles.get(file).split('\n').length} lines</small></a>`).join('')}</div><p class="source-note">Binary files and large records remain in <a href="${repository}/tree/${commit}">the GitHub repository</a>. This website does not run the local service.</p>` }));
for (const file of sourceFiles) {
  const text = textFiles.get(file);
  const lines = text.split('\n');
  const content = `<div class="document-meta"><a href="/source/">Source files</a><span>/</span><span>${esc(path.posix.basename(file))}</span></div><h1 class="source-title">${esc(file)}</h1><div class="source-tools"><span>${lines.length} lines · ${commit.slice(0, 7)}</span><a href="${rawUrl(file)}">Raw file</a><a href="${githubUrl(file)}">GitHub ↗</a>${/\.md$/i.test(file) ? `<a href="${docUrl(file)}">Read document</a>` : ''}</div><div class="code-file" aria-label="Source code">${lines.map((line, index) => `<div class="code-line" id="L${index + 1}"><a href="#L${index + 1}" class="line-number" aria-label="Line ${index + 1}">${index + 1}</a><code>${esc(line.replace(/\r$/, '')) || ' '}</code></div>`).join('')}</div>`;
  await write(`source/${file}/index.html`, shell({ title: file, content, wide: true }));
}
for (const file of usedImages) await copy(file, 'repository-assets/' + file);
for (const file of ['architecture-data.js', 'canvas.js', 'canvas.css', 'SOURCE_INDEX.json', 'PUBLICATION_BINDING.json']) await copy('docs/system-map/' + file, 'map/' + file);
let mapHtml = await fs.readFile(path.join(root, 'docs/system-map/index.html'), 'utf8');
mapHtml = mapHtml.replace('href="README.md"', `href="${docUrl('docs/system-map/README.md')}"`).replace('href="TRACE.md"', `href="${docUrl('docs/system-map/TRACE.md')}"`).replace('href="research/core.md"', `href="${docUrl('docs/open-source/SYSTEM_OVERVIEW.md')}"`).replace('href="../../computer-use-runtime/docs/RUNNING.md"', `href="${docUrl('computer-use-runtime/docs/RUNNING.md')}"`);
mapHtml = mapHtml.replace('<div class="snapshot">', '<div class="snapshot"><a href="/" style="color:inherit;text-decoration:none">rig-os home ↗</a><a href="/docs/" style="color:inherit;text-decoration:none">Documentation ↗</a>');
await write('map/index.html', applyMetadata(mapHtml, mapMetadata));
await copy('website/node_modules/mermaid/dist/mermaid.esm.min.mjs', 'vendor/mermaid/mermaid.esm.min.mjs');
await fs.cp(path.join(here, 'node_modules/mermaid/dist/chunks/mermaid.esm.min'), path.join(out, 'vendor/mermaid/chunks/mermaid.esm.min'), { recursive: true, filter: file => !file.endsWith('.map') });
await copy('website/node_modules/mermaid/LICENSE', 'vendor/mermaid/LICENSE');
const manifest = { generatedAt: new Date().toISOString(), sourceCommit: commit, documents: pageData.map(page => ({ path: page.file, url: page.url, sha256: sourceHashes.get(page.file) })), counts: { markdownDocuments: documents.length, sourcePages: sourceFiles.length, rawTextFiles: textFiles.size, binaryFilesLinkedToRepository: binaryFiles.length, mermaidDiagrams: pageData.reduce((count, page) => count + (page.text.match(/^```mermaid/gm) || []).length, 0) }, unresolvedSourceLinks: missingLinks, rebasedSnapshotLinks, publication: 'Static documentation and source browsing. No runtime execution or new runtime qualification.' };
await write('publication.json', JSON.stringify(manifest, null, 2));
let headers = '';
try { headers = await fs.readFile(path.join(out, '_headers'), 'utf8'); } catch { /* no public headers */ }
await write('_headers', headers + '\n/raw/*\n  Content-Type: text/plain; charset=utf-8\n  X-Content-Type-Options: nosniff\n\n/repository-assets/*\n  X-Content-Type-Options: nosniff\n');
if (siteUrl) await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/docs/', '/map/', '/source/', ...pageData.map(page => page.url)].map(url => `<url><loc>${esc(siteUrl.replace(/\/$/, '') + url)}</loc></url>`).join('')}</urlset>`);
await write('robots.txt', 'User-agent: *\nAllow: /\nDisallow: /raw/\nDisallow: /vendor/\n' + (siteUrl ? `Sitemap: ${siteUrl.replace(/\/$/, '')}/sitemap.xml\n` : ''));
console.log(JSON.stringify({ ...manifest.counts, unresolvedSourceLinks: missingLinks.length, output: out }, null, 2));
if (missingLinks.length) throw new Error(`Unresolved source links: ${JSON.stringify(missingLinks)}`);
