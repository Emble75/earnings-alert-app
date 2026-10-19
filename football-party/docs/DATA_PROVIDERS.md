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

## Decision

1. **Wikidata is the implemented live provider** (`server/football/providers/wikidata.ts`): it is the only free source found that models dated club history, it has a permissive licence, and it needs no secret.
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
