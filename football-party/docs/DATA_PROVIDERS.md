# Football data: provider research, selection and policy

Pitchside's Tic-Tac-Toe needs **historical** facts (player ↔ team with season ranges, club ↔ league with season ranges). Most "football APIs" are built for live scores and current squads, so this requirement drives the choice.

## What was (and was not) verified

Research was done on 2026-10-19 from this build environment. **Official provider documentation sites were not reachable from the sandbox** (DNS/egress blocked), so the table below is based on web-search summaries and third-party comparison pages, not on reading the official docs or terms. Treat every figure as _unverified_ and re-check before committing.

| Source                       | Historical team membership with dates                                                         | Cost / limits (as reported by third parties, unverified)                                      | Key/terms notes                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Wikidata** (property P54)  | Yes — `member of sports team` with start/end-time qualifiers, but crowd-sourced and patchy    | Free, no key. Query-service limits (60 s processing per 60 s per client; User-Agent required) | CC0 data. Requires descriptive User-Agent. No images/logos.                               |
| API-Football (api-sports.io) | Reported to have `players`, `transfers` and per-team seasons endpoints; depth by plan unclear | Free: ~100 req/day, ~10 req/min; paid from ~US$19/mo (reported)                               | Key required (server-side only). Logo/photo usage rights must be read in their terms.     |
| football-data.org            | Competitions/teams/squads; free tier reported as current-season only, 12 competitions         | Free: 10 req/min; paid plans from ~€12/mo (reported)                                          | Sources disagree on whether the free tier includes player data. Not suitable for history. |
| Sportmonks                   | Teams, squads, players, transfers                                                             | League-based plans from ~€29/mo; free plan covers 2 leagues (reported)                        | Terms/logo rights not verified.                                                           |

## Update 4: `dcaribou` (CC0 — the publishable option)

`server/football/providers/dcaribou.ts` reads the Kaggle dataset [davidcariboo/player-scores](https://www.kaggle.com/datasets/davidcariboo/player-scores) (repo `dcaribou/transfermarkt-datasets`, **CC0**). It converts the tables to the shape of the Transfermarkt builder: careers from `transfers.csv`, season-exact leagues from `games.csv`, national-team caps counted from `appearances.csv`.

```
pip install kagglehub && python -c 'import kagglehub;print(kagglehub.dataset_download("davidcariboo/player-scores"))'
DCARIBOU_DIR=<that folder> FOOTBALL_PROVIDER=dcaribou npm run sync
npm run data:report -- --source dcaribou
```

Residual risk: the data was scraped from Transfermarkt, whose terms are separate from the CC0 licence — get legal advice before commercial use. Not live-tested in the build sandbox (Kaggle is blocked there); covered by a fixture test using the real column names.

## Update 3: `transfermarkt` (best free source, data up to Aug 2025)

`server/football/providers/transfermarkt.ts` builds the dataset from the Transfermarkt scrape published as [salimt/football-datasets](https://github.com/salimt/football-datasets) (profiles, dated transfer history, national-team caps, league tables per club and season, market values). Reep (withqwerty/reep) was evaluated and rejected: it is an ID crosswalk, not career data.

- Club spells come from transfer dates (June joins count for the new season); open spells at the current club stay open; youth/reserve sides and "Retired / Without club" are ignored.
- Leagues come from per-season league tables, so "played in the Bundesliga" is season-exact (Lucas Vázquez at Leverkusen 2025 counts; Jorge Meré at Köln counts, Spain correctly does not).
- Nations require actual senior caps; fame = market value + caps.
- Last live sync: **85,237 players · 11,595 clubs · 214 competitions · 579,100 dated affiliations**; 47/47 spot checks correct, 0 wrong (`npm run data:report -- --source transfermarkt`). Party mode ships ~5.6 MB gzipped.
- Licence: the repository carries no licence and its content derives from Transfermarkt → **private/testing use only**.

Run: `FOOTBALL_PROVIDER=transfermarkt npm run sync` (downloads ~100 MB, one-time; set `TRANSFERMARKT_LOCAL_DIR` to use files you already have).

## Update 2: broad coverage via "opendata" (transfers + World Cup squads)

StatsBomb alone misses most careers (e.g. Ashley Young at Premier League and Inter). `opendata` (`server/football/providers/opendata.ts`) combines two GitHub datasets, both fetched live in this environment:

| Dataset              | What it gives                                                                                                                                                                                                        | Licence                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ewenme/transfers`   | Every transfer of 9 leagues (Premier League, Championship, La Liga, Serie A, Bundesliga, Ligue 1, Eredivisie, Liga NOS, Russian PL), 1992/93–2022/23 → club spells with season ranges, league memberships, positions | **No licence file; derived from Transfermarkt.** Use for private testing only. Do not ship publicly/commercially on it without permission. |
| `jfjelstul/worldcup` | Men's World Cup squads 1930–2022 → national teams, exact birth years                                                                                                                                                 | CC-BY-SA 4.0 (attribution + share-alike)                                                                                                   |

Result of the last live sync: **39,010 players · 5,874 teams · 136,600 dated affiliations**; 38/38 checkable spot-facts correct, 0 wrong (`npm run data:report -- --source opendata`).

How careers are reconstructed: arrival and departure transfer windows → season ranges (summer departure in year Y ⇒ last season Y−1; winter ⇒ Y). Loans and returns become separate spells. Counterpart club names that differ between files ("Man Utd" vs "Manchester United") are unified by pairing the same transfer's two rows; unmatched ones are real outside clubs (known, dates unknown ⇒ valid for club squares only). Players have no ids in the source, so identity = name + birth-year estimate from transfer ages; World Cup links need name **and** birth year to agree. Ages outside 14–50 are ignored.

Limits: the archive stops in 2022 (no 2023+ moves); only moves involving the 9 leagues are recorded (a player who only ever played elsewhere is absent); nations are World-Cup-squad only (no Euro/Copa-only players); fame tiers are a proxy (transfer fees + World Cup appearances).

## Update: StatsBomb Open Data — tested live, now the recommended free source

After the sandbox could only reach `raw.githubusercontent.com`, StatsBomb's public open-data repository turned out to be a better free source than Wikidata for _verifiability_: facts come from real match lineups (a player is affiliated with a team for a season only if they **played** for it; a club is in a league for a season only if it **played a league match**). It needs no key and was **fetched and validated live in this environment**.

- Implemented in `server/football/providers/statsbomb.ts`; run `npm run sync -- --provider statsbomb` (see [TEST_WITH_REAL_DATA.md](TEST_WITH_REAL_DATA.md)).
- Result of the last live sync: 6,791 players · 218 teams · 9,453 dated affiliations · 211 league-season memberships · 0 conflicts. Spot checks of 17 well-known facts: 17 correct, 0 wrong.
- **Partial by design**: selected competitions only (men's: La Liga 2004/05–2020/21 mostly Barcelona's matches plus a 1973/74 season, Premier League 2003/04 and 2015/16, Serie A 2015/16 and 1986/87, Ligue 1 2015/16 + 2021/22 + 2022/23, Bundesliga 2015/16 + 2023/24, and World Cups, Euros, Copa América, AFCON for national teams). True facts outside these seasons are missing, so the game rejects them as "not confirmed".
- **No popularity or birth-year signal**: fame tiers are a proxy (appearances + tournament participation) and `shared/football/prominence.ts` holds a small list of recognisable clubs to keep Easy/Medium grids sensible.
- **Terms** (repository README): when publishing or sharing analysis/insights based on the data, credit StatsBomb and use their logo from the Media Pack. The app shows textual attribution on `/data`; the **logo is not bundled** — add it from StatsBomb's Media Pack if you publish publicly. The README doesn't address commercial use: confirm with StatsBomb before commercial deployment.

## Decision

1. **StatsBomb Open Data is the recommended free provider today** (see update above). **Wikidata is also implemented** (`server/football/providers/wikidata.ts`): it is the only free source found that models dated club history, it has a permissive licence, and it needs no secret.
2. It is **not complete or authoritative**. The adapter therefore treats anything it cannot date unambiguously as `year`/`unknown` precision, and those records are _excluded_ from league validation (see below).
3. **The adapter has not been run against the live service** from this environment (egress to wikidata.org was blocked). Its parsing and season derivation are unit-tested against fixtures in the documented `wbgetentities` shape. First step after deploying: `npm run sync -- --provider wikidata` and inspect `/admin`.
4. For a production-grade dataset the likely best path is a paid provider with a transfers/career endpoint (API-Football or Sportmonks) behind the same `FootballProvider` interface — **not implemented**, because it cannot be built or tested without credentials and without reading the provider's terms. See "Adding a provider".
5. The bundled **sample** dataset (`data/sample/sample.ts`) powers local development, tests, demos and offline practice. It is hand-curated, limited to 20 clubs / 23 nations / 97 players, snapshot as of the 2024-25 season, and always labelled "sample" in the UI, the API (`kind: "sample"`) and the admin page.

## Data model (see `db/migrations/001_init.sql`)

- `seasons` — explicit season table (`start_year` = 2003 means 2003-04, 1 Jul–30 Jun).
- `teams` (club | national), `competitions`, `competition_memberships` (team ∈ competition for seasons `[from, to]`, `to = NULL` ongoing).
- `players`, `player_affiliations` (player ↔ team, `from_season`/`to_season`, `precision`, `status`).
- `data_sources` (licence, attribution, generated-at, last-synced-at), `sync_runs`, `data_conflicts`.
- Every row carries `source_id` and timestamps; entities carry `provider_ids`.

### Validation rules (`shared/football/index.ts → verdict`)

- _Club / national team_: valid iff a **confirmed** affiliation with that team exists.
- _League_: valid iff a **confirmed, season-precision** affiliation at a club overlaps (in seasons) a **confirmed** membership of that club in that league. Example modelled in the sample: Juventus played 2006-07 in Serie B; Atlético Madrid was outside La Liga for 2000-01 and 2001-02; Manchester City 2001-02 outside the Premier League.
- `status = unknown`, `precision = year|unknown` records are stored but **never** make an answer valid. The game says "can't verify from our data" instead of guessing.
- A grid is only generated when all 9 cells have at least N verified answers (3/2/1 for easy/medium/hard). If the data can't support one, the game refuses to start (`insufficient-data`).

### Sync pipeline (`server/football/sync.ts`)

provider → zod validation → sanitise (dangling refs and possible duplicates become explicit `data_conflicts`; no fuzzy merging) → transactional idempotent upsert (unchanged rows are not rewritten) → prune rows the source no longer contains → rebuild the in-memory index. Safeguards: empty-snapshot refusal, **shrink guard** (<50% of stored affiliations aborts), one sync at a time, 20-minute timeout, retries with exponential backoff + `Retry-After` in the HTTP client, client-side request spacing. Staleness is reported after `STALE_AFTER_HOURS` (default 72) for live sources.

## Rights policy for images and marks

No crests, flags, portraits or logos are bundled or hot-linked. Teams are shown as text monograms in a kit colour; players as names. Before any licensed imagery is added, record the provider's terms in `data_sources.license`/`attribution` and in this file. Wikidata data requires no attribution (CC0) but attribution is shown on `/data` anyway.

## Adding a provider

1. Create `server/football/providers/<name>.ts` exporting a `FootballProvider` (`sourceId`, `label`, `kind`, `fetchDataset(ctx)`) that returns a `Dataset` (zod-validated; ids must be lowercase `[a-z0-9_.:-]`).
2. Read keys from env **server-side only**; use `createJsonClient` for polite retries/backoff.
3. Register it in `createProvider` (`server/football/sync.ts`) and in `config.ts`'s `FOOTBALL_PROVIDER` enum.
4. Map only facts the provider states explicitly; mark anything dated loosely as `precision: 'year'` or `status: 'unknown'`.
5. Add fixture-based tests like `tests/data-sync.test.ts`, then run `npm run sync -- --provider <name>` with real credentials and review `/admin`.

For an offline ETL path today, produce a JSON file matching `DatasetSchema` and run `npm run sync -- --provider file --file ./dataset.json` (validate first with `npm run data:validate -- ./dataset.json`).
