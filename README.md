# GCS Hoops Stats

A simple GameChanger-style stat tracker for GCS Boys' Basketball.

- **Parents keep the stats.** Each parent gets their own 4-digit PIN. You assign a parent to a game, and on game day they open the link on their phone and tap the player, then the stat.
- **Only you see the numbers.** Parents only see the one game they are assigned, and only until they submit it. Season stats, player game logs, other games, and the spreadsheet itself are coach-only.
- **Easy to fix mistakes.** Every play has an Undo button, and anyone tracking can tap a player in the box score to adjust any number up or down.
- **Works with bad gym Wi-Fi.** Each tap is saved on the phone first and sent when there's a connection, so nothing is lost or double counted.

**Stats tracked:** points, 2PT and 3PT field goals (made/attempted), free throws (made/attempted), rebounds, assists, steals, blocks, turnovers, fouls, games played, and the opponent's score.

**Analysis (coach only):** team record and points for/against, stat leaders, a sortable season table (per-game or totals, with FG%, 3P%, FT%), each player's game-by-game log, full box scores, and one-tap export to **Season Stats** and **Game Log** tabs in your Google Sheet for charts and printing.

It runs free on Google Apps Script. All data lives in a Google Sheet that you own.

---

## One-time setup (about 10 minutes)

> **Which Google account?** School Google accounts often block apps that people outside the school can open. If parents get a "You need access" or "Sign in" page in step 6, redo the setup with a personal Gmail account.

1. **Create the spreadsheet.** Go to [sheets.new](https://sheets.new) and name it something like `GCS Basketball Stats`.
2. **Open the script editor.** In the sheet, click **Extensions → Apps Script**.
3. **Add the code.**
   - In the editor, `Code.gs` is already open. Delete what's there and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
   - Click **+** next to *Files*, choose **HTML**, and name it exactly `Index`. Delete what's there and paste in everything from [`apps-script/Index.html`](apps-script/Index.html).
   - Click 💾 **Save**.
4. **Run setup once.** In the toolbar's function menu, pick **`setup`** and click **▶ Run**. Google will ask you to authorize the script:
   - Choose your account.
   - If you see *"Google hasn't verified this app"*, click **Advanced → Go to (project name)**. That warning appears because you wrote the app yourself.
   - Click **Allow**.

   The log at the bottom shows **your coach PIN**. You'll also find it on the new **Settings** tab of your spreadsheet, where you can change it to any number (6+ digits recommended).
5. **Publish it as a web app.** Click **Deploy → New deployment**, then click the ⚙️ gear and pick **Web app**. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*

   Click **Deploy** and copy the **Web app URL**. That's the link for you and the parents.
6. **Open the link on your phone** and sign in with your coach PIN. Tip: use **Share → Add to Home Screen** so it opens like an app.

### Updating to a newer version later
Paste in the new code, then click **Deploy → Manage deployments → ✏️ Edit**, set **Version** to **New version**, and click **Deploy**. The link stays the same.

---

## Using it

### Before the season (Coach)
1. **Roster tab:** tap **Add many** and paste your roster, one player per line (`23 Ben Center`).
2. **Parents tab:** add each parent who'll keep stats. Each one gets a PIN. Copy the app link from that tab and text it to them with their PIN.
3. **Games tab:** add each game (opponent, date, home/away). Under **Who keeps stats?** pick the parent, or leave it as *Me (coach)*.

### Game day (Parent, or Coach)
1. Open the link and enter your PIN. Your assigned game appears. Tap **Start tracking**.
2. Uncheck anyone who isn't playing today.
3. For each play: **tap the player, then the stat**. You can also tap the stat first, then the player.
   - Green = made shot, red = missed shot. A made shot also counts as an attempt.
   - Use **+1 / +2 / +3** under the opponent's score to keep their points.
   - Tapped the wrong thing? Hit **UNDO** on the pop-up, or **Undo** next to the play in *Recent plays*.
   - Player tiles show points and fouls. Fouls turn orange at 4 and red at 5.
4. The dot at the top shows **All saved** (green), **Saving…** (yellow), or **Offline · N waiting** (red). Offline taps are kept on the phone and sent automatically once there's a connection.
5. Open **Box score** and tap any player to fix a number with − / +.
6. When the game ends, tap **Game over: submit final stats**. The game then closes on the parent's phone.

### Reviewing (Coach)
- **Season tab:** record, scoring, leaders, and the full player table. Switch between **Per game** and **Totals**, tap a column to sort, and tap a player for their game log.
- **Games tab:** each game's score and result. **Box score** lets you correct anything, even after a game is final. **Edit** changes the date, opponent, or assigned parent.
- **Update stats in Google Sheet** writes **Season Stats** and **Game Log** tabs in your spreadsheet for sorting, charts, or printing.

---

## How privacy works
- The web app runs as **you**, so only your account ever opens the spreadsheet. Parents never get access to it.
- Every request is checked on the server: a parent's PIN can only open, record, and submit **their assigned game, and only before it's final**. Season stats, other games, other parents, and the roster editor require the coach PIN.
- After 30 wrong PINs in 15 minutes, sign-in pauses for everyone for 15 minutes.
- To cut off a parent, remove them or tap **Give them a new PIN** on the Parents tab.
- To change your coach PIN, edit **Coach PIN** on the spreadsheet's **Settings** tab.

## What's in the spreadsheet
| Tab | What it holds |
| --- | --- |
| Settings | Team name, season, coach PIN |
| Players | Roster (ID, number, name, active) |
| Parents | Stat-keeper parents and their PINs |
| Games | Schedule, assigned parent, status |
| Events | Every tap (who, what, when, entered by). Box scores are totals of these rows, which keeps a full history and makes undo safe. |
| Season Stats / Game Log | Created when you tap *Update stats in Google Sheet* |

Avoid hand-editing the **Events** tab. Fix stats in the app's box score instead. You *can* safely edit names, numbers, and dates on the other tabs.

---

## For developers
```bash
npm test             # backend unit tests (Code.gs against mocked Google services)
npm run dev          # local preview at http://localhost:8080 (prints the coach PIN)
node dev/smoke.js    # end-to-end phone-sized browser test (needs Playwright)
```
- `apps-script/`: the files that get pasted into Apps Script (`appsscript.json` is included for `clasp` users).
- `dev/gas-mock.js`: in-memory stand-ins for SpreadsheetApp, LockService, and the other Google services.
- `dev/server.js`: runs `Code.gs` locally and serves `Index.html` with a `google.script.run` shim.
