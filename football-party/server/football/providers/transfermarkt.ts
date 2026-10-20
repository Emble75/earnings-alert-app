import fs from 'node:fs';
import path from 'node:path';
import { normalizeText } from '../../../shared/football/normalize';
import {
  DatasetSchema,
  type Affiliation,
  type Competition,
  type Dataset,
  type FootballPlayer,
  type Membership,
  type PositionGroupT,
  type Team,
} from '../../../shared/football/types';
import { csvRecords } from '../csv';
import { createClient } from '../http';
import type { FootballProvider, ProviderContext } from './types';

/**
 * Provider for the public GitHub datalake github.com/salimt/football-datasets (Transfermarkt data:
 * ~92,000 players, ~1.1 million transfers, national-team caps, club-per-league-per-season tables).
 *
 * WHY IT IS THE BEST FREE SOURCE WE FOUND
 *  - real Transfermarkt player and club IDs (no name-matching guesswork),
 *  - exact birth dates and country of citizenship,
 *  - complete transfer histories incl. loans, up to the repository's last update (check `generatedAt`
 *    and the `_last_modified_at` columns; mid/late 2025 at the time of writing),
 *  - a table of which club played in which competition in which season (league memberships),
 *  - national-team caps per player (so uncapped players are NOT credited with a nation),
 *  - market values (used as the popularity signal).
 *
 * LICENCE WARNING: the repository has no licence file and the data is scraped from Transfermarkt,
 * whose terms restrict re-use. Fine for private testing; do not publish or sell on it without
 * permission from the rights holders.
 */

const BASE =
  'https://raw.githubusercontent.com/salimt/football-datasets/main/datalake/transfermarkt';
const LFS =
  'https://media.githubusercontent.com/media/salimt/football-datasets/main/datalake/transfermarkt';

/** [directory/file name, served through Git LFS?] */
export const TM_FILES = {
  profiles: ['player_profiles', false],
  transfers: ['transfer_history', true], // Git LFS: the raw URL would only return a pointer file
  national: ['player_national_performances', false],
  seasons: ['team_competitions_seasons', false],
  children: ['team_children', false],
  values: ['player_market_value', false],
} as const;
export type TmFileKey = keyof typeof TM_FILES;
export type TmTexts = Record<TmFileKey, string>;

const TERMINAL = /^(retired|without club|career break|unknown|ban|suspended|\?)$/i;
/** Youth/reserve sides are not "clubs" for quiz purposes (Transfermarkt lists them as separate teams). */
const YOUTH =
  /(\bU-?\d{2}\b|\bunder[- ]?\d{2}\b|\byouth\b|\bjuniors?\b|\bjugend\b|\bprimavera\b|\bsub-?\d{2}\b|\bacademy\b|\bcadete\b|\bjuvenil\b|\bamateure?\b|\breserves?\b)/i;

const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s));
const slug = (s: string, max = 50) => normalizeText(s).replace(/ /g, '-').slice(0, max) || 'x';
/** Transfermarkt's league names differ from common usage; add the names people actually type. */
const LEAGUE_ALIASES: Record<string, string[]> = {
  ES1: ['La Liga', 'Primera Division', 'Spanish La Liga'],
  ES2: ['La Liga 2', 'Segunda Division'],
  GB1: ['Premier League', 'English Premier League', 'EPL'],
  GB2: ['Championship', 'EFL Championship'],
  L1: ['Bundesliga', '1 Bundesliga', 'German Bundesliga'],
  L2: ['2 Bundesliga', '2. Bundesliga'],
  IT1: ['Serie A', 'Italian Serie A'],
  FR1: ['Ligue 1', 'French Ligue 1'],
  NL1: ['Eredivisie'],
  PO1: ['Primeira Liga', 'Liga Portugal'],
  TR1: ['Super Lig', 'Süper Lig'],
  BE1: ['Jupiler Pro League', 'Belgian Pro League'],
  SC1: ['Scottish Premiership'],
  MLS1: ['MLS', 'Major League Soccer'],
  BRA1: ['Brasileirao', 'Serie A Brazil'],
  AR1N: ['Liga Profesional', 'Primera Division Argentina'],
};
/** "1.FC Köln" → also "FC Köln"; "Paris SG" → handled by the shared alias table. */
/** Names that collide across countries ("Bundesliga" exists in Germany and Austria). */
const LEAGUE_NAMES: Record<string, string> = { A1: 'Austrian Bundesliga', L1: 'Bundesliga' };
const clubAliases = (name: string): string[] => {
  const out = new Set<string>();
  const stripped = name.replace(/^\d+\.\s?/, '');
  if (stripped !== name) out.add(stripped);
  return [...out];
};

const cleanName = (s: string) => s.replace(/\s*\(\d+\)\s*$/, '').trim();

/** Season (start year) in which an arrival on this date first counts. June joins belong to the new season. */
const firstSeason = (y: number, m: number) => (m >= 6 ? y : y - 1);
/** Last season spent at a club that was left on this date (left before the new season's autumn ⇒ previous). */
const lastSeason = (y: number, m: number) => (m >= 9 ? y : y - 1);

function mainPosition(p: string): PositionGroupT | null {
  const x = p.toLowerCase();
  if (x.startsWith('goal')) return 'GK';
  if (x.startsWith('defen')) return 'DEF';
  if (x.startsWith('midf')) return 'MID';
  if (x.startsWith('attack') || x.startsWith('forw')) return 'FWD';
  return null;
}

interface Ev {
  ms: number;
  y: number;
  m: number;
  from: string;
  to: string;
  order: number;
}

function require_(file: string, rec: Record<string, string> | undefined, cols: string[]) {
  if (!rec) throw new Error(`${file}: file is empty`);
  const missing = cols.filter((c) => !(c in rec));
  if (missing.length)
    throw new Error(
      `${file}: missing expected columns ${missing.join(', ')} — the dataset format may have changed`,
    );
}

export interface TmBuildInfo {
  players: number;
}

/** Pure transformation of the CSV texts into our normalized dataset (unit-testable without network). */
export function buildTransfermarktDataset(files: TmTexts, generatedAt: string): Dataset {
  // ---- competitions & memberships (club ∈ league per season) ------------------------------------
  const clubName = new Map<string, { name: string; season: number }>();
  const compInfo = new Map<string, { name: string; season: number; tier: number }>();
  const memberSeasons = new Map<string, Set<number>>(); // `${club}|${comp}` -> seasons
  const TIER = new Map([
    ['First Tier', 1],
    ['Second Tier', 2],
    ['Third Tier', 3],
  ]);
  let currentSeason = 0;
  let seenSeasonsHeader = false;
  for (const r of csvRecords(files.seasons)) {
    if (!seenSeasonsHeader) {
      require_('team_competitions_seasons', r, [
        'club_id',
        'competition_id',
        'competition_name',
        'season_id',
        'season_league_level_level_name',
        'team_name',
      ]);
      seenSeasonsHeader = true;
    }
    const season = num(r.season_id);
    if (!Number.isFinite(season)) continue;
    const prev = clubName.get(r.club_id!);
    if (!prev || season >= prev.season)
      clubName.set(r.club_id!, { name: cleanName(r.team_name!), season });
    const tier = TIER.get(r.season_league_level_level_name!);
    if (!tier || !r.competition_id) continue; // youth/reserve/regional tables are not criteria
    currentSeason = Math.max(currentSeason, season);
    const c = compInfo.get(r.competition_id);
    if (!c || season >= c.season)
      compInfo.set(r.competition_id, { name: r.competition_name!, season, tier });
    const k = `${r.club_id}|${r.competition_id}`;
    (memberSeasons.get(k) ?? memberSeasons.set(k, new Set()).get(k)!).add(season);
  }

  // ---- youth / reserve teams to ignore ---------------------------------------------------------
  const childTeams = new Set<string>();
  for (const r of csvRecords(files.children))
    if (r.child_team_id && r.child_team_id !== r.parent_team_id) childTeams.add(r.child_team_id);

  // ---- profiles --------------------------------------------------------------------------------
  interface Prof {
    name: string;
    alias: string;
    birth: number | null;
    pos: PositionGroupT | null;
    cits: string[];
    current: string;
    loanFrom: string;
    dead: boolean;
  }
  const profiles = new Map<string, Prof>();
  let first = true;
  for (const r of csvRecords(files.profiles)) {
    if (first) {
      require_('player_profiles', r, [
        'player_id',
        'player_name',
        'date_of_birth',
        'citizenship',
        'main_position',
        'current_club_id',
      ]);
      first = false;
    }
    const born = /^(\d{4})-/.exec(r.date_of_birth ?? '')?.[1];
    profiles.set(r.player_id!, {
      name: cleanName(r.player_name!),
      alias: cleanName(r.name_in_home_country ?? ''),
      birth: born ? Number(born) : null,
      pos: mainPosition(r.main_position ?? ''),
      cits: (r.citizenship ?? '')
        .split(/\s{2,}/)
        .map((c) => c.trim())
        .filter(Boolean),
      current: r.current_club_id ?? '',
      loanFrom: r.on_loan_from_club_id ?? '',
      dead: !!r.date_of_death,
    });
  }

  // ---- market values (popularity) --------------------------------------------------------------
  const maxValue = new Map<string, number>();
  for (const r of csvRecords(files.values)) {
    const v = num(r.value);
    if (Number.isFinite(v) && v > (maxValue.get(r.player_id!) ?? 0)) maxValue.set(r.player_id!, v);
  }

  // ---- national teams: senior team of each country = the team with the most matches per player ----
  const natRows = new Map<string, { player: string; matches: number }[]>();
  for (const r of csvRecords(files.national)) {
    const matches = num(r.matches);
    if (!(matches > 0) || !profiles.has(r.player_id!)) continue; // uncapped players are NOT credited with a nation
    (natRows.get(r.team_id!) ?? natRows.set(r.team_id!, []).get(r.team_id!)!).push({
      player: r.player_id!,
      matches,
    });
  }
  const caps = new Map<string, number>();
  const teamCountry = new Map<string, { country: string; avg: number }>();
  for (const [team, rows] of natRows) {
    for (const x of rows) caps.set(x.player, Math.max(caps.get(x.player) ?? 0, x.matches));
    if (rows.length < 12) continue;
    const share = new Map<string, number>();
    for (const x of rows)
      for (const c of new Set(profiles.get(x.player)!.cits)) share.set(c, (share.get(c) ?? 0) + 1);
    const [country, n] = [...share].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (!country || n / rows.length < 0.8) continue; // not a clean single-country squad
    teamCountry.set(team, { country, avg: rows.reduce((s, x) => s + x.matches, 0) / rows.length });
  }
  const seniorOf = new Map<string, string>(); // country -> team id
  for (const [team, { country, avg }] of teamCountry) {
    const cur = seniorOf.get(country);
    if (!cur || avg > teamCountry.get(cur)!.avg) seniorOf.set(country, team);
  }
  const seniorTeamIds = new Map([...seniorOf].map(([country, team]) => [team, country]));

  // ---- transfers → club spells -----------------------------------------------------------------
  const events = new Map<string, Ev[]>();
  const nameFromTransfers = new Map<string, { name: string; ms: number }>();
  let order = 0;
  first = true;
  for (const r of csvRecords(files.transfers)) {
    if (first) {
      require_('transfer_history', r, [
        'player_id',
        'transfer_date',
        'from_team_id',
        'from_team_name',
        'to_team_id',
        'to_team_name',
      ]);
      first = false;
    }
    const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.transfer_date ?? '');
    if (!d || !profiles.has(r.player_id!)) continue;
    const y = Number(d[1]);
    if (y < 1900 || y > 2100 || y > currentSeason + 1) continue; // bogus future dates exist in the source
    const m = Number(d[2]);
    const ms = Date.UTC(y, m - 1, Number(d[3]));
    for (const [id, nm] of [
      [r.from_team_id!, r.from_team_name!],
      [r.to_team_id!, r.to_team_name!],
    ] as const) {
      const seen = nameFromTransfers.get(id);
      if (!seen || ms >= seen.ms) nameFromTransfers.set(id, { name: nm, ms });
    }
    const list = events.get(r.player_id!) ?? [];
    list.push({ ms, y, m, from: r.from_team_id!, to: r.to_team_id!, order: order++ });
    events.set(r.player_id!, list);
  }

  const isTerminal = (id: string) =>
    TERMINAL.test(nameFromTransfers.get(id)?.name ?? clubName.get(id)?.name ?? '');
  const displayName = (id: string) =>
    clubName.get(id)?.name ?? cleanName(nameFromTransfers.get(id)?.name ?? id);
  const isSeniorClub = (id: string) =>
    !childTeams.has(id) && !isTerminal(id) && !YOUTH.test(displayName(id));

  const affiliations: Affiliation[] = [];
  const clubUse = new Map<string, number>();
  const personIds = new Set<string>();
  const addAff = (a: Affiliation) => {
    affiliations.push(a);
    personIds.add(a.playerId);
  };
  for (const [pid, evs] of events) {
    const id = `tmk-p${pid}`;
    const prof = profiles.get(pid)!;
    // Newest rows come first in the file; reverse so that same-day chains stay in chronological order.
    const chron = evs.sort((a, b) => a.ms - b.ms || b.order - a.order);
    const open = new Map<string, number>(); // club -> first season
    const emit = (club: string, from: number, to: number | null, precision: 'season' | 'year') => {
      addAff({
        playerId: id,
        teamId: `tmk-c${club}`,
        fromSeason: from,
        toSeason: to,
        precision,
        status: 'confirmed',
        source: 'transfermarkt',
      });
      clubUse.set(club, (clubUse.get(club) ?? 0) + 1);
    };
    let lastY = 0;
    for (const e of chron) {
      lastY = Math.max(lastY, firstSeason(e.y, e.m));
      if (isSeniorClub(e.from)) {
        const start = open.get(e.from);
        const end = lastSeason(e.y, e.m);
        if (start !== undefined) {
          if (end >= start) emit(e.from, start, end, 'season');
          open.delete(e.from);
        } else emit(e.from, end, end, 'season'); // already there when the record starts: certain for its last season
      }
      if (isSeniorClub(e.to) && !open.has(e.to)) open.set(e.to, firstSeason(e.y, e.m));
    }
    for (const [club, start] of open) {
      const stillThere = club === prof.current || club === prof.loanFrom;
      if (stillThere && !prof.dead) emit(club, start, null, 'season');
      else emit(club, start, start, 'year'); // end not recorded: valid for the club square only
    }
    void lastY;
  }

  // ---- teams: only clubs that matter (appear in a league table or have enough history) ------------
  const inLeague = new Set<string>();
  for (const k of memberSeasons.keys()) inLeague.add(k.split('|')[0]!);
  const keep = (club: string) =>
    isSeniorClub(club) && (inLeague.has(club) || (clubUse.get(club) ?? 0) >= 5);
  const keptAffs = affiliations.filter((a) => keep(a.teamId.slice(5)));

  const teams = new Map<string, Team>();
  const mkTeam = (club: string) => {
    const tid = `tmk-c${club}`;
    if (teams.has(tid)) return;
    const name = displayName(club).slice(0, 80);
    teams.set(tid, {
      id: tid,
      kind: 'club',
      name,
      shortName:
        name
          .replace(/\b(FC|AFC|CF|SC)\b/gi, '')
          .replace(/[^A-Za-z]/g, '')
          .slice(0, 3)
          .toUpperCase() || 'CLB',
      country: '',
      color: '#2b3a33',
      aliases: clubAliases(name),
      source: 'transfermarkt',
      providerIds: { transfermarkt: club },
    });
  };
  for (const a of keptAffs) mkTeam(a.teamId.slice(5));

  const competitions = new Map<string, Competition>();
  const memberships: Membership[] = [];
  for (const [k, seasons] of memberSeasons) {
    const [club, comp] = k.split('|') as [string, string];
    if (!isSeniorClub(club)) continue;
    const info = compInfo.get(comp)!;
    const cid = `tmk-l-${slug(comp)}`;
    if (!competitions.has(cid))
      competitions.set(cid, {
        id: cid,
        kind: 'league',
        name: (LEAGUE_NAMES[comp] ?? info.name).slice(0, 80),
        shortName: (LEAGUE_NAMES[comp] ?? info.name).slice(0, 24),
        aliases: LEAGUE_ALIASES[comp] ?? [],
        source: 'transfermarkt',
        providerIds: { transfermarkt: comp },
      });
    mkTeam(club);
    const sorted = [...seasons].sort((a, b) => a - b);
    let start = sorted[0]!;
    let prev = start;
    const push = (a: number, b: number) =>
      memberships.push({
        teamId: `tmk-c${club}`,
        competitionId: cid,
        fromSeason: a,
        toSeason: b,
        status: 'confirmed',
        source: 'transfermarkt',
      });
    for (const y of sorted.slice(1)) {
      if (y !== prev + 1) {
        push(start, prev);
        start = y;
      }
      prev = y;
    }
    push(start, prev);
  }

  // ---- nations ---------------------------------------------------------------------------------
  const natAffs: Affiliation[] = [];
  for (const [team, rows] of natRows) {
    const country = seniorTeamIds.get(team);
    if (!country) continue;
    const tid = `tmk-n-${slug(country)}`;
    if (!teams.has(tid))
      teams.set(tid, {
        id: tid,
        kind: 'national',
        name: country,
        shortName:
          country
            .replace(/[^A-Za-z]/g, '')
            .slice(0, 3)
            .toUpperCase() || 'NAT',
        country,
        color: '#2b3a33',
        aliases: [],
        source: 'transfermarkt',
        providerIds: { transfermarkt: team },
      });
    for (const x of rows)
      natAffs.push({
        playerId: `tmk-p${x.player}`,
        teamId: tid,
        fromSeason: null,
        toSeason: null,
        precision: 'unknown',
        status: 'confirmed',
        source: 'transfermarkt',
      });
  }

  // ---- players ---------------------------------------------------------------------------------
  const allAffs = [...keptAffs, ...natAffs];
  const withAff = new Set(allAffs.map((a) => a.playerId));
  const players: FootballPlayer[] = [];
  for (const [pid, p] of profiles) {
    const id = `tmk-p${pid}`;
    if (!withAff.has(id) || !p.name) continue;
    const value = maxValue.get(pid) ?? 0;
    const c = caps.get(pid) ?? 0;
    players.push({
      id,
      name: p.name.slice(0, 80),
      aliases:
        p.alias && normalizeText(p.alias) !== normalizeText(p.name) ? [p.alias.slice(0, 80)] : [],
      birthYear: p.birth && p.birth >= 1900 && p.birth <= 2015 ? p.birth : null,
      position: p.pos,
      tier: value >= 40_000_000 || c >= 60 ? 1 : value >= 8_000_000 || c >= 15 ? 2 : 3,
      fame: Math.round(value / 250_000 + Math.min(c, 120)),
      source: 'transfermarkt',
      providerIds: { transfermarkt: pid },
    });
  }

  return DatasetSchema.parse({
    meta: {
      sourceId: 'transfermarkt',
      label: 'Transfermarkt data (salimt/football-datasets)',
      kind: 'live',
      generatedAt,
      license:
        'No licence file in the source repository; scraped from Transfermarkt (restricted re-use). Private/testing use only.',
      attribution:
        'Data originates from Transfermarkt, republished at github.com/salimt/football-datasets.',
      notes:
        'Club careers rebuilt from transfer histories (youth/reserve teams excluded); league membership from per-season league tables of tiers 1–3; nations only for players with national-team caps. Dates are day-precise in the source but windows are mapped to seasons conservatively.',
      currentSeason,
    },
    teams: [...teams.values()],
    competitions: [...competitions.values()],
    memberships,
    players,
    affiliations: allAffs,
  });
}

export interface TransfermarktOptions {
  cacheDir: string;
  /** Use already-downloaded files in this folder instead of the network (name.csv per table). */
  localDir?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function transfermarktProvider(opts: TransfermarktOptions): FootballProvider {
  return {
    sourceId: 'transfermarkt',
    label: 'Transfermarkt data (salimt/football-datasets)',
    kind: 'live',
    async fetchDataset(ctx: ProviderContext): Promise<Dataset> {
      const http = createClient({
        userAgent: 'Pitchside/0.1 (open-data reader)',
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: ctx.log,
        signal: ctx.signal,
        timeoutMs: 300_000,
      });
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      const texts = {} as TmTexts;
      for (const key of Object.keys(TM_FILES) as TmFileKey[]) {
        const [name, lfs] = TM_FILES[key];
        const local = opts.localDir ? path.join(opts.localDir, `${name}.csv`) : null;
        const cacheFile = path.join(opts.cacheDir, `${name}.csv`);
        if (local && fs.existsSync(local)) texts[key] = fs.readFileSync(local, 'utf8');
        else if (fs.existsSync(cacheFile)) texts[key] = fs.readFileSync(cacheFile, 'utf8');
        else {
          ctx.log.info('transfermarkt: downloading', { file: name });
          const text = await http.text(`${lfs ? LFS : BASE}/${name}/${name}.csv`);
          if (text.startsWith('version https://git-lfs'))
            throw new Error(`${name}: got a Git LFS pointer instead of data`);
          fs.writeFileSync(cacheFile, text);
          texts[key] = text;
        }
      }
      ctx.log.info('transfermarkt: building dataset');
      return buildTransfermarktDataset(texts, (opts.now ?? (() => new Date()))().toISOString());
    },
  };
}
