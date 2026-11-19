// Builds the installable offline app into docs/ (served by GitHub Pages).
//   npm run build:pwa
// docs/index.html is apps-script/Index.html plus the PWA head tags, so it can't drift from the original.
// Everything written here is deterministic: running it twice changes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const NAVY = [0x12, 0x26, 0x4d];
const THEME = '#1c3d8c';
const BACKGROUND = '#eef1f6';

const HEAD_TAGS = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Stats">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="theme-color" content="' + THEME + '">',
].join('\n');

function buildIndex() {
  const src = fs.readFileSync(path.join(ROOT, 'apps-script', 'Index.html'), 'utf8');
  if (src.split('</head>').length !== 2) throw new Error('Index.html must contain exactly one </head>');
  return src.replace('</head>', HEAD_TAGS + '\n</head>');
}

// --- A tiny PNG encoder (node core only) and a basketball drawn with it -------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Navy square with an orange ball and black seams, kept inside the middle 60% so it survives round masks.
function ballIcon(size) {
  const px = Buffer.alloc(size * size * 3);
  const c = size / 2, R = size * 0.3, seam = Math.max(1.2, size * 0.011), SS = 4;
  const ORANGE = [0xe8, 0x7a, 0x2c], SEAM = [0x1b, 0x14, 0x10];
  // Side seams: arcs of circles centred outside the ball (left and right), bulging toward the middle.
  const d = 1.2536 * R, arc = 0.9036 * R;
  const sample = (x, y) => {
    const dx = x - c, dy = y - c;
    if (dx * dx + dy * dy > R * R) return NAVY;
    const onSeam = Math.abs(dx) < seam || Math.abs(dy) < seam ||
      Math.abs(Math.hypot(dx - d, dy) - arc) < seam || Math.abs(Math.hypot(dx + d, dy) - arc) < seam ||
      Math.abs(Math.hypot(dx, dy) - R) < seam * 1.3;
    return onSeam ? SEAM : ORANGE;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const s = sample(x + (i + 0.5) / SS, y + (j + 0.5) / SS);
      r += s[0]; g += s[1]; b += s[2];
    }
    const o = (y * size + x) * 3, n = SS * SS;
    px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n);
  }
  return encodePng(size, px);
}

function build() {
  fs.mkdirSync(DOCS, { recursive: true });
  const files = {
    'index.html': Buffer.from(buildIndex(), 'utf8'),
    'icon-192.png': ballIcon(192),
    'icon-512.png': ballIcon(512),
    'apple-touch-icon.png': ballIcon(180),
    'manifest.webmanifest': Buffer.from(JSON.stringify({
      name: 'Team Stats',
      short_name: 'Stats',
      description: 'Basketball stat tracker that works with no internet.',
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'any',
      theme_color: THEME,
      background_color: BACKGROUND,
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }, null, 2) + '\n'),
  };
  // Cache name = hash of everything the worker caches, so any change ships as a new version.
  const template = fs.readFileSync(path.join(__dirname, 'sw.template.js'), 'utf8');
  const hash = crypto.createHash('sha256');
  Object.keys(files).sort().forEach(k => { hash.update(k); hash.update(files[k]); });
  hash.update(template);
  files['sw.js'] = Buffer.from(template.replace('__VERSION__', hash.digest('hex').slice(0, 12)), 'utf8');
  files['.nojekyll'] = Buffer.alloc(0);
  Object.keys(files).forEach(k => fs.writeFileSync(path.join(DOCS, k), files[k]));
  return files;
}

if (require.main === module) {
  const files = build();
  console.log('Wrote docs/: ' + Object.keys(files).sort().join(', '));
}
module.exports = { build, buildIndex };
