import { shuffle, type Rng } from '../util/rng';
import { normalizeText } from './normalize';
import {
  isEasyClub,
  isEasyLeague,
  isEasyNation,
  isMediumNation,
  isProminentClub,
  isProminentLeague,
} from './prominence';

interface Level {
  allowed: (c: Criterion, size: number) => boolean;
  minAnswers: number;
  famousPerCell: number;
  minMembers: number;
}
import { famousRank } from './famous';
import type {
  Affiliation,
  Competition,
  Criterion,
  Dataset,
  DatasetMeta,
  FootballPlayer,
  Membership,
  PlayerCard,
  Team,
  Verdict,
} from './types';

export * from './types';

export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTY_MIN_ANSWERS: Record<Difficulty, number> = { easy: 3, medium: 2, hard: 1 };

export type ImpostorCategory =
  | 'all'
  | 'premier-league'
  | 'la-liga'
  | 'serie-a'
  | 'bundesliga'
  | 'ligue-1'
  | 'legends'
  | 'current';

export const IMPOSTOR_CATEGORY_LABELS: Record<ImpostorCategory, string> = {
  all: 'Everything',
  'premier-league': 'Premier League',
  'la-liga': 'La Liga',
  'serie-a': 'Serie A',
  bundesliga: 'Bundesliga',
  'ligue-1': 'Ligue 1',
  legends: 'Legends (born 1980 or earlier)',
  current: 'Still active in our data',
};

const IMPOSTOR_TOP_ALL: Record<Difficulty, number> = { easy: 100, medium: 250, hard: 400 };
const IMPOSTOR_TOP_CATEGORY: Record<Difficulty, number> = { easy: 40, medium: 100, hard: 200 };
const MAX_TIER: Record<Difficulty, 1 | 2 | 3> = { easy: 1, medium: 2, hard: 3 };

interface SearchEntry {
  player: FootballPlayer;
  /** normalized name + aliases, pre-split into tokens */
  names: { full: string; tokens: string[] }[];
}

export interface GridSpec {
  rows: Criterion[];
  cols: Criterion[];
  /** Number of confirmed valid answers per cell, row-major. */
  answerCounts: number[];
}

/**
 * Read-only, in-memory query layer over a normalized dataset. The database is the source of
 * truth; this index is rebuilt from it after every sync. The same code runs in the browser for
 * the offline practice mode, fed by the bundled sample dataset.
 */
export class FootballIndex {
  readonly meta: DatasetMeta;
  private teams = new Map<string, Team>();
  private competitions = new Map<string, Competition>();
  private players = new Map<string, FootballPlayer>();
  private affByPlayer = new Map<string, Affiliation[]>();
  private membershipsByTeam = new Map<string, Membership[]>();
  private affByTeam = new Map<string, Affiliation[]>();
  private teamsByLeague = new Map<string, Set<string>>();
  private search: SearchEntry[] = [];
  private criterionCache = new Map<string, Set<string>>();
  private effectiveFame = new Map<string, number>();
  fameOf(id: string) {
    return this.effectiveFame.get(id) ?? 0;
  }

  constructor(readonly dataset: Dataset) {
    this.meta = dataset.meta;
    for (const t of dataset.teams) this.teams.set(t.id, t);
    for (const c of dataset.competitions) this.competitions.set(c.id, c);
    for (const m of dataset.memberships) {
      const list = this.membershipsByTeam.get(m.teamId) ?? [];
      list.push(m);
      this.membershipsByTeam.set(m.teamId, list);
      const ts = this.teamsByLeague.get(m.competitionId) ?? new Set();
      ts.add(m.teamId);
      this.teamsByLeague.set(m.competitionId, ts);
    }
    const known = new Set(dataset.players.map((p) => p.id));
    for (const a of dataset.affiliations) {
      if (!this.teams.has(a.teamId) || !known.has(a.playerId)) continue;
      const list = this.affByPlayer.get(a.playerId) ?? [];
      list.push(a);
      this.affByPlayer.set(a.playerId, list);
      const tl = this.affByTeam.get(a.teamId) ?? [];
      tl.push(a);
      this.affByTeam.set(a.teamId, tl);
    }
    for (const p of dataset.players) {
      this.players.set(p.id, p);
      const names = [...new Set([p.name, ...p.aliases].map(normalizeText).filter(Boolean))];
      this.search.push({
        player: p,
        names: names.map((full) => ({ full, tokens: full.split(' ') })),
      });
    }
    this.applyFamousBoost();
  }

  /**
   * Curated famous names outrank everything else (score 100000 - rank), but only for the best-known
   * bearer of a name, so an unknown namesake never inherits a star's fame.
   */
  private applyFamousBoost() {
    const best = new Map<number, FootballPlayer>();
    for (const p of this.players.values()) {
      const ranks = [p.name, ...p.aliases]
        .map(famousRank)
        .filter((r): r is number => r !== undefined);
      if (!ranks.length) continue;
      const r = Math.min(...ranks);
      const cur = best.get(r);
      if (!cur || p.fame > cur.fame) best.set(r, p);
    }
    for (const p of this.players.values()) this.effectiveFame.set(p.id, p.fame);
    for (const [rank, p] of best) this.effectiveFame.set(p.id, 100000 - rank);
  }

  get counts() {
    return {
      players: this.players.size,
      teams: this.teams.size,
      competitions: this.competitions.size,
      affiliations: this.dataset.affiliations.length,
      memberships: this.dataset.memberships.length,
    };
  }

  getPlayer(id: string) {
    return this.players.get(id);
  }
  getTeam(id: string) {
    return this.teams.get(id);
  }
  getCompetition(id: string) {
    return this.competitions.get(id);
  }
  allPlayers() {
    return [...this.players.values()];
  }
  affiliationsOf(playerId: string) {
    return this.affByPlayer.get(playerId) ?? [];
  }

  card(id: string): PlayerCard | null {
    const p = this.players.get(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      position: p.position,
      birthYear: p.birthYear,
      hint: [p.birthYear ? `b. ${p.birthYear}` : null, p.position].filter(Boolean).join(' · '),
    };
  }

  /** Accent-insensitive search over names and aliases; every query token must prefix-match. */
  searchPlayers(query: string, limit = 8, excludeIds?: ReadonlySet<string>): PlayerCard[] {
    const q = normalizeText(query);
    if (q.length < 2) return [];
    const qTokens = q.split(' ');
    const scored: { entry: SearchEntry; score: number }[] = [];
    for (const entry of this.search) {
      if (excludeIds?.has(entry.player.id)) continue;
      let best = 0;
      for (const { full: name, tokens } of entry.names) {
        let s = 0;
        if (name === q) s = 100;
        else if (name.startsWith(q)) s = 80;
        else if (qTokens.every((qt) => tokens.some((nt) => nt.startsWith(qt)))) s = 60;
        else if (name.includes(q)) s = 40;
        if (s > best) best = s;
      }
      if (best > 0) scored.push({ entry, score: best });
    }
    // Best text match first; among equals the better-known player (so "young" finds Ashley before obscure namesakes).
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        this.fameOf(b.entry.player.id) - this.fameOf(a.entry.player.id) ||
        a.entry.player.name.localeCompare(b.entry.player.name),
    );
    return scored.slice(0, limit).map((s) => this.card(s.entry.player.id)!);
  }

  // ---- Criteria ----------------------------------------------------------------------------

  criterionFor(type: Criterion['type'], id: string): Criterion | null {
    if (type === 'league') {
      const c = this.competitions.get(id);
      return c ? { type, id, label: c.name, short: c.shortName } : null;
    }
    const t = this.teams.get(id);
    if (!t || (type === 'club') !== (t.kind === 'club')) return null;
    return { type, id, label: t.name, short: t.shortName, color: t.color };
  }

  private seasonRange(a: Affiliation): [number, number] | null {
    if (a.precision !== 'season' || a.fromSeason === null) return null;
    return [a.fromSeason, a.toSeason ?? this.meta.currentSeason];
  }

  private leagueMembershipsOverlap(a: Affiliation, leagueId: string): boolean {
    const range = this.seasonRange(a);
    if (!range) return false;
    for (const m of this.membershipsByTeam.get(a.teamId) ?? []) {
      if (m.competitionId !== leagueId || m.status !== 'confirmed') continue;
      const mTo = m.toSeason ?? this.meta.currentSeason;
      if (Math.max(range[0], m.fromSeason) <= Math.min(range[1], mTo)) return true;
    }
    return false;
  }

  /**
   * Validates one criterion for one player using only confirmed, adequately dated records.
   * Anything the data cannot establish is rejected — never guessed.
   */
  verdict(playerId: string, c: Criterion): Verdict {
    if (!this.players.has(playerId)) return { ok: false, reason: 'unknown-player' };
    const affs = this.affiliationsOf(playerId);
    let weak = false;
    for (const a of affs) {
      if (c.type === 'league') {
        const isMember = (this.membershipsByTeam.get(a.teamId) ?? []).some(
          (m) => m.competitionId === c.id,
        );
        if (!isMember) continue;
        if (a.status === 'confirmed' && this.leagueMembershipsOverlap(a, c.id)) return { ok: true };
        weak = true; // a record exists but is unknown/undated/year-precision: cannot be used
      } else if (a.teamId === c.id) {
        if (a.status === 'confirmed') return { ok: true };
        weak = true;
      }
    }
    return { ok: false, reason: weak ? 'unverified-record' : 'not-confirmed' };
  }

  private criterionKey(c: Criterion) {
    return `${c.type}:${c.id}`;
  }

  /** Set of players who satisfy a criterion (cached). */
  playersFor(c: Criterion): Set<string> {
    const key = this.criterionKey(c);
    let set = this.criterionCache.get(key);
    if (!set) {
      // Same rules as verdict(), evaluated from the team side so it stays fast on large datasets.
      set = new Set();
      if (c.type === 'league') {
        for (const teamId of this.teamsByLeague.get(c.id) ?? [])
          for (const a of this.affByTeam.get(teamId) ?? [])
            if (a.status === 'confirmed' && this.leagueMembershipsOverlap(a, c.id))
              set.add(a.playerId);
      } else {
        for (const a of this.affByTeam.get(c.id) ?? [])
          if (a.status === 'confirmed') set.add(a.playerId);
      }
      this.criterionCache.set(key, set);
    }
    return set;
  }

  private pairCache = new Map<string, string[]>();
  validAnswers(a: Criterion, b: Criterion): string[] {
    const key = `${a.type}:${a.id}|${b.type}:${b.id}`;
    let hit = this.pairCache.get(key);
    if (!hit) {
      const A = this.playersFor(a);
      const B = this.playersFor(b);
      hit = [...A].filter((id) => B.has(id));
      this.pairCache.set(key, hit);
    }
    return hit;
  }

  /** Every criterion that has any chance of being playable. */
  criteriaPool(minFamous = 0, clubsMustBeProminent = false, minMembers = 2): Criterion[] {
    const out: Criterion[] = [];
    const add = (c: Criterion | null) => {
      if (!c) return;
      const set = this.playersFor(c);
      // Nations are far larger than clubs in World-Cup-based data; scale the bar so Easy/Medium favour big nations.
      if (set.size < (c.type === 'national' ? minMembers * 2 : minMembers)) return;
      if (clubsMustBeProminent && c.type === 'club' && !isProminentClub(c.label)) return;
      if (clubsMustBeProminent && c.type === 'league' && !isProminentLeague(c.label)) return;
      if (minFamous > 0) {
        // Prominence of a criterion = weighted count of its well-known players (tier 1 counts 5x).
        let score = 0;
        for (const id of set) {
          const t = this.players.get(id)!.tier;
          score += t === 1 ? 5 : t === 2 ? 1 : 0;
          if (score >= minFamous) break;
        }
        if (score < minFamous) return;
      }
      out.push(c);
    };
    for (const t of this.teams.values())
      add(this.criterionFor(t.kind === 'club' ? 'club' : 'national', t.id));
    for (const comp of this.competitions.values())
      if (comp.kind === 'league') add(this.criterionFor('league', comp.id));
    return out;
  }

  /**
   * Builds a 3x3 grid where every one of the 9 cells has at least the difficulty's minimum number
   * of validated answers. Easier grids prefer well-known criteria (those with many well-known
   * players) so the board feels fair; if the data can't support that, it relaxes to any verifiable
   * criteria. Returns null if even that is impossible: the game is then unplayable, never guessed.
   */
  generateGrid(rng: Rng, difficulty: Difficulty): GridSpec | null {
    // Each level fixes WHICH criteria may appear (so Easy = famous leagues/clubs/nations only) and
    // how many well-known players each cell needs. Levels fall back to the next looser one only when
    // a (thin) dataset cannot support the strict one, so a grid is always verified.
    const medClub = (c: Criterion) => isProminentClub(c.label) || isEasyClub(c.label);
    const levels: Record<string, Level> = {
      easy: {
        allowed: (c) =>
          c.type === 'league'
            ? isEasyLeague(c.label)
            : c.type === 'club'
              ? isEasyClub(c.label)
              : isEasyNation(c.label),
        minAnswers: 3,
        famousPerCell: 2,
        minMembers: 40,
      },
      medium: {
        allowed: (c) =>
          c.type === 'league'
            ? isProminentLeague(c.label)
            : c.type === 'club'
              ? medClub(c)
              : isMediumNation(c.label),
        minAnswers: 2,
        famousPerCell: 1,
        minMembers: 30,
      },
      hard: {
        // Still recognisable-ish: big squads' worth of history, not village clubs.
        allowed: (c, size) =>
          c.type === 'club'
            ? medClub(c) || size >= 200
            : c.type === 'league'
              ? size >= 400
              : size >= 40,
        minAnswers: 1,
        famousPerCell: 0,
        minMembers: 10,
      },
      any: { allowed: () => true, minAnswers: 1, famousPerCell: 0, minMembers: 2 },
      // Thin datasets: any criteria, but keep the requested level's answer floor.
      any3: { allowed: () => true, minAnswers: 3, famousPerCell: 0, minMembers: 2 },
      any2: { allowed: () => true, minAnswers: 2, famousPerCell: 0, minMembers: 2 },
    };
    const order =
      difficulty === 'easy'
        ? ['easy', 'any3', 'medium', 'any2', 'any']
        : difficulty === 'medium'
          ? ['medium', 'any2', 'any']
          : ['hard', 'any'];
    for (const name of order) {
      const lv = levels[name]!;
      const pool = this.criteriaPool(0, false, lv.minMembers).filter((c) =>
        lv.allowed(c, this.playersFor(c).size),
      );
      if (pool.length < 6) continue;
      const fam = (a: Criterion, b: Criterion) =>
        this.validAnswers(a, b).filter((id) => (this.players.get(id)?.tier ?? 3) <= 2).length;
      const ok = (a: Criterion, b: Criterion) =>
        !(a.type === b.type && a.id === b.id) &&
        // two leagues or two nations make dull, near-empty cells
        !(a.type === b.type && a.type !== 'club') &&
        !this.isTrivialPair(a, b) &&
        this.validAnswers(a, b).length >= lv.minAnswers &&
        fam(a, b) >= lv.famousPerCell;
      for (let attempt = 0; attempt < 300; attempt++) {
        // Constructive: add rows one at a time, always keeping >= 3 columns compatible with every row so far.
        const rows: Criterion[] = [];
        let cand = pool;
        for (let k = 0; k < 3; k++) {
          const next = shuffle(pool, rng).find(
            (r) => !rows.includes(r) && cand.filter((c) => c !== r && ok(r, c)).length >= 3,
          );
          if (!next) break;
          rows.push(next);
          cand = cand.filter((c) => c !== next && ok(next, c));
        }
        if (rows.length < 3) continue;
        const cols = shuffle(
          cand.filter((c) => !rows.includes(c)),
          rng,
        ).slice(0, 3);
        if (cols.length < 3) continue;
        const counts = rows.flatMap((r) => cols.map((c) => this.validAnswers(r, c).length));
        return { rows, cols, answerCounts: counts };
      }
    }
    return null;
  }

  private isTrivialPair(a: Criterion, b: Criterion) {
    const [league, other] =
      a.type === 'league' ? [a, b] : b.type === 'league' ? [b, a] : [null, null];
    if (!league || !other || other.type !== 'club') return false;
    return (this.membershipsByTeam.get(other.id) ?? []).some((m) => m.competitionId === league.id);
  }

  // ---- Impostor pool -------------------------------------------------------------------------

  categoryCounts(difficulty: Difficulty): Record<ImpostorCategory, number> {
    const out = {} as Record<ImpostorCategory, number>;
    for (const cat of Object.keys(IMPOSTOR_CATEGORY_LABELS) as ImpostorCategory[]) {
      out[cat] = this.impostorPool(cat, difficulty).length;
    }
    return out;
  }

  /** Finds the league behind a category by id or by (accent-insensitive) name, whatever the dataset calls it. */
  private leagueForCategory(category: ImpostorCategory): Criterion | null {
    const names: Partial<Record<ImpostorCategory, string[]>> = {
      'premier-league': ['premier league'],
      'la-liga': ['la liga', 'laliga', 'primera division'],
      'serie-a': ['serie a'],
      bundesliga: ['bundesliga', '1 bundesliga'],
      'ligue-1': ['ligue 1'],
    };
    const wanted = names[category];
    if (!wanted) return null;
    const comp =
      this.competitions.get(category) ??
      [...this.competitions.values()].find(
        (c) => c.kind === 'league' && wanted.includes(normalizeText(c.name)),
      );
    return comp ? this.criterionFor('league', comp.id) : null;
  }

  /**
   * Footballers an Impostor round may draw from: only genuinely well-known ones. Candidates are
   * ranked by fame and cut to the top N (everything: 100 / 250 / 400 by difficulty; within a league
   * or other category: 40 / 100 / 200), so obscure players can never appear.
   */
  impostorPool(category: ImpostorCategory, difficulty: Difficulty): FootballPlayer[] {
    const maxTier = MAX_TIER[difficulty];
    const leagueCrit = this.leagueForCategory(category);
    const leagueSet = leagueCrit ? this.playersFor(leagueCrit) : null;
    const candidates = this.allPlayers().filter((p) => {
      if (p.tier > maxTier || !p.position) return false;
      if (leagueSet) return leagueSet.has(p.id);
      if (category === 'legends') return p.birthYear !== null && p.birthYear <= 1980;
      if (category === 'current')
        return this.affiliationsOf(p.id).some(
          (a) => a.status === 'confirmed' && a.precision === 'season' && a.toSeason === null,
        );
      return true;
    });
    const top =
      category === 'all' ? IMPOSTOR_TOP_ALL[difficulty] : IMPOSTOR_TOP_CATEGORY[difficulty];
    return candidates
      .sort((a, b) => this.fameOf(b.id) - this.fameOf(a.id) || a.name.localeCompare(b.name))
      .slice(0, top);
  }
}
