import fs from 'node:fs';
import crypto from 'node:crypto';

export const siteUrl = 'https://rig-os.netlify.app';
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const clean = value => String(value).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
function concise(value) {
  const text = clean(value);
  if (text.length <= 170) return text;
  const boundary = text.lastIndexOf(' ', 167);
  return text.slice(0, boundary > 110 ? boundary : 167).replace(/[,;:]$/, '') + '...';
}
function preview(file, alt) {
  const bytes = fs.readFileSync(new URL(`./public/media/${file}`, import.meta.url));
  return { url: `${siteUrl}/media/${file}?v=${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alt };
}
const sitePreview = preview('site-preview.png', 'Rig OS landing page with a source-linked overview of the local computer-use runtime.');
const mapPreview = preview('map-poster.png', 'Inside Rig OS system map showing the console, runtime, model providers, storage, and desktop adapters.');

export const homeMetadata = {
  title: 'Rig OS | Local computer-use runtime',
  description: 'Explore a local computer-use runtime with human-reviewed actions, a source-linked system map, full documentation, and recorded demos.',
  route: '/',
};
export const mapMetadata = {
  title: 'Inside Rig OS | Interactive system map',
  description: 'Explore 120 responsibilities and 22 guided journeys through Rig OS. Follow decisions, inspect exact source lines, and see how the system fits together.',
  route: '/map/',
  image: mapPreview,
};
export const docsMetadata = {
  title: 'Rig OS documentation | Setup, architecture and evidence',
  description: 'Read the full Rig OS documentation. Set up the local runtime, explore its architecture, configure providers, and check the evidence and open questions.',
  route: '/docs/',
};
export const sourceMetadata = {
  title: 'Rig OS source code | Explore the implementation',
  description: 'Browse the Rig OS source code with file search, line links, and raw downloads. Trace the local service, execution checks, providers, and saved evidence.',
  route: '/source/',
};
const documentTitles = {
  'README.md': 'Rig OS overview',
  'computer-use-runtime/README.md': 'Local runtime guide',
  'computer-use-runtime/REQUEST.md': 'Original product request',
  'computer-use-runtime/docs/completion-contract-v1/REQUEST.md': 'Original product request',
  'computer-use-runtime/docs/completion-contract-v1/USER_COMPLETION_REQUEST.md': 'User completion request',
};
const documentDescriptions = {
  'AUTHOR.md': 'Brad Clonan is a hands-on software architect and engineer building Rig OS. Open to Software Architect, Staff or Principal Engineer, and applied AI roles.',
};
export function documentMetadata(file, heading, route, description) {
  const title = clean(documentTitles[file] || heading).replace(/\brig-os\b/gi, 'Rig OS');
  const historical = file.includes('/completion-contract-v1/');
  return {
    title: `${title}${historical ? ' | Historical record' : ''} | Rig OS docs`,
    description: historical ? `Read the historical ${title.toLowerCase()} for Rig OS. This archived document preserves the original requirements and their recorded scope.` : documentDescriptions[file] || description,
    route,
  };
}
export function fileMetadata(file, route) {
  return {
    title: `${file} | Rig OS source`,
    description: `Read ${file} from the public Rig OS repository, with numbered lines, raw downloads, and links to the original source.`,
    route,
  };
}
export function metadataTags({ title, description, route, image = sitePreview }) {
  const safeTitle = escape(clean(title));
  const safeDescription = escape(concise(description));
  const canonical = escape(siteUrl + route);
  return `<title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta name="author" content="Brad Clonan">
  <meta name="theme-color" content="#0b1517">
  <link rel="canonical" href="${canonical}">
  <meta property="og:site_name" content="Rig OS">
  <meta property="og:locale" content="en_US">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${escape(image.url)}">
  <meta property="og:image:secure_url" content="${escape(image.url)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${image.width}">
  <meta property="og:image:height" content="${image.height}">
  <meta property="og:image:alt" content="${escape(image.alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  <meta name="twitter:image" content="${escape(image.url)}">
  <meta name="twitter:image:alt" content="${escape(image.alt)}">`;
}
export function applyMetadata(html, metadata) {
  return html.replace(/<head>([\s\S]*?)<\/head>/i, (_, head) => {
    const cleaned = head.replace(/\s*<title>[\s\S]*?<\/title>/gi, '')
      .replace(/\s*<meta\b[^>]*(?:name|property)=["'](?:description|author|theme-color|og:[^"']+|twitter:[^"']+)["'][^>]*>/gi, '')
      .replace(/\s*<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '');
    return `<head>${cleaned.trimEnd()}\n  ${metadataTags(metadata)}\n</head>`;
  });
}
