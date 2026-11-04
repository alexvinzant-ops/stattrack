/**
 * GCS Hoops Stats: backend (Google Apps Script).
 *
 * This file is pasted into Extensions → Apps Script of a Google Sheet the coach owns.
 * All data lives in that Sheet. The web app runs as the coach, so parents never
 * get access to the Sheet itself. They can only record stats for the game they
 * have been assigned, through the actions below.
 *
 * Roles:
 *   coach  : Coach PIN (Settings tab). Sees and edits everything.
 *   scorer : a parent's PIN (Parents tab). By default they can only open and
 *            record stats for games assigned to them that are not final.
 *            The coach can grant extra access per person (see PERMS).
 *            Managing people and PINs is always coach-only.
 */

const TEAM_DEFAULT = "GCS Boys' Basketball";

const TABLES = {
  Settings: ['Setting', 'Value'],
  Players: ['ID', 'Number', 'Name', 'Active'],
  Parents: ['ID', 'Name', 'PIN', 'Active', 'Track Any', 'Fix Stats', 'View Stats', 'Manage'],
  Games: ['ID', 'Date', 'Opponent', 'Location', 'Scorer ID', 'Status', 'Notes', 'Opp Roster'],
  Events: ['ID', 'Game ID', 'Player ID', 'Stat', 'Delta', 'Time', 'Entered By'],
};
// Columns stored as plain text so Sheets doesn't turn PINs, dates, or jersey "00" into numbers/dates.
const TEXT_COLUMNS = { Settings: [2], Players: [2], Parents: [3], Games: [2, 8] };

// Base counters. Everything else (points, FG, %) is derived.
const STATS = ['GP', 'FG2M', 'FG2A', 'FG3M', 'FG3A', 'FTM', 'FTA', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF', 'OPP'];
const STATUSES = ['scheduled', 'live', 'final'];
const LOCATIONS = ['home', 'away', 'neutral'];
const REPORT_SHEETS = ['Season Stats', 'Game Log'];
const TEAM_KEY = '_team';
// Opponent players are tracked per game by jersey number: "opp:23", or "opp:team" for unknown/team.
const OPP_ID = /^opp:(\d{1,3}|team)$/;

// Extra access the coach can give each person. Column on the Parents tab → default.
//   trackAny  : keep stats for any game that isn't final (not just ones assigned to them)
//   fixStats  : change numbers in a box score (undoing their own taps is always allowed)
//   viewStats : read-only season stats, player game logs and every box score
//   manage    : add/edit players and games, assign stat keepers, mark games final (assistant coach)
const PERMS = { trackAny: ['Track Any', false], fixStats: ['Fix Stats', true], viewStats: ['View Stats', false], manage: ['Manage', false] };
const ALL_PERMS = { trackAny: true, fixStats: true, viewStats: true, manage: true };
const MAX_FAILED_LOGINS = 30; // across everyone, per 15 minutes

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet() {
  ensureSetup_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(getSettings_().teamName + ' Stats')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** Run once from the Apps Script editor to create the tabs and your coach PIN. */
function setup() {
  ensureSetup_();
  Logger.log('Setup complete. Your coach PIN is ' + getSettings_().coachPin +
    '. You can change it on the Settings tab of the spreadsheet.');
}

/** The single function the web page calls (google.script.run.api). */
function api(req) {
  req = req || {};
  ensureSetup_();
  const who = authenticate_(req.pin);
  const action = ACTIONS[req.action];
  if (!action) throw new Error('Unknown action: ' + req.action);
  if (action.need === 'coach' && who.role !== 'coach') throw new Error('Only the coach can do that.');
  if (action.need === 'manage' && !who.perms.manage) throw new Error('Only the coach can do that.');
  if (action.need === 'view' && !(who.perms.viewStats || who.perms.manage)) throw new Error('Only the coach can do that.');
  return action.run(who, req.data || {});
}

const ACTIONS = {
  me: { run: me_ },
  scorerHome: { run: scorerHome_ },
  game: { run: getGame_ },
  record: { run: record_ },
  setStatus: { run: setStatus_ },
  setOppRoster: { run: setOppRoster_ },
  all: { need: 'view', run: all_ },
  savePlayer: { need: 'manage', run: savePlayer_ },
  addPlayers: { need: 'manage', run: addPlayers_ },
  deletePlayer: { need: 'manage', run: deletePlayer_ },
  saveGame: { need: 'manage', run: saveGame_ },
  deleteGame: { need: 'coach', run: deleteGame_ },
  saveParent: { need: 'coach', run: saveParent_ },
  deleteParent: { need: 'coach', run: deleteParent_ },
  saveSettings: { need: 'coach', run: saveSettings_ },
  writeReport: { need: 'coach', run: writeReport_ },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authenticate_(pin) {
  pin = normPin_(pin);
  if (!pin) throw new Error('AUTH: Enter your PIN.');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= MAX_FAILED_LOGINS) throw new Error('AUTH: Too many wrong PINs. Try again in 15 minutes.');

  if (pin === normPin_(getSettings_().coachPin)) return { role: 'coach', id: 'coach', name: 'Coach', perms: ALL_PERMS };
  const parent = readTable_('Parents').find(r => bool_(r.Active, true) && normPin_(r.PIN) === pin);
  if (parent) return { role: 'scorer', id: str_(parent.ID), name: str_(parent.Name), perms: perms_(parent) };

  cache.put('pinFails', String(fails + 1), 900);
  Utilities.sleep(1000);
  throw new Error("AUTH: That PIN didn't work.");
}

function normPin_(v) {
  return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, '');
}

function randomPin_(len, taken) {
  taken = taken || {};
  for (let i = 0; i < 1000; i++) {
    let pin = String(1 + Math.floor(Math.random() * 9));
    while (pin.length < len) pin += Math.floor(Math.random() * 10);
    if (!taken[pin]) return pin;
  }
  throw new Error('Could not generate a unique PIN.');
}

function takenPins_() {
  const taken = {};
  taken[normPin_(getSettings_().coachPin)] = true;
  readTable_('Parents').forEach(r => { taken[normPin_(r.PIN)] = true; });
  return taken;
}

// ---------------------------------------------------------------------------
// Actions available to scorers (and the coach)
// ---------------------------------------------------------------------------

function me_(who) {
  return { role: who.role, id: who.id, name: who.name, teamName: getSettings_().teamName, perms: who.perms };
}

function scorerHome_(who) {
  const games = listGames_()
    .filter(g => g.status !== 'final' && (g.scorerId === who.id || who.perms.trackAny || who.perms.manage))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { me: me_(who), games: games };
}

function getGame_(who, data) {
  const g = findGame_(data.gameId);
  const track = canTrack_(who, g);
  if (!track && !(who.perms.viewStats || who.perms.manage)) checkGameAccess_(who, g); // throws the reason
  const box = boxes_(g.id)[g.id] || {};
  const players = listPlayers_().filter(p => p.active || box[p.id]);
  return {
    game: g, box: box, players: players,
    canTrack: track,
    canFix: track && !!(who.perms.fixStats || who.perms.manage),
  };
}

function record_(who, data) {
  const events = data.events;
  if (!Array.isArray(events) || !events.length) return { saved: 0 };
  if (events.length > 200) throw new Error('Too many plays in one request.');

  return withLock_(() => {
    const g = findGame_(data.gameId);
    checkGameAccess_(who, g);
    if (!(who.perms.fixStats || who.perms.manage) && events.some(e => e.fix)) {
      throw new Error("You don't have permission to change box score numbers.");
    }
    const playerIds = {};
    listPlayers_().forEach(p => { playerIds[p.id] = true; });
    const seen = {};
    readColumn_('Events', 1).forEach(id => { seen[str_(id)] = true; });

    const rows = [];
    events.forEach(e => {
      const id = str_(e.id).slice(0, 64);
      if (!id) throw new Error('Play is missing an id.');
      if (seen[id]) return; // already saved (retry after a dropped connection)
      const stat = str_(e.stat);
      if (STATS.indexOf(stat) < 0) throw new Error('Unknown stat: ' + stat);
      const delta = Number(e.delta);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10) throw new Error('Bad stat change.');
      let playerId = str_(e.playerId);
      if (stat === 'OPP') playerId = '';
      else if (OPP_ID.test(playerId)) { if (stat === 'GP') throw new Error('Bad stat change.'); }
      else if (!playerIds[playerId]) throw new Error('Unknown player.');
      const time = isNaN(Date.parse(e.time)) ? new Date().toISOString() : new Date(e.time).toISOString();
      rows.push([id, g.id, playerId, stat, delta, time, who.name]);
      seen[id] = true;
    });
    appendRows_('Events', rows);
    if (rows.length && g.status === 'scheduled') updateGameField_(g.id, 'Status', 'live');
    return { saved: rows.length };
  });
}

function setStatus_(who, data) {
  const status = str_(data.status);
  if (STATUSES.indexOf(status) < 0) throw new Error('Unknown status.');
  if (!who.perms.manage && status === 'scheduled') throw new Error('Only the coach can do that.');
  return withLock_(() => {
    const g = findGame_(data.gameId);
    checkGameAccess_(who, g);
    updateGameField_(g.id, 'Status', status);
    return { ok: true, status: status };
  });
}

/** Opponent jersey numbers (and optional names) for one game. Anyone who can track the game can set them. */
function setOppRoster_(who, data) {
  return withLock_(() => {
    const g = findGame_(data.gameId);
    checkGameAccess_(who, g);
    const roster = oppRosterText_(data.roster);
    updateGameField_(g.id, 'Opp Roster', roster);
    return { ok: true, oppRoster: parseOppRoster_(roster) };
  });
}

function canTrack_(who, g) {
  if (who.role === 'coach' || who.perms.manage) return true;
  if (g.status === 'final') return false;
  return g.scorerId === who.id || !!who.perms.trackAny;
}

function checkGameAccess_(who, g) {
  if (canTrack_(who, g)) return;
  if (g.status === 'final') throw new Error('This game is final. Ask the coach to reopen it if something needs fixing.');
  throw new Error("This game isn't assigned to you.");
}

// ---------------------------------------------------------------------------
// Coach-only actions
// ---------------------------------------------------------------------------

function all_(who) {
  const s = getSettings_();
  const isCoach = !who || who.role === 'coach';
  let appUrl = '';
  try { appUrl = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed yet */ }
  let sheetUrl = '';
  try { sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl(); } catch (e) { /* ignore */ }
  return {
    me: who ? me_(who) : { role: 'coach', name: 'Coach', teamName: s.teamName, perms: ALL_PERMS },
    settings: { teamName: s.teamName, season: s.season },
    players: listPlayers_(),
    // PINs and permissions are only ever sent to the coach.
    parents: readTable_('Parents').map(parent_).map(p => (isCoach ? p : { id: p.id, name: p.name, active: p.active })),
    games: listGames_(),
    boxes: boxes_(),
    appUrl: isCoach ? appUrl : '',
    sheetUrl: isCoach ? sheetUrl : '',
  };
}

function savePlayer_(who, d) {
  const name = clean_(d.name, 60);
  if (!name) throw new Error('Player name is required.');
  const number = clean_(d.number, 3).replace(/[^0-9]/g, '');
  const active = d.active !== false;
  withLock_(() => {
    if (d.id) {
      const row = findRow_('Players', d.id);
      writeRow_('Players', row._row, { ID: row.ID, Number: number, Name: name, Active: active });
    } else {
      appendRows_('Players', [[newId_('P'), number, name, active]]);
    }
  });
  return all_(who);
}

function addPlayers_(who, d) {
  const list = (Array.isArray(d.list) ? d.list : []).slice(0, 40)
    .map(p => [newId_('P'), clean_(p.number, 3).replace(/[^0-9]/g, ''), clean_(p.name, 60), true])
    .filter(r => r[2]);
  withLock_(() => appendRows_('Players', list));
  return all_(who);
}

function deletePlayer_(who, d) {
  withLock_(() => {
    const row = findRow_('Players', d.id);
    const hasStats = readColumn_('Events', 3).some(pid => str_(pid) === str_(row.ID));
    if (hasStats) {
      // Keep their history; just hide them from new games.
      writeRow_('Players', row._row, { ID: row.ID, Number: row.Number, Name: row.Name, Active: false });
    } else {
      sheet_('Players').deleteRow(row._row);
    }
  });
  return all_(who);
}

function saveGame_(who, d) {
  const date = str_(d.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a game date.');
  const opponent = clean_(d.opponent, 60);
  if (!opponent) throw new Error('Opponent is required.');
  const location = LOCATIONS.indexOf(d.location) >= 0 ? d.location : 'home';
  const status = STATUSES.indexOf(d.status) >= 0 ? d.status : 'scheduled';
  const scorerId = str_(d.scorerId);
  if (scorerId && !readTable_('Parents').some(r => str_(r.ID) === scorerId)) throw new Error('Unknown parent.');
  const notes = clean_(d.notes, 200);
  const oppRoster = oppRosterText_(d.oppRoster);
  withLock_(() => {
    if (d.id) {
      const row = findRow_('Games', d.id);
      writeRow_('Games', row._row, {
        ID: row.ID, Date: date, Opponent: opponent, Location: location,
        'Scorer ID': scorerId, Status: status, Notes: notes, 'Opp Roster': oppRoster,
      });
    } else {
      appendRows_('Games', [[newId_('G'), date, opponent, location, scorerId, status, notes, oppRoster]]);
    }
  });
  return all_(who);
}

function deleteGame_(who, d) {
  withLock_(() => {
    const row = findRow_('Games', d.id);
    sheet_('Games').deleteRow(row._row);
    const keep = readRaw_('Events').filter(r => str_(r[1]) !== str_(d.id));
    replaceRows_('Events', keep);
  });
  return all_(who);
}

function saveParent_(who, d) {
  const name = clean_(d.name, 60);
  if (!name) throw new Error('Parent name is required.');
  const active = d.active !== false;
  const perms = d.perms || {};
  const obj = { Name: name, Active: active };
  Object.keys(PERMS).forEach(k => { obj[PERMS[k][0]] = k in perms ? !!perms[k] : PERMS[k][1]; });
  withLock_(() => {
    if (d.id) {
      const row = findRow_('Parents', d.id);
      obj.ID = row.ID;
      obj.PIN = d.newPin ? randomPin_(4, takenPins_()) : str_(row.PIN);
      writeRow_('Parents', row._row, obj);
    } else {
      obj.ID = newId_('U');
      obj.PIN = randomPin_(4, takenPins_());
      appendRows_('Parents', [TABLES.Parents.map(h => obj[h])]);
    }
  });
  return all_(who);
}

function deleteParent_(who, d) {
  withLock_(() => {
    const row = findRow_('Parents', d.id);
    sheet_('Parents').deleteRow(row._row);
    readTable_('Games').forEach(g => {
      if (str_(g['Scorer ID']) === str_(d.id)) updateGameField_(str_(g.ID), 'Scorer ID', '');
    });
  });
  return all_(who);
}

function saveSettings_(who, d) {
  withLock_(() => {
    const teamName = clean_(d.teamName, 60);
    if (teamName) setSetting_('Team Name', teamName);
    const season = clean_(d.season, 20);
    if (season) setSetting_('Season', season);
  });
  return all_(who);
}

/** Writes tables the page already computed into report tabs, so the coach can sort/chart in Sheets. */
function writeReport_(who, d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = d.sheets || {};
  Object.keys(sheets).forEach(name => {
    if (REPORT_SHEETS.indexOf(name) < 0) throw new Error('Unknown report: ' + name);
    const rows = sheets[name];
    if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new Error('Bad report data.');
    const width = rows[0].length;
    if (width > 40) throw new Error('Bad report data.');
    const clean = rows.map(r => {
      if (!Array.isArray(r) || r.length !== width) throw new Error('Bad report data.');
      return r.map(v => (typeof v === 'number' ? v : clean_(v, 100)));
    });
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, clean.length, width).setValues(clean);
    sh.getRange(1, 1, 1, width).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  return { ok: true, sheetUrl: ss.getUrl() };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function getSettings_() {
  const map = {};
  readTable_('Settings').forEach(r => { if (!(str_(r.Setting) in map)) map[str_(r.Setting)] = str_(r.Value); });
  return {
    teamName: map['Team Name'] || TEAM_DEFAULT,
    season: map['Season'] || '',
    coachPin: map['Coach PIN'] || '',
  };
}

function setSetting_(key, value) {
  const row = readTable_('Settings').find(r => str_(r.Setting) === key);
  if (row) writeRow_('Settings', row._row, { Setting: key, Value: value });
  else appendRows_('Settings', [[key, value]]);
}

function listPlayers_() {
  return readTable_('Players').map(r => ({
    id: str_(r.ID), number: str_(r.Number), name: str_(r.Name), active: bool_(r.Active, true),
  }));
}

function perms_(r) {
  const out = {};
  Object.keys(PERMS).forEach(k => { out[k] = bool_(r[PERMS[k][0]], PERMS[k][1]); });
  return out;
}

function parent_(r) {
  return { id: str_(r.ID), name: str_(r.Name), pin: str_(r.PIN), active: bool_(r.Active, true), perms: perms_(r) };
}

/** "4 Smith, 12, 23 Jones" ⇄ [{number:'4', name:'Smith'}, ...] */
function parseOppRoster_(text) {
  const seen = {};
  return str_(text).split(/[,\n]+/).map(part => {
    const m = /^\s*#?(\d{1,3})\b\s*(.*)$/.exec(part);
    return m ? { number: String(Number(m[1])), name: m[2].trim().slice(0, 40) } : null;
  }).filter(p => p && !seen[p.number] && (seen[p.number] = true)).slice(0, 25);
}

function oppRosterText_(v) {
  const list = Array.isArray(v) ? v.map(p => (p && p.number != null ? (p.number + ' ' + (p.name || '')).trim() : '')).join(', ') : str_(v);
  return parseOppRoster_(clean_(list.replace(/\n/g, ','), 1000)).map(p => (p.number + ' ' + p.name).trim()).join(', ');
}

function listGames_() {
  return readTable_('Games').map(r => {
    const status = str_(r.Status).toLowerCase();
    const location = str_(r.Location).toLowerCase();
    return {
      id: str_(r.ID),
      date: date_(r.Date),
      opponent: str_(r.Opponent),
      location: LOCATIONS.indexOf(location) >= 0 ? location : 'home',
      scorerId: str_(r['Scorer ID']),
      status: STATUSES.indexOf(status) >= 0 ? status : 'scheduled',
      notes: str_(r.Notes),
      oppRoster: parseOppRoster_(r['Opp Roster']),
    };
  });
}

function findGame_(id) {
  const g = listGames_().find(x => x.id === str_(id));
  if (!g) throw new Error('Game not found.');
  return g;
}

function updateGameField_(id, field, value) {
  const row = findRow_('Games', id);
  row[field] = value;
  writeRow_('Games', row._row, row);
}

/** { gameId: { playerId | _team: { STAT: total } } } */
function boxes_(onlyGameId) {
  const out = {};
  readRaw_('Events').forEach(r => {
    const gameId = str_(r[1]);
    if (onlyGameId && gameId !== onlyGameId) return;
    const stat = str_(r[3]);
    if (STATS.indexOf(stat) < 0) return;
    const key = str_(r[2]) || TEAM_KEY;
    const g = out[gameId] || (out[gameId] = {});
    const p = g[key] || (g[key] = {});
    p[stat] = (p[stat] || 0) + (Number(r[4]) || 0);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

let setupDone_ = false;
const sheetCache_ = {};

function ensureSetup_() {
  if (setupDone_) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const missing = Object.keys(TABLES).filter(n => !ss.getSheetByName(n));
  // Add columns introduced by newer versions of this app to existing tabs.
  Object.keys(TABLES).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const headers = TABLES[name];
    const have = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (headers.some((h, i) => str_(have[i]) !== h) && headers.slice(0, have.filter(String).length).every((h, i) => str_(have[i]) === h)) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      (TEXT_COLUMNS[name] || []).forEach(c => sh.getRange(2, c, 999, 1).setNumberFormat('@'));
    }
  });
  const needSettings = () => {
    const have = {};
    readTable_('Settings').forEach(r => { have[str_(r.Setting)] = true; });
    return ['Team Name', 'Season', 'Coach PIN'].filter(k => !have[k]);
  };
  if (missing.length || needSettings().length) {
    withLock_(() => {
      Object.keys(TABLES).forEach(name => {
        if (ss.getSheetByName(name)) return;
        const headers = TABLES[name];
        const sh = ss.insertSheet(name);
        sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sh.setFrozenRows(1);
        (TEXT_COLUMNS[name] || []).forEach(c => sh.getRange(2, c, 999, 1).setNumberFormat('@'));
      });
      const add = needSettings().map(k => {
        if (k === 'Team Name') return [k, TEAM_DEFAULT];
        if (k === 'Season') return [k, defaultSeason_()];
        return [k, randomPin_(6)];
      });
      appendRows_('Settings', add);
    });
  }
  setupDone_ = true;
}

function defaultSeason_() {
  const now = new Date();
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return y + '-' + String(y + 1).slice(2);
}

function sheet_(name) {
  if (!sheetCache_[name]) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sh) throw new Error('Missing tab: ' + name);
    sheetCache_[name] = sh;
  }
  return sheetCache_[name];
}

function readRaw_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, TABLES[name].length).getValues()
    .filter(r => r.some(v => v !== '' && v != null));
}

function readColumn_(name, col) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, col, last - 1, 1).getValues().map(r => r[0]);
}

function readTable_(name) {
  const sh = sheet_(name);
  const headers = TABLES[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues()
    .map((row, i) => {
      const o = { _row: i + 2 };
      headers.forEach((h, j) => { o[h] = row[j]; });
      return o;
    })
    .filter(o => headers.some(h => o[h] !== '' && o[h] != null));
}

function findRow_(name, id) {
  const row = readTable_(name).find(r => str_(r.ID) === str_(id));
  if (!row) throw new Error('Not found. It may have been deleted. Refresh and try again.');
  return row;
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function writeRow_(name, rowNum, obj) {
  const headers = TABLES[name];
  sheet_(name).getRange(rowNum, 1, 1, headers.length)
    .setValues([headers.map(h => (obj[h] == null ? '' : obj[h]))]);
}

function replaceRows_(name, rows) {
  const sh = sheet_(name);
  const width = TABLES[name].length;
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function str_(v) {
  if (v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return date_(v);
  return String(v).trim();
}

function clean_(v, max) {
  return str_(v).replace(/[\u0000-\u001f]/g, ' ').replace(/^[=+\-@]+/, '').slice(0, max);
}

function date_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v == null ? '' : v).trim();
}

function bool_(v, dflt) {
  if (v === '' || v == null) return dflt;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  return !(s === 'false' || s === 'no' || s === '0' || s === 'n');
}

function newId_(prefix) {
  return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}
