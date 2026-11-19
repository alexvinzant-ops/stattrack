'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildIndex } = require('../scripts/build-pwa');

const docs = f => fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8');

test('docs/index.html is a fresh build of apps-script/Index.html (run npm run build:pwa)', () => {
  assert.equal(docs('index.html'), buildIndex());
});

test('PWA files: manifest, service worker, icons', () => {
  const m = JSON.parse(docs('manifest.webmanifest'));
  assert.equal(m.name, 'Team Stats');
  assert.equal(m.short_name, 'Stats');
  assert.equal(m.start_url, './');
  assert.equal(m.display, 'standalone');
  assert.deepEqual(m.icons.map(i => i.sizes), ['192x192', '512x512']);
  for (const i of m.icons) assert.deepEqual([...fs.readFileSync(path.join(__dirname, '..', 'docs', i.src)).subarray(1, 4)], [80, 78, 71]);
  const sw = docs('sw.js');
  assert.match(sw, /team-stats-[0-9a-f]{12}/);
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
  assert.match(sw, /req\.method !== 'GET'/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', '.nojekyll')));
});

test('the Apps Script page itself is untouched by the PWA tags', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Index.html'), 'utf8');
  assert.ok(!/rel="manifest"|apple-mobile-web-app|theme-color/.test(src));
});
