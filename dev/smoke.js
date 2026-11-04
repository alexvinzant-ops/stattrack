// End-to-end smoke test in a phone-sized browser (requires Playwright).
//   node dev/smoke.js [screenshotDir]
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const PORT = 8091;
const shots = process.argv[2];
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hoops-')), 'data.json');

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_FILE: dataFile } });
  const coachPin = await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { const m = /coach PIN: (\d+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.stderr.on('data', d => reject(new Error(String(d))));
  });
  const browser = await chromium.launch();
  const errors = [];
  const newPhone = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: shots ? 2 : 1, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`http://localhost:${PORT}/`);
    return page;
  };
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: false }); };
  const typePin = async (page, pin) => { for (const k of pin) await page.click(`.keypad [data-k="${k}"]`); await page.click('[data-act=login]'); };

  try {
    // ---- Coach sets up the team
    const coach = await newPhone();
    await shot(coach, '01-login');
    await typePin(coach, coachPin);
    await coach.waitForSelector('text=Welcome, Coach!');
    await coach.click('[data-act=tab][data-tab=roster]');
    await coach.click('[data-act=bulkPlayers]');
    await coach.fill('textarea[name=list]', '3 Ava Guard\n23 Ben Center\n5 Chris Wing\n11 Dev Forward\n0 Eli Point\n32 Finn Post');
    await coach.click('form[data-form=bulk] button[type=submit]');
    await coach.waitForSelector('text=Finn Post');
    await coach.click('[data-act=tab][data-tab=parents]');
    await coach.click('[data-act=editParent]:has-text("Add parent")');
    await coach.fill('input[name=name]', 'Jamie (Ava’s mom)');
    await coach.click('form[data-form=parent] button[type=submit]');
    await coach.waitForSelector('.pin');
    const parentPin = (await coach.textContent('.pin')).trim();
    await shot(coach, '02-parents');
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('[data-act=editGame]:has-text("New game")');
    await coach.fill('input[name=opponent]', 'Valley Christian');
    await coach.selectOption('select[name=scorerId]', { label: 'Jamie (Ava’s mom)' });
    await coach.click('form[data-form=game] button[type=submit]');
    await coach.waitForSelector('text=vs Valley Christian');
    await coach.click('[data-act=editGame]:has-text("New game")');
    await coach.fill('input[name=opponent]', 'Hillside');
    await coach.click('form[data-form=game] button[type=submit]');
    await coach.waitForSelector('text=vs Hillside');
    await shot(coach, '03-games');

    // ---- Parent tracks the game
    const parent = await newPhone();
    await typePin(parent, parentPin);
    await parent.waitForSelector('text=Valley Christian');
    assert.equal(await parent.locator('text=Hillside').count(), 0, 'parent only sees assigned game');
    assert.equal(await parent.locator('[data-tab=season]').count(), 0, 'parent has no season tab');
    await parent.click('[data-act=openGame]');
    await parent.waitForSelector('form[data-form=whosHere]');
    await parent.uncheck('input[name=p] >> nth=5'); // Finn is absent
    await parent.click('form[data-form=whosHere] button[type=submit]');
    const tap = async (num, code) => {
      await parent.click(`.pbtn:has(.n:text-is("#${num}"))`);
      await parent.click(`.sbtn[data-code="${code}"]`);
    };
    await tap(3, '3M'); await tap(3, '2X'); await tap(23, '2M'); await tap(23, 'REB'); await tap(5, 'AST');
    await tap(23, 'FM'); await tap(23, 'FX'); await tap(3, 'STL'); await tap(11, 'TO'); await tap(0, 'PF');
    // Stat first, then player
    await parent.click('.sbtn[data-code="BLK"]');
    await parent.click('.pbtn:has(.n:text-is("#23"))');
    // Mistake + undo
    await tap(5, '3M');
    await parent.click('.plays [data-act=undo] >> nth=0');
    await parent.click('[data-act=opp][data-d="2"]');
    await parent.click('[data-act=opp][data-d="3"]');
    assert.equal(await parent.locator('.pbtn').count(), 5, 'absent player hidden');

    // Gym Wi-Fi drops: plays are kept and sent later.
    await parent.evaluate(() => { window.__offline = true; });
    await tap(5, '2M');
    await parent.waitForSelector('.sync.offline');
    await shot(parent, '04-tracker');
    await parent.evaluate(() => { window.__offline = false; Queue.delay = 100; Queue.flush(); });
    await parent.waitForSelector('.sync:text("All saved")');
    const score = await parent.$$eval('.score .pts', els => els.map(e => e.textContent));
    assert.deepEqual(score, ['8', '5']);

    await parent.click('[data-act=gameTab][data-tab=box]');
    await parent.waitForSelector('tr.total');
    await shot(parent, '05-box');
    // Fix a stat in the box score
    await parent.click('tr[data-act=editLine]:has-text("Ben Center")');
    await parent.click('[data-act=step][data-k=REB][data-d="1"]');
    await parent.click('.modal [data-act=closeModal]');
    await parent.click('[data-act=endGame]');
    await parent.waitForSelector('text=No games are assigned to you right now.');

    // ---- Coach reviews
    await coach.click('[data-act=refresh]');
    await coach.click('[data-act=tab][data-tab=season]');
    await coach.waitForSelector('text=Player stats');
    const rec = await coach.textContent('.tile .value');
    assert.equal(rec.replace(/\s/g, ''), '1–0');
    const ben = await coach.$$eval('tr:has-text("Ben Center") td', tds => tds.map(t => t.textContent));
    // Player, GP, PTS, REB, AST, STL, BLK, TO, FG, FG%, 3P, 3P%, FT, FT%, PF
    assert.deepEqual(ben.slice(1, 9), ['1', '3.0', '2.0', '0.0', '0.0', '1.0', '0.0', '1.0-1.0']);
    await shot(coach, '06-season');
    await coach.click('[data-act=seasonMode][data-m=tot]');
    await coach.click('tr[data-act=openPlayer]:has-text("Ava Guard")');
    await coach.waitForSelector('text=Game log');
    await shot(coach, '07-player');
    await coach.click('[data-act=back]');
    await coach.click('[data-act=writeReport]');
    await coach.waitForSelector('text=Season Stats and Game Log tabs updated');

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved['Season Stats'][0][1], 'Player');
    assert.equal(saved['Season Stats'].length, 6, 'five players who played');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('SMOKE TEST PASSED');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
