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
    await coach.click('[data-act=editParent]:has-text("Add person")');
    await coach.fill('input[name=name]', 'Jamie (Ava’s mom)');
    await coach.fill('input[name=email]', 'jamie@example.com');
    await coach.fill('input[name=phone]', '555-123-4567');
    await coach.click('form[data-form=parent] button[type=submit]');
    // New person with contact info → invite opens right away.
    await coach.waitForSelector('text=Invite Jamie');
    assert.equal(await coach.getAttribute('a.btn:has-text("Text to (555) 123-4567")', 'href').then(h => h.startsWith('sms:5551234567?&body=')), true);
    await coach.click('[data-act=emailInvite]');
    await coach.waitForSelector('text=Email sent ✓');
    await shot(coach, '02a-invite-sent');
    await coach.click('.modal [data-act=closeModal]');
    await coach.waitForSelector('.list-item:has-text("Jamie") .chip.win');
    const parentPin = (await coach.textContent('.pin')).trim();
    // A second parent who may only view season stats.
    await coach.click('[data-act=editParent]:has-text("Add person")');
    await coach.fill('input[name=name]', 'Grandpa Joe');
    await coach.uncheck('input[name=perm_fixStats]');
    await coach.check('input[name=perm_viewStats]');
    await coach.click('form[data-form=parent] button[type=submit]');
    await coach.waitForSelector('text=Grandpa Joe');
    const viewerPin = (await coach.textContent('.list-item:has-text("Grandpa Joe") .pin')).trim();
    await coach.click('.list-item:has-text("Grandpa Joe") [data-act=editParent]');
    await shot(coach, '02b-access-edit');
    await coach.click('.modal [data-act=closeModal]');
    await shot(coach, '02-parents');
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('[data-act=bulkGames]');
    await coach.fill('textarea[name=list]', '11/10 School A, home\n12/8 @ School A\n1/4 School C, neutral, Tournament');
    await coach.click('form[data-form=bulkGames] button[type=submit]');
    await coach.waitForSelector('text=@ School A');
    const dates = await coach.evaluate(() => S.data.games.map(g => g.date + ' ' + g.location + ' ' + g.notes).sort());
    assert.deepEqual(dates, ['2026-11-10 home ', '2026-12-08 away ', '2027-01-04 neutral Tournament']);
    await coach.click('[data-act=editGame]:has-text("New game")');
    await coach.fill('input[name=opponent]', 'Valley Christian');
    await coach.fill('textarea[name=oppRoster]', '4 Smith, 12, 23');
    await coach.selectOption('select[name=scorerId]', { label: 'Jamie (Ava’s mom)' });
    await coach.click('form[data-form=game] button[type=submit]');
    await coach.waitForSelector('text=vs Valley Christian');
    await coach.click('[data-act=editGame]:has-text("New game")');
    await coach.fill('input[name=opponent]', 'Hillside');
    await coach.click('form[data-form=game] button[type=submit]');
    await coach.waitForSelector('text=vs Hillside');
    await shot(coach, '03-games');

    // A player-parent: tracks only Ava, and may see Ava's official stats.
    await coach.click('[data-act=tab][data-tab=parents]');
    await coach.click('[data-act=editParent]:has-text("Add person")');
    await coach.fill('input[name=name]', 'Pat (Ava’s dad)');
    await coach.check('input[name=perm_viewOwn]');
    await coach.check('.player-checks label:has-text("Ava Guard") input');
    await coach.click('form[data-form=parent] button[type=submit]');
    await coach.waitForSelector('.list-item:has-text("Pat (Ava’s dad)")');
    assert.match(await coach.textContent('.list-item:has-text("Pat (Ava’s dad)")'), /Tracks Ava/);
    const patPin = (await coach.textContent('.list-item:has-text("Pat (Ava’s dad)") .pin')).trim();
    await coach.click('.list-item:has-text("Jamie") [data-act=invite]');
    const invite = await coach.inputValue('#inviteText');
    assert.match(invite, new RegExp('Your PIN: ' + parentPin));
    assert.match(invite, /Valley Christian/);
    assert.match(invite, /http:\/\/localhost/);
    await shot(coach, '02c-invite');
    await coach.click('.modal [data-act=closeModal]');

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
    let score = await parent.$$eval('.score .pts', els => els.map(e => e.textContent));
    assert.deepEqual(score, ['8', '5']);

    // Opponent stats: switch sides, add a number, track individuals and the team.
    await parent.click('[data-act=side][data-side=opp]');
    assert.equal(await parent.locator('.pbtn').count(), 4, '3 numbers + TEAM');
    await parent.click('[data-act=oppRoster]');
    await parent.fill('textarea[name=roster]', '4 Smith\n12\n23\n30');
    await parent.click('form[data-form=oppRoster] button[type=submit]');
    await parent.waitForSelector('.pbtn:has(.n:text-is("#30"))');
    const oppTap = async (label, code) => {
      await parent.click(`.pbtn:has(.n:text-is("${label}"))`);
      await parent.click(`.sbtn[data-code="${code}"]`);
    };
    await oppTap('#23', '3M'); await oppTap('#30', '2X'); await oppTap('TEAM', 'TO'); await oppTap('#4', 'PF');
    await shot(parent, '04b-opponent');
    score = await parent.$$eval('.score .pts', els => els.map(e => e.textContent));
    assert.deepEqual(score, ['8', '8'], 'opponent 3 adds to their score');
    await parent.click('[data-act=side][data-side=us]');
    await tap(3, 'FM');
    await parent.waitForSelector('.sync:text("All saved")');

    await parent.click('[data-act=gameTab][data-tab=box]');
    await parent.waitForSelector('tr.total');
    await shot(parent, '05-box');
    // Fix a stat in the box score
    await parent.click('tr[data-act=editLine]:has-text("Ben Center")');
    await parent.click('[data-act=step][data-k=REB][data-d="1"]');
    await parent.click('.modal [data-act=closeModal]');
    await parent.click('[data-act=endGame]');
    await parent.waitForSelector('text=No games are assigned to you right now.');

    // ---- Player-parent keeps their own record of Ava in a live game (official game already final above,
    // so use the Hillside game).
    const pat = await newPhone();
    await pat.click('[data-act=help]');
    await pat.waitForSelector('text=How to keep stats');
    await pat.click('.modal [data-act=closeModal]');
    await typePin(pat, patPin);
    await pat.waitForSelector('text=Your player: #3 Ava Guard');
    await pat.click('.card:has-text("Hillside") [data-act=openPersonal]');
    await pat.waitForSelector('text=Your record of Ava');
    if (await pat.locator('form[data-form=whosHere]').count()) await pat.click('form[data-form=whosHere] button[type=submit]');
    assert.equal(await pat.locator('.pbtn').count(), 1, 'only Ava');
    assert.equal(await pat.locator('[data-act=side]').count(), 0, 'no opponent tracking');
    await pat.click('.pbtn'); await pat.click('.sbtn[data-code="3M"]');
    await pat.click('.pbtn'); await pat.click('.sbtn[data-code="STL"]');
    await pat.waitForSelector('.sync:text("All saved")');
    await shot(pat, '09-player-parent');

    // ---- Coach reviews
    await coach.click('[data-act=refresh]');
    await coach.click('[data-act=tab][data-tab=season]');
    await coach.waitForSelector('text=Player stats');
    const rec = await coach.textContent('.tile .value');
    assert.equal(rec.replace(/\s/g, ''), '1–0'); // 9–8
    const ben = await coach.$$eval('tr:has-text("Ben Center") td', tds => tds.map(t => t.textContent));
    // Player, GP, PTS, REB, AST, STL, BLK, TO, FG, FG%, 3P, 3P%, FT, FT%, PF
    assert.deepEqual(ben.slice(1, 9), ['1', '3.0', '2.0', '0.0', '0.0', '1.0', '0.0', '1.0-1.0']);
    await shot(coach, '06-season');
    await coach.waitForSelector('text=Us vs. opponents');
    const oppFg = await coach.$$eval('tr:has(td:text-is("FG%")) td', tds => tds.map(t => t.textContent));
    assert.deepEqual(oppFg, ['FG%', '75.0', '50.0']);
    await coach.click('[data-act=seasonMode][data-m=tot]');
    await coach.click('tr[data-act=openPlayer]:has-text("Ava Guard")');
    await coach.waitForSelector('text=Game log');
    await shot(coach, '07-player');
    await coach.click('[data-act=back]');
    await coach.click('[data-act=writeReport]');
    await coach.waitForSelector('text=Season Stats and Game Log tabs updated');

    // Read-only viewer: sees stats, can't edit or track, no Access tab.
    const viewer = await newPhone();
    await typePin(viewer, viewerPin);
    await viewer.waitForSelector('text=Player stats');
    assert.equal(await viewer.locator('[data-tab=parents]').count(), 0);
    assert.equal(await viewer.locator('[data-tab=roster]').count(), 0);
    assert.equal(await viewer.locator('text=Google Sheet').count(), 0);
    await viewer.click('[data-act=tab][data-tab=games]');
    assert.equal(await viewer.locator('[data-act=editGame]').count(), 0);
    await viewer.click('.card:has-text("Valley Christian") [data-act=openBox]');
    await viewer.waitForSelector('tr.total');
    assert.equal(await viewer.locator('tr[data-act=editLine]').count(), 0, 'read-only box score');
    assert.equal(await viewer.locator('[data-tab=track]').count(), 0);
    await shot(viewer, '08-viewer-box');

    // Coach compares Pat's record with the official stats for Hillside (official: none for Ava).
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('.card:has-text("Hillside") [data-act=openBox]');
    await coach.waitForSelector('text=Parent records');
    const diffs = await coach.locator('table.compare td.diff').count();
    assert.ok(diffs >= 3, 'PTS, FG, 3P, STL differ');
    await shot(coach, '10-parent-records');
    await coach.click('[data-act=leaveGame]');
    // Official season stats were not changed by Pat's record.
    await coach.click('[data-act=tab][data-tab=season]');
    await coach.click('[data-act=refresh]');
    const avaPts = await coach.$$eval('tr:has-text("Ava Guard") td', tds => tds[2].textContent);
    assert.equal(avaPts, '4');

    // Pat can see Ava's official stats.
    await pat.click('[data-act=leaveGame]');
    await pat.waitForSelector('text=#3 Ava Guard: official stats');
    assert.equal(await pat.locator('text=Ben Center').count(), 0, 'no other players');

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(saved['Game Log'].some(r => r[6] === 'Opponent' && r[7] === '23' && r[9] === 3), 'opponent rows exported');
    assert.equal(saved['Season Stats'][0][1], 'Player');
    assert.equal(saved['Season Stats'].length, 6, 'five players who played');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('SMOKE TEST PASSED');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
