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

test('pwa.config.json teamLink is built into the page, and checked', () => {
  const link = 'https://script.google.com/a/macros/school.org/s/AKfy_1-x/exec';
  assert.match(buildIndex({ teamLink: link }), new RegExp('<meta name="team-link" content="' + link.replace(/[.\/]/g, '\\$&') + '">'));
  assert.ok(!/<meta name="team-link"/.test(buildIndex({ teamLink: '' })));
  assert.throws(() => buildIndex({ teamLink: 'https://script.google.com/macros/s/x/dev' }), /ends in \/exec/);
  assert.throws(() => buildIndex({ teamLink: 'https://evil.example/"><script>' }), /ends in \/exec/);
  // The manifest is added by the page's script, so it can be left out for an iPhone install link.
  assert.ok(!/rel="manifest"/.test(buildIndex({ teamLink: '' })));
});
