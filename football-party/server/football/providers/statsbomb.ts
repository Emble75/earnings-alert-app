import fs from 'node:fs';
import path from 'node:path';
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
import { createJsonClient } from '../http';
import type { FootballProvider, ProviderContext } from './types';

/**
 * StatsBomb Open Data provider (https://github.com/statsbomb/open-data), read from the public
 * GitHub raw files — no API key.
 *
 * WHY IT IS TRUSTWORTHY: every fact is derived from a real match lineup. A player is affiliated with
 * a team for a season only if they actually PLAYED (non-empty `positions`) for that team in a match
 * of that season; a team belongs to a league for a season only if it played a league match in it.
 *
 * WHY IT IS PARTIAL: StatsBomb publishes only selected competitions/seasons (e.g. Premier League
 * 2003/04 and 2015/16, Barcelona's La Liga matches 2004/05–2020/21, major international
 * tournaments). Absence of a record therefore means "not in this data", never "false". The game
 * already fails closed: unverified answers are rejected as "not confirmed".
 *
 * TERMS (from the repository README): if you publish or share analysis/insights based on this data
 * you must state StatsBomb as the source and use their logo (Media Pack). Commercial use beyond
 * that is not addressed in the README — confirm with StatsBomb before commercial deployment.
 */

const RAW = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';

const LEAGUES = new Set(['Premier League', 'La Liga', 'Serie A', 'Ligue 1', '1. Bundesliga']);
const TOURNAMENTS = new Set([
  'FIFA World Cup',
  'UEFA Euro',
  'Copa America',
  'African Cup of Nations',
]);

export interface SbCompetition {
  competition_id: number;
  season_id: number;
  competition_name: string;
  season_name: string;
  country_name?: string;
  competition_gender: string;
}
export interface SbMatch {
  match_id: number;
  home_team: { home_team_id: number; home_team_name: string; country?: { name: string } };
  away_team: { away_team_id: number; away_team_name: string; country?: { name: string } };
}
export interface SbLineup {
  team_id: number;
  team_name: string;
  lineup: {
    player_id: number;
    player_name: string;
    player_nickname: string | null;
    positions: { position: string }[];
  }[];
}

export function wantedCompetitions(all: SbCompetition[]): SbCompetition[] {
  return all.filter((c) => {
    if (c.competition_gender !== 'male') return false;
    if (TOURNAMENTS.has(c.competition_name)) return true;
    // Only European-style "YYYY/YYYY" league seasons map cleanly onto our season model.
    return LEAGUES.has(c.competition_name) && /^\d{4}\/\d{4}$/.test(c.season_name);
  });
}

export function positionGroup(position: string): PositionGroupT | null {
  const p = position.toLowerCase();
  if (p.includes('goalkeeper')) return 'GK';
  if (p.includes('back')) return 'DEF';
  if (p.includes('midfield')) return 'MID';
  if (p.includes('forward') || p.includes('striker') || p.includes('wing')) return 'FWD';
  return null;
}

const seasonStart = (name: string) => Number(name.slice(0, 4));

/** Merges a set of season years into contiguous [from, to] ranges. */
export function contiguousRanges(years: Iterable<number>): [number, number][] {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const y of sorted) {
    const last = out[out.length - 1];
    if (last && y === last[1] + 1) last[1] = y;
    else out.push([y, y]);
  }
  return out;
}

export interface SbInput {
  competition: SbCompetition;
  matches: { match: SbMatch; lineups: SbLineup[] }[];
}

const fameScore = (r: { apps: number; tournaments: Set<string> }) =>
  r.apps + 15 * r.tournaments.size;

/** Pure transformation from raw StatsBomb records into our normalized, validated dataset. */
export function buildStatsBombDataset(inputs: SbInput[], generatedAt: string): Dataset {
  const teams = new Map<string, Team>();
  const competitions = new Map<string, Competition>();
  const leagueSeasons = new Map<string, Set<number>>(); // `${teamId}|${compId}` -> seasons
  const clubSeasons = new Map<string, Set<number>>(); // `${playerId}|${teamId}` -> seasons
  const nationalTeams = new Set<string>(); // `${playerId}|${teamId}`
  const players = new Map<
    string,
    {
      name: string;
      aliases: Set<string>;
      apps: number;
      tournaments: Set<string>;
      pos: Map<PositionGroupT, number>;
    }
  >();

  for (const { competition: c, matches } of inputs) {
    const isLeague = LEAGUES.has(c.competition_name);
    const compId = `sb-c${c.competition_id}`;
    if (!competitions.has(compId)) {
      competitions.set(compId, {
        id: compId,
        kind: isLeague ? 'league' : 'international',
        name: c.competition_name === '1. Bundesliga' ? 'Bundesliga' : c.competition_name,
        shortName: (c.competition_name === '1. Bundesliga'
          ? 'Bundesliga'
          : c.competition_name
        ).slice(0, 24),
        country: isLeague ? c.country_name : undefined,
        aliases: c.competition_name === '1. Bundesliga' ? ['1. Bundesliga'] : [],
        source: 'statsbomb',
        providerIds: { statsbomb: String(c.competition_id) },
      });
    }
    const season = isLeague ? seasonStart(c.season_name) : null;

    for (const { match, lineups } of matches) {
      for (const [id, name, country] of [
        [
          match.home_team.home_team_id,
          match.home_team.home_team_name,
          match.home_team.country?.name,
        ],
        [
          match.away_team.away_team_id,
          match.away_team.away_team_name,
          match.away_team.country?.name,
        ],
      ] as const) {
        const tid = `sb-t${id}`;
        if (!teams.has(tid))
          teams.set(tid, {
            id: tid,
            kind: isLeague ? 'club' : 'national',
            name: name.slice(0, 80),
            shortName:
              name
                .replace(/[^A-Za-z]/g, '')
                .slice(0, 3)
                .toUpperCase() || 'TBD',
            country: (country ?? '').slice(0, 60),
            color: '#2b3a33',
            aliases: [],
            source: 'statsbomb',
            providerIds: { statsbomb: String(id) },
          });
        if (isLeague && season !== null) {
          const k = `${tid}|${compId}`;
          leagueSeasons.set(k, (leagueSeasons.get(k) ?? new Set()).add(season));
        }
      }
      for (const side of lineups) {
        const tid = `sb-t${side.team_id}`;
        for (const p of side.lineup) {
          if (p.positions.length === 0) continue; // unused substitute: did not play
          const pid = `sb-p${p.player_id}`;
          const rec = players.get(pid) ?? {
            name: '',
            aliases: new Set<string>(),
            apps: 0,
            tournaments: new Set<string>(),
            pos: new Map(),
          };
          rec.name = (p.player_nickname ?? p.player_name).slice(0, 80);
          if (p.player_nickname && p.player_nickname !== p.player_name)
            rec.aliases.add(p.player_name.slice(0, 80));
          rec.apps += 1;
          const g = positionGroup(p.positions[0]!.position);
          if (g) rec.pos.set(g, (rec.pos.get(g) ?? 0) + 1);
          players.set(pid, rec);
          if (isLeague && season !== null) {
            const k = `${pid}|${tid}`;
            clubSeasons.set(k, (clubSeasons.get(k) ?? new Set()).add(season));
          } else {
            nationalTeams.add(`${pid}|${tid}`);
            rec.tournaments.add(`${c.competition_id}/${c.season_id}`);
          }
        }
      }
    }
  }

  const memberships: Membership[] = [];
  for (const [k, seasons] of leagueSeasons) {
    const [teamId, competitionId] = k.split('|') as [string, string];
    for (const [from, to] of contiguousRanges(seasons))
      memberships.push({
        teamId,
        competitionId,
        fromSeason: from,
        toSeason: to,
        status: 'confirmed',
        source: 'statsbomb',
      });
  }
  const affiliations: Affiliation[] = [];
  for (const [k, seasons] of clubSeasons) {
    const [playerId, teamId] = k.split('|') as [string, string];
    for (const [from, to] of contiguousRanges(seasons))
      affiliations.push({
        playerId,
        teamId,
        fromSeason: from,
        toSeason: to,
        precision: 'season',
        status: 'confirmed',
        source: 'statsbomb',
      });
  }
  for (const k of nationalTeams) {
    const [playerId, teamId] = k.split('|') as [string, string];
    affiliations.push({
      playerId,
      teamId,
      fromSeason: null,
      toSeason: null,
      precision: 'unknown',
      status: 'confirmed',
      source: 'statsbomb',
    });
  }

  const playerList: FootballPlayer[] = [...players].map(([id, r]) => {
    const pos = [...r.pos].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      id,
      name: r.name,
      aliases: [...r.aliases].slice(0, 4),
      birthYear: null,
      position: pos,
      // Fame proxy (this data has no popularity signal): appearances, with international tournaments
      // weighted heavily because club coverage is skewed toward a few teams (e.g. Barcelona).
      tier: fameScore(r) >= 80 ? 1 : fameScore(r) >= 30 ? 2 : 3,
      fame: fameScore(r),
      source: 'statsbomb',
      providerIds: { statsbomb: id.slice(4) },
    };
  });

  const clubYears = [...clubSeasons.values()].flatMap((s) => [...s]);
  return DatasetSchema.parse({
    meta: {
      sourceId: 'statsbomb',
      label: 'StatsBomb Open Data',
      kind: 'live',
      generatedAt,
      license:
        'StatsBomb Open Data terms (see repository README): attribution to StatsBomb required when publishing analysis.',
      attribution:
        'Data provided by StatsBomb (https://github.com/statsbomb/open-data). StatsBomb is a trademark of its owners.',
      notes:
        'Match-lineup evidence only: covers selected competitions and seasons, not every career. A missing record means "not in this data". Fame tiers are a proxy based on appearances in this data.',
      currentSeason: clubYears.length
        ? Math.max(...clubYears)
        : new Date(generatedAt).getUTCFullYear(),
    },
    teams: [...teams.values()],
    competitions: [...competitions.values()],
    memberships,
    players: playerList,
    affiliations,
  });
}

export interface StatsBombOptions {
  cacheDir: string;
  /** Cap on matches fetched per competition-season (quick smoke runs). 0 = no cap. */
  maxMatchesPerSeason?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  baseUrl?: string;
}

export function statsbombProvider(opts: StatsBombOptions): FootballProvider {
  return {
    sourceId: 'statsbomb',
    label: 'StatsBomb Open Data',
    kind: 'live',
    async fetchDataset(ctx: ProviderContext): Promise<Dataset> {
      const base = opts.baseUrl ?? RAW;
      const getJson = createJsonClient({
        userAgent: 'Pitchside/0.1 (open-data reader)',
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: ctx.log,
        signal: ctx.signal,
      });
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      // Files at a pinned commit-less URL can change; the cache is a politeness measure, not a source of truth.
      const cached = async <T>(rel: string): Promise<T> => {
        const file = path.join(opts.cacheDir, rel.replace(/\//g, '_'));
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
        const data = await getJson<T>(`${base}/${rel}`);
        fs.writeFileSync(file, JSON.stringify(data));
        return data;
      };
      const pool = async <T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> => {
        const out: R[] = new Array(items.length);
        let i = 0;
        await Promise.all(
          Array.from({ length: Math.min(n, items.length) }, async () => {
            while (i < items.length) {
              const idx = i++;
              out[idx] = await fn(items[idx]!);
            }
          }),
        );
        return out;
      };

      const comps = wantedCompetitions(await cached<SbCompetition[]>('competitions.json'));
      ctx.log.info('statsbomb: competition-seasons selected', { count: comps.length });
      const inputs: SbInput[] = [];
      let done = 0;
      for (const competition of comps) {
        let matches = await cached<SbMatch[]>(
          `matches/${competition.competition_id}/${competition.season_id}.json`,
        );
        if (opts.maxMatchesPerSeason) matches = matches.slice(0, opts.maxMatchesPerSeason);
        const withLineups = await pool(matches, opts.concurrency ?? 6, async (match) => {
          const lineups = await cached<SbLineup[]>(`lineups/${match.match_id}.json`);
          if (++done % 200 === 0) ctx.log.info('statsbomb: lineups fetched', { done });
          return { match, lineups };
        });
        inputs.push({ competition, matches: withLineups });
      }
      return buildStatsBombDataset(inputs, (opts.now ?? (() => new Date()))().toISOString());
    },
  };
}
