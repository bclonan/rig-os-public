const searchDialog = document.querySelector('#docs-search');
const queryInput = document.querySelector('#doc-query');
const results = document.querySelector('#search-results');
const status = document.querySelector('#search-status');
let indexPromise;
let lastFocus;

function openSearch() {
  lastFocus = document.activeElement;
  searchDialog.showModal();
  queryInput.focus();
  indexPromise ||= fetch('/search-index.json').then(response => {
    if (!response.ok) throw new Error('Search index unavailable');
    return response.json();
  });
  indexPromise.catch(() => { status.textContent = 'Search could not load. Browse the documentation library or try again.'; indexPromise = undefined; });
}
document.querySelectorAll('[data-open-search]').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('[data-close-search]')?.addEventListener('click', () => searchDialog.close());
searchDialog?.addEventListener('close', () => lastFocus?.focus());
searchDialog?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); searchDialog.close(); }
});
searchDialog?.addEventListener('click', event => {
  if (event.target !== searchDialog) return;
  const bounds = searchDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) searchDialog.close();
});
document.addEventListener('keydown', event => {
  if ((event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault();
    if (!searchDialog.open) openSearch();
  }
});
queryInput?.addEventListener('input', async () => {
  const query = queryInput.value.trim().toLowerCase();
  results.replaceChildren();
  if (!query) { status.textContent = 'Type a word or a source path to search the full documentation.'; return; }
  status.textContent = 'Searching...';
  let index;
  try { index = await indexPromise; } catch { return; }
  if (!index || query !== queryInput.value.trim().toLowerCase()) return;
  const words = query.split(/\s+/);
  const matches = index.map(page => {
    const title = page.title.toLowerCase();
    const path = page.path.toLowerCase();
    const text = page.text.toLowerCase();
    if (!words.every(word => `${title} ${path} ${text}`.includes(word))) return null;
    const score = words.reduce((value, word) => value + (title.includes(word) ? 20 : 0) + (path.includes(word) ? 12 : 0) + (text.includes(word) ? 1 : 0), 0);
    return { ...page, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  status.textContent = matches.length ? `${matches.length} matching document${matches.length === 1 ? '' : 's'}` : 'No documents found. Try a shorter word or a filename.';
  for (const page of matches.slice(0, 25)) {
    const link = document.createElement('a');
    link.href = page.url;
    const title = document.createElement('strong'); title.textContent = page.title;
    const path = document.createElement('small'); path.textContent = page.path;
    const excerpt = document.createElement('p');
    const position = page.text.toLowerCase().indexOf(words[0]);
    const start = Math.max(0, position - 70);
    excerpt.textContent = (start ? '... ' : '') + page.text.slice(start, start + 230) + '...';
    link.append(title, path, excerpt); results.append(link);
  }
});

const menu = document.querySelector('.menu-toggle');
menu?.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(expanded));
  document.querySelector('#docs-nav').classList.toggle('is-open', expanded);
});
document.querySelectorAll('.prose pre:not(.mermaid)').forEach(pre => {
  const code = pre.querySelector('code');
  if (!code) return;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'copy-code'; button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy code');
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code.textContent); button.textContent = 'Copied'; }
    catch { button.textContent = 'Select and copy'; }
    setTimeout(() => { button.textContent = 'Copy'; }, 2000);
  });
  pre.append(button);
});
const sourceFilter = document.querySelector('#source-filter');
function filterSource() {
  const query = sourceFilter.value.trim().toLowerCase(); let count = 0;
  document.querySelectorAll('[data-source-path]').forEach(link => { link.hidden = !link.dataset.sourcePath.includes(query); if (!link.hidden) count++; });
  document.querySelector('#source-count').textContent = `${count} matching file${count === 1 ? '' : 's'}`;
}
sourceFilter?.addEventListener('input', filterSource);
if (sourceFilter) {
  sourceFilter.value = new URLSearchParams(location.search).get('q') || '';
  if (sourceFilter.value) filterSource();
}
const tocLinks = [...document.querySelectorAll('.page-toc a')];
if ('IntersectionObserver' in window && tocLinks.length) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      tocLinks.forEach(link => link.classList.toggle('is-active', link.hash === `#${entry.target.id}`));
    }
  }, { rootMargin: '-15% 0px -70% 0px' });
  document.querySelectorAll('.prose h2, .prose h3').forEach(heading => observer.observe(heading));
}
