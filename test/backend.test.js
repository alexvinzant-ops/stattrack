'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas } = require('../dev/gas-mock');

function setup() {
  const gas = createGas();
  gas.context.setup();
  const settings = gas.sheets.Settings.data;
  const coachPin = settings.find(r => r[0] === 'Coach PIN')[1];
  const call = (pin, action, data) => gas.api({ pin, action, data });
  const coach = (action, data) => call(coachPin, action, data);
  return { gas, coachPin, call, coach };
}

let n = 0;
const ev = (playerId, stat, delta = 1) => ({ id: 'e' + (++n), playerId, stat, delta, time: new Date().toISOString() });

function seed(t) {
  let all = t.coach('addPlayers', { list: [{ number: '3', name: 'Ava Guard' }, { number: '23', name: 'Ben Center' }] });
  all = t.coach('saveParent', { name: 'Pat Parent' });
  all = t.coach('saveParent', { name: 'Sam Other' });
  const [pat, sam] = all.parents;
  all = t.coach('saveGame', { date: '2026-11-14', opponent: 'Valley', location: 'home', scorerId: pat.id });
  all = t.coach('saveGame', { date: '2026-11-21', opponent: 'Hills', location: 'away', scorerId: sam.id });
  const [g1, g2] = all.games;
  const [ava, ben] = all.players;
  return { pat, sam, g1, g2, ava, ben };
}

test('setup creates tabs and a 6-digit coach PIN', () => {
  const t = setup();
  for (const name of ['Settings', 'Players', 'Parents', 'Games', 'Events']) assert.ok(t.gas.sheets[name], name);
  assert.match(String(t.coachPin), /^[1-9]\d{5}$/);
  assert.equal(t.coach('me').role, 'coach');
});

test('wrong or missing PIN is rejected', () => {
  const t = setup();
  assert.throws(() => t.call('', 'me'), /AUTH/);
  assert.throws(() => t.call('000', 'me'), /AUTH/);
});

test('parents get a PIN, can sign in, and are not allowed coach actions', () => {
  const t = setup();
  const { pat } = seed(t);
  assert.match(pat.pin, /^[1-9]\d{3}$/);
  assert.deepEqual(t.call(pat.pin, 'me'), {
    role: 'scorer', id: pat.id, name: 'Pat Parent', teamName: "GCS Boys' Basketball",
    perms: { trackAny: false, fixStats: true, viewStats: false, manage: false, viewOwn: false },
    players: [],
  });
  assert.throws(() => t.call(pat.pin, 'all'), /Only the coach/);
  assert.throws(() => t.call(pat.pin, 'savePlayer', { name: 'X' }), /Only the coach/);
  assert.throws(() => t.call(pat.pin, 'writeReport', { sheets: {} }), /Only the coach/);
});

test('a parent only sees and records their own, non-final games', () => {
  const t = setup();
  const { pat, g1, g2, ava } = seed(t);
  const home = t.call(pat.pin, 'scorerHome');
  assert.deepEqual(home.games.map(g => g.id), [g1.id]);
  assert.equal(home.boxes, undefined);
  assert.ok(t.call(pat.pin, 'game', { gameId: g1.id }).game);
  assert.throws(() => t.call(pat.pin, 'game', { gameId: g2.id }), /isn't assigned/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g2.id, events: [ev(ava.id, 'REB')] }), /isn't assigned/);

  t.call(pat.pin, 'setStatus', { gameId: g1.id, status: 'final' });
  assert.equal(t.call(pat.pin, 'scorerHome').games.length, 0);
  assert.throws(() => t.call(pat.pin, 'game', { gameId: g1.id }), /final/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'REB')] }), /final/);
  // Coach can still fix a final game.
  assert.equal(t.coach('record', { gameId: g1.id, events: [ev(ava.id, 'REB')] }).saved, 1);
});

test('recording builds the box score, and retries are not double counted', () => {
  const t = setup();
  const { pat, g1, ava, ben } = seed(t);
  const batch = [
    ev(ava.id, 'GP'), ev(ben.id, 'GP'),
    ev(ava.id, 'FG3M'), ev(ava.id, 'FG3A'),
    ev(ava.id, 'FG2A'),
    ev(ben.id, 'FG2M'), ev(ben.id, 'FG2A'),
    ev(ben.id, 'FTM'), ev(ben.id, 'FTA'), ev(ben.id, 'FTA'),
    ev(ben.id, 'REB'), ev(ava.id, 'AST'), ev(ava.id, 'TO'),
    ev('', 'OPP', 3),
  ];
  assert.equal(t.call(pat.pin, 'record', { gameId: g1.id, events: batch }).saved, batch.length);
  assert.equal(t.call(pat.pin, 'record', { gameId: g1.id, events: batch }).saved, 0, 'retry is idempotent');
  // Undo = negative delta.
  t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'TO', -1)] });

  const { box, game } = t.call(pat.pin, 'game', { gameId: g1.id });
  assert.equal(game.status, 'live', 'first play moves game to live');
  assert.deepEqual(box[ava.id], { GP: 1, FG3M: 1, FG3A: 1, FG2A: 1, AST: 1, TO: 0 });
  assert.deepEqual(box[ben.id], { GP: 1, FG2M: 1, FG2A: 1, FTM: 1, FTA: 2, REB: 1 });
  assert.deepEqual(box._team, { OPP: 3 });

  const all = t.coach('all');
  assert.equal(all.boxes[g1.id][ava.id].FG3M, 1);
  assert.ok(t.gas.sheets.Events.data.slice(1).every(r => r[6] === 'Pat Parent'), 'events record who entered them');
});

test('bad plays are rejected', () => {
  const t = setup();
  const { pat, g1, ava } = seed(t);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'DUNK')] }), /Unknown stat/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev('nobody', 'REB')] }), /Unknown player/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'REB', 50)] }), /Bad stat/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'REB', 1.5)] }), /Bad stat/);
});

test('deleting a game removes its events; deleting a player with stats only deactivates', () => {
  const t = setup();
  const { g1, g2, ava, ben } = seed(t);
  t.coach('record', { gameId: g1.id, events: [ev(ava.id, 'REB')] });
  t.coach('record', { gameId: g2.id, events: [ev(ava.id, 'AST')] });
  let all = t.coach('deleteGame', { id: g1.id });
  assert.deepEqual(Object.keys(all.boxes), [g2.id]);
  assert.equal(all.games.length, 1);

  all = t.coach('deletePlayer', { id: ava.id });
  assert.equal(all.players.find(p => p.id === ava.id).active, false);
  all = t.coach('deletePlayer', { id: ben.id });
  assert.equal(all.players.find(p => p.id === ben.id), undefined);
});

test('removing a parent unassigns their games and their PIN stops working', () => {
  const t = setup();
  const { pat, g1 } = seed(t);
  const all = t.coach('deleteParent', { id: pat.id });
  assert.equal(all.games.find(g => g.id === g1.id).scorerId, '');
  assert.throws(() => t.call(pat.pin, 'me'), /AUTH/);
});

test('new PIN for a parent replaces the old one', () => {
  const t = setup();
  const { pat } = seed(t);
  const all = t.coach('saveParent', { id: pat.id, name: pat.name, newPin: true });
  const updated = all.parents.find(p => p.id === pat.id);
  assert.notEqual(updated.pin, pat.pin);
  assert.throws(() => t.call(pat.pin, 'me'), /AUTH/);
  assert.equal(t.call(updated.pin, 'me').role, 'scorer');
});

test('repeated wrong PINs lock out sign-in for a while', () => {
  const t = setup();
  for (let i = 0; i < 30; i++) assert.throws(() => t.call('1', 'me'), /didn't work/);
  assert.throws(() => t.coach('me'), /Too many/);
});

test('writeReport only writes the allowed report tabs', () => {
  const t = setup();
  t.coach('writeReport', { sheets: { 'Season Stats': [['Player', 'PTS'], ['Ava', 10]] } });
  assert.deepEqual(t.gas.sheets['Season Stats'].data, [['Player', 'PTS'], ['Ava', 10]]);
  assert.throws(() => t.coach('writeReport', { sheets: { Settings: [['x']] } }), /Unknown report/);
  // Formula-looking text is neutralized.
  t.coach('writeReport', { sheets: { 'Game Log': [['=IMPORTDATA("x")']] } });
  assert.equal(t.gas.sheets['Game Log'].data[0][0], 'IMPORTDATA("x")');
});

test('PIN typed into the sheet as a number still works', () => {
  const t = setup();
  const row = t.gas.sheets.Settings.data.find(r => r[0] === 'Coach PIN');
  row[1] = 424242;
  assert.equal(t.call('424242', 'me').role, 'coach');
});

test('coach decides what each parent can do', () => {
  const t = setup();
  const { pat, sam, g1, g2, ava } = seed(t);
  const grant = (p, perms) => t.coach('saveParent', { id: p.id, name: p.name, perms });

  // Defaults: no season stats; box-score fixes allowed.
  assert.throws(() => t.call(pat.pin, 'all'), /Only the coach/);
  t.call(pat.pin, 'record', { gameId: g1.id, events: [{ ...ev(ava.id, 'REB'), fix: true }] });

  // Turn off box-score fixes: taps still work, fixes don't.
  grant(pat, { fixStats: false });
  assert.equal(t.call(pat.pin, 'game', { gameId: g1.id }).canFix, false);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [{ ...ev(ava.id, 'REB'), fix: true }] }), /permission/);
  assert.equal(t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'REB')] }).saved, 1);

  // Track any game.
  grant(pat, { trackAny: true });
  assert.deepEqual(t.call(pat.pin, 'scorerHome').games.map(g => g.id).sort(), [g1.id, g2.id].sort());
  assert.equal(t.call(pat.pin, 'record', { gameId: g2.id, events: [ev(ava.id, 'AST')] }).saved, 1);

  // Read-only season stats: can see everything except PINs, can't edit.
  grant(sam, { viewStats: true });
  const seen = t.call(sam.pin, 'all');
  assert.ok(seen.boxes[g1.id]);
  assert.equal(seen.parents[0].pin, undefined, 'PINs stay coach-only');
  assert.equal(seen.appUrl, '');
  assert.throws(() => t.call(sam.pin, 'savePlayer', { name: 'X' }), /Only the coach/);
  t.coach('setStatus', { gameId: g1.id, status: 'final' });
  const box = t.call(sam.pin, 'game', { gameId: g1.id });
  assert.equal(box.canTrack, false, 'viewer opens final game read-only');
  assert.throws(() => t.call(sam.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'AST')] }), /final/);

  // Assistant coach: manage roster & games, but never people/PINs.
  grant(sam, { manage: true });
  assert.equal(t.call(sam.pin, 'savePlayer', { name: 'New Kid', number: '9' }).players.length, 3);
  assert.equal(t.call(sam.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'AST')] }).saved, 1, 'can fix final games');
  assert.throws(() => t.call(sam.pin, 'saveParent', { name: 'Y' }), /Only the coach/);
  assert.throws(() => t.call(sam.pin, 'deleteGame', { id: g1.id }), /Only the coach/);
});

test('opponent players are tracked by number per game', () => {
  const t = setup();
  const { pat, g1 } = seed(t);
  const r = t.call(pat.pin, 'setOppRoster', { gameId: g1.id, roster: '4 Smith, #12, 23 Jones\n12 dup, x' });
  assert.deepEqual(r.oppRoster, [{ number: '4', name: 'Smith' }, { number: '12', name: '' }, { number: '23', name: 'Jones' }]);
  t.call(pat.pin, 'record', { gameId: g1.id, events: [ev('opp:23', 'FG3M'), ev('opp:23', 'FG3A'), ev('opp:team', 'TO'), ev('opp:4', 'PF')] });
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev('opp:abc', 'REB')] }), /Unknown player/);
  assert.throws(() => t.call(pat.pin, 'record', { gameId: g1.id, events: [ev('opp:4', 'GP')] }), /Bad stat/);
  const g = t.call(pat.pin, 'game', { gameId: g1.id });
  assert.equal(g.game.oppRoster.length, 3);
  assert.deepEqual(g.box['opp:23'], { FG3M: 1, FG3A: 1 });
  assert.deepEqual(g.box['opp:team'], { TO: 1 });
  // Coach can also set it from the game form.
  const all = t.coach('saveGame', { ...g.game, oppRoster: [{ number: '7', name: 'Lee' }] });
  assert.deepEqual(all.games.find(x => x.id === g1.id).oppRoster, [{ number: '7', name: 'Lee' }]);
});

test('older spreadsheets get the new columns added', () => {
  const gas = createGas();
  gas.context.setup();
  // Simulate the first version's Parents/Games headers.
  gas.sheets.Parents.data[0] = ['ID', 'Name', 'PIN', 'Active'];
  gas.sheets.Parents.data.push(['U1', 'Old Parent', '5555', true]);
  gas.sheets.Games.data[0] = ['ID', 'Date', 'Opponent', 'Location', 'Scorer ID', 'Status', 'Notes'];
  // A new execution of the new code against the same spreadsheet.
  const again = createGas();
  for (const k of Object.keys(gas.sheets)) again.sheets[k] = gas.sheets[k];
  again.context.setup();
  assert.deepEqual(gas.sheets.Parents.data[0].slice(4), ['Track Any', 'Fix Stats', 'View Stats', 'Manage', 'Players', 'See Own Players']);
  assert.equal(gas.sheets.Events.data[0][7], 'Book');
  assert.equal(gas.sheets.Games.data[0][7], 'Opp Roster');
  const me = again.api({ pin: '5555', action: 'me' });
  assert.deepEqual(me.perms, { trackAny: false, fixStats: true, viewStats: false, manage: false, viewOwn: false });
});

test('coach can add many games at once', () => {
  const t = setup();
  const all = t.coach('addGames', { list: [
    { date: '2026-11-10', opponent: 'School A', location: 'home' },
    { date: '2026-11-12', opponent: 'School B', location: 'neutral', notes: 'Tournament' },
  ] });
  assert.deepEqual(all.games.map(g => [g.date, g.opponent, g.location, g.status, g.notes]), [
    ['2026-11-10', 'School A', 'home', 'scheduled', ''],
    ['2026-11-12', 'School B', 'neutral', 'scheduled', 'Tournament'],
  ]);
  assert.throws(() => t.coach('addGames', { list: [{ date: 'soon', opponent: 'X' }] }), /date/);
});

test('player-parents keep their own record without touching official stats', () => {
  const t = setup();
  const { pat, sam, g1, g2, ava, ben } = seed(t);
  // Sam is assigned to Ava only, and may see her stats.
  let all = t.coach('saveParent', { id: sam.id, name: sam.name, players: [ava.id, 'bogus'], perms: { viewOwn: true } });
  assert.deepEqual(all.parents.find(p => p.id === sam.id).players, [ava.id]);

  const home = t.call(sam.pin, 'scorerHome');
  assert.deepEqual(home.myPlayers.map(p => p.id), [ava.id]);
  assert.deepEqual(home.playerGames.map(g => g.id).sort(), [g1.id, g2.id].sort(), 'any non-final game');
  assert.deepEqual(home.games.map(g => g.id), [g2.id], 'still keeps team stats for their assigned game');

  // Pat keeps the official team stats for game 1; Sam keeps a personal record of Ava at the same time.
  t.call(pat.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'FG2M'), ev(ava.id, 'FG2A'), ev(ben.id, 'REB')] });
  t.call(sam.pin, 'record', { gameId: g1.id, mode: 'personal', events: [ev(ava.id, 'FG2M'), ev(ava.id, 'FG2A'), ev(ava.id, 'FG2M'), ev(ava.id, 'FG2A'), ev(ava.id, 'STL')] });
  assert.throws(() => t.call(sam.pin, 'record', { gameId: g1.id, mode: 'personal', events: [ev(ben.id, 'REB')] }), /assigned players/);
  assert.throws(() => t.call(sam.pin, 'record', { gameId: g1.id, mode: 'personal', events: [ev('', 'OPP', 2)] }), /assigned players/);
  assert.throws(() => t.call(sam.pin, 'record', { gameId: g1.id, events: [ev(ava.id, 'REB')] }), /isn't assigned/, 'not the team scorer for game 1');

  const official = t.call(pat.pin, 'game', { gameId: g1.id });
  assert.deepEqual(official.box[ava.id], { FG2M: 1, FG2A: 1 }, 'official stats untouched');
  const personal = t.call(sam.pin, 'game', { gameId: g1.id, mode: 'personal' });
  assert.equal(personal.mode, 'personal');
  assert.deepEqual(personal.players.map(p => p.id), [ava.id]);
  assert.deepEqual(personal.box[ava.id], { FG2M: 2, FG2A: 2, STL: 1 });

  // Coach sees both, side by side.
  const coachView = t.coach('game', { gameId: g1.id });
  assert.deepEqual(coachView.parentBooks, [{ id: sam.id, name: 'Sam Other', box: { [ava.id]: { FG2M: 2, FG2A: 2, STL: 1 } } }]);
  assert.equal(t.coach('all').boxes[g1.id][ava.id].FG2M, 1, 'season uses official stats only');
  assert.equal(t.call(pat.pin, 'game', { gameId: g1.id }).parentBooks, undefined, 'only the coach sees parent records');

  // viewOwn: official numbers for their players only.
  const mine = t.call(sam.pin, 'scorerHome').myStats;
  assert.deepEqual(mine.map(x => Object.keys(x.box)), [[ava.id]]);
  assert.deepEqual(mine[0].box[ava.id], { FG2M: 1, FG2A: 1 });
  // Without the switch, nothing.
  t.coach('saveParent', { id: sam.id, name: sam.name, players: [ava.id], perms: { viewOwn: false } });
  assert.equal(t.call(sam.pin, 'scorerHome').myStats, undefined);

  // Final games close the personal record too.
  t.coach('setStatus', { gameId: g1.id, status: 'final' });
  assert.throws(() => t.call(sam.pin, 'record', { gameId: g1.id, mode: 'personal', events: [ev(ava.id, 'REB')] }), /final/);
});
