import fs from 'node:fs';
import path from 'node:path';
import type { Dataset } from '../../../shared/football/types';
import { csvRecords } from '../csv';
import type { FootballProvider, ProviderContext } from './types';
import { fetchCareers, type WdSpell } from '../wikidata-careers';
import { buildTransfermarktDataset, type TmTexts } from './transfermarkt';

/**
 * dcaribou/transfermarkt-datasets ("player-scores" on Kaggle, CC0). Its tables are converted into the
 * shape the Transfermarkt builder already understands, so both sources share one career/league logic:
 *  - transfers.csv           → transfer history (future-dated contract end rows are re-dated by season)
 *  - games.csv + clubs.csv   → per-season league tables (club ∈ domestic league in that season)
 *  - appearances.csv         → national-team caps (appearances for a national_teams id)
 *  - players.csv             → profiles + market-value popularity (highest value)
 */
export const DCARIBOU_FILES = [
  'players',
  'transfers',
  'clubs',
  'competitions',
  'games',
  'appearances',
  'national_teams',
] as const;
export type DcaribouTexts = Record<(typeof DCARIBOU_FILES)[number], string>;

/** competitions.csv names are slugs ("premier-league"); show proper names. */
const PRETTY: Record<string, string> = {
  GB1: 'Premier League',
  GB2: 'Championship',
  ES1: 'LaLiga',
  ES2: 'LaLiga 2',
  L1: 'Bundesliga',
  L2: '2. Bundesliga',
  IT1: 'Serie A',
  IT2: 'Serie B',
  FR1: 'Ligue 1',
  FR2: 'Ligue 2',
  NL1: 'Eredivisie',
  PO1: 'Liga Portugal',
  TR1: 'Süper Lig',
  BE1: 'Jupiler Pro League',
  SC1: 'Scottish Premiership',
  MLS1: 'Major League Soccer',
  BRA1: 'Brasileirão Série A',
  AR1N: 'Liga Profesional',
  A1: 'Austrian Bundesliga',
  C1: 'Swiss Super League',
  GR1: 'Super League Greece',
  RU1: 'Russian Premier League',
  UKR1: 'Ukrainian Premier League',
  DK1: 'Danish Superliga',
  NO1: 'Eliteserien',
  SE1: 'Allsvenskan',
  PL1: 'Ekstraklasa',
  TS1: 'Czech First League',
  KR1: 'Croatian HNL',
  SER1: 'Serbian SuperLiga',
};
const titleCase = (slug: string) =>
  slug.replace(/-/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());

const q = (s: string | undefined) => `"${(s ?? '').replace(/"/g, '""')}"`;
const row = (...cols: (string | number | undefined)[]) =>
  cols.map((c) => q(String(c ?? ''))).join(',');

const need = (table: string, r: Record<string, string>, cols: string[]) => {
  const missing = cols.filter((c) => !(c in r));
  if (missing.length)
    throw new Error(
      `${table}.csv: missing columns ${missing.join(', ')} (have: ${Object.keys(r).join(', ')})`,
    );
};

/** "25/26" → 2025; "99/00" → 1999. */
const seasonStart = (s: string) => {
  const m = /^(\d{2})\/(\d{2})$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  return a >= 50 ? 1900 + a : 2000 + a;
};

export function convertDcaribou(t: DcaribouTexts, now: Date, wd: WdSpell[] = []): TmTexts {
  const tierOf: Record<string, string> = {
    first_tier: 'First Tier',
    second_tier: 'Second Tier',
    third_tier: 'Third Tier',
  };
  // competitions: only domestic leagues become league criteria
  const comps = new Map<string, { name: string; tier: string }>();
  let chk = true;
  for (const r of csvRecords(t.competitions)) {
    if (chk) need('competitions', r, ['competition_id', 'name', 'sub_type', 'type']);
    chk = false;
    const tier = tierOf[r.sub_type!];
    if (r.type === 'domestic_league' && tier)
      comps.set(r.competition_id!, {
        name: PRETTY[r.competition_id!] ?? titleCase(r.name!),
        tier,
      });
  }
  const clubName = new Map<string, string>();
  chk = true;
  for (const r of csvRecords(t.clubs)) {
    if (chk) need('clubs', r, ['club_id', 'name']);
    chk = false;
    clubName.set(r.club_id!, r.name!);
  }

  // ---- league tables from games ----
  const seen = new Set<string>();
  const seasons = [
    'club_id,competition_id,competition_name,season_id,season_league_level_level_name,team_name',
  ];
  chk = true;
  for (const r of csvRecords(t.games)) {
    if (chk)
      need('games', r, [
        'competition_id',
        'season',
        'home_club_id',
        'away_club_id',
        'home_club_name',
      ]);
    chk = false;
    const c = comps.get(r.competition_id!);
    if (!c) continue;
    for (const [id, nm] of [
      [r.home_club_id!, r.home_club_name!],
      [r.away_club_id!, r.away_club_name!],
    ] as const) {
      const key = `${id}|${r.competition_id}|${r.season}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seasons.push(row(id, r.competition_id, c.name, r.season, c.tier, clubName.get(id) ?? nm));
    }
  }

  // ---- national teams ----
  const nationalIds = new Set<string>();
  chk = true;
  for (const r of csvRecords(t.national_teams)) {
    if (chk) need('national_teams', r, ['national_team_id']);
    chk = false;
    nationalIds.add(r.national_team_id!);
  }
  const caps = new Map<string, number>(); // `${player}|${team}` -> matches
  const played = new Map<string, Set<number>>(); // `${player}|${club}` -> seasons with a club appearance
  chk = true;
  for (const r of csvRecords(t.appearances)) {
    if (chk) need('appearances', r, ['player_id', 'player_club_id']);
    chk = false;
    if (!nationalIds.has(r.player_club_id!)) {
      const m = /^(\d{4})-(\d{2})/.exec(r.date ?? '');
      if (m) {
        const season = Number(m[2]) >= 7 ? Number(m[1]) : Number(m[1]) - 1;
        const key = `${r.player_id}|${r.player_club_id}`;
        (played.get(key) ?? played.set(key, new Set()).get(key)!).add(season);
      }
      continue;
    }
    const k = `${r.player_id}|${r.player_club_id}`;
    caps.set(k, (caps.get(k) ?? 0) + 1);
  }
  const national = ['player_id,team_id,matches'];
  for (const [k, n] of caps) {
    const [p, tm] = k.split('|');
    national.push(row(p, tm, n));
  }

  // consecutive appearance seasons at one club become spells (2012+ careers are complete this way)
  const spells = ['player_id,club_id,from,to,precision'];
  for (const [key, set] of played) {
    const [p, c] = key.split('|');
    const ys = [...set].sort((a, b) => a - b);
    let from = ys[0]!;
    let prev = from;
    for (const y of [...ys.slice(1), Infinity]) {
      if (y !== prev + 1) {
        spells.push(row(p, c, from, prev, 'season'));
        from = y;
      }
      prev = y;
    }
  }

  // Wikidata careers (CC0), keyed by Transfermarkt ids: year-precision, club-only evidence
  const names = ['club_id,name'];
  for (const [id, nm] of clubName) names.push(row(id, nm));
  for (const w of wd) {
    spells.push(row(w.tm, w.club, w.from, w.to, 'year'));
    if (w.clubName && !clubName.has(w.club)) names.push(row(w.club, w.clubName));
  }

  // ---- profiles + values ----
  const profiles = [
    'player_id,player_name,date_of_birth,citizenship,main_position,current_club_id,on_loan_from_club_id,date_of_death',
  ];
  const values = ['player_id,date_unix,value'];
  chk = true;
  for (const r of csvRecords(t.players)) {
    if (chk)
      need('players', r, [
        'player_id',
        'name',
        'date_of_birth',
        'country_of_citizenship',
        'position',
      ]);
    chk = false;
    profiles.push(
      row(
        r.player_id,
        r.name,
        r.date_of_birth,
        r.country_of_citizenship,
        r.position,
        r.current_club_id,
      ),
    );
    if (r.highest_market_value_in_eur)
      values.push(row(r.player_id, '2000-01-01', r.highest_market_value_in_eur));
  }

  // ---- transfers ----
  const horizon = now.getTime() + 120 * 86_400_000;
  const transfers = [
    'player_id,transfer_date,from_team_id,from_team_name,to_team_id,to_team_name,transfer_fee',
  ];
  chk = true;
  for (const r of csvRecords(t.transfers)) {
    if (chk)
      need('transfers', r, [
        'player_id',
        'transfer_date',
        'from_club_id',
        'to_club_id',
        'transfer_season',
      ]);
    chk = false;
    let date = r.transfer_date!.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (Date.parse(date) > horizon) {
      // contract-end placeholders (e.g. 2030-06-30): use the stated season's start instead
      const y = seasonStart(r.transfer_season ?? '');
      if (y === null) continue;
      date = `${y}-07-01`;
    }
    transfers.push(
      row(
        r.player_id,
        date,
        r.from_club_id,
        r.from_club_name,
        r.to_club_id,
        r.to_club_name,
        r.transfer_fee,
      ),
    );
  }

  return {
    profiles: profiles.join('\n'),
    transfers: transfers.join('\n'),
    national: national.join('\n'),
    seasons: seasons.join('\n'),
    children: 'parent_team_id,child_team_id\n',
    spells: spells.join('\n'),
    names: names.join('\n'),
    values: values.join('\n'),
  };
}

export function buildDcaribouDataset(
  t: DcaribouTexts,
  generatedAt: string,
  wd: WdSpell[] = [],
): Dataset {
  const ds = buildTransfermarktDataset(convertDcaribou(t, new Date(generatedAt), wd), generatedAt);
  const own = <T extends { source: string }>(xs: T[]): T[] =>
    xs.map((x) => ({ ...x, source: 'dcaribou' }));
  return {
    ...ds,
    teams: own(ds.teams),
    competitions: own(ds.competitions),
    memberships: own(ds.memberships),
    affiliations: own(ds.affiliations),
    players: ds.players.map((p) => ({ ...p, source: 'dcaribou' })),
    meta: {
      ...ds.meta,
      sourceId: 'dcaribou',
      label: 'Transfermarkt player-scores (dcaribou)',
      license:
        'CC0 1.0 (dcaribou/transfermarkt-datasets). The data was scraped from Transfermarkt; its terms of use are a residual risk for commercial publication.',
      attribution: 'dcaribou/transfermarkt-datasets (CC0), derived from Transfermarkt.',
      notes:
        'Club careers from transfer records; leagues from per-season games; national teams from caps counted in appearances. Youth/reserve sides are excluded.',
    },
  };
}

export interface DcaribouOptions {
  /** Folder with the extracted Kaggle files (players.csv, transfers.csv, …). */
  dir: string;
  /** Wikidata (CC0) fills pre-2012 careers; skipped gracefully when unreachable. */
  wikidata?: { enabled: boolean; cacheFile: string; userAgent: string; fetchImpl?: typeof fetch };
  now?: () => Date;
}

export function dcaribouProvider(opts: DcaribouOptions): FootballProvider {
  return {
    sourceId: 'dcaribou',
    label: 'Transfermarkt player-scores (dcaribou, CC0)',
    kind: 'live',
    async fetchDataset(ctx: ProviderContext): Promise<Dataset> {
      const texts = {} as DcaribouTexts;
      for (const name of DCARIBOU_FILES) {
        const file = path.join(opts.dir, `${name}.csv`);
        if (!fs.existsSync(file))
          throw new Error(
            `dcaribou: ${file} not found. Download https://www.kaggle.com/datasets/davidcariboo/player-scores and set DCARIBOU_DIR to the extracted folder.`,
          );
        texts[name] = fs.readFileSync(file, 'utf8');
      }
      let wd: WdSpell[] = [];
      if (opts.wikidata?.enabled) {
        // Notable players only: that is who Wikidata knows well and who the games ask for.
        const ids: string[] = [];
        for (const r of csvRecords(texts.players)) {
          const value = Number(r.highest_market_value_in_eur);
          if (value >= 1_000_000 || Number(r.international_caps) >= 10) ids.push(r.player_id!);
        }
        ctx.log.info('dcaribou: fetching careers from Wikidata', { players: ids.length });
        wd = await fetchCareers(ids, { ...opts.wikidata, log: ctx.log });
        ctx.log.info('dcaribou: Wikidata career statements', { count: wd.length });
      }
      ctx.log.info('dcaribou: building dataset');
      return buildDcaribouDataset(texts, (opts.now ?? (() => new Date()))().toISOString(), wd);
    },
  };
}
