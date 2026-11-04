/**
 * Team Stats (basketball): backend (Google Apps Script).
 *
 * This file lives in Extensions → Apps Script of a Google Sheet the coach owns.
 * Coaches who copy the shared template never open the editor: the "🏀 Team Stats"
 * menu in the spreadsheet sets everything up and publishes the app (see setupApp).
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

const TEAM_DEFAULT = 'My Team';

const TABLES = {
  Settings: ['Setting', 'Value'],
  Players: ['ID', 'Number', 'Name', 'Active'],
  Parents: ['ID', 'Name', 'PIN', 'Active', 'Track Any', 'Fix Stats', 'View Stats', 'Manage', 'Players', 'See Own Players', 'Email', 'Phone', 'Invited'],
  Games: ['ID', 'Date', 'Opponent', 'Location', 'Scorer ID', 'Status', 'Notes', 'Opp Roster'],
  // Book is blank for official stats, or a parent's ID for that parent's own record of their players.
  // Period: 1-4 = quarters, 5 = OT, 6 = 2OT... (blank on plays recorded before quarters were tracked)
  Events: ['ID', 'Game ID', 'Player ID', 'Stat', 'Delta', 'Time', 'Entered By', 'Book', 'Period'],
};
// Columns stored as plain text so Sheets doesn't turn PINs, dates, or jersey "00" into numbers/dates.
const TEXT_COLUMNS = { Settings: [2], Players: [2], Parents: [3, 9, 11, 12, 13], Games: [2, 8] };

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
//   viewOwn   : see official stats (season + game log) for the players assigned to them
const PERMS = {
  trackAny: ['Track Any', false], fixStats: ['Fix Stats', true], viewStats: ['View Stats', false],
  manage: ['Manage', false], viewOwn: ['See Own Players', false],
};
const ALL_PERMS = { trackAny: true, fixStats: true, viewStats: true, manage: true, viewOwn: true };
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
  addGames: { need: 'manage', run: addGames_ },
  deletePlayer: { need: 'manage', run: deletePlayer_ },
  saveGame: { need: 'manage', run: saveGame_ },
  deleteGame: { need: 'coach', run: deleteGame_ },
  saveParent: { need: 'coach', run: saveParent_ },
  deleteParent: { need: 'coach', run: deleteParent_ },
  emailInvite: { need: 'coach', run: emailInvite_ },
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
  if (parent) return { role: 'scorer', id: str_(parent.ID), name: str_(parent.Name), perms: perms_(parent), players: idList_(parent.Players) };

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
  return { role: who.role, id: who.id, name: who.name, teamName: getSettings_().teamName, perms: who.perms, players: who.players || [] };
}

function scorerHome_(who) {
  const all = listGames_().sort((a, b) => a.date.localeCompare(b.date));
  const games = all.filter(g => g.status !== 'final' && (g.scorerId === who.id || who.perms.trackAny || who.perms.manage));
  const mine = myPlayers_(who);
  const out = {
    me: me_(who),
    games: games,
    // Games where a player-parent can keep their own record of their players.
    playerGames: mine.length ? all.filter(g => g.status !== 'final') : [],
    myPlayers: mine,
  };
  if (mine.length && who.perms.viewOwn) {
    // Official numbers for their players only.
    const ids = {};
    mine.forEach(p => { ids[p.id] = true; });
    const boxes = boxes_();
    out.myStats = all.filter(g => boxes[g.id]).map(g => {
      const box = {};
      Object.keys(boxes[g.id]).forEach(k => { if (ids[k]) box[k] = boxes[g.id][k]; });
      return { game: { id: g.id, date: g.date, opponent: g.opponent, location: g.location, status: g.status }, box: box };
    }).filter(x => Object.keys(x.box).length);
  }
  return out;
}

function myPlayers_(who) {
  if (!who.players || !who.players.length) return [];
  return listPlayers_().filter(p => who.players.indexOf(p.id) >= 0);
}

/** A player-parent's own record of their players in one game (never the official box score). */
function getPersonalGame_(who, g) {
  if (!who.players || !who.players.length) throw new Error('No players are assigned to you.');
  if (g.status === 'final') throw new Error('This game is final.');
  const box = bookBoxes_(g.id)[who.id] || {};
  return { game: g, box: box, players: myPlayers_(who), canTrack: true, canFix: true, mode: 'personal' };
}

function getGame_(who, data) {
  const g = findGame_(data.gameId);
  if (data.mode === 'personal') return getPersonalGame_(who, g);
  const track = canTrack_(who, g);
  if (!track && !(who.perms.viewStats || who.perms.manage)) checkGameAccess_(who, g); // throws the reason
  const box = boxes_(g.id)[g.id] || {};
  const players = listPlayers_().filter(p => p.active || box[p.id]);
  const byPeriod = periods_(g.id);
  const out = {
    game: g, box: box, players: players,
    canTrack: track,
    canFix: track && !!(who.perms.fixStats || who.perms.manage),
    periods: byPeriod.periods,
    periodBoxes: byPeriod.boxes,
    currentPeriod: byPeriod.current,
  };
  if (who.role === 'coach') out.parentBooks = parentBooks_(g.id);
  return out;
}

/** Coach-only: each player-parent's own record for one game, for comparing with the official stats. */
function parentBooks_(gameId) {
  const names = {};
  readTable_('Parents').forEach(r => { names[str_(r.ID)] = str_(r.Name); });
  const books = bookBoxes_(gameId);
  return Object.keys(books).map(id => ({ id: id, name: names[id] || 'Removed parent', box: books[id] }));
}

function record_(who, data) {
  const events = data.events;
  if (!Array.isArray(events) || !events.length) return { saved: 0 };
  if (events.length > 200) throw new Error('Too many plays in one request.');

  const personal = data.mode === 'personal';
  return withLock_(() => {
    const g = findGame_(data.gameId);
    let allowed = null;
    if (personal) {
      if (!who.players || !who.players.length) throw new Error('No players are assigned to you.');
      if (g.status === 'final') throw new Error('This game is final.');
      allowed = {};
      who.players.forEach(id => { allowed[id] = true; });
    } else {
      checkGameAccess_(who, g);
    }
    if (!personal && !(who.perms.fixStats || who.perms.manage) && events.some(e => e.fix)) {
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
      if (allowed) {
        if (!allowed[playerId] || !playerIds[playerId] || stat === 'OPP') throw new Error('You can only keep stats for your assigned players.');
      } else if (stat === 'OPP') playerId = '';
      else if (OPP_ID.test(playerId)) { if (stat === 'GP') throw new Error('Bad stat change.'); }
      else if (!playerIds[playerId]) throw new Error('Unknown player.');
      const time = isNaN(Date.parse(e.time)) ? new Date().toISOString() : new Date(e.time).toISOString();
      const period = Number(e.period);
      rows.push([id, g.id, playerId, stat, delta, time, who.name, personal ? who.id : '', Number.isInteger(period) && period >= 1 && period <= 9 ? period : '']);
      seen[id] = true;
    });
    appendRows_('Events', rows);
    if (!personal && rows.length && g.status === 'scheduled') updateGameField_(g.id, 'Status', 'live');
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

function addGames_(who, d) {
  const rows = (Array.isArray(d.list) ? d.list : []).slice(0, 60).map(g => {
    const date = str_(g.date);
    const opponent = clean_(g.opponent, 60);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !opponent) throw new Error('Each game needs a date and an opponent.');
    const location = LOCATIONS.indexOf(g.location) >= 0 ? g.location : 'home';
    return [newId_('G'), date, opponent, location, '', 'scheduled', clean_(g.notes, 200), ''];
  });
  withLock_(() => appendRows_('Games', rows));
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
  const validPlayers = {};
  listPlayers_().forEach(p => { validPlayers[p.id] = true; });
  const players = (Array.isArray(d.players) ? d.players : []).map(str_).filter(id => validPlayers[id]);
  const email = clean_(d.email, 100).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email address doesn't look right.");
  const phone = cleanPhone_(d.phone);
  const obj = { Name: name, Active: active, Players: players.join(','), Email: email, Phone: phone };
  Object.keys(PERMS).forEach(k => { obj[PERMS[k][0]] = k in perms ? !!perms[k] : PERMS[k][1]; });
  withLock_(() => {
    if (d.id) {
      const row = findRow_('Parents', d.id);
      obj.ID = row.ID;
      obj.PIN = d.newPin ? randomPin_(4, takenPins_()) : str_(row.PIN);
      // A new PIN or a new address means the old invite is out of date.
      obj.Invited = d.newPin || email !== str_(row.Email).toLowerCase() ? '' : str_(row.Invited);
      writeRow_('Parents', row._row, obj);
    } else {
      obj.ID = newId_('U');
      obj.PIN = randomPin_(4, takenPins_());
      appendRows_('Parents', [TABLES.Parents.map(h => obj[h])]);
    }
  });
  return all_(who);
}

function cleanPhone_(v) {
  const raw = str_(v);
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 10) throw new Error("That phone number doesn't look right. Include the area code.");
  return digits.slice(0, 16);
}

/**
 * Emails an invite from the coach's own Gmail. The message is written by the page, but it can only
 * go to the address saved for that person, so this can't be used to email anyone else.
 */
function emailInvite_(who, d) {
  const row = findRow_('Parents', d.id);
  const to = str_(row.Email);
  if (!to) throw new Error('Add an email address for this person first.');
  const subject = clean_(d.subject, 120) || (getSettings_().teamName + ' stats app');
  const body = str_(d.body).slice(0, 4000);
  if (!body) throw new Error('The message is empty.');
  if (body.indexOf(str_(row.PIN)) < 0) throw new Error('The message is missing their PIN.');
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: getSettings_().teamName });
  withLock_(() => {
    const fresh = findRow_('Parents', d.id);
    fresh.Invited = new Date().toISOString();
    writeRow_('Parents', fresh._row, fresh);
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
  return {
    id: str_(r.ID), name: str_(r.Name), pin: str_(r.PIN), active: bool_(r.Active, true), perms: perms_(r), players: idList_(r.Players),
    email: str_(r.Email), phone: str_(r.Phone), invited: str_(r.Invited),
  };
}

function idList_(v) {
  return str_(v).split(',').map(x => x.trim()).filter(Boolean);
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

/** Official stats: { gameId: { playerId | _team: { STAT: total } } } */
function boxes_(onlyGameId) {
  const out = {};
  readRaw_('Events').forEach(r => {
    if (str_(r[7])) return; // a parent's own record, not official
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

const POINTS_ = { FG2M: 2, FG3M: 3, FTM: 1 };

/**
 * Official stats split by period:
 *   periods: { 1: { us, opp, usPF, oppPF } }   scoring and team fouls
 *   boxes:   { 1: { playerId: { STAT: n } } }   each player's line in that period
 */
function periods_(gameId) {
  const periods = {}, boxes = {};
  let current = 0;
  readRaw_('Events').forEach(r => {
    if (str_(r[1]) !== gameId || str_(r[7])) return;
    const p = Number(r[8]);
    if (!Number.isInteger(p) || p < 1) return;
    const stat = str_(r[3]), delta = Number(r[4]) || 0, pid = str_(r[2]);
    const q = periods[p] || (periods[p] = { us: 0, opp: 0, usPF: 0, oppPF: 0 });
    const opp = stat === 'OPP' || OPP_ID.test(pid);
    if (stat === 'OPP') q.opp += delta;
    else if (POINTS_[stat]) q[opp ? 'opp' : 'us'] += POINTS_[stat] * delta;
    else if (stat === 'PF') q[opp ? 'oppPF' : 'usPF'] += delta;
    if (STATS.indexOf(stat) >= 0) {
      const b = boxes[p] || (boxes[p] = {});
      const line = b[pid || TEAM_KEY] || (b[pid || TEAM_KEY] = {});
      line[stat] = (line[stat] || 0) + delta;
    }
    if (p > current) current = p;
  });
  return { periods: periods, boxes: boxes, current: current };
}

/** Parents' own records for one game: { parentId: { playerId: { STAT: total } } } */
function bookBoxes_(gameId) {
  const out = {};
  readRaw_('Events').forEach(r => {
    const book = str_(r[7]);
    if (!book || str_(r[1]) !== gameId) return;
    const stat = str_(r[3]);
    if (STATS.indexOf(stat) < 0) return;
    const b = out[book] || (out[book] = {});
    const p = b[str_(r[2])] || (b[str_(r[2])] = {});
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
    return ['Team Name', 'Season', 'Coach PIN', 'Sheet ID'].filter(k => !have[k]);
  };
  // A copied spreadsheet (e.g. from a template, or last season's sheet) must not keep the
  // original's PINs: give the copy a fresh coach PIN and clear the parents list.
  if (!missing.length) {
    const idRow = readTable_('Settings').find(r => str_(r.Setting) === 'Sheet ID');
    if (idRow && str_(idRow.Value) && str_(idRow.Value) !== ss.getId()) {
      withLock_(() => {
        setSetting_('Coach PIN', randomPin_(6));
        setSetting_('Sheet ID', ss.getId());
        replaceRows_('Parents', []);
      });
    }
  }
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
        if (k === 'Sheet ID') return [k, ss.getId()];
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

// ---------------------------------------------------------------------------
// One-button setup from the spreadsheet menu (no Apps Script editor needed)
// ---------------------------------------------------------------------------

const SCRIPT_API = 'https://script.googleapis.com/v1/projects/';
const API_SETTINGS_URL = 'https://script.google.com/home/usersettings';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🏀 Team Stats')
    .addItem('Set up my app (or publish updates)', 'setupApp')
    .addItem('Show my app link and coach PIN', 'showAppInfo')
    .addToUi();
}

/**
 * Security: every public function can be called by web-app visitors (google.script.run), and the web
 * app runs as the owner. These setup functions reveal the coach PIN, so they only work for the owner
 * using the spreadsheet itself (anonymous visitors have no active-user email).
 */
function requireOwner_() {
  let active = '', owner = '';
  try { active = Session.getActiveUser().getEmail(); owner = Session.getEffectiveUser().getEmail(); } catch (e) { /* no identity */ }
  if (!active || active !== owner) throw new Error('Only the owner of this spreadsheet can do that.');
}

/** Menu: create the tabs, publish the web app, and show the link + coach PIN. */
function setupApp() {
  requireOwner_();
  const result = setupResult_();
  showDialog_(result.ok ? appInfoHtml_(result) : setupProblemHtml_(result), result.ok ? 'Your app is ready' : 'One more step');
}

/** Never throws; returns what the dialog should show. Private: callers must check requireOwner_(). */
function setupResult_() {
  try {
    ensureSetup_();
    const url = deployWebApp_();
    return { ok: true, url: url, pin: getSettings_().coachPin, teamName: getSettings_().teamName };
  } catch (e) {
    return { ok: false, apiOff: !!e.apiOff, message: String(e.message || e) };
  }
}

/** Menu: show the link and PIN again. */
function showAppInfo() {
  requireOwner_();
  ensureSetup_();
  const url = savedAppUrl_();
  if (!url) return showDialog_(setupProblemHtml_({ notYet: true }), 'Not set up yet');
  const s = getSettings_();
  showDialog_(appInfoHtml_({ url: url, pin: s.coachPin, teamName: s.teamName }), 'Your app');
}

/**
 * Publishes (or re-publishes) the web app using the Apps Script API and returns its link.
 * Reuses the existing web-app deployment so the link never changes.
 */
function deployWebApp_() {
  const scriptId = ScriptApp.getScriptId();
  const base = SCRIPT_API + scriptId;
  const version = scriptApi_('post', base + '/versions', { description: 'Team Stats' });
  const config = { versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: 'Team Stats' };
  const list = scriptApi_('get', base + '/deployments').deployments || [];
  const existing = list.find(d => webAppUrl_(d) && /\/exec$/.test(webAppUrl_(d)));
  const dep = existing
    ? scriptApi_('put', base + '/deployments/' + existing.deploymentId, { deploymentConfig: config })
    : scriptApi_('post', base + '/deployments', config);
  const url = webAppUrl_(dep);
  if (!url) throw new Error('Google published the app but did not return its link. Use "Show my app link" in a minute.');
  PropertiesService.getScriptProperties().setProperty('appUrl:' + scriptId, url);
  return url;
}

function webAppUrl_(dep) {
  const web = (dep && dep.entryPoints || []).find(p => p.entryPointType === 'WEB_APP');
  return (web && web.webApp && web.webApp.url) || '';
}

function savedAppUrl_() {
  let url = PropertiesService.getScriptProperties().getProperty('appUrl:' + ScriptApp.getScriptId()) || '';
  if (!url) { try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { /* not deployed */ } }
  return url;
}

function scriptApi_(method, url, body) {
  const opts = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();
  let json = {};
  try { json = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* not JSON */ }
  if (code >= 200 && code < 300) return json;
  const msg = (json.error && json.error.message) || ('Google returned error ' + code);
  const err = new Error(msg);
  err.apiOff = /has not enabled the Apps Script API|usersettings/i.test(msg);
  throw err;
}

function showDialog_(html, title) {
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(480).setHeight(520), title);
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const DIALOG_CSS_ = '<style>body{font:15px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#141821;margin:0}' +
  'h2{font-size:18px;margin:0 0 8px}.box{background:#eef2f8;border-radius:10px;padding:10px 12px;margin:8px 0}' +
  'input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccd3de;border-radius:8px;font-size:13px}' +
  '.pin{font:800 26px ui-monospace,Menlo,monospace;letter-spacing:.15em}' +
  '.btn{display:inline-block;background:#1c3d8c;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:700;text-decoration:none;cursor:pointer;font-size:15px}' +
  '.btn.light{background:#fff;color:#1c3d8c;border:1px solid #ccd3de}ol{padding-left:20px;margin:6px 0}li{margin:4px 0}.muted{color:#5f6b7d;font-size:13px}</style>';

function appInfoHtml_(r) {
  return DIALOG_CSS_ +
    '<h2>' + esc_(r.teamName) + ' stats app</h2>' +
    '<div class="box"><b>App link</b> (for you and your parents)<input readonly value="' + esc_(r.url) + '" onclick="this.select()"></div>' +
    '<p><a class="btn" href="' + esc_(r.url) + '" target="_blank">Open my app</a></p>' +
    '<div class="box"><b>Your coach PIN</b><div class="pin">' + esc_(r.pin) + '</div>' +
    '<div class="muted">Keep this to yourself. You can change it on the Settings tab.</div></div>' +
    '<b>Next:</b><ol><li>Open the link on your phone, sign in with your PIN, and tap Share → Add to Home Screen.</li>' +
    '<li><b>Roster</b> tab → Add many → paste your players.</li>' +
    '<li><b>Games</b> tab → Add many → paste your schedule.</li>' +
    '<li><b>Access</b> tab → add parents → tap <b>Invite</b> to send each one their link and PIN.</li></ol>' +
    '<p class="muted">Find this again anytime: 🏀 Team Stats menu → Show my app link and coach PIN.</p>';
}

function setupProblemHtml_(r) {
  if (r.notYet) {
    return DIALOG_CSS_ + '<h2>Your app isn\'t set up yet</h2><p>Click <b>🏀 Team Stats → Set up my app</b> first.</p>';
  }
  const retry = '<p><button class="btn" id="go" onclick="retry()">I did it. Try again</button> <span id="msg" class="muted"></span></p>' +
    '<script>function retry(){var b=document.getElementById("go");b.disabled=true;b.textContent="Setting up…";' +
    'google.script.run.withSuccessHandler(function(r){if(r.ok){document.body.innerHTML=' + JSON.stringify(DIALOG_CSS_) + '+r.html;}' +
    'else{b.disabled=false;b.textContent="Try again";document.getElementById("msg").textContent=r.message;}}).retrySetup_ui();}</script>';
  if (r.apiOff) {
    return DIALOG_CSS_ + '<h2>Turn on one Google switch</h2>' +
      '<p>Google needs your OK before this sheet can publish your app. This is a one-time step.</p>' +
      '<ol><li><a href="' + API_SETTINGS_URL + '" target="_blank"><b>Open this Google settings page</b></a> (opens a new tab).</li>' +
      '<li>Click <b>Google Apps Script API</b> and switch it <b>On</b>.</li>' +
      '<li>Come back to this window and click the button below.</li></ol>' + retry;
  }
  return DIALOG_CSS_ + '<h2>Almost there</h2>' +
    '<p>Google didn\'t let the sheet publish the app by itself (' + esc_(r.message) + '). You can do it by hand in about a minute:</p>' +
    '<ol><li>Click <b>Extensions → Apps Script</b>.</li>' +
    '<li>Click the blue <b>Deploy</b> button → <b>New deployment</b>.</li>' +
    '<li>Click the ⚙️ gear next to "Select type" → <b>Web app</b>.</li>' +
    '<li>Set <b>Who has access</b> to <b>Anyone</b>, then click <b>Deploy</b> (and <b>Authorize</b> if asked).</li>' +
    '<li>Come back here: <b>🏀 Team Stats → Show my app link and coach PIN</b>.</li></ol>' + retry;
}

/** Called by the dialog's retry button: returns ready-to-show HTML on success. */
function retrySetup_ui() {
  requireOwner_();
  const r = setupResult_();
  return r.ok ? { ok: true, html: appInfoHtml_(r).replace(DIALOG_CSS_, '') } : { ok: false, message: r.apiOff ? 'Still off. Make sure the switch says On, then try again.' : r.message };
}
