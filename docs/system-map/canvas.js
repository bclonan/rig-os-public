(() => {
  'use strict';
  const data = window.ARCHITECTURE_SNAPSHOT;
  const $ = (id) => document.getElementById(id);
  if (!data) { $('view-description').textContent = 'The source snapshot is missing. Run python docs/system-map/build_map.py from the repository root.'; return; }
  const byId = new Map(data.components.map((node) => [node.id, node]));
  const viewport = $('canvas-viewport');
  const world = $('world');
  const svg = $('connections');
  const state = { view: 'overview', flow: null, step: 0, selection: null, mode: 'map', query: '', scale: 1, x: 0, y: 0, width: 1100, height: 650, moved: false };
  const positions = new Map();
  const pointers = new Map();
  let dragOrigin = null;
  let pinchOrigin = null;
  let suppressedClickUntil = 0;
  let visible = [];
  let visibleEdges = [];
  const create = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const svgElement = (tag, attrs) => { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value)); return element; };
  const announce = (text) => { $('announcement').textContent = text; };
  const color = (node) => `var(--${node.category || 'runtime'})`;
  const currentFlow = () => data.flows.find((flow) => flow.id === state.flow);
  const selectedView = () => data.views.find((view) => view.id === state.view);
  const searchable = (node) => [node.title, node.summary, node.group, ...(node.details || []), ...(node.sources || []).map((ref) => ref.path)].join(' ').toLowerCase();

  function renderNavigation() {
    for (const view of data.views) {
      const button = create('button', view.title, 'view-button'); button.type = 'button'; button.dataset.view = view.id;
      button.setAttribute('aria-pressed', String(view.id === state.view));
      button.addEventListener('click', () => chooseView(view.id)); $('view-list').append(button);
    }
    for (const flow of data.flows) {
      const button = create('button', undefined, 'journey-button'); button.type = 'button'; button.dataset.flow = flow.id;
      button.append(create('strong', flow.title), create('span', `${flow.steps.length} traced steps`));
      button.setAttribute('aria-pressed', 'false'); button.addEventListener('click', () => chooseFlow(flow.id)); $('journey-list').append(button);
    }
  }

  function chooseView(id) {
    state.view = id; state.flow = null; state.selection = null; state.moved = false; state.query = ''; $('search').value = '';
    $('inspector').hidden = true; $('journey-panel').hidden = true;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === id));
    for (const button of document.querySelectorAll('[data-flow]')) button.setAttribute('aria-pressed', 'false');
    render(); announce(selectedView().title);
  }

  function chooseFlow(id) {
    state.flow = id; state.selection = null; state.step = 0; state.query = ''; $('search').value = ''; state.moved = false;
    $('inspector').hidden = true;
    for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', 'false');
    for (const button of document.querySelectorAll('[data-flow]')) button.setAttribute('aria-pressed', String(button.dataset.flow === id));
    render(); renderJourney(); announce(currentFlow().title);
  }

  function matchingNodes() {
    const flow = currentFlow();
    let ids = flow ? [...new Set(flow.steps.map((step) => step.component))] : selectedView().components;
    if (state.query) ids = data.components.filter((node) => searchable(node).includes(state.query)).map((node) => node.id);
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function arrange() {
    positions.clear();
    if (!state.flow && state.view === 'overview' && !state.query) {
      for (const node of visible) positions.set(node.id, node.position);
    } else {
      const columns = visible.length <= 3 ? visible.length || 1 : Math.min(8, Math.max(3, Math.ceil(Math.sqrt(visible.length))));
      visible.forEach((node, index) => positions.set(node.id, { x: 45 + (index % columns) * 330, y: 40 + Math.floor(index / columns) * 220 }));
    }
    state.width = Math.max(500, ...[...positions.values()].map((position) => position.x + 285));
    state.height = Math.max(320, ...[...positions.values()].map((position) => position.y + 210));
    world.style.width = `${state.width}px`; world.style.height = `${state.height}px`;
    svg.setAttribute('width', state.width); svg.setAttribute('height', state.height);
  }

  function nodeButton(node, inList = false) {
    const button = create('button', undefined, 'node'); button.type = 'button'; button.dataset.node = node.id; button.style.setProperty('--node-color', color(node));
    button.setAttribute('aria-label', `${node.title}. ${node.summary}`);
    button.append(create('span', node.group, 'node-group'), create('span', node.title, 'node-title'), create('span', node.summary, 'node-summary'), create('span', `${node.sources.length} source reference${node.sources.length === 1 ? '' : 's'}`, 'node-source-count'));
    if (!inList) { const position = positions.get(node.id); button.style.left = `${position.x}px`; button.style.top = `${position.y}px`; }
    button.addEventListener('click', () => { if (Date.now() >= suppressedClickUntil) selectNode(node.id, true); });
    button.addEventListener('focus', () => { if (!inList) ensureVisible(node.id); });
    return button;
  }

  function render() {
    visible = matchingNodes(); arrange();
    const ids = new Set(visible.map((node) => node.id));
    visibleEdges = data.relationships.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const flow = currentFlow();
    if (flow && !state.query) {
      visibleEdges = flow.steps.slice(1).map((step, index) => ({ from: flow.steps[index].component, to: step.component, label: `${index + 1} → ${index + 2}`, detail: step.description, sources: step.sources || [] })).filter((edge) => edge.from !== edge.to);
    }
    const view = flow || selectedView();
    $('view-title').textContent = state.query ? `Search results for "${state.query}"` : view.title;
    $('view-description').textContent = state.query ? 'Matches include component explanations and source paths. Select a result to read its code.' : view.summary;
    $('view-eyebrow').textContent = flow ? 'Follow the work in order' : view.eyebrow || 'Code responsibilities';
    $('nodes').replaceChildren(...visible.map((node) => nodeButton(node)));
    const list = create('div', undefined, 'component-list'); list.append(...visible.map((node) => nodeButton(node, true))); $('list-view').replaceChildren(list);
    if (!visible.length) list.append(create('p', 'No matching components. Clear or shorten the search.'));
    $('visible-count').textContent = `${visible.length} components · ${visibleEdges.length} links`;
    $('empty-state').hidden = visible.length !== 0;
    renderEdges(); updateSelection();
    if (!state.moved) requestAnimationFrame(fitView); else applyTransform();
    $('journey-panel').hidden = !flow || Boolean(state.query);
    if (flow && !state.query) renderJourney();
  }

  function renderEdges() {
    svg.replaceChildren();
    const defs = svgElement('defs', {});
    const marker = svgElement('marker', { id: 'connection-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--edge)' })); defs.append(marker); svg.append(defs);
    for (const edge of visibleEdges) {
      const start = positions.get(edge.from); const end = positions.get(edge.to); if (!start || !end) continue;
      const startNode = $('nodes').querySelector(`[data-node="${edge.from}"]`); const endNode = $('nodes').querySelector(`[data-node="${edge.to}"]`);
      const sh = startNode?.offsetHeight || 115; const eh = endNode?.offsetHeight || 115;
      let sx, sy, ex, ey, curve;
      if (Math.abs(end.x - start.x) > 100) {
        const rightward = end.x > start.x; sx = start.x + (rightward ? 238 : 0); sy = start.y + sh / 2; ex = end.x + (rightward ? 0 : 238); ey = end.y + eh / 2;
        const bend = Math.max(45, Math.abs(ex - sx) / 2); const direction = rightward ? 1 : -1;
        curve = `M ${sx} ${sy} C ${sx + bend * direction} ${sy}, ${ex - bend * direction} ${ey}, ${ex} ${ey}`;
      } else {
        const downward = end.y > start.y; sx = start.x + 119; sy = start.y + (downward ? sh : 0); ex = end.x + 119; ey = end.y + (downward ? 0 : eh);
        const bend = Math.max(40, Math.abs(ey - sy) / 2); const direction = downward ? 1 : -1;
        curve = `M ${sx} ${sy} C ${sx} ${sy + bend * direction}, ${ex} ${ey - bend * direction}, ${ex} ${ey}`;
      }
      const related = state.selection && (edge.from === state.selection || edge.to === state.selection);
      const line = svgElement('path', { d: curve, class: `connection-line${related ? ' highlight' : ''}`, 'marker-end': 'url(#connection-arrow)' });
      line.append(svgElement('title', {})); line.firstChild.textContent = `${byId.get(edge.from).title} → ${byId.get(edge.to).title}: ${edge.label}`; svg.append(line);
      if (related || currentFlow()) { const label = svgElement('text', { x: (sx + ex) / 2, y: (sy + ey) / 2 - 8, 'text-anchor': 'middle', class: 'edge-label' }); label.textContent = edge.label; svg.append(label); }
    }
  }

  function applyTransform() {
    world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    const compactChanged = world.classList.contains('compact') !== (state.scale < .8);
    world.classList.toggle('compact', state.scale < .8);
    $('zoom-level').textContent = `${Math.round(state.scale * 100)}%`;
    renderMinimap();
    if (compactChanged) renderEdges();
  }

  function fitView() {
    if (state.mode !== 'map') return;
    state.scale = Math.max(.04, Math.min(1, (viewport.clientWidth - 70) / state.width, (viewport.clientHeight - 90) / state.height));
    state.x = (viewport.clientWidth - state.width * state.scale) / 2; state.y = (viewport.clientHeight - state.height * state.scale) / 2 - 12;
    state.moved = false; applyTransform(); renderEdges();
  }

  function zoom(factor, point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
    const previous = state.scale; state.scale = Math.max(.04, Math.min(2.5, previous * factor));
    state.x = point.x - (point.x - state.x) / previous * state.scale; state.y = point.y - (point.y - state.y) / previous * state.scale;
    state.moved = true; applyTransform(); renderEdges();
  }

  function centerNode(id) {
    const position = positions.get(id); if (!position) return;
    state.scale = Math.max(.85, state.scale); state.x = viewport.clientWidth / 2 - (position.x + 119) * state.scale; state.y = viewport.clientHeight / 2 - (position.y + 70) * state.scale;
    state.moved = true; applyTransform(); renderEdges();
  }

  function ensureVisible(id) {
    const position = positions.get(id); if (!position) return;
    const left = state.x + position.x * state.scale; const top = state.y + position.y * state.scale;
    if (left < 10 || top < 10 || left + 238 * state.scale > viewport.clientWidth - 10 || top + 165 * state.scale > viewport.clientHeight - 45) centerNode(id);
  }

  function renderMinimap() {
    const mini = $('minimap'); mini.replaceChildren(); mini.setAttribute('viewBox', `0 0 ${state.width} ${state.height}`);
    for (const node of visible) { const position = positions.get(node.id); mini.append(svgElement('rect', { x: position.x, y: position.y, width: 238, height: 115, rx: 8, fill: color(node), opacity: .62 })); }
    mini.append(svgElement('rect', { x: -state.x / state.scale, y: -state.y / state.scale, width: viewport.clientWidth / state.scale, height: viewport.clientHeight / state.scale, fill: 'none', stroke: 'var(--ink)', 'stroke-width': Math.max(4, state.width / 160) }));
  }

  function updateSelection() {
    const neighbors = new Set([state.selection]);
    for (const edge of visibleEdges) { if (edge.from === state.selection) neighbors.add(edge.to); if (edge.to === state.selection) neighbors.add(edge.from); }
    const flow = currentFlow(); const stepNode = flow?.steps[state.step]?.component;
    for (const element of document.querySelectorAll('[data-node]')) {
      element.classList.toggle('selected', element.dataset.node === state.selection);
      element.classList.toggle('dimmed', Boolean(state.selection && !neighbors.has(element.dataset.node)));
      element.classList.toggle('active-step', element.dataset.node === stepNode);
      const old = element.querySelector('.node-step'); if (old) old.remove();
      if (element.dataset.node === stepNode) element.append(create('span', String(state.step + 1), 'node-step'));
    }
    renderEdges();
  }

  function sourceButton(ref) {
    const button = create('button', `${ref.path}:${ref.line || 1}`, 'source-button'); button.type = 'button';
    if (ref.symbol || ref.label || ref.anchor) button.append(create('span', ref.symbol || ref.label || ref.anchor));
    button.addEventListener('click', () => showSource(ref)); return button;
  }

  function selectNode(id, openInspector) {
    const node = byId.get(id); if (!node) return; state.selection = id; updateSelection();
    if (!openInspector) return;
    $('inspector').hidden = false; $('component-group').textContent = node.group; $('component-title').textContent = node.title;
    $('component-status').textContent = node.status || 'Source traced'; $('component-summary').textContent = node.summary;
    const ul = create('ul'); for (const detail of node.details || []) ul.append(create('li', detail)); $('component-details').replaceChildren(ul);
    const edges = data.relationships.filter((edge) => edge.from === id || edge.to === id);
    $('component-connections').replaceChildren(...edges.map((edge) => {
      const other = byId.get(edge.from === id ? edge.to : edge.from); const button = create('button', `${edge.from === id ? 'To' : 'From'} ${other.title}`, 'connection-button'); button.type = 'button'; button.append(create('small', edge.label));
      button.addEventListener('click', () => { if (!visible.some((item) => item.id === other.id)) chooseView('all'); selectNode(other.id, true); centerNode(other.id); }); return button;
    }));
    const refs = [...node.sources]; const step = currentFlow()?.steps[state.step];
    if (step?.component === id) for (const ref of step.sources || []) if (!refs.some((item) => item.path === ref.path && item.line === ref.line)) refs.unshift(ref);
    $('component-sources').replaceChildren(...refs.map(sourceButton));
    $('component-title').focus();
    requestAnimationFrame(() => ensureVisible(id)); announce(`Selected ${node.title}`);
  }

  function renderJourney() {
    const flow = currentFlow(); $('journey-panel').hidden = !flow; if (!flow) return;
    const step = flow.steps[state.step]; $('step-progress').textContent = `Step ${state.step + 1} of ${flow.steps.length}: ${step.title}`;
    $('step-description').textContent = step.description;
    $('previous-step').disabled = state.step === 0; $('next-step').disabled = state.step === flow.steps.length - 1;
    const activeStepButton = document.activeElement?.closest('#step-list button');
    const focusedStep = activeStepButton ? [...$('step-list').querySelectorAll('button')].indexOf(activeStepButton) : -1;
    $('step-list').replaceChildren(...flow.steps.map((item, index) => { const li = create('li'); const button = create('button', `${index + 1}. ${item.title}`); button.type = 'button'; if (index === state.step) button.setAttribute('aria-current', 'step'); button.addEventListener('click', () => showStep(index)); li.append(button); return li; }));
    if (focusedStep >= 0) $('step-list').querySelectorAll('button')[focusedStep]?.focus();
    updateSelection();
  }

  function showStep(index) {
    const flow = currentFlow(); state.step = Math.max(0, Math.min(flow.steps.length - 1, index)); const step = flow.steps[state.step];
    state.selection = null; renderJourney(); centerNode(step.component);
    if (!$('inspector').hidden) selectNode(step.component, true);
    announce(`Step ${state.step + 1}: ${step.title}. ${step.description}`);
  }

  function showSource(ref) {
    const file = data.files.find((item) => item.path === ref.path); if (!file) { announce(`No embedded source for ${ref.path}`); return; }
    const line = Math.max(1, Math.min(file.lines, ref.line || 1));
    $('source-title').textContent = `${file.path}:${line}`; $('source-meta').textContent = `${file.lines} lines · SHA256 ${file.sha256.slice(0, 16)} · Snapshot, not a live editor`;
    $('source-code').replaceChildren(...file.text.split('\n').map((text, index) => { const row = create('div', undefined, `source-line${index + 1 === line ? ' highlighted' : ''}`); row.dataset.line = String(index + 1); row.append(create('span', String(index + 1), 'line-number'), create('code', text)); return row; }));
    $('source-dialog').showModal(); requestAnimationFrame(() => $('source-code').querySelector('.highlighted')?.scrollIntoView({ block: 'center' }));
  }

  function showEntities() {
    $('entity-content').replaceChildren(...data.entities.map((entity) => {
      const article = create('article', undefined, 'entity-card'); article.append(create('h3', entity.title || entity.name));
      if (entity.summary || entity.description) article.append(create('p', entity.summary || entity.description));
      if (entity.storage && typeof entity.storage === 'object') { const storage = create('dl'); for (const [label, value] of Object.entries(entity.storage)) storage.append(create('dt', label), create('dd', typeof value === 'object' ? JSON.stringify(value) : String(value))); article.append(storage); }
      else if (entity.storage) article.append(create('p', `Stored in ${entity.storage}.`));
      if (entity.fields?.length) article.append(create('p', `Fields: ${entity.fields.map((field) => typeof field === 'string' ? field : JSON.stringify(field)).join(', ')}.`));
      if (entity.lifetime) article.append(create('p', entity.lifetime));
      if (entity.operations?.length) article.append(create('p', `Operations: ${entity.operations.join(', ')}.`));
      for (const detail of entity.details || []) article.append(create('p', detail));
      for (const ref of entity.sources || []) article.append(sourceButton(ref)); return article;
    }));
    $('entities-dialog').showModal();
  }

  function renderFileIndex() {
    const query = $('file-search').value.toLowerCase(); const files = data.files.filter((file) => file.maintained && file.path.toLowerCase().includes(query));
    $('file-count').textContent = `${files.length} of ${data.meta.maintainedFiles} maintained files`;
    $('file-index').replaceChildren(...files.map((file) => { const row = create('div', undefined, 'file-entry'); const button = create('button', file.path); button.type = 'button'; button.addEventListener('click', () => showSource({ path: file.path, line: 1 })); const count = data.components.filter((node) => node.sources.some((ref) => ref.path === file.path)).length; row.append(button, create('small', `${file.lines} lines · ${count ? count + ' component references' : 'Inventory only'}`)); return row; }));
  }

  function setMode(mode) {
    state.mode = mode; $('map-mode').setAttribute('aria-pressed', String(mode === 'map')); $('list-mode').setAttribute('aria-pressed', String(mode === 'list'));
    viewport.hidden = mode !== 'map'; $('list-view').hidden = mode !== 'list'; if (mode === 'map') requestAnimationFrame(fitView);
  }

  viewport.addEventListener('wheel', (event) => { if (event.target.closest('.canvas-controls')) return; event.preventDefault(); const rect = viewport.getBoundingClientRect(); const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1); zoom(Math.exp(-delta * .0018), { x: event.clientX - rect.left, y: event.clientY - rect.top }); }, { passive: false });
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.canvas-controls') || event.target.closest('.empty-state')) return;
    const node = event.target.closest('[data-node]'); if (node && event.pointerType !== 'touch') return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, node: node?.dataset.node, initialX: event.clientX, initialY: event.clientY, moved: false });
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
    if (pointers.size === 1) dragOrigin = { x: event.clientX, y: event.clientY, mapX: state.x, mapY: state.y }; else { pinchOrigin = null; suppressedClickUntil = Date.now() + 400; }
  });
  viewport.addEventListener('pointermove', (event) => {
    const pointer = pointers.get(event.pointerId); if (!pointer) return; pointer.x = event.clientX; pointer.y = event.clientY;
    if (Math.hypot(pointer.x - pointer.initialX, pointer.y - pointer.initialY) > 5) pointer.moved = true;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()]; const rect = viewport.getBoundingClientRect(); const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }; const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (!pinchOrigin) pinchOrigin = { distance, scale: state.scale, worldX: (mid.x - state.x) / state.scale, worldY: (mid.y - state.y) / state.scale };
      state.scale = Math.max(.04, Math.min(2.5, pinchOrigin.scale * distance / pinchOrigin.distance)); state.x = mid.x - pinchOrigin.worldX * state.scale; state.y = mid.y - pinchOrigin.worldY * state.scale;
      suppressedClickUntil = Date.now() + 400;
    } else if (dragOrigin && pointer.moved) { state.x = dragOrigin.mapX + event.clientX - dragOrigin.x; state.y = dragOrigin.mapY + event.clientY - dragOrigin.y; suppressedClickUntil = Date.now() + 300; }
    state.moved = true; applyTransform();
  });
  const endPointer = (event) => {
    const pointer = pointers.get(event.pointerId); const wasSingle = pointers.size === 1; pointers.delete(event.pointerId);
    if (event.type === 'pointerup' && pointer?.node && !pointer.moved && wasSingle && Date.now() >= suppressedClickUntil) selectNode(pointer.node, true);
    pinchOrigin = null;
    if (pointers.size) { const next = [...pointers.values()][0]; dragOrigin = { x: next.x, y: next.y, mapX: state.x, mapY: state.y }; next.moved = true; } else { dragOrigin = null; viewport.classList.remove('dragging'); }
  };
  viewport.addEventListener('pointerup', endPointer); viewport.addEventListener('pointercancel', endPointer); viewport.addEventListener('lostpointercapture', (event) => { if (pointers.has(event.pointerId)) endPointer(event); });
  viewport.addEventListener('keydown', (event) => {
    if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey) return;
    const movement = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key];
    if (movement) { event.preventDefault(); state.x += movement[0]; state.y += movement[1]; state.moved = true; applyTransform(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.2); }
    else if (event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
  });
  $('zoom-in').addEventListener('click', () => zoom(1.2)); $('zoom-out').addEventListener('click', () => zoom(1 / 1.2)); $('fit-view').addEventListener('click', fitView); $('reset-view').addEventListener('click', () => zoom(1 / state.scale));
  $('previous-step').addEventListener('click', () => showStep(state.step - 1)); $('next-step').addEventListener('click', () => showStep(state.step + 1)); $('whole-journey').addEventListener('click', () => { state.selection = null; updateSelection(); fitView(); });
  $('map-mode').addEventListener('click', () => setMode('map')); $('list-mode').addEventListener('click', () => setMode('list'));
  $('close-inspector').addEventListener('click', () => { const oldSelection = state.selection; $('inspector').hidden = true; state.selection = null; updateSelection(); const parent = state.mode === 'map' ? $('nodes') : $('list-view'); parent.querySelector(`[data-node="${oldSelection}"]`)?.focus(); });
  $('search').addEventListener('input', () => { state.query = $('search').value.trim().toLowerCase(); state.moved = false; $('inspector').hidden = true; state.selection = null; render(); announce(`${visible.length} matching components`); });
  $('clear-search').addEventListener('click', () => { $('search').value = ''; state.query = ''; state.moved = false; render(); $('search').focus(); });
  $('about-button').addEventListener('click', () => $('about-dialog').showModal()); $('requested-button').addEventListener('click', () => { $('search').value = ''; state.query = ''; chooseView('requested'); });
  $('entities-button').addEventListener('click', showEntities); $('files-button').addEventListener('click', () => { renderFileIndex(); $('files-dialog').showModal(); }); $('file-search').addEventListener('input', renderFileIndex);
  $('operating-guide').addEventListener('click', (event) => { event.preventDefault(); showSource({ path: 'computer-use-runtime/docs/RUNNING.md', line: 1 }); });
  for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
  $('snapshot-label').textContent = `Code traced ${data.meta.date} · ${data.meta.head.slice(0, 8)}`;
  $('file-index-description').textContent = 'Every maintained source/configuration/protected requirement file is indexed. Inventory-only means no individual component citation, not a claim of manual review.';
  const facts = { Repository: data.meta.repository, Revision: data.meta.head, 'Implementation SHA256': data.meta.implementationSha256, 'Maintained files': data.meta.maintainedFiles, 'Traced responsibilities': data.components.length, Journeys: data.flows.length, 'Generated at': data.meta.generatedAt };
  for (const [key, value] of Object.entries(facts)) $('snapshot-details').append(create('dt', key), create('dd', String(value)));
  renderNavigation(); render();
  new ResizeObserver(() => { if (!state.moved && state.mode === 'map') fitView(); else renderMinimap(); }).observe(viewport);
})();
