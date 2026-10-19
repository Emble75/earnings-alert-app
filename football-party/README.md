# Pitchside — football party games

Mobile-first, installable (PWA) party games for friends: open a link, make or join a room with a 5-letter code, play. No accounts.

- **Football Impostor** — social deduction. Crew all see the same footballer; the impostor doesn't. Clues → discussion → vote → reveal, multi-round scoring.
- **Football Tic-Tac-Toe** — each row/column is a club, nation or league; name a footballer who fits both. Every answer is validated **on the server** against dated records.
- **Game framework** — modular registry (`shared/games`), shared rooms/identity/timers/scoring, plus an **offline practice mode** (clearly labelled _local, not multiplayer_).

> **Two ways to play.** _One phone_: pass a single phone around in person (roles and votes are hidden between hand-overs, clues are said out loud; Tic-Tac-Toe also works against the computer). _Online_: everyone on their own phone via a room code. Timers can be switched off in both.

> **Data honesty.** The default dataset is a small **hand-curated sample** (97 players, 20 clubs, snapshot 2024-25), labelled "sample" everywhere. For **broad real data** (~39,000 players, 9 European leagues 1992–2022, World Cup squads) run `npm run sync -- --provider opendata` (private/testing use — see licence notes in docs/DATA_PROVIDERS.md). For a smaller, cleanly verified set run `npm run sync -- --provider statsbomb` (StatsBomb Open Data: ~6,800 players, verified from match lineups, partial coverage) — see [docs/TEST_WITH_REAL_DATA.md](docs/TEST_WITH_REAL_DATA.md) and [docs/DATA_PROVIDERS.md](docs/DATA_PROVIDERS.md).

## Quick start

Requires Node ≥ 20 (developed on 22). No database to install: it falls back to embedded PGlite (Postgres-in-WASM).

```bash
cd football-party
npm install
npm run dev          # API on :8787 + web on http://localhost:5173
```

Open http://localhost:5173, create a room, then open the invite link in another browser/device on the same network (use your machine's LAN IP and port 5173) to join.

Production-style run (single process serves the API, WebSocket and built client):

```bash
npm run build
npm start            # http://localhost:8787
```

## Scripts

| Command                                 | What it does                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                           | API (tsx watch) + Vite dev server with proxy for `/api` and `/ws`                                                |
| `npm run build` / `npm start`           | Build client (`dist/`) and bundle server (`dist-server/`) / run it                                               |
| `npm run check`                         | format check + lint + typecheck + unit/integration tests + build                                                 |
| `npm test`                              | Vitest: rules, scoring, eligibility, affiliations, room transitions, HTTP + WebSocket integration, sync pipeline |
| `npm run test:e2e`                      | Playwright (mobile + desktop viewports) against the built app; run `npm run build` first                         |
| `npm run db:migrate`                    | Apply SQL migrations in `db/migrations`                                                                          |
| `npm run db:seed`                       | Upsert the sample dataset                                                                                        |
| `npm run db:reset`                      | **Destructive**: drop everything, re-migrate, re-seed (refuses remote DBs without `--yes`)                       |
| `npm run sync [-- --provider wikidata]` | Run one data sync (see below)                                                                                    |
| `npm run data:validate [-- file.json]`  | Schema + referential integrity check of the sample or a dataset file                                             |
| `npm run icons`                         | Re-render PWA PNG icons from `public/icons/icon.svg` (uses Chromium)                                             |

`TEST_DATABASE_URL=postgres://… npx vitest run --no-file-parallelism` runs the same server/data suites against a real PostgreSQL (the tests drop and recreate the `public` schema — use a throwaway database).

## Configuration (`.env.example`, placeholders only)

| Variable                                         | Purpose                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                   | PostgreSQL 14+ URL. Unset → embedded PGlite in `.data/pglite`. `DB_MODE=memory` → throwaway.                                    |
| `FOOTBALL_PROVIDER`                              | `sample` (default), `wikidata`, or `file` (+ `FOOTBALL_IMPORT_FILE`).                                                           |
| `SYNC_INTERVAL_HOURS`                            | Scheduled sync for non-sample providers (0 = off). `STALE_AFTER_HOURS` (72) drives the stale flag.                              |
| `WIKIDATA_USER_AGENT`                            | Required by Wikimedia: descriptive UA with contact info. `WIKIDATA_MAX_PLAYERS`, `WIKIDATA_QID_FILE` tune scope.                |
| `ADMIN_TOKEN`                                    | Enables `/admin` and `/api/admin/*` (sync status, manual resync). Unset → admin disabled. Generate with `openssl rand -hex 32`. |
| `PUBLIC_ORIGIN`                                  | Extra allowed WebSocket origin (if the client is served from another origin).                                                   |
| `PORT`, `HOST`, `LOG_LEVEL`, `ROOM_IDLE_MINUTES` | Server basics.                                                                                                                  |

API keys never reach the client: providers run server-side only.

## Architecture

```
shared/            isomorphic TypeScript (runs on server AND in the browser)
  football/        normalized model (zod), FootballIndex: search, validation, grid generation
  games/           GameModule contract, registry, impostor, tictactoe, practice bot
  room/            pure room engine (join/host/config/start/actions/timers/rematch), per-player views
server/            Fastify HTTP + ws WebSocket, rooms manager, DB (pg | PGlite), providers, sync, profiles
src/               React client: design system (src/ui, src/styles), screens, game screens, hooks
db/migrations/     SQL schema
data/sample/       clearly-labelled sample dataset
e2e/ tests/        Playwright / Vitest
```

- **Server-authoritative.** Clients send intent (`game.action`); the server validates, applies, and pushes each player **their own projection** (`buildRoomView`). Impostor secrets exist only in server state and in the crew's own view; tests assert the footballer's name never appears in any message sent to the impostor.
- **Timers.** Deadlines are server epoch-ms; clients compute a clock offset from each state message, so countdowns match across devices. A 500 ms server ticker advances phases; disconnected players' turns are skipped after ~3 s.
- **Identity & reconnect.** Creating/joining returns `{playerId, token}` (192-bit random). The token is stored on the device, sent in the first WebSocket message (never in URLs), and re-attaches the seat after refreshes/network drops. The client reconnects with backoff, and the server always sends a full state first (resync). Duplicate submissions are de-duplicated by nonce and are idempotent by phase/turn checks.
- **Safety.** zod validation on every message, per-IP HTTP rate limits, per-socket token bucket, 8 KB frame limit, WebSocket origin check, nickname sanitising (control/bidi/zero-width stripped, unique per room), host-only commands, room expiry, strict CSP + security headers, secrets redacted from structured logs.
- **Adding a game:** implement `GameModule` in `shared/games/<id>.ts`, register it in `shared/games/registry.ts`, add its view type to `GameViewEnvelope` (`shared/room/types.ts`), and add metadata + screen in `src/games/meta.ts` / `registry.tsx`. Rooms, roster, timers, host controls, rematch, session totals and offline mode come for free.

### Real multiplayer vs. local demo

- **Multiplayer** (`/r/CODE`): WebSocket to the server; works across devices. State lives in server memory.
- **One phone** (`/party`): the same engine runs in your browser, on the server's active dataset (fetched compactly; falls back to the bundled sample when offline). Tic-Tac-Toe: 2–8 friends in teams, or vs the computer. Impostor: 3–8 players, spoken clues. The UI says it's not online multiplayer.

## Football data & sync

See [docs/DATA_PROVIDERS.md](docs/DATA_PROVIDERS.md) for the provider research, what is and isn't verified, validation rules and how to add a provider.

```bash
npm run sync -- --provider statsbomb      # free, no key, verified live (cached in .data/)
npm run data:report -- --source statsbomb # quality report + spot checks
npm run sync                              # sample (no-op after seeding)
WIKIDATA_USER_AGENT="Pitchside/0.1 (https://you.example; you@example.com)" \
  npm run sync -- --provider wikidata     # live Wikidata (see caveat: untested live)
```

Admin: set `ADMIN_TOKEN`, open `/admin`, paste it. Shows source, last success, age, staleness, counts, conflicts, recent runs, and a **Resync now** button. Scheduled sync: `SYNC_INTERVAL_HOURS` (in-process timer).

## Deployment

`Dockerfile` (multi-stage, non-root, health-checked), `fly.toml` and `render.yaml` are provided but **nothing is deployed by this repo**.

```bash
docker build -t pitchside . && docker run -p 8080:8080 -e DATABASE_URL=... -e ADMIN_TOKEN=... pitchside
# Fly:   fly launch --no-deploy && fly secrets set ADMIN_TOKEN=... DATABASE_URL=... && fly deploy
```

**Scaling:** rooms are in memory, so run **one instance**. Horizontal scale needs sticky routing per room code or a shared room store/pub-sub (not implemented). Behind a proxy, set `NODE_ENV=production` so client IPs come from `X-Forwarded-For`. CI is in `.github/workflows/football-party-ci.yml` (runs against real Postgres).

## Troubleshooting

- **`Executable doesn't exist` from Playwright** — the cached Chromium revision differs from the installed Playwright. Either `npx playwright install chromium`, or set `CHROMIUM_PATH` (the config also auto-detects `chromium-*` under `PLAYWRIGHT_BROWSERS_PATH`).
- **Fonts fall back to system fonts** — the CSP is strict (`font-src 'self'`); fonts are shipped as files (`assetsInlineLimit: 0`). Don't re-enable inlining.
- **"Your seat in this room is gone"** — the room expired (inactivity), the server restarted (rooms are in memory), or the host removed you.
- **Can't join from a phone in dev** — use `http://<LAN-IP>:5173`; the dev proxy forwards `/api` and `/ws`.
- **Tic-Tac-Toe says "can't support a verifiable grid"** — the loaded dataset lacks enough confirmed, dated records for that difficulty. Use an easier setting or sync more data.
- **`db:reset` refuses** — it will not touch a remote database without `--yes`.

## Implemented features

Landing page; create/join by code or link; guest nicknames; optional device-local profile with stats and delete; roster with host crown, kick, live presence; host-controlled game choice and settings; timers; session totals across games; rematch; reconnect/resync; invalid-code, full-room, in-progress, name-taken, offline and kicked states; error boundary; PWA manifest, icons and service worker; preferences (sound — off by default, haptics, calm motion + `prefers-reduced-motion`); skip link, keyboard-navigable pickers/radiogroups, live regions; admin sync page; data & rights page.

## Test and build results (this repository state)

| Check                                                                           | Result                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prettier --check` / `eslint` / `tsc --noEmit`                                  | clean                                                                                                                                                                                                                     |
| Vitest (PGlite)                                                                 | 78 tests, 7 files, all passing                                                                                                                                                                                            |
| Vitest against PostgreSQL 16 (`TEST_DATABASE_URL`)                              | 78 tests, all passing                                                                                                                                                                                                     |
| Playwright (mobile 390×844 + desktop 1280×800)                                  | 20 tests passing: landing, invalid codes, 3-device Impostor round with rematch, 2-device Tic-Tac-Toe with server validation + reload-reconnect + rejected answer, empty search state, offline practice vs bot, PWA assets |
| axe-core (WCAG 2 A/AA) on play, lobby, Tic-Tac-Toe, role card, mobile + desktop | 0 violations                                                                                                                                                                                                              |
| Production build                                                                | client ≈ 95 kB gzip initial JS; game engine chunk ≈ 43 kB gzip loads on room entry                                                                                                                                        |

## Known limitations

- **Out of the box the data is the sample set.** The free StatsBomb data was synced and played live here, but it is partial (selected competitions/seasons; true facts outside them are rejected as "not confirmed") and has no birth years. The Wikidata adapter is unit-tested on fixtures but **was not run against the live service** (egress blocked in the build sandbox). Commercial providers (API-Football, Sportmonks…) are researched but **not implemented** (need keys + terms review).
- Official provider docs/terms could not be fetched here; pricing and limits in the research are third-party-reported.
- Rooms are in-memory and single-instance; a server restart ends running games.
- League validation uses season granularity; mid-season loans and winter moves are treated as "registered that season".
- Impostor has no free-text moderation beyond sanitising; there is no profanity filter (host can remove players).
- Sound effects are simple synthesized blips; no audio assets are shipped.
- Not tested on real iOS/Android devices; verified in Chromium at phone and desktop viewports only. Haptics only fire where `navigator.vibrate` exists.
- No real-money, ads, analytics or tracking of any kind.

## Next highest-value improvements

1. Run the Wikidata sync live, review `/admin` conflicts, and curate a QID list; or integrate a paid provider with a licensed transfers/career endpoint.
2. Shared room store (Redis/Postgres + pub/sub) for multi-instance deploys and server-restart resilience.
3. More criteria (trophies, managers, shirt numbers) and a daily-grid mode.
4. Spectator mode and reconnect-to-lobby for late joiners.
5. Real-device testing, i18n, and an automated visual regression suite.
