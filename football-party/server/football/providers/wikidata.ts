import {
  DatasetSchema,
  type Affiliation,
  type Dataset,
  type FootballPlayer,
  type Team,
  type Competition,
  type Membership,
} from '../../../shared/football/types';
import { createJsonClient } from '../http';
import type { FootballProvider, ProviderContext } from './types';
import fs from 'node:fs';

/**
 * Wikidata provider (https://www.wikidata.org) — structured data released under CC0, no API key.
 * It is the only free source we found that models historical team membership with start/end dates
 * (property P54 "member of sports team" + qualifiers P580/P582).
 *
 * HONESTY NOTES
 *  - Coverage and accuracy are crowd-sourced and uneven; dates are often missing. We therefore
 *    only treat an affiliation as "season"-precise when both ends are day-precise and not in an
 *    ambiguous transfer-window month. Everything else is stored as year/unknown precision and is
 *    excluded from league-based validation.
 *  - This adapter's parsing/derivation logic is unit-tested against fixtures in the documented
 *    API shape. It has NOT been exercised against the live service from this build environment
 *    (egress to wikidata.org was blocked). Run `npm run sync -- --provider wikidata` to verify.
 *  - Wikimedia requires a descriptive User-Agent with contact info (WIKIDATA_USER_AGENT).
 */

const API = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';

const Q = {
  footballer: 'Q937857',
  nationalTeam: 'Q6979593',
  club: 'Q476028',
};
const POSITION: Record<string, FootballPlayer['position']> = {
  Q201330: 'GK',
  Q336286: 'DEF',
  Q193592: 'MID',
  Q280658: 'FWD',
};

interface WbTime {
  time: string;
  precision: number;
}
interface Snak {
  snaktype: string;
  datavalue?: { value: unknown };
}
interface Claim {
  mainsnak: Snak;
  qualifiers?: Record<string, Snak[]>;
  rank?: string;
}
export interface WbEntity {
  id: string;
  labels?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, unknown>;
  missing?: string;
}

function entityIdOf(s: Snak | undefined): string | null {
  const v = s?.datavalue?.value as { id?: string } | undefined;
  return s?.snaktype === 'value' && v?.id ? v.id : null;
}
function timeOf(s: Snak | undefined): WbTime | null {
  const v = s?.datavalue?.value as WbTime | undefined;
  return s?.snaktype === 'value' && v?.time ? v : null;
}
function parseTime(t: WbTime): { year: number; month: number; precision: number } | null {
  const m = /^([+-])(\d{4,})-(\d{2})-(\d{2})T/.exec(t.time);
  if (!m) return null;
  return {
    year: Number(m[2]) * (m[1] === '-' ? -1 : 1),
    month: Number(m[3]),
    precision: t.precision,
  };
}

/** Season (start year) for a day-precise date, or null when the transfer-window month is ambiguous. */
export function seasonOf(t: WbTime, role: 'start' | 'end'): number | null {
  const p = parseTime(t);
  if (!p || p.precision < 11 || p.month === 0) return null;
  if (role === 'start') {
    if (p.month >= 7) return p.year; // joined for the new season
    if (p.month <= 5) return p.year - 1; // joined mid-season
    return null; // June: could be either
  }
  if (p.month >= 9) return p.year; // left during the season that started this year
  if (p.month <= 6) return p.year - 1; // season ended (Jun) or left mid-season
  return null; // Jul–Aug: may or may not have played in the new season
}

export interface DerivedAffiliation {
  fromSeason: number | null;
  toSeason: number | null;
  precision: Affiliation['precision'];
}

/**
 * Turns Wikidata start/end qualifiers into our explicit season model. `ongoing` is a heuristic the
 * caller supplies for open-ended statements of active players.
 */
export function deriveAffiliation(
  start: WbTime | null,
  end: WbTime | null,
  ongoing: boolean,
): DerivedAffiliation {
  if (!start && !end) return { fromSeason: null, toSeason: null, precision: 'unknown' };
  const sy = start ? (parseTime(start)?.year ?? null) : null;
  const ey = end ? (parseTime(end)?.year ?? null) : null;
  const fs_ = start ? seasonOf(start, 'start') : null;
  const es = end ? seasonOf(end, 'end') : null;
  const startOk = start !== null && fs_ !== null;
  const endOk = end ? es !== null : ongoing;
  if (startOk && endOk && (end === null || (es !== null && es >= fs_!))) {
    return { fromSeason: fs_, toSeason: end ? es : null, precision: 'season' };
  }
  if (sy === null) return { fromSeason: null, toSeason: null, precision: 'unknown' };
  return { fromSeason: sy, toSeason: ey ?? (ongoing ? null : sy), precision: 'year' };
}

/** Internal ids are lowercase (`wd-q42`); the original QID stays in providerIds. */
const wd = (qid: string) => `wd-${qid.toLowerCase()}`;
const label = (e: WbEntity) => e.labels?.en?.value;

function tierFromSitelinks(n: number): 1 | 2 | 3 {
  return n >= 100 ? 1 : n >= 60 ? 2 : 3;
}

export interface WikidataOptions {
  userAgent: string;
  maxPlayers: number;
  qidFile?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  now?: () => Date;
}

export function wikidataProvider(opts: WikidataOptions): FootballProvider {
  return {
    sourceId: 'wikidata',
    label: 'Wikidata (CC0)',
    kind: 'live',
    async fetchDataset(ctx: ProviderContext): Promise<Dataset> {
      const now = (opts.now ?? (() => new Date()))();
      const getJson = createJsonClient({
        userAgent: opts.userAgent,
        minIntervalMs: opts.minIntervalMs ?? 1200,
        fetchImpl: opts.fetchImpl,
        sleep: opts.sleep,
        log: ctx.log,
        signal: ctx.signal,
      });

      // 1. Which players? A curated QID file, else the most-linked footballers (a fame proxy).
      let qids: string[];
      if (opts.qidFile) {
        qids = fs
          .readFileSync(opts.qidFile, 'utf8')
          .split(/\s+/)
          .filter((x) => /^Q\d+$/.test(x));
      } else {
        const sparql = `SELECT ?p WHERE { ?p wdt:P31 wd:Q5; wdt:P106 wd:${Q.footballer}; wikibase:sitelinks ?s . FILTER(?s > 40) } ORDER BY DESC(?s) LIMIT ${opts.maxPlayers}`;
        const res = await getJson<{ results: { bindings: { p: { value: string } }[] } }>(
          `${SPARQL}?format=json&query=${encodeURIComponent(sparql)}`,
        );
        qids = res.results.bindings.map((b) => b.p.value.split('/').pop()!);
      }
      qids = [...new Set(qids)].slice(0, opts.maxPlayers);
      ctx.log.info('wikidata: players to fetch', { count: qids.length });

      const fetchEntities = async (ids: string[], props: string) => {
        const out: WbEntity[] = [];
        for (let i = 0; i < ids.length; i += 50) {
          const batch = ids.slice(i, i + 50);
          const url = `${API}?action=wbgetentities&format=json&languages=en&languagefallback=1&props=${props}&ids=${batch.join('|')}`;
          const res = await getJson<{ entities?: Record<string, WbEntity> }>(url);
          out.push(...Object.values(res.entities ?? {}).filter((e) => !e.missing));
        }
        return out;
      };

      const playerEntities = await fetchEntities(qids, 'labels|aliases|claims|sitelinks');
      const teamIds = new Set<string>();
      for (const p of playerEntities)
        for (const c of p.claims?.P54 ?? []) {
          const id = entityIdOf(c.mainsnak);
          if (id) teamIds.add(id);
        }
      const teamEntities = await fetchEntities([...teamIds], 'labels|aliases|claims');

      // 2. Teams: keep only senior clubs and national teams, identified by instance-of (P31).
      const teams: Team[] = [];
      const teamKind = new Map<string, Team['kind']>();
      for (const t of teamEntities) {
        const inst = (t.claims?.P31 ?? []).map((c) => entityIdOf(c.mainsnak));
        const kind: Team['kind'] | null = inst.includes(Q.nationalTeam)
          ? 'national'
          : inst.includes(Q.club)
            ? 'club'
            : null;
        const name = label(t);
        if (!kind || !name) continue;
        teamKind.set(t.id, kind);
        teams.push({
          id: wd(t.id),
          kind,
          name,
          shortName: name.slice(0, 24),
          country: '',
          color: '#2b3a33',
          aliases: (t.aliases?.en ?? []).map((a) => a.value).slice(0, 8),
          source: 'wikidata',
          providerIds: { wikidata: t.id },
        });
      }

      // 3. Leagues & memberships from P118 ("league or competition") on clubs, only where dated.
      const leagueIds = new Set<string>();
      for (const t of teamEntities)
        if (teamKind.get(t.id) === 'club')
          for (const c of t.claims?.P118 ?? []) {
            const id = entityIdOf(c.mainsnak);
            if (id) leagueIds.add(id);
          }
      const leagueEntities = await fetchEntities([...leagueIds], 'labels|aliases');
      const competitions: Competition[] = leagueEntities
        .filter((l) => label(l))
        .map((l) => ({
          id: wd(l.id),
          kind: 'league' as const,
          name: label(l)!,
          shortName: label(l)!.slice(0, 24),
          aliases: (l.aliases?.en ?? []).map((a) => a.value).slice(0, 8),
          source: 'wikidata',
          providerIds: { wikidata: l.id },
        }));
      const compIds = new Set(competitions.map((c) => c.id));
      const currentSeason =
        now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      const memberships: Membership[] = [];
      for (const t of teamEntities) {
        if (teamKind.get(t.id) !== 'club') continue;
        for (const c of t.claims?.P118 ?? []) {
          const lid = entityIdOf(c.mainsnak);
          if (!lid || !compIds.has(wd(lid))) continue;
          const start = timeOf(c.qualifiers?.P580?.[0]);
          const end = timeOf(c.qualifiers?.P582?.[0]);
          // League spells are season-based; take the calendar year of the start date as the first season
          // (league records are typically dated to a season, not a transfer window).
          const fromSeason = start ? (parseTime(start)?.year ?? null) : null;
          if (fromSeason === null) continue; // undated league membership cannot validate anything
          const toYear = end ? (parseTime(end)?.year ?? null) : null;
          memberships.push({
            teamId: wd(t.id),
            competitionId: wd(lid),
            fromSeason,
            toSeason: end ? (toYear !== null ? toYear - 1 : null) : null,
            status: start && start.precision >= 9 ? 'confirmed' : 'unknown',
            source: 'wikidata',
          });
        }
      }

      // 4. Players and affiliations.
      const players: FootballPlayer[] = [];
      const affiliations: Affiliation[] = [];
      for (const p of playerEntities) {
        const name = label(p);
        if (!name) continue;
        const birth = timeOf(p.claims?.P569?.[0]?.mainsnak);
        const birthYear = birth ? (parseTime(birth)?.year ?? null) : null;
        const died = (p.claims?.P570?.length ?? 0) > 0;
        const pos = entityIdOf(p.claims?.P413?.[0]?.mainsnak);
        const statements = (p.claims?.P54 ?? []).filter((c) => c.rank !== 'deprecated');
        // Active heuristic: not deceased, under 40, and this is the player's latest-starting open statement.
        const starts = statements.map((c) => timeOf(c.qualifiers?.P580?.[0])?.time ?? '');
        const latestStart = [...starts].sort().pop() ?? '';
        const young = birthYear !== null && currentSeason - birthYear < 40;
        players.push({
          id: wd(p.id),
          name,
          aliases: (p.aliases?.en ?? []).map((a) => a.value).slice(0, 8),
          birthYear,
          position: pos ? (POSITION[pos] ?? null) : null,
          tier: tierFromSitelinks(Object.keys(p.sitelinks ?? {}).length),
          fame: Object.keys(p.sitelinks ?? {}).length,
          source: 'wikidata',
          providerIds: { wikidata: p.id },
        });
        for (const c of statements) {
          const tid = entityIdOf(c.mainsnak);
          if (!tid || !teamKind.has(tid)) continue;
          const start = timeOf(c.qualifiers?.P580?.[0]);
          const end = timeOf(c.qualifiers?.P582?.[0]);
          const kind = teamKind.get(tid)!;
          if (kind === 'national') {
            // Caps are what matter for "played for"; dates are not needed or trusted.
            affiliations.push({
              playerId: wd(p.id),
              teamId: wd(tid),
              fromSeason: null,
              toSeason: null,
              precision: 'unknown',
              status: 'confirmed',
              source: 'wikidata',
            });
            continue;
          }
          const ongoing = !end && !died && young && (start?.time ?? '') === latestStart;
          const d = deriveAffiliation(start, end, ongoing);
          affiliations.push({
            playerId: wd(p.id),
            teamId: wd(tid),
            fromSeason: d.fromSeason,
            toSeason: d.toSeason,
            precision: d.precision,
            status: 'confirmed',
            source: 'wikidata',
          });
        }
      }

      return DatasetSchema.parse({
        meta: {
          sourceId: 'wikidata',
          label: 'Wikidata (CC0)',
          kind: 'live',
          generatedAt: now.toISOString(),
          license: 'CC0 1.0 (Wikidata structured data)',
          attribution: 'Data from Wikidata, CC0. Wikidata is a Wikimedia Foundation project.',
          notes:
            'Crowd-sourced; coverage and dates are incomplete. Only day-precise, unambiguous spells are used for league validation.',
          currentSeason,
        },
        teams,
        competitions,
        memberships,
        players,
        affiliations,
      });
    },
  };
}
