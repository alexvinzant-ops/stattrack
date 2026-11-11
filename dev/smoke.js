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
    // A second parent who may see the whole team afterwards, but only rebounds and assists.
    await coach.click('[data-act=editParent]:has-text("Add person")');
    await coach.fill('input[name=name]', 'Grandpa Joe');
    assert.equal(await coach.isChecked('input[name=see][value=none]'), true, 'sees nothing by default');
    await coach.uncheck('input[name=fixStats]');
    await coach.check('input[name=see][value=team]');
    await coach.click('[data-act=checkAll][data-name=vg][data-on=""]');
    await coach.check('input[name=vg][value=reb]');
    await coach.check('input[name=vg][value=ast]');
    await coach.click('form[data-form=parent] button[type=submit]');
    await coach.waitForSelector('text=Grandpa Joe');
    assert.match(await coach.textContent('.list-item:has-text("Grandpa Joe")'), /After games: sees whole team \(Rebounds, Assists\)/);
    assert.match(await coach.textContent('.list-item:has-text("Jamie")'), /After games: sees nothing/);
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
    await coach.check('.modal .player-checks label:has-text("Jamie") input');
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
    await coach.check('.player-checks label:has-text("Ava Guard") input');
    await coach.check('input[name=see][value=own]');
    // Pat only enters scoring and steals.
    await coach.click('[data-act=checkAll][data-name=tg][data-on=""]');
    await coach.check('input[name=tg][value=scoring]');
    await coach.check('input[name=tg][value=stl]');
    await coach.click('form[data-form=parent] button[type=submit]');
    await coach.waitForSelector('.list-item:has-text("Pat (Ava’s dad)")');
    assert.match(await coach.textContent('.list-item:has-text("Pat (Ava’s dad)")'), /Own record of: Ava/);
    assert.match(await coach.textContent('.list-item:has-text("Pat (Ava’s dad)")'), /Points & shooting, Steals/);
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
    await tap(3, '3M'); await tap(3, '2X'); await tap(23, '2M'); await tap(23, 'DREB'); await tap(5, 'AST');
    await tap(23, 'FM'); await tap(23, 'FX'); await tap(3, 'STL'); await tap(11, 'TO'); await tap(0, 'PF');
    // Stat first, then player
    await parent.click('.sbtn[data-code="BLK"]');
    await parent.click('.pbtn:has(.n:text-is("#23"))');
    // Mistake + undo
    await tap(5, '3M');
    await parent.click('.plays [data-act=undo] >> nth=0');
    await parent.click('[data-act=oppStat][data-code="2M"]');
    await parent.click('[data-act=oppStat][data-code="3M"]');
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

    // Opponent stats: add a number via the Player select, track individuals and the team.
    assert.equal(await parent.locator('.pbtn').count(), 5, 'only our players are tiles');
    assert.equal(await parent.locator('[data-act=side]').count(), 0, 'no side toggle');
    assert.equal(await parent.locator('.panel.opp select[data-oppsel] option').count(), 5, 'Team + 3 numbers + Add numbers');
    await parent.selectOption('select[data-oppsel]', '__add');
    await parent.fill('textarea[name=roster]', '4 Smith\n12\n23\n30');
    await parent.click('form[data-form=oppRoster] button[type=submit]');
    await parent.waitForSelector('select[data-oppsel] option[value="opp:30"]', { state: 'attached' });
    const oppTap = async (pid, code) => {
      await parent.selectOption('select[data-oppsel]', pid);
      await parent.click(`[data-act=oppStat][data-code="${code}"]`);
    };
    await oppTap('opp:23', '3M'); await oppTap('opp:30', '2X'); await oppTap('opp:team', 'TO'); await oppTap('opp:4', 'PF');
    await shot(parent, '04b-opponent');
    score = await parent.$$eval('.score .pts', els => els.map(e => e.textContent));
    assert.deepEqual(score, ['8', '8'], 'opponent 3 adds to their score');
    assert.equal(await parent.inputValue('select[data-oppsel]'), 'opp:team', 'selection resets after a tap');
    await tap(3, 'FM');
    await parent.waitForSelector('.sync:text("All saved")');

    // Second quarter
    await parent.click('[data-act=period][data-n="2"]');
    await parent.waitForSelector('.period-seg button.on:text-is("Q2")');
    await tap(5, '2M');
    await tap(0, 'PF');
    assert.match(await parent.textContent('.team-fouls'), /Q2: .* 1/);
    // Overtime: OT, then 2OT appears.
    await parent.click('[data-act=period][data-n="5"]');
    await parent.waitForSelector('[data-act=period][data-n="6"]:text-is("2OT")');
    await tap(11, 'DREB');
    await tap(0, 'PF');
    await parent.waitForSelector('.alert:has-text("Eli: 3 fouls")');
    await parent.waitForSelector('.end-game');
    await shot(parent, '04c-quarters');
    await parent.waitForSelector('.sync:text("All saved")');
    await parent.click('[data-act=gameTab][data-tab=box]');
    await parent.waitForSelector('tr.total');
    const byQ = await parent.$$eval('.card:has(h2:text-is("By quarter")) tbody tr', trs => trs.map(tr => Array.from(tr.cells).map(c => c.textContent)));
    assert.deepEqual(byQ[0].slice(1), ['9', '2', '0', '0', '0', '11'], 'Q1-Q4, OT, total');
    assert.deepEqual(byQ[1].slice(1), ['8', '0', '0', '0', '0', '8']);
    // Overtime-only box score: just Dev's rebound.
    await parent.click('[data-act=boxFilter][data-f=ot]');
    const otRows = await parent.$$eval('.card:has(.box-filter) tbody tr:not(.total) td:first-child', tds => tds.map(t => t.textContent));
    assert.deepEqual(otRows, ['#0Eli Point', '#11Dev Forward']);
    await shot(parent, '05b-ot-box');
    await parent.click('[data-act=boxFilter][data-f=all]');
    await shot(parent, '05-box');
    // Fix a stat in the box score, in the quarter it belongs to (we're in OT now, the miss was in Q1).
    await parent.click('tr[data-act=editLine]:has-text("Ben Center")');
    await parent.waitForSelector('.modal [data-act=editScope].on:text-is("OT")');
    await parent.click('.modal [data-act=editScope][data-n="1"]');
    await parent.waitForSelector('text=Numbers below are for Q1');
    await parent.click('[data-act=step][data-k=DREB][data-d="1"]');
    await shot(parent, '05c-fix-quarter');
    await parent.click('.modal [data-act=closeModal]');
    const benQ1 = await parent.evaluate(() => { const b = S.t.players.find(p => p.name === 'Ben Center'); return S.t.periodBoxes[1][b.id].DREB; });
    assert.equal(benQ1, 2, 'fix landed in Q1');
    assert.equal(await parent.evaluate(() => Object.keys(S.t.periodBoxes[5]).length), 2, 'OT untouched (Eli + Dev only)');

    // Full play-by-play: undo an old Q1 play from the list.
    await parent.click('[data-act=gameTab][data-tab=track]');
    await parent.click('[data-act=allPlays]');
    await parent.waitForSelector('.modal .section-title:text-is("Q1")');
    await shot(parent, '05d-all-plays');
    const before = await parent.textContent('.score .pts');
    // Undo Ava's 2PT miss in Q1 (no score change) and check it's marked undone.
    const missRow = parent.locator('.modal .list-item:has-text("Ava Guard · 2PT miss")');
    await missRow.locator('[data-act=undo]').click();
    await parent.waitForSelector('.modal .list-item.undone:has-text("Ava Guard · 2PT miss")');
    assert.equal(await parent.textContent('.score .pts'), before);
    await parent.click('.modal [data-act=closeModal]');
    await parent.click('[data-act=gameTab][data-tab=box]');
    await parent.waitForSelector('.sync:text("All saved")');
    // Live bench view: the coach's open box score updates by itself while the parent taps.
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('.card:has-text("Valley Christian") [data-act=openBox]');
    await coach.waitForSelector('text=Live: updates automatically');
    await parent.click('[data-act=gameTab][data-tab=track]');
    await tap(11, 'AST');
    await parent.waitForSelector('.sync:text("All saved")');
    await coach.waitForFunction(() => {
      const dev = S.t && S.t.players.find(p => p.name === 'Dev Forward');
      return dev && (S.t.box[dev.id] || {}).AST === 1;
    }, null, { timeout: 20000 });
    await coach.waitForSelector('.alert:has-text("Eli: 3 fouls")');
    await shot(coach, '05e-live-bench');
    await coach.click('[data-act=leaveGame]');
    await parent.click('[data-act=gameTab][data-tab=box]');
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
    assert.equal(await pat.locator('.panel.opp, [data-act=oppStat]').count(), 0, 'no opponent tracking');
    assert.equal(await pat.locator('.sbtn[data-code=DREB]').count(), 0, 'only the stats the coach allowed');
    assert.equal(await pat.locator('.sbtn').count(), 7, '6 shooting buttons + STL');
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
    // GP, PTS, REB, OREB, DREB, AST, STL, BLK, TO, FG
    assert.deepEqual(ben.slice(1, 11), ['1', '3.0', '2.0', '0.0', '2.0', '0.0', '0.0', '1.0', '0.0', '1.0-1.0']);
    await shot(coach, '06-season');
    await coach.waitForSelector('text=Us vs. opponents');
    const oppFg = await coach.$$eval('tr:has(td:text-is("FG%")) td', tds => tds.map(t => t.textContent));
    assert.deepEqual(oppFg, ['FG%', '100.0', '75.0']); // opp 3-4: team +2 and +3 now count as made shots
    // Printable box score (coach only).
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('.card:has-text("Valley Christian") [data-act=openBox]');
    await coach.click('[data-act=printBox]');
    await coach.waitForSelector('.print-page h1');
    assert.equal(await coach.textContent('.print-page h1'), 'My Team 11, Valley Christian 8');
    assert.equal(await coach.locator('.print-page table.pt').count(), 3, 'quarters + both teams');
    assert.equal(await coach.isVisible('#app'), false, 'only the printable page shows');
    await shot(coach, '06b-print');
    await coach.click('[data-act=closePrint]');
    await coach.click('[data-act=leaveGame]');
    await coach.click('[data-act=tab][data-tab=season]');
    await coach.click('[data-act=seasonMode][data-m=tot]');
    // Coach keeps stats for a second game so Ava has a trend.
    await coach.click('[data-act=tab][data-tab=games]');
    await coach.click('.card:has-text("Hillside") [data-act=openGame]');
    await coach.waitForSelector('form[data-form=whosHere]');
    await coach.click('form[data-form=whosHere] button[type=submit]');
    await coach.click('.pbtn:has(.n:text-is("#3"))'); await coach.click('.sbtn[data-code="2M"]');
    await coach.click('.pbtn:has(.n:text-is("#3"))'); await coach.click('.sbtn[data-code="FM"]');
    await coach.waitForSelector('.sync:text("All saved")');
    await coach.click('[data-act=leaveGame]');
    await coach.click('[data-act=tab][data-tab=season]');
    await coach.click('tr[data-act=openPlayer]:has-text("Ava Guard")');
    await coach.waitForSelector('text=Game log');
    assert.equal(await coach.locator('svg.trend rect.bar').count(), 2, 'one bar per game');
    assert.deepEqual(await coach.$$eval('svg.trend .tv', ts => ts.map(t => t.textContent)), ['4', '3']);
    await coach.click('[data-act=trendStat][data-k=ftp]');
    assert.deepEqual(await coach.$$eval('svg.trend .tv', ts => ts.map(t => t.textContent)), ['100%', '100%']);
    await coach.click('[data-act=trendStat][data-k=pts]');
    await shot(coach, '07-player');
    await coach.click('[data-act=back]');
    await coach.click('[data-act=writeReport]');
    await coach.waitForSelector('text=Season Stats and Game Log tabs updated');

    // Read-only viewer: sees stats, can't edit or track, no Access tab.
    const viewer = await newPhone();
    await typePin(viewer, viewerPin);
    await viewer.waitForSelector('text=Player stats');
    const vHead = await viewer.$$eval('.card:has-text("Player stats") th', ths => ths.map(t => t.textContent.replace(/[▾▴]/, '').trim()));
    assert.deepEqual(vHead, ['Player', 'GP', 'REB', 'OREB', 'DREB', 'AST'], 'only rebounds and assists');
    assert.equal(await viewer.locator('.tile:has-text("Record")').count(), 0, 'no scoring = no record/points');
    await shot(viewer, '07b-viewer-season');
    assert.equal(await viewer.locator('[data-tab=parents]').count(), 0);
    assert.equal(await viewer.locator('[data-tab=roster]').count(), 0);
    assert.equal(await viewer.locator('text=Google Sheet').count(), 0);
    await viewer.click('[data-act=tab][data-tab=games]');
    assert.equal(await viewer.locator('[data-act=editGame]').count(), 0);
    await viewer.click('.card:has-text("Valley Christian") [data-act=openBox]');
    await viewer.waitForSelector('tr.total');
    const bHead = await viewer.$$eval('.card:has(tr.total) th', ths => ths.map(t => t.textContent));
    assert.deepEqual(bHead.slice(0, 5), ['Player', 'REB', 'OR', 'DR', 'AST']);
    assert.equal(await viewer.textContent('.score .pts'), '–');
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
    assert.equal(avaPts, '7'); // 4 + 3 official; Pat's separate record (3 more) is not counted

    // Pat can see Ava's official stats.
    await pat.click('[data-act=leaveGame]');
    await pat.waitForSelector('text=#3 Ava Guard: official stats');
    assert.equal(await pat.locator('text=Ben Center').count(), 0, 'no other players');

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(saved['Game Log'].some(r => r[6] === 'Opponent' && r[7] === '23' && r[9] === 3), 'opponent rows exported');
    assert.equal(saved['Season Stats'][0][1], 'Player');
    assert.equal(saved['Season Stats'].length, 7, 'six players who played (Finn played the second game)');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('SMOKE TEST PASSED');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
