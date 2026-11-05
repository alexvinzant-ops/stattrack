# GCS Hoops Stats

A simple GameChanger-style stat tracker for GCS Boys' Basketball.

- **Parents keep the stats.** Each parent gets their own 4-digit PIN. You assign a parent to a game, and on game day they open the link on their phone and tap the player, then the stat.
- **You decide who sees what.** By default a parent only sees the one game you assign them, and only until they submit it. On the **Access** tab you can give individual people more: tracking any game, fixing box scores, read-only season stats, or assistant-coach access. The spreadsheet, PINs, and access settings are always yours alone.
- **Easy to fix mistakes.** Every play has an Undo button, and anyone tracking can tap a player in the box score to adjust any number up or down.
- **Works with bad gym Wi-Fi.** Each tap is saved on the phone first and sent when there's a connection, so nothing is lost or double counted.

**Stats tracked:** points, 2PT and 3PT field goals (made/attempted), free throws (made/attempted), rebounds, assists, steals, blocks, turnovers, fouls, and games played. **Opponents** can be tracked the same way, either by jersey number or as one team, or you can just keep their score.

**Analysis:** team record and points for/against, stat leaders, a sortable season table (per-game or totals, with FG%, 3P%, FT%), each player's game-by-game log, full box scores for both teams, an **Us vs. opponents** comparison, and one-tap export to **Season Stats** and **Game Log** tabs in your Google Sheet.

It runs free on Google Apps Script. All data lives in a Google Sheet that you own.

---

## Sharing with other coaches (no Apps Script needed)
Other coaches don't need to touch any code. You keep one **template** spreadsheet that already has the app inside and share its "Make a copy" link. Each coach then does this:

1. Open your link and click **Make a copy**. The copy, and all of their team's data, lives in **their** Google Drive.
2. In their copy, click **🏀 Team Stats → Set up my app**. Approve Google's permission screens. If you see *"Google hasn't verified this app"*, click **Advanced → Go to Team Stats**.
3. The first time only, Google may ask them to switch on the **Google Apps Script API**. The setup window links straight to that switch and has a **Try again** button.
4. Their app link and coach PIN appear. They're done, and can continue with *Using it* below.

If Google ever refuses to publish automatically, the setup window shows a 1-minute manual alternative (Deploy → Web app → Anyone).

**Making the template (you, once):**
1. Create a blank Google Sheet named like `Team Stats (template)` with a **Start Here** tab of instructions.
2. **Extensions → Apps Script.** Paste [`Code.gs`](apps-script/Code.gs) and add an HTML file named `Index` with [`Index.html`](apps-script/Index.html).
3. In the editor's **Project Settings** (⚙️), tick **Show "appsscript.json" manifest file in editor**. Then open `appsscript.json` and replace it with [`appsscript.json`](apps-script/appsscript.json). Save.
4. Don't run setup in the template. Close the editor.
5. **Share → General access → Anyone with the link → Viewer.**
6. Copy the sheet's link and change the ending from `/edit…` to `/copy`. That's the link to send coaches.

Each copy automatically gets its own coach PIN and an empty parents list, even if the template had data in it.

## One-time setup (about 10 minutes)

> **Which Google account?** School Google accounts often block apps that people outside the school can open. If parents get a "You need access" or "Sign in" page in step 6, redo the setup with a personal Gmail account.

1. **Create the spreadsheet.** Go to [sheets.new](https://sheets.new) and name it something like `GCS Basketball Stats`.
2. **Open the script editor.** In the sheet, click **Extensions → Apps Script**.
3. **Add the code.** (To copy a file from GitHub, open it and click the **Copy raw file** button ⧉ above the code.)
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
2. **Access tab:** add each parent who'll keep stats. Each one gets a PIN. Tap **Edit** to choose what they can do (see *Access levels* below). Copy the app link from that tab and text it to them with their PIN.
3. **Games tab:** add each game (opponent, date, home/away), or tap **Add many** and paste your schedule, one game per line (`11/10 Louisiana School for the Deaf, home`, `12/8 @ Dodson`, `1/4 Hicks, neutral, Tournament`). Under **Who keeps stats?** pick the parent, or leave it as *Coach*. You can also type the opponent's jersey numbers here if you know them.

### Access levels
**You (the coach PIN) always see everything.** For everyone else, tap **Edit** on the Access tab. The screen has two numbered steps:

**1. During games: what do they track?**
- **Which games:** only games you assign them (Games tab → Edit → *Who keeps stats?*), or any game that isn't over.
- **Which stats they enter:** points & shooting, rebounds, assists, steals, blocks, turnovers, fouls, and the opponent's stats & score. Their tracker only shows those buttons, and the server refuses anything else.
  To **split a game**, tick several parents under *Who keeps stats?* and give each one different stats (e.g. one does scoring, another rebounds/assists/steals).
- **Can fix numbers in the box score** (− / +). Undoing their own taps always works.
- **Their own player(s):** a separate personal record that never changes the official stats.

While a game is going, anyone tracking it sees that game's live numbers.

**2. After games: what can they see?**
- **Nothing** (the default, recommended): they enter stats, the game closes on their phone, and only you see the results.
- **Only their own player(s):** official stats for the players ticked in step 1.
- **The whole team:** season stats, player game logs, and every box score (read only).
- **Which stats they can see:** e.g. rebounds and assists only. Everything else is hidden, and the server never sends it to them.

**Advanced → Assistant coach:** edit roster and schedule, track or fix any game, and see all stats. Never sees PINs, contact info, or the Access screen.

Only you can see PINs, phone numbers, emails, and access settings, add or remove people, delete games, or export to the spreadsheet.

### Parents who follow one player
On the Access tab, tap **Edit** on a parent and tick their player(s) under **Their players**. They can then keep **their own record** of those players at any game, even while another parent keeps the team stats.
- Their record is **kept separately and never changes the official stats.** You'll see it under **Parent records** in that game's box score, with any numbers that differ from the official stats highlighted.
- In step 2, choose **Only their own player(s)** if you want them to be able to look up their player's official numbers.

### Inviting parents
Add a parent's **email** and/or **cell number** when you add them (Access → + Add person), and their invite opens right away:
- **Email it** sends the invite from your own Gmail, automatically. **Email invites (N)** on the Access tab emails everyone who hasn't been invited yet.
- **Text to (number)** opens Messages on your phone with the number and message filled in. Just tap Send. (Google can't send texts by itself.)
- Each person shows **Invited** or **Not invited yet**. Giving someone a new PIN resets this so you remember to send the new one.

You can always tap **Invite** next to a person later. You get a ready-to-send message with the app link, their PIN, their games, and five simple steps. Tap **Copy** (or **Text it** on a phone). Parents can also tap **First time? How it works** on the sign-in screen.

Want a shorter link? Make a free one at [tinyurl.com](https://tinyurl.com) with a custom name (e.g. `tinyurl.com/gcs-hoops`) that points to your app link.

**Only the coach PIN** can see PINs, add or remove people, change access, delete games, change team settings, or export to the spreadsheet. Unticking **Can sign in** turns someone off without deleting them.

### Game day (Parent, or Coach)
1. Open the link and enter your PIN. Your assigned game appears. Tap **Start tracking**.
2. Uncheck anyone who isn't playing today.
3. For each play: **tap the player, then the stat**. You can also tap the stat first, then the player.
   - Green = made shot, red = missed shot. A made shot also counts as an attempt. Rebounds are **O-REB** (offensive) or **D-REB** (defensive).
   - Use **+1 / +2 / +3** under the opponent's score to keep their points.
   - Tapped the wrong thing? Hit **UNDO** on the pop-up, or **Undo** next to the play in *Recent plays*. **All plays this game** lists every play entered on that phone, grouped by quarter, each with Undo, so you can fix a mistake from an earlier quarter.
   - Player tiles show points and fouls. Fouls turn orange at 4 and red at 5.
4. **Quarters:** tap **Q1 / Q2 / Q3 / Q4 / OT** under the score when the quarter changes (after OT, a **2OT** button appears, and so on). Every stat is recorded with its quarter. Team fouls for the current quarter show right there (handy for the bonus), and the box score shows scoring and fouls **by quarter**.
5. The dot at the top shows **All saved** (green), **Saving…** (yellow), or **Offline · N waiting** (red). Offline taps are kept on the phone and sent automatically once there's a connection.
6. **Opponent stats (optional):** tap the opponent's name in the toggle above the player tiles. Tap **Opponent numbers** to enter their jerseys (`4, 12 Smith, 23`), then track them exactly like your players. Use the **TEAM** tile for anything you can't attribute to a number. If you only care about their score, ignore all this and use the **+1 / +2 / +3** buttons.
7. Open **Box score** and tap any player to fix a number with − / +. The opponent has its own box score below yours. Use **Game / Q1–Q4 / OT** at the top of the box score to see one quarter or overtime on its own. When fixing, pick **which quarter** the correction belongs to (it starts on the current quarter).
8. When the game ends, tap **Game over: submit final stats** at the bottom of the Track screen (the coach sees **End game (mark final)**). The game then closes on the parent's phone.

### Reviewing (Coach, and anyone you let see the whole team)
- **Season tab:** record, scoring, leaders, and the full player table. Switch between **Per game** and **Totals**, tap a column to sort, and tap a player for their game log. **Us vs. opponents** compares shooting, rebounds, turnovers, etc. per game, using only games where opponent stats were kept.
- **Player trends:** tap a player (Season tab) to see a bar chart of their points, rebounds, assists, steals, turnovers, fouls, FG% or FT% game by game, with the season average. Parents allowed to see their own player get the same chart.
- **Live bench view:** open a live game's box score and it updates by itself every few seconds while a parent keeps stats. Alerts show players at 3+ fouls and when either team is in the bonus (5th team foul in a quarter).
- **Printable box score:** open any game's **Box score** and tap **🖨 Printable box score**, then **Print / Save as PDF**. It's a clean one-page sheet with scoring by quarter and both teams' box scores (coach only).
- **Games tab:** each game's score and result. **Box score** lets you correct anything, even after a game is final. **Edit** changes the date, opponent, or assigned parent.
- **Update stats in Google Sheet** writes **Season Stats** and **Game Log** tabs in your spreadsheet for sorting, charts, or printing.

---

## How privacy works
- The web app runs as **you**, so only your account ever opens the spreadsheet. Parents never get access to it.
- Every request is checked on the server against that person's access. With no extra access, a parent's PIN can only open, record, and submit **their assigned game, and only before it's final**.
- PINs, access settings, the app link, and the spreadsheet link are only ever sent to the coach PIN.
- After 30 wrong PINs in 15 minutes, sign-in pauses for everyone for 15 minutes.
- To cut off a parent, untick **Can sign in**, remove them, or tap **Give them a new PIN** on the Access tab.
- To change your coach PIN, edit **Coach PIN** on the spreadsheet's **Settings** tab.

## What's in the spreadsheet
| Tab | What it holds |
| --- | --- |
| Settings | Team name, season, coach PIN |
| Players | Roster (ID, number, name, active) |
| Parents | People who can sign in, their PINs, and their access switches (TRUE/FALSE) |
| Games | Schedule, assigned stat keeper, status, opponent jersey numbers |
| Events | Every tap (who, what, when, entered by). Opponent players appear as `opp:23` (or `opp:team`). Box scores are totals of these rows, which keeps a full history and makes undo safe. |
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
