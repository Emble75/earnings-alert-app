import type { Dataset } from './types';

/**
 * Compact transport form of a dataset for the one-phone party mode (which runs the game engine in
 * the browser). Drops provenance fields the client never uses and stores the big tables as tuples.
 * `expandDataset(compactDataset(d))` is lossless for everything the FootballIndex reads.
 */
export interface CompactDataset {
  v: 1;
  meta: Dataset['meta'];
  teams: Pick<
    Dataset['teams'][number],
    'id' | 'kind' | 'name' | 'shortName' | 'color' | 'aliases'
  >[];
  competitions: Pick<
    Dataset['competitions'][number],
    'id' | 'kind' | 'name' | 'shortName' | 'aliases'
  >[];
  /** [teamId, competitionId, fromSeason, toSeason|null, confirmed(1)|unknown(0)] */
  memberships: [string, string, number, number | null, 0 | 1][];
  /** [id, name, birthYear|null, position|null, tier, aliases, fame] */
  players: [string, string, number | null, string | null, number, string[], number][];
  /** [playerId, teamId, fromSeason|null, toSeason|null, precision(0 season|1 year|2 unknown), confirmed(1)|unknown(0)] */
  affiliations: [string, string, number | null, number | null, 0 | 1 | 2, 0 | 1][];
}

const PRECISION = ['season', 'year', 'unknown'] as const;

export function compactDataset(d: Dataset): CompactDataset {
  return {
    v: 1,
    meta: d.meta,
    teams: d.teams.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      shortName: t.shortName,
      color: t.color,
      aliases: t.aliases,
    })),
    competitions: d.competitions.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      shortName: c.shortName,
      aliases: c.aliases,
    })),
    memberships: d.memberships.map((m) => [
      m.teamId,
      m.competitionId,
      m.fromSeason,
      m.toSeason,
      m.status === 'confirmed' ? 1 : 0,
    ]),
    players: d.players.map((p) => [
      p.id,
      p.name,
      p.birthYear,
      p.position,
      p.tier,
      p.aliases,
      p.fame,
    ]),
    affiliations: d.affiliations.map((a) => [
      a.playerId,
      a.teamId,
      a.fromSeason,
      a.toSeason,
      PRECISION.indexOf(a.precision) as 0 | 1 | 2,
      a.status === 'confirmed' ? 1 : 0,
    ]),
  };
}

export function expandDataset(c: CompactDataset): Dataset {
  if (c.v !== 1) throw new Error('Unsupported dataset format');
  const src = c.meta.sourceId;
  return {
    meta: c.meta,
    teams: c.teams.map((t) => ({ ...t, country: '', source: src, providerIds: {} })),
    competitions: c.competitions.map((x) => ({ ...x, source: src, providerIds: {} })),
    memberships: c.memberships.map(([teamId, competitionId, fromSeason, toSeason, ok]) => ({
      teamId,
      competitionId,
      fromSeason,
      toSeason,
      status: ok ? 'confirmed' : 'unknown',
      source: src,
    })),
    players: c.players.map(([id, name, birthYear, position, tier, aliases, fame]) => ({
      id,
      name,
      birthYear,
      position: position as Dataset['players'][number]['position'],
      tier: tier as 1 | 2 | 3,
      aliases,
      fame: fame ?? 0,
      source: src,
      providerIds: {},
    })),
    affiliations: c.affiliations.map(([playerId, teamId, fromSeason, toSeason, p, ok]) => ({
      playerId,
      teamId,
      fromSeason,
      toSeason,
      precision: PRECISION[p]!,
      status: ok ? 'confirmed' : 'unknown',
      source: src,
    })),
  };
}
