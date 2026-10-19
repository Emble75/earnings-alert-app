import fs from 'node:fs';
import path from 'node:path';
import { normalizeText } from '../../../shared/football/normalize';
import { isProminentClub } from '../../../shared/football/prominence';
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
import { createClient } from '../http';
import type { FootballProvider, ProviderContext } from './types';

/**
 * "Open data" provider: broad career coverage assembled from two public GitHub datasets.
 *
 *  1. ewenme/transfers — player transfers of 9 European leagues since 1992/93 (Premier League,
 *     Championship, La Liga, Serie A, Bundesliga, Ligue 1, Eredivisie, Liga NOS, Russian Premier
 *     Liga), scraped from Transfermarkt. Club spells are RECONSTRUCTED from arrival/departure
 *     transfer windows. Data ends in 2022 (the repository stopped updating).
 *  2. jfjelstul/worldcup — FIFA men's World Cup squads 1930–2022 (CC-BY-SA 4.0) for national teams
 *     and exact birth dates.
 *
 * LICENCE WARNING: (1) has NO licence file and derives from Transfermarkt, whose terms restrict
 * re-use. Fine for private testing; do NOT ship publicly/commercially on it without permission or a
 * licensed provider. (2) requires attribution and share-alike.
 *
 * IDENTITY: the transfer files carry no player ids. Events are grouped by normalized name and
 * clustered by birth-year estimate (transfer age); people with the same name and an inconsistent
 * age become separate players. Linking to World Cup records needs name AND birth year to agree.
 * Nothing is fuzzy-matched beyond that.
 */

const RAW = 'https://raw.githubusercontent.com';
export const TRANSFER_FILES = [
  'premier-league',
  'championship',
  'primera-division',
  'serie-a',
  '1-bundesliga',
  'ligue-1',
  'eredivisie',
  'liga-nos',
  'premier-liga',
];
/** The season (start year) the transfer archive ends with. */
const DATA_END_SEASON = 2022;

// ---------------------------------------------------------------- CSV

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export interface TransferRow {
  club_name: string;
  player_name: string;
  age: string;
  position: string;
  club_involved_name: string;
  fee: string;
  fee_cleaned: string;
  transfer_movement: string;
  transfer_period: string;
  league_name: string;
  year: string;
  country: string;
}
export interface WcSquadRow {
  tournament_name: string;
  team_id: string;
  team_name: string;
  player_id: string;
  family_name: string;
  given_name: string;
  position_code: string;
}
export interface WcPlayerRow {
  player_id: string;
  family_name: string;
  given_name: string;
  birth_date: string;
  female: string;
}

// ---------------------------------------------------------------- helpers

const slug = (s: string, max = 60) =>
  normalizeText(s).replace(/ /g, '-').replace(/-+/g, '-').slice(0, max) || 'x';

export function positionOf(raw: string): PositionGroupT | null {
  const p = raw.toLowerCase();
  if (p.includes('goal')) return 'GK';
  // Midfield first: "Defensive Midfield" must not be read as a defender.
  if (p.includes('midfield')) return 'MID';
  if (p.includes('back') || p.includes('defen') || p.includes('sweeper')) return 'DEF';
  if (
    p.includes('winger') ||
    p.includes('forward') ||
    p.includes('striker') ||
    p.includes('attack')
  )
    return 'FWD';
  return null;
}

const JUNK_CLUB = /^(-|\?|without club|retired|career break|unknown|suspended|\s*)$/i;
const cleanClub = (s: string) => s.trim();

/** t orders transfer windows: summer of season y < winter of season y (which happens in January y+1). */
const tOf = (year: number, winter: boolean) => year * 2 + (winter ? 1 : 0);
/** Last season a player was registered at a club he LEFT in the given window. */
const lastSeasonWhenLeaving = (year: number, winter: boolean) => (winter ? year : year - 1);

interface Ev {
  t: number;
  year: number;
  winter: boolean;
  club: string;
  dir: 'in' | 'out';
  other: string;
  fee: number;
}
interface Person {
  name: string;
  estimates: number[];
  events: Map<string, Ev>;
  positions: Map<PositionGroupT, number>;
  maxFee: number;
  birth: number | null; // exact (from World Cup data)
  wcTournaments: number;
  nationTeams: Set<string>;
}

const rangeOf = (p: Person): [number, number] => {
  const lo = Math.max(...p.estimates) - 1;
  const hi = Math.min(...p.estimates);
  return lo <= hi ? [lo, hi] : [Math.round((lo + hi) / 2), Math.round((lo + hi) / 2)];
};

export interface OpenDataInput {
  transfers: TransferRow[];
  wcSquads: WcSquadRow[];
  wcPlayers: WcPlayerRow[];
}

/** Pure transformation into the normalized dataset (unit-testable without network). */
export function buildOpenDataset(input: OpenDataInput, generatedAt: string): Dataset {
  const rows = input.transfers.filter(
    (r) => r.player_name && r.club_name && r.year && /^(in|out)$/.test(r.transfer_movement),
  );
  const primary = new Set(rows.map((r) => r.club_name));

  // 1) Alias votes: the same transfer appears as "in" at one club and "out" at another, each naming
  //    the counterpart differently ("Man Utd" vs "Manchester United"). Pair them to unify names.
  const votes = new Map<string, Map<string, number>>();
  const vote = (alias: string, club: string) => {
    if (primary.has(alias) || JUNK_CLUB.test(alias)) return;
    const m = votes.get(alias) ?? new Map();
    m.set(club, (m.get(club) ?? 0) + 1);
    votes.set(alias, m);
  };
  const byTransfer = new Map<string, TransferRow[]>();
  for (const r of rows) {
    const k = `${normalizeText(r.player_name)}|${r.year}|${r.transfer_period}`;
    const l = byTransfer.get(k) ?? [];
    l.push(r);
    byTransfer.set(k, l);
  }
  for (const list of byTransfer.values()) {
    const ins = list.filter((r) => r.transfer_movement === 'in');
    const outs = list.filter((r) => r.transfer_movement === 'out');
    if (ins.length === 1 && outs.length === 1 && ins[0]!.club_name !== outs[0]!.club_name) {
      vote(cleanClub(ins[0]!.club_involved_name), outs[0]!.club_name);
      vote(cleanClub(outs[0]!.club_involved_name), ins[0]!.club_name);
    }
  }
  const alias = new Map<string, string>();
  for (const [a, m] of votes) alias.set(a, [...m].sort((x, y) => y[1] - x[1])[0]![0]);
  const resolveOther = (name: string): { club: string; outside: boolean } | null => {
    const n = cleanClub(name);
    if (JUNK_CLUB.test(n)) return null;
    if (primary.has(n)) return { club: n, outside: false };
    const a = alias.get(n);
    return a ? { club: a, outside: false } : { club: n, outside: true };
  };

  // 2) People: group by name, split by birth-year estimate.
  const byName = new Map<string, Person[]>();
  const leagueOf = new Map<string, { league: string; country: string; seasons: Set<number> }>();
  for (const r of rows) {
    const year = Number(r.year);
    const winter = r.transfer_period === 'Winter';
    const age = Number(r.age);
    // Ages outside a plausible playing range are data glitches: ignore them rather than guess.
    const est =
      Number.isFinite(age) && age >= 14 && age <= 50 ? year + (winter ? 1 : 0) - age : NaN;
    const lk = r.club_name;
    const lg = leagueOf.get(lk) ?? {
      league: r.league_name,
      country: r.country,
      seasons: new Set<number>(),
    };
    lg.seasons.add(year);
    leagueOf.set(lk, lg);

    const key = normalizeText(r.player_name);
    const list = byName.get(key) ?? [];
    let person = list.find(
      (p) =>
        Number.isNaN(est) ||
        p.estimates.length === 0 ||
        Math.max(est, ...p.estimates) - Math.min(est, ...p.estimates) <= 2,
    );
    if (!person) {
      person = {
        name: r.player_name,
        estimates: [],
        events: new Map(),
        positions: new Map(),
        maxFee: 0,
        birth: null,
        wcTournaments: 0,
        nationTeams: new Set(),
      };
      list.push(person);
      byName.set(key, list);
    }
    if (!Number.isNaN(est)) person.estimates.push(est);
    const fee = Number(r.fee_cleaned);
    if (Number.isFinite(fee)) person.maxFee = Math.max(person.maxFee, fee);
    const pg = positionOf(r.position);
    if (pg) person.positions.set(pg, (person.positions.get(pg) ?? 0) + 1);
    const ev: Ev = {
      t: tOf(year, winter),
      year,
      winter,
      club: r.club_name,
      dir: r.transfer_movement as 'in' | 'out',
      other: r.club_involved_name,
      fee: Number.isFinite(fee) ? fee : 0,
    };
    person.events.set(`${ev.club}|${ev.dir}|${ev.t}|${ev.other}`, ev);
  }

  // 3) World Cup squads: nations, exact birth years, tournaments; link to people by name + birth year.
  const wcBirth = new Map(
    input.wcPlayers
      .filter((p) => p.female !== '1')
      .map((p) => [p.player_id, Number(p.birth_date.slice(0, 4))] as const)
      .filter(([, y]) => y >= 1850 && y <= 2015),
  );
  const nations = new Map<string, Team>();
  const wcAdds = new Map<
    string,
    {
      name: string;
      birth: number;
      pos: PositionGroupT | null;
      teams: Set<string>;
      tournaments: Set<string>;
    }
  >();
  const personsFlat = () => [...byName.values()].flat();
  const nationName = (n: string) => (n === 'West Germany' ? 'Germany' : n);
  for (const s of input.wcSquads) {
    if (!s.tournament_name.includes("Men's") || !wcBirth.has(s.player_id)) continue;
    const tname = nationName(s.team_name);
    const tid = `wc-${slug(tname)}`;
    if (!nations.has(tid))
      nations.set(tid, {
        id: tid,
        kind: 'national',
        name: tname,
        shortName:
          tname
            .replace(/[^A-Za-z]/g, '')
            .slice(0, 3)
            .toUpperCase() || 'NAT',
        country: tname,
        color: '#2b3a33',
        aliases: [],
        source: 'opendata',
        providerIds: {},
      });
    const given = s.given_name === 'not applicable' ? '' : s.given_name;
    const full = `${given} ${s.family_name}`.trim();
    const key = normalizeText(full);
    const birth = wcBirth.get(s.player_id)!;
    const candidates = byName.get(key) ?? [];
    const match = candidates.find((p) => {
      if (p.birth !== null) return p.birth === birth;
      const [lo, hi] = rangeOf(p);
      return birth >= lo - 1 && birth <= hi + 1;
    });
    const tournament = s.tournament_name;
    if (match) {
      match.birth = birth;
      match.nationTeams.add(tid);
      match.wcTournaments = Math.max(match.wcTournaments, 0);
      (match as Person & { _t?: Set<string> })._t ??= new Set();
      (match as Person & { _t?: Set<string> })._t!.add(tournament);
    } else if (candidates.length === 0) {
      const add = wcAdds.get(s.player_id) ?? {
        name: full,
        birth,
        pos: null,
        teams: new Set(),
        tournaments: new Set(),
      };
      add.teams.add(tid);
      add.tournaments.add(tournament);
      add.pos ??=
        s.position_code === 'GK'
          ? 'GK'
          : s.position_code === 'DF'
            ? 'DEF'
            : s.position_code === 'MF'
              ? 'MID'
              : s.position_code === 'FW'
                ? 'FWD'
                : null;
      wcAdds.set(s.player_id, add);
    }
  }
  for (const p of personsFlat())
    p.wcTournaments = (p as Person & { _t?: Set<string> })._t?.size ?? 0;

  // 4) Build entities.
  const teams = new Map<string, Team>(nations);
  const competitions = new Map<string, Competition>();
  const memberships: Membership[] = [];
  const clubId = (name: string) => `tm-c-${slug(name)}`;
  const outsideId = (name: string) => `tm-x-${slug(name)}`;
  const shortOf = (n: string) =>
    n
      .replace(/\b(FC|AFC|CF|SC)\b/gi, '')
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'CLB';

  for (const [club, info] of leagueOf) {
    const compId = `tm-l-${slug(info.league)}`;
    if (!competitions.has(compId))
      competitions.set(compId, {
        id: compId,
        kind: 'league',
        name: info.league,
        shortName: info.league.slice(0, 24),
        country: info.country,
        aliases: [],
        source: 'opendata',
        providerIds: {},
      });
    teams.set(clubId(club), {
      id: clubId(club),
      kind: 'club',
      name: club.slice(0, 80),
      shortName: shortOf(club),
      country: info.country,
      color: '#2b3a33',
      aliases: [],
      source: 'opendata',
      providerIds: {},
    });
    const years = [...info.seasons].sort((a, b) => a - b);
    let start = years[0]!;
    let prev = start;
    const push = (a: number, b: number) =>
      memberships.push({
        teamId: clubId(club),
        competitionId: compId,
        fromSeason: a,
        toSeason: b,
        status: 'confirmed',
        source: 'opendata',
      });
    for (const y of years.slice(1)) {
      if (y !== prev + 1) {
        push(start, prev);
        start = y;
      }
      prev = y;
    }
    push(start, prev);
  }

  const players: FootballPlayer[] = [];
  const affiliations: Affiliation[] = [];
  const usedIds = new Set<string>();
  const addAff = (a: Affiliation) => affiliations.push(a);
  const seenUnknown = new Set<string>();

  for (const [, list] of byName) {
    for (const p of list) {
      const [lo, hi] = p.estimates.length ? rangeOf(p) : [0, 0];
      const rawBirth = p.birth ?? (p.estimates.length && lo === hi ? hi : null);
      const birth = rawBirth !== null && rawBirth >= 1900 && rawBirth <= 2015 ? rawBirth : null;
      let id = `tm-${slug(p.name, 50)}-${birth ?? 'x'}`;
      for (let n = 2; usedIds.has(id); n++) id = `tm-${slug(p.name, 50)}-${birth ?? 'x'}-${n}`;
      usedIds.add(id);
      const pos = [...p.positions].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const tier =
        p.maxFee >= 40 || p.wcTournaments >= 3 || (p.maxFee >= 15 && p.wcTournaments >= 1)
          ? 1
          : p.maxFee >= 8 || p.wcTournaments >= 1 || p.events.size >= 12
            ? 2
            : 3;
      const prominentClubs = new Set(
        [...p.events.values()].map((e) => e.club).filter(isProminentClub),
      ).size;
      // Popularity: biggest transfer fee (EUR m), World Cup appearances and spells at famous clubs.
      const fame = Math.round(p.maxFee * 1.5 + 30 * p.wcTournaments + 6 * prominentClubs);
      players.push({
        id,
        name: p.name.slice(0, 80),
        aliases: [],
        birthYear: birth,
        position: pos,
        tier,
        fame,
        source: 'opendata',
        providerIds: {},
      });

      const evs = [...p.events.values()].sort((a, b) => a.t - b.t || (a.dir === 'in' ? -1 : 1));
      // Club spells at the primary (covered-league) clubs.
      const byClub = new Map<string, Ev[]>();
      for (const e of evs) (byClub.get(e.club) ?? byClub.set(e.club, []).get(e.club)!).push(e);
      for (const [club, cevs] of byClub) {
        let open: Ev | null = null;
        const emit = (from: number, to: number | null, precision: 'season' | 'year') =>
          addAff({
            playerId: id,
            teamId: clubId(club),
            fromSeason: from,
            toSeason: to,
            precision,
            status: 'confirmed',
            source: 'opendata',
          });
        for (const e of cevs) {
          if (e.dir === 'in') {
            open ??= e;
          } else if (open) {
            const to = lastSeasonWhenLeaving(e.year, e.winter);
            if (to >= open.year) emit(open.year, to, 'season');
            open = null;
          } else {
            const to = lastSeasonWhenLeaving(e.year, e.winter);
            emit(to, to, 'season'); // was already at the club when it left: certain for that last season
          }
        }
        if (open) {
          const later = evs.find((e) => e.t > open!.t && e.club !== club);
          if (later) {
            const to = lastSeasonWhenLeaving(later.year, later.winter);
            if (to >= open.year) emit(open.year, to, 'season');
          } else if (open.year >= DATA_END_SEASON - 4)
            emit(open.year, null, 'season'); // recent arrival, no later move: still there
          else emit(open.year, open.year, 'year'); // end unknown → club-only validity
        }
      }
      // Clubs outside the covered leagues, known only as a transfer counterpart (dates unknown).
      for (const e of evs) {
        const r = resolveOther(e.other);
        if (!r) continue;
        if (r.outside) {
          const tid = outsideId(r.club);
          if (!teams.has(tid))
            teams.set(tid, {
              id: tid,
              kind: 'club',
              name: r.club.slice(0, 80),
              shortName: shortOf(r.club),
              country: '',
              color: '#2b3a33',
              aliases: [],
              source: 'opendata',
              providerIds: {},
            });
          const k = `${id}|${tid}`;
          if (!seenUnknown.has(k)) {
            seenUnknown.add(k);
            addAff({
              playerId: id,
              teamId: tid,
              fromSeason: null,
              toSeason: null,
              precision: 'unknown',
              status: 'confirmed',
              source: 'opendata',
            });
          }
        }
      }
      for (const t of p.nationTeams)
        addAff({
          playerId: id,
          teamId: t,
          fromSeason: null,
          toSeason: null,
          precision: 'unknown',
          status: 'confirmed',
          source: 'opendata',
        });
    }
  }

  // World Cup players without any transfer record (mostly pre-1992 or outside the 9 leagues): keep
  // multi-tournament names only, so the player list isn't flooded with one-off squad members.
  for (const [, a] of wcAdds) {
    if (a.tournaments.size < 2) continue;
    let id = `wc-${slug(a.name, 50)}-${a.birth}`;
    for (let n = 2; usedIds.has(id); n++) id = `wc-${slug(a.name, 50)}-${a.birth}-${n}`;
    usedIds.add(id);
    players.push({
      id,
      name: a.name.slice(0, 80),
      aliases: [],
      birthYear: a.birth,
      position: a.pos,
      tier: a.tournaments.size >= 3 ? 1 : 2,
      fame: 40 * a.tournaments.size,
      source: 'opendata',
      providerIds: {},
    });
    for (const t of a.teams)
      addAff({
        playerId: id,
        teamId: t,
        fromSeason: null,
        toSeason: null,
        precision: 'unknown',
        status: 'confirmed',
        source: 'opendata',
      });
  }

  return DatasetSchema.parse({
    meta: {
      sourceId: 'opendata',
      label: 'Open data: transfers 1992–2022 + World Cup squads',
      kind: 'live',
      generatedAt,
      license:
        'Mixed. Transfers: ewenme/transfers (no licence file; derived from Transfermarkt — private/testing use only). World Cup squads: Fjelstul World Cup Database, CC-BY-SA 4.0.',
      attribution:
        'Transfer data via github.com/ewenme/transfers (originally Transfermarkt). World Cup data: © 2023 Joshua C. Fjelstul, Ph.D., CC-BY-SA 4.0, github.com/jfjelstul/worldcup — modified: filtered to men’s squads and merged with transfer records.',
      notes:
        'Club careers are reconstructed from transfer windows for 9 European leagues, 1992/93–2022/23 (the archive stopped updating in 2022). Players who never moved between covered clubs, or who played only elsewhere, may be missing. Nations come from World Cup squads only. Birth years exist for World-Cup players only. Names are matched without player ids.',
      currentSeason: DATA_END_SEASON,
    },
    teams: [...teams.values()],
    competitions: [...competitions.values()],
    memberships,
    players,
    affiliations,
  });
}

export interface OpenDataOptions {
  cacheDir: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  baseUrl?: string;
}

export function openDataProvider(opts: OpenDataOptions): FootballProvider {
  return {
    sourceId: 'opendata',
    label: 'Open data: transfers + World Cup squads',
    kind: 'live',
    async fetchDataset(ctx: ProviderContext): Promise<Dataset> {
      const base = opts.baseUrl ?? RAW;
      const http = createClient({
        userAgent: 'Pitchside/0.1 (open-data reader)',
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: ctx.log,
        signal: ctx.signal,
        timeoutMs: 120_000,
      });
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      const cached = async (rel: string): Promise<string> => {
        const file = path.join(opts.cacheDir, rel.replace(/\//g, '_'));
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
        const text = await http.text(`${base}/${rel}`);
        fs.writeFileSync(file, text);
        return text;
      };
      const transfers: TransferRow[] = [];
      for (const f of TRANSFER_FILES) {
        ctx.log.info('opendata: fetching transfers', { file: f });
        transfers.push(
          ...(parseCsv(
            await cached(`ewenme/transfers/master/data/${f}.csv`),
          ) as unknown as TransferRow[]),
        );
      }
      const wcSquads = parseCsv(
        await cached('jfjelstul/worldcup/master/data-csv/squads.csv'),
      ) as unknown as WcSquadRow[];
      const wcPlayers = parseCsv(
        await cached('jfjelstul/worldcup/master/data-csv/players.csv'),
      ) as unknown as WcPlayerRow[];
      ctx.log.info('opendata: building dataset', {
        transferRows: transfers.length,
        wcSquadRows: wcSquads.length,
      });
      return buildOpenDataset(
        { transfers, wcSquads, wcPlayers },
        (opts.now ?? (() => new Date()))().toISOString(),
      );
    },
  };
}
