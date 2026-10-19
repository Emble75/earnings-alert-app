import { shuffle, type Rng } from '../util/rng';
import { normalizeText } from './normalize';
import { isProminentClub } from './prominence';
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

const MAX_TIER: Record<Difficulty, 1 | 2 | 3> = { easy: 1, medium: 2, hard: 3 };

interface SearchEntry {
  player: FootballPlayer;
  names: string[]; // normalized: name + aliases
  tokens: string[];
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
  private search: SearchEntry[] = [];
  private criterionCache = new Map<string, Set<string>>();

  constructor(readonly dataset: Dataset) {
    this.meta = dataset.meta;
    for (const t of dataset.teams) this.teams.set(t.id, t);
    for (const c of dataset.competitions) this.competitions.set(c.id, c);
    for (const m of dataset.memberships) {
      const list = this.membershipsByTeam.get(m.teamId) ?? [];
      list.push(m);
      this.membershipsByTeam.set(m.teamId, list);
    }
    for (const a of dataset.affiliations) {
      if (!this.teams.has(a.teamId)) continue;
      const list = this.affByPlayer.get(a.playerId) ?? [];
      list.push(a);
      this.affByPlayer.set(a.playerId, list);
    }
    for (const p of dataset.players) {
      this.players.set(p.id, p);
      const names = [...new Set([p.name, ...p.aliases].map(normalizeText).filter(Boolean))];
      this.search.push({ player: p, names, tokens: names.flatMap((n) => n.split(' ')) });
    }
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
      for (const name of entry.names) {
        let s = 0;
        if (name === q) s = 100;
        else if (name.startsWith(q)) s = 80;
        else if (qTokens.every((qt) => name.split(' ').some((nt) => nt.startsWith(qt)))) s = 60;
        else if (name.includes(q)) s = 40;
        if (s > best) best = s;
      }
      if (best > 0) scored.push({ entry, score: best - entry.player.tier });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.entry.player.name.localeCompare(b.entry.player.name),
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
      set = new Set();
      for (const id of this.players.keys()) if (this.verdict(id, c).ok) set.add(id);
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
  criteriaPool(minFamous = 0, clubsMustBeProminent = false): Criterion[] {
    const out: Criterion[] = [];
    const add = (c: Criterion | null) => {
      if (!c) return;
      const set = this.playersFor(c);
      if (set.size < 2) return;
      if (clubsMustBeProminent && c.type === 'club' && !isProminentClub(c.label)) return;
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
    const minAnswers = DIFFICULTY_MIN_ANSWERS[difficulty];
    const famousNeeded = { easy: 20, medium: 10, hard: 0 }[difficulty];
    // Easy: only recognisable clubs. Medium: recognisable clubs or ones with many well-known players.
    // Final pass relaxes everything so thin datasets still produce a (verified) grid.
    const passes: [number, boolean][] =
      difficulty === 'easy'
        ? [
            [0, true],
            [famousNeeded, false],
            [0, false],
          ]
        : difficulty === 'medium'
          ? [
              [famousNeeded, false],
              [0, false],
            ]
          : [[0, false]];
    for (const [minFamous, prominentOnly] of passes) {
      const pool = this.criteriaPool(minFamous, prominentOnly);
      if (pool.length < 6) continue;
      const ok = (a: Criterion, b: Criterion) =>
        !(a.type === b.type && a.id === b.id) &&
        !this.isTrivialPair(a, b) &&
        this.validAnswers(a, b).length >= minAnswers;
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

  impostorPool(category: ImpostorCategory, difficulty: Difficulty): FootballPlayer[] {
    const maxTier = MAX_TIER[difficulty];
    const leagueCrit =
      category === 'premier-league' ||
      category === 'la-liga' ||
      category === 'serie-a' ||
      category === 'bundesliga' ||
      category === 'ligue-1'
        ? this.criterionFor('league', category)
        : null;
    const leagueSet = leagueCrit ? this.playersFor(leagueCrit) : null;
    return this.allPlayers().filter((p) => {
      if (p.tier > maxTier || !p.position) return false;
      if (leagueSet) return leagueSet.has(p.id);
      if (category === 'legends') return p.birthYear !== null && p.birthYear <= 1980;
      if (category === 'current')
        return this.affiliationsOf(p.id).some(
          (a) => a.status === 'confirmed' && a.precision === 'season' && a.toSeason === null,
        );
      return true;
    });
  }
}
