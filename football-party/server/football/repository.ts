import { normalizeText } from '../../shared/football/normalize';
import type { Dataset } from '../../shared/football/types';
import { DatasetSchema } from '../../shared/football/types';
import type { Queryable } from '../db';

interface Col {
  name: string;
  type: string;
}

/**
 * Idempotent bulk upsert via unnest(): unchanged rows are not rewritten (no updated_at churn) and the
 * return value is the number of rows actually inserted or changed.
 */
async function upsert(
  q: Queryable,
  table: string,
  cols: Col[],
  conflict: string[],
  rows: unknown[][],
  opts: { touchUpdatedAt?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const touch = opts.touchUpdatedAt ?? true;
  const names = cols.map((c) => c.name);
  const updatable = cols.filter((c) => !conflict.includes(c.name));
  let changed = 0;
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const arrays = cols.map((_, ci) =>
      part.map((r) => (r[ci] === null || r[ci] === undefined ? null : String(r[ci]))),
    );
    const sql = `
      INSERT INTO ${table} AS t (${names.join(', ')})
      SELECT ${cols.map((c, ci) => `u.x${ci}::${c.type}`).join(', ')}
      FROM unnest(${cols.map((_, ci) => `$${ci + 1}::text[]`).join(', ')}) AS u(${cols.map((_, ci) => `x${ci}`).join(', ')})
      ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET
        ${updatable.map((c) => `${c.name} = EXCLUDED.${c.name}`).join(', ')}${touch ? ', updated_at = now()' : ''}
      WHERE (${updatable.map((c) => `t.${c.name}`).join(', ')}) IS DISTINCT FROM (${updatable.map((c) => `EXCLUDED.${c.name}`).join(', ')})
      RETURNING 1`;
    const res = await q.query(sql, arrays);
    changed += res.rows.length;
  }
  return changed;
}

export class SyncGuardError extends Error {}

export interface SaveStats {
  players: number;
  teams: number;
  competitions: number;
  memberships: number;
  affiliations: number;
  changed: number;
  removed: number;
}

const affId = (a: Dataset['affiliations'][number]) =>
  `${a.playerId}|${a.teamId}|${a.fromSeason ?? 'x'}|${a.toSeason ?? 'x'}`;

export async function saveDataset(q: Queryable, ds: Dataset, now = new Date()): Promise<SaveStats> {
  const src = ds.meta.sourceId;
  let changed = 0;

  changed += await upsert(
    q,
    'data_sources',
    [
      { name: 'id', type: 'text' },
      { name: 'label', type: 'text' },
      { name: 'kind', type: 'text' },
      { name: 'license', type: 'text' },
      { name: 'attribution', type: 'text' },
      { name: 'notes', type: 'text' },
      { name: 'current_season', type: 'integer' },
      { name: 'generated_at', type: 'timestamptz' },
    ],
    ['id'],
    [
      [
        src,
        ds.meta.label,
        ds.meta.kind,
        ds.meta.license,
        ds.meta.attribution,
        ds.meta.notes,
        ds.meta.currentSeason,
        ds.meta.generatedAt,
      ],
    ],
  );
  await q.query('UPDATE data_sources SET last_synced_at = $2 WHERE id = $1', [
    src,
    now.toISOString(),
  ]);

  // Seasons referenced anywhere (explicit season table, not implied by integers).
  const years = new Set<number>([ds.meta.currentSeason]);
  for (const m of ds.memberships)
    [m.fromSeason, m.toSeason].forEach((y) => y !== null && years.add(y));
  for (const a of ds.affiliations)
    [a.fromSeason, a.toSeason].forEach((y) => y !== null && years.add(y));
  if (years.size) {
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    const rows: unknown[][] = [];
    for (let y = lo; y <= hi; y++)
      rows.push([y, `${y}-${String(y + 1).slice(2)}`, `${y}-07-01`, `${y + 1}-06-30`]);
    await upsert(
      q,
      'seasons',
      [
        { name: 'start_year', type: 'integer' },
        { name: 'label', type: 'text' },
        { name: 'start_date', type: 'date' },
        { name: 'end_date', type: 'date' },
      ],
      ['start_year'],
      rows,
      { touchUpdatedAt: false },
    );
  }

  const j = (v: unknown) => JSON.stringify(v);
  changed += await upsert(
    q,
    'teams',
    [
      { name: 'id', type: 'text' },
      { name: 'kind', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'short_name', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'color', type: 'text' },
      { name: 'aliases', type: 'jsonb' },
      { name: 'name_norm', type: 'text' },
      { name: 'source_id', type: 'text' },
      { name: 'provider_ids', type: 'jsonb' },
    ],
    ['id'],
    ds.teams.map((t) => [
      t.id,
      t.kind,
      t.name,
      t.shortName,
      t.country,
      t.color,
      j(t.aliases),
      normalizeText(t.name),
      src,
      j(t.providerIds),
    ]),
  );

  changed += await upsert(
    q,
    'competitions',
    [
      { name: 'id', type: 'text' },
      { name: 'kind', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'short_name', type: 'text' },
      { name: 'country', type: 'text' },
      { name: 'aliases', type: 'jsonb' },
      { name: 'name_norm', type: 'text' },
      { name: 'source_id', type: 'text' },
      { name: 'provider_ids', type: 'jsonb' },
    ],
    ['id'],
    ds.competitions.map((c) => [
      c.id,
      c.kind,
      c.name,
      c.shortName,
      c.country ?? null,
      j(c.aliases),
      normalizeText(c.name),
      src,
      j(c.providerIds),
    ]),
  );

  changed += await upsert(
    q,
    'players',
    [
      { name: 'id', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'name_norm', type: 'text' },
      { name: 'aliases', type: 'jsonb' },
      { name: 'birth_year', type: 'integer' },
      { name: 'position', type: 'text' },
      { name: 'tier', type: 'smallint' },
      { name: 'fame', type: 'integer' },
      { name: 'source_id', type: 'text' },
      { name: 'provider_ids', type: 'jsonb' },
    ],
    ['id'],
    ds.players.map((p) => [
      p.id,
      p.name,
      normalizeText(p.name),
      j(p.aliases),
      p.birthYear,
      p.position,
      p.tier,
      p.fame,
      src,
      j(p.providerIds),
    ]),
  );

  changed += await upsert(
    q,
    'competition_memberships',
    [
      { name: 'team_id', type: 'text' },
      { name: 'competition_id', type: 'text' },
      { name: 'from_season', type: 'integer' },
      { name: 'to_season', type: 'integer' },
      { name: 'status', type: 'text' },
      { name: 'source_id', type: 'text' },
    ],
    ['team_id', 'competition_id', 'from_season'],
    ds.memberships.map((m) => [m.teamId, m.competitionId, m.fromSeason, m.toSeason, m.status, src]),
  );

  changed += await upsert(
    q,
    'player_affiliations',
    [
      { name: 'id', type: 'text' },
      { name: 'player_id', type: 'text' },
      { name: 'team_id', type: 'text' },
      { name: 'from_season', type: 'integer' },
      { name: 'to_season', type: 'integer' },
      { name: 'precision', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'source_id', type: 'text' },
    ],
    ['id'],
    ds.affiliations.map((a) => [
      affId(a),
      a.playerId,
      a.teamId,
      a.fromSeason,
      a.toSeason,
      a.precision,
      a.status,
      src,
    ]),
  );

  // The snapshot is authoritative for its own source: drop rows it no longer contains.
  let removed = 0;
  const prune = async (table: string, ids: string[], idCol = 'id') => {
    const r = await q.query(
      `DELETE FROM ${table} WHERE source_id = $1 AND NOT (${idCol} = ANY($2::text[])) RETURNING 1`,
      [src, ids],
    );
    removed += r.rows.length;
  };
  await prune('player_affiliations', ds.affiliations.map(affId));
  await prune(
    'players',
    ds.players.map((p) => p.id),
  );
  await prune(
    'teams',
    ds.teams.map((t) => t.id),
  );
  await prune(
    'competitions',
    ds.competitions.map((c) => c.id),
  );
  await prune(
    'competition_memberships',
    ds.memberships.map((m) => `${m.teamId}|${m.competitionId}|${m.fromSeason}`),
    "(team_id || '|' || competition_id || '|' || from_season)",
  );

  return {
    players: ds.players.length,
    teams: ds.teams.length,
    competitions: ds.competitions.length,
    memberships: ds.memberships.length,
    affiliations: ds.affiliations.length,
    changed,
    removed,
  };
}

export async function countSource(q: Queryable, sourceId: string) {
  const one = async (t: string) =>
    Number(
      (await q.query<{ n: string }>(`SELECT count(*) n FROM ${t} WHERE source_id = $1`, [sourceId]))
        .rows[0]!.n,
    );
  return {
    players: await one('players'),
    teams: await one('teams'),
    competitions: await one('competitions'),
    memberships: await one('competition_memberships'),
    affiliations: await one('player_affiliations'),
  };
}

export async function loadDataset(q: Queryable, sourceId: string): Promise<Dataset | null> {
  const src = (await q.query(`SELECT * FROM data_sources WHERE id = $1`, [sourceId])).rows[0];
  if (!src) return null;
  const [teams, comps, mems, players, affs] = await Promise.all([
    q.query('SELECT * FROM teams WHERE source_id = $1 ORDER BY id', [sourceId]),
    q.query('SELECT * FROM competitions WHERE source_id = $1 ORDER BY id', [sourceId]),
    q.query('SELECT * FROM competition_memberships WHERE source_id = $1', [sourceId]),
    q.query('SELECT * FROM players WHERE source_id = $1 ORDER BY id', [sourceId]),
    q.query('SELECT * FROM player_affiliations WHERE source_id = $1', [sourceId]),
  ]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return DatasetSchema.parse({
    meta: {
      sourceId,
      label: src.label,
      kind: src.kind,
      generatedAt: iso(src.generated_at),
      license: src.license,
      attribution: src.attribution,
      notes: src.notes,
      currentSeason: src.current_season,
    },
    teams: teams.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      shortName: r.short_name,
      country: r.country,
      color: r.color,
      aliases: r.aliases,
      source: r.source_id,
      providerIds: r.provider_ids,
    })),
    competitions: comps.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      shortName: r.short_name,
      country: r.country ?? undefined,
      aliases: r.aliases,
      source: r.source_id,
      providerIds: r.provider_ids,
    })),
    memberships: mems.rows.map((r) => ({
      teamId: r.team_id,
      competitionId: r.competition_id,
      fromSeason: r.from_season,
      toSeason: r.to_season,
      status: r.status,
      source: r.source_id,
    })),
    players: players.rows.map((r) => ({
      id: r.id,
      name: r.name,
      aliases: r.aliases,
      birthYear: r.birth_year,
      position: r.position,
      tier: r.tier,
      fame: r.fame ?? 0,
      source: r.source_id,
      providerIds: r.provider_ids,
    })),
    affiliations: affs.rows.map((r) => ({
      playerId: r.player_id,
      teamId: r.team_id,
      fromSeason: r.from_season,
      toSeason: r.to_season,
      precision: r.precision,
      status: r.status,
      source: r.source_id,
    })),
  });
}
