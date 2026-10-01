const components = {
  console: { label: 'Browser console', text: 'Review proposals, run tasks, and inspect evidence through the local Vue console.', path: 'console/App.vue' },
  providers: { label: 'Model providers', text: 'Ollama, Codex CLI, and Claude CLI produce proposals. A model cannot grant itself permission.', path: 'src/providers/selection.ts' },
  service: { label: 'Authenticated API', text: 'The local Fastify service checks authentication and request contracts before calling the shared runtime.', path: 'src/service/index.ts' },
  runtime: { label: 'Durable runtime', text: 'One execution lane owns approval, version pins, dispatch, verification, and recovery after interruption.', path: 'src/runtime/index.ts' },
  store: { label: 'SQLite + artifacts', text: 'Runs and ordered events stay in SQLite. Content-hashed artifact files preserve the evidence alongside it.', path: 'src/storage/index.ts' },
  desktop: { label: 'Desktop & browser', text: 'The router selects the owned browser, native target, or granted workspace. Dispatch still checks current state.', path: 'src/adapters/desktop.ts' },
};
document.querySelectorAll('[data-node]').forEach((button, index) => {
  button.addEventListener('click', () => {
    const item = components[button.dataset.node];
    document.querySelectorAll('[data-node]').forEach(node => {
      node.classList.toggle('active', node === button);
      node.setAttribute('aria-pressed', String(node === button));
    });
    document.querySelector('#detail-label').textContent = item.label.toUpperCase();
    document.querySelector('#detail-copy').textContent = item.text;
    const link = document.querySelector('#detail-link');
    link.href = `/source/computer-use-runtime/${item.path}/`;
    link.setAttribute('aria-label', `Read ${item.label.toLowerCase()} source`);
    document.querySelector('.architecture-preview .mono').textContent = `0${index + 1} / 06`;
  });
});
const videos = {
  tour: { file: 'rig-os-tour', poster: 'tour-poster.png', title: 'INSIDE RIG OS / GUIDED TOUR', note: 'Recorded from this documentation site. Follow a journey and open its source.', label: 'Rig OS documentation walkthrough' },
  runtime: { file: 'runtime-demo', poster: 'runtime-poster.png', title: 'RIG OS / LOCAL BROWSER TASK', note: 'Real local Vue console, Fastify service, SQLite store, and isolated Chromium fixture. No native desktop or model-generated actions in this recording.', label: 'Rig OS local browser task recording' },
};
document.querySelectorAll('[data-video]').forEach(button => button.addEventListener('click', () => {
  const item = videos[button.dataset.video];
  const video = document.querySelector('#demo-video');
  video.pause();
  video.poster = `/media/${item.poster}`;
  video.setAttribute('aria-label', item.label);
  video.querySelector('source').src = `/media/${item.file}.mp4`;
  video.querySelector('track').src = `/media/${item.file}.vtt`;
  video.load();
  document.querySelector('#video-title').textContent = item.title;
  document.querySelector('#video-note').textContent = item.note;
  document.querySelector('#video-download').href = `/media/${item.file}.mp4`;
  document.querySelector('#transcript-link').href = `/media/${item.file}-transcript.txt`;
  document.querySelectorAll('[data-video]').forEach(other => {
    other.classList.toggle('selected', other === button);
    other.setAttribute('aria-pressed', String(other === button));
  });
}));
