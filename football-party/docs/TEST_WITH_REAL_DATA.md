# Test Pitchside with real (free) football data — 10 minutes

The default data is a small hand-made sample. This guide switches to **StatsBomb Open Data** (free, fetched from GitHub, no key) and gives you a way to verify it yourself.

## 1. Load the real data (about 2 minutes)

```bash
cd football-party
npm install
npm run sync -- --provider statsbomb      # downloads ~2,500 small JSON files, cached in .data/statsbomb-cache
```

Expected last lines: `"status": "success"` and roughly `players 6791 · teams 218 · affiliations 9453`. Re-running is instant (cache) and idempotent (`changed: 0`).

## 2. Run the data quality report

```bash
npm run data:report -- --source statsbomb
```

You should see:

- **League coverage**: which competitions/seasons exist (e.g. La Liga 18 seasons, Premier League 2003/04 + 2015/16, Ligue 1 ×3, Serie A ×2, Bundesliga ×2).
- **Spot checks** of 17 well-known facts. Each is `PASS`, `COVERAGE GAP` (true fact missing from this free data → the game would reject it) or **`WRONG`** (data says something false — this would be a real bug; the command exits non-zero). Last run: 17 PASS, 0 WRONG.
- **Playability**: grids buildable at easy/medium/hard (60/60 each last run).

## 3. Play it

```bash
FOOTBALL_PROVIDER=statsbomb npm run dev        # or put FOOTBALL_PROVIDER=statsbomb in .env
```

Open http://localhost:5173, create a room, open the link in a second browser/phone (use your LAN IP and port 5173), pick **Football Tic-Tac-Toe**.

Check these yourself:

| #   | Do this                                                                                                           | You should see                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lobby                                                                                                             | Banner says **StatsBomb Open Data… Coverage is partial**, not "Sample". `/data` shows licence + attribution + counts.             |
| 2   | Start Easy                                                                                                        | Board uses recognisable clubs/leagues/nations (Barcelona, Premier League, Italy…).                                                |
| 3   | Search "muller", "mbappe", "agüero"                                                                               | Accent-insensitive matches.                                                                                                       |
| 4   | Pick a cell, answer with a player you **know** fits (e.g. Messi for Barcelona × Argentina)                        | Square claimed on both devices.                                                                                                   |
| 5   | Answer with a player who clearly does **not** fit                                                                 | Rejected, turn passes, message names the criterion.                                                                               |
| 6   | Answer with a player who **really** fits but whose club/season isn't covered (e.g. Ronaldo × Premier League 2008) | Rejected as "isn't confirmed". This is the known trade-off of free partial data: absence ≠ false.                                 |
| 7   | Reuse a claimed footballer                                                                                        | "already used this round", turn kept.                                                                                             |
| 8   | Refresh the page mid-game                                                                                         | Same seat, same board.                                                                                                            |
| 9   | Impostor on this data: set Category "Premier League" or "Legends"                                                 | Footballers come from the loaded data. (Birth decade hint is unavailable here — StatsBomb has no birth years; use Position hint.) |

## 4. Optional: test Wikidata (needs internet access to wikidata.org)

It could not be run in the build sandbox, so **you** are the first live test:

```bash
WIKIDATA_USER_AGENT="Pitchside/0.1 (https://your.site; you@example.com)" \
WIKIDATA_MAX_PLAYERS=300 npm run sync -- --provider wikidata
npm run data:report -- --source wikidata
```

Expect many `COVERAGE GAP`s for league checks (Wikidata dates are often missing/ambiguous and the adapter deliberately refuses to guess). Any `WRONG` is a bug — please report the line.

## 5. Back to the sample / automated checks

```bash
npm run db:reset            # sample data again (dev DB only)
npm test                    # includes real-data checks when the StatsBomb cache exists
```
