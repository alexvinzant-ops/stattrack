// End-to-end test of the installable offline app (docs/, served at /pwa/ by dev/server.js).
//   node dev/offline.js [screenshotDir]      (or: npm run test:offline)
// A coach opens the app, goes offline, reloads, tracks a whole game, ends it, and comes back online.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { buildIndex } = require('../scripts/build-pwa');

const PORT = Number(process.env.PORT || 8092);
const BASE = `http://localhost:${PORT}`;
const shots = process.argv[2] || '/tmp/claude-0/-home-user-stattrack/7b4fbb64-6cfb-56af-8e63-70def6f5626f/scratchpad/shots';
fs.mkdirSync(shots, { recursive: true });
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hoops-off-')), 'data.json');

const pad = n => String(n).padStart(2, '0');
function isoDay(offset) { const d = new Date(); d.setDate(d.getDate() + offset); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

(async () => {
  // The generated copy must match a fresh build of apps-script/Index.html.
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8'), buildIndex(), 'docs/index.html is out of date: run npm run build:pwa');

  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_FILE: dataFile } });
  const coachPin = await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { const m = /coach PIN: (\d+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.stderr.on('data', d => reject(new Error(String(d))));
  });
  const api = async (action, data) => {
    const r = await fetch(BASE + '/exec', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, data, pin: coachPin }) });
    const j = await r.json();
    assert.equal(j.ok, true, action + ': ' + j.error);
    return j.result;
  };

  const browser = await chromium.launch();
  const errors = [];
  try {
    // ---- Setup through the same JSON endpoint the app uses: 2 players, a game today, a game next week.
    await api('addPlayers', { list: [{ number: '3', name: 'Ava Guard' }, { number: '23', name: 'Ben Center' }] });
    await api('saveGame', { date: isoDay(0), opponent: 'Valley', location: 'home' });
    let all = await api('saveGame', { date: isoDay(7), opponent: 'Hills', location: 'away' });
    const todayGame = all.games.find(g => g.opponent === 'Valley');
    const ava = all.players.find(p => p.name === 'Ava Guard');

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());

    // ---- First run: no app link yet, so the connect screen shows; a bad link is refused.
    await page.goto(`${BASE}/pwa/`);
    await page.waitForSelector('text=Paste your team\'s app link');
    await page.fill('input[name=url]', 'https://example.com/exec');
    await page.click('form[data-form=api] button[type=submit]');
    await page.waitForSelector('[data-api-err]:text("doesn\'t look like the team link")');

    // ---- The link check: school accounts' longer form, a pasted message, and wrong links.
    const parsed = await page.evaluate(() => [
      apiUrlFrom('https://script.google.com/a/macros/school.org/s/AKfy_cb-12/exec'),
      apiUrlFrom('https://script.google.com/macros/s/AKfy_cb-12/exec'),
      apiUrlFrom('Hi Pat!\n\nApp: https://script.google.com/a/macros/school.org/s/AKfy_cb-12/exec\nYour PIN: 4321'),
      apiUrlFrom(' https://script.google.com/macros/s/AKfy_cb-12/exec?x=1 '),
      apiUrlFrom('https://script.google.com/macros/s/AKfy_cb-12/dev'),
      apiUrlFrom('https://docs.google.com/spreadsheets/d/abc/edit'),
      apiUrlFrom('https://script.google.com/macros/s/AKfy_cb-12/execute'),
    ]);
    const short = 'https://script.google.com/macros/s/AKfy_cb-12/exec';
    assert.deepEqual(parsed, [short, short, short, short, '', '', '']);
    await page.fill('input[name=url]', 'https://script.google.com/macros/s/AKfy_cb-12/dev');
    await page.click('form[data-form=api] button[type=submit]');
    await page.waitForSelector('[data-api-err]:text("That is the test link")');

    // ---- Open with ?api=: the link is remembered and removed from the address bar.
    await page.goto(`${BASE}/pwa/?api=${encodeURIComponent(BASE + '/exec')}`);
    await page.waitForSelector('.keypad');
    assert.equal(new URL(page.url()).search, '', 'api parameter removed from the address bar');
    assert.equal(await page.evaluate(() => localStorage.getItem('gcs_api')), JSON.stringify(BASE + '/exec'));
    assert.equal(await page.evaluate(() => !!document.querySelector('link[rel=manifest]')), true, 'manifest linked');
    for (const k of coachPin) await page.click(`.keypad [data-k="${k}"]`);
    await page.click('[data-act=login]');
    await page.waitForSelector('.tabs');
    await page.click('[data-act=tab][data-tab=games]');

    // ---- Pre-download: today's game and next week's are saved on the device.
    await page.waitForSelector('.card:has-text("Valley") [data-ready]');
    await page.waitForSelector('.card:has-text("Hills") [data-ready]');
    assert.match(await page.textContent('.card:has-text("Valley") [data-ready]'), /Ready offline/);
    // The service worker has the app files and controls this page.
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
    const cached = await page.evaluate(async () => (await caches.keys()).length && (await (await caches.open((await caches.keys())[0])).keys()).map(r => new URL(r.url).pathname));
    assert.ok(cached.some(p => p.endsWith('/index.html')) && cached.some(p => p.endsWith('/manifest.webmanifest')), 'shell cached: ' + cached);
    await page.waitForTimeout(500);

    // ---- No internet: reload. The app opens from the service worker with the saved home screen.
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.tabs');
    await page.waitForSelector('[data-offline-banner]');
    assert.match(await page.textContent('[data-offline-banner]'), /Offline: showing what's saved on this device\. Stats you enter will upload when you're back on Wi-Fi\./);
    await page.click('[data-act=tab][data-tab=games]');
    await page.waitForSelector('.card:has-text("Valley") [data-ready]');
    await page.screenshot({ path: path.join(shots, '10-offline-home.png') });
    // Online-only things say so plainly.
    await page.click('[data-act=tab][data-tab=roster]');
    await page.click('[data-act=bulkPlayers]');
    await page.waitForSelector('.toast:has-text("This needs an internet connection")');
    assert.equal(await page.locator('.modal').count(), 0, 'no form opens offline');
    await page.click('[data-act=tab][data-tab=games]');

    // ---- Track the game offline.
    await page.click('.card:has-text("Valley") [data-act=openGame]');
    await page.waitForSelector('.pbtn');
    if (await page.locator('.modal').count()) await page.click('.modal button[type=submit]'); // "Who's playing?"
    const tap = async (id, code) => { await page.click(`[data-act=pickPlayer][data-id="${id}"]`); await page.click(`[data-act=stat][data-code="${code}"]`); };
    await tap(ava.id, '2M');
    await tap(ava.id, '2M');
    await tap(ava.id, 'AST');
    await page.click('[data-act=oppStat][data-code="FM"]');
    await page.click('.toast [data-act=undo]'); // Undo the opponent free throw
    await page.waitForSelector('.sync.offline');
    const waiting = Number(/Offline · (\d+) waiting/.exec(await page.textContent('.sync'))[1]);
    assert.ok(waiting >= 6, 'plays waiting: ' + waiting);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, '11-offline-tracker.png') });
    // Box score works offline.
    await page.click('[data-act=gameTab][data-tab=box]');
    await page.waitForSelector('tr.total');
    assert.match(await page.textContent('.score'), /4/, 'box score shows 4 points');
    // End the game. It is queued, not blocked.
    await page.click('[data-act=endGame]');
    await page.waitForSelector('.toast:has-text("Game ended. It will be submitted when you\'re back on Wi-Fi.")');
    const waiting2 = Number(/Offline · (\d+) waiting/.exec(await page.textContent('.sync'))[1]);
    assert.equal(waiting2, waiting + 1, 'status change queued behind the plays');
    assert.deepEqual(await page.evaluate(() => Queue.items.filter(e => e.kind === 'status').map(e => [e.gameId, e.status])), [[todayGame.id, 'final']]);
    // Nothing reached the server yet.
    assert.equal((await api('game', { gameId: todayGame.id })).game.status, 'scheduled');
    await page.screenshot({ path: path.join(shots, '12-offline-ended.png') });

    // ---- Wi-Fi returns: everything uploads, plays first, then the final.
    const sent = [];
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/exec')) { try { const b = JSON.parse(r.postData()); sent.push(b.action + (b.data && b.data.gameId ? ':' + b.data.gameId : '')); } catch (e) { /* ignore */ } } });
    await ctx.setOffline(false);
    await page.waitForSelector('.sync:text("All saved")', { timeout: 45000 });
    const lastRecord = sent.map((a, i) => a.startsWith('record:' + todayGame.id) ? i : -1).reduce((m, i) => Math.max(m, i), -1);
    const status = sent.indexOf('setStatus:' + todayGame.id);
    assert.ok(lastRecord >= 0 && status > lastRecord, 'final is sent after the last play: ' + sent.join(', '));
    const g = await api('game', { gameId: todayGame.id });
    assert.equal(g.game.status, 'final', 'game ended on the server');
    assert.equal(g.box[ava.id].FG2M, 2, 'two made 2s saved');
    assert.equal(g.box[ava.id].AST, 1, 'assist saved');
    assert.ok(!g.box['opp:team'] || !g.box['opp:team'].FTM, 'undone opponent free throw nets to nothing');
    assert.equal(await page.evaluate(() => Queue.items.length), 0);
    await page.screenshot({ path: path.join(shots, '13-back-online.png') });

    // ---- Leaving the game back online shows the refreshed home without the banner.
    await page.evaluate(() => { document.querySelector('[data-act=leaveGame]').click(); });
    await page.waitForSelector('.tabs');
    await page.waitForSelector('[data-offline-banner]', { state: 'detached' });

    // ---- A parent: same thing on their own device. Ending the game offline closes it on their side.
    all = await api('saveParent', { name: 'Pat Parent' });
    const pat = all.parents.find(p => p.name === 'Pat Parent');
    all = await api('saveGame', { date: isoDay(0), opponent: 'Rivals', location: 'away', scorerIds: [pat.id] });
    const rivals = all.games.find(g => g.opponent === 'Rivals');
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'allow' });
    const parent = await pctx.newPage();
    parent.on('pageerror', e => errors.push(e.message));
    parent.on('dialog', d => d.accept());
    await parent.goto(`${BASE}/pwa/?api=${encodeURIComponent(BASE + '/exec')}`);
    await parent.waitForSelector('.keypad');
    for (const k of String(pat.pin)) await parent.click(`.keypad [data-k="${k}"]`);
    await parent.click('[data-act=login]');
    await parent.waitForSelector('.card:has-text("Rivals") [data-ready]');
    await parent.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
    await pctx.setOffline(true);
    await parent.reload();
    await parent.waitForSelector('[data-offline-banner]');
    await parent.click('.card:has-text("Rivals") [data-act=openGame]');
    await parent.waitForSelector('.pbtn');
    if (await parent.locator('.modal').count()) await parent.click('.modal button[type=submit]');
    await parent.click(`[data-act=pickPlayer][data-id="${ava.id}"]`);
    await parent.click('[data-act=stat][data-code="3M"]');
    await parent.click('[data-act=endGame]');
    await parent.waitForSelector('.toast:has-text("Game ended. It will be submitted when you\'re back on Wi-Fi.")');
    await parent.waitForSelector('text=No games are assigned to you right now.');
    assert.equal(await parent.evaluate(id => localStorage.getItem('gcs_box_' + id), rivals.id), null, 'parent copy cleared');
    await pctx.setOffline(false);
    await parent.waitForSelector('.sync:text("All saved")', { timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 60 && (await api('game', { gameId: rivals.id })).game.status !== 'final'; i++) await new Promise(r => setTimeout(r, 1000));
    const rg = await api('game', { gameId: rivals.id });
    assert.equal(rg.game.status, 'final', 'parent game ended on the server');
    assert.equal(rg.box[ava.id].FG3M, 1, 'parent plays saved');
    await parent.screenshot({ path: path.join(shots, '14-parent-offline-done.png') });

    // ---- One-tap install link (iPhone). The coach's ⚙ Settings shows it, built from the /exec link.
    await api('saveSettings', { offlineApp: `${BASE}/pwa/` });
    const install = `${BASE}/pwa/?api=${encodeURIComponent(BASE + '/exec')}`;
    assert.equal((await api('all')).installUrl, install);
    const { devices } = require('playwright');
    const ictx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'allow' });
    const safari = await ictx.newPage();
    safari.on('pageerror', e => errors.push(e.message));
    await safari.goto(install);
    // In Safari: install steps, the team link stays in the address (the Home Screen icon opens that
    // address), and the manifest is dropped so its start_url can't replace it.
    await safari.waitForSelector('text=Add to Home Screen');
    assert.equal(safari.url(), install, 'team link kept in the address for Add to Home Screen');
    assert.equal(await safari.evaluate(() => !!document.querySelector('link[rel=manifest]')), false, 'manifest removed');
    await safari.screenshot({ path: path.join(shots, '15-ios-install.png') });
    await safari.click('[data-act=skipInstall]');
    await safari.waitForSelector('.keypad');
    // Opened from the Home Screen icon: its own empty storage, same address. Connected with no pasting.
    const hctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'allow' });
    await hctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    const home = await hctx.newPage();
    home.on('pageerror', e => errors.push(e.message));
    await home.goto(install);
    await home.waitForSelector('.keypad');
    assert.equal(new URL(home.url()).search, '', 'link hidden once installed');
    assert.equal(await home.evaluate(() => localStorage.getItem('gcs_api')), JSON.stringify(BASE + '/exec'));
    for (const k of coachPin) await home.click(`.keypad [data-k="${k}"]`);
    await home.click('[data-act=login]');
    await home.waitForSelector('.tabs');
    // Settings on this phone: the install card with the same link.
    await home.click('.gear');
    await home.waitForSelector('text=Offline app (no Wi-Fi at the gym)');
    assert.equal(await home.getAttribute('a:has-text("Open on this device")', 'href'), install);
    await home.locator('text=Offline app (no Wi-Fi at the gym)').scrollIntoViewIfNeeded();
    await home.screenshot({ path: path.join(shots, '16-settings-install.png') });
    await ictx.close(); await hctx.close();

    // ---- A copy built for one team (pwa.config.json teamLink): no link anywhere, just the PIN.
    const builtPage = buildIndex({ teamLink: BASE + '/exec' });
    const routeIndex = async c => c.route(u => /\/pwa\/(index\.html)?(\?.*)?$/.test(new URL(u).pathname + new URL(u).search), r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: builtPage }));
    const bctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await routeIndex(bctx);
    const bsafari = await bctx.newPage();
    bsafari.on('pageerror', e => errors.push(e.message));
    await bsafari.goto(`${BASE}/pwa/`);
    await bsafari.waitForSelector('text=Add to Home Screen');
    await bsafari.click('[data-act=skipInstall]');
    await bsafari.waitForSelector('.keypad');
    await bsafari.reload();
    await bsafari.waitForSelector('.keypad'); // the steps show once
    const bhctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await routeIndex(bhctx);
    await bhctx.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    const bhome = await bhctx.newPage();
    bhome.on('pageerror', e => errors.push(e.message));
    await bhome.goto(`${BASE}/pwa/`);
    await bhome.waitForSelector('.keypad');
    assert.equal(await bhome.evaluate(() => !!document.querySelector('link[rel=manifest]')), true, 'manifest linked');
    for (const k of coachPin) await bhome.click(`.keypad [data-k="${k}"]`);
    await bhome.click('[data-act=login]');
    await bhome.waitForSelector('.tabs');
    await bhome.screenshot({ path: path.join(shots, '17-built-in-team.png') });
    await bctx.close(); await bhctx.close();

    assert.deepEqual(errors, [], 'no page errors');
    console.log('offline.js: all checks passed');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
