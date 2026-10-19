import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FootballIndex } from '../shared/football';
import { seededRng } from '../shared/util/rng';
import { silentLogger } from '../server/log';
import {
  buildStatsBombDataset,
  contiguousRanges,
  positionGroup,
  statsbombProvider,
  wantedCompetitions,
  type SbCompetition,
  type SbInput,
  type SbLineup,
  type SbMatch,
} from '../server/football/providers/statsbomb';

const comp = (
  id: number,
  season: number,
  name: string,
  season_name: string,
  gender = 'male',
): SbCompetition => ({
  competition_id: id,
  season_id: season,
  competition_name: name,
  season_name,
  competition_gender: gender,
  country_name: 'Spain',
});
const match = (id: number, h: [number, string], a: [number, string]): SbMatch => ({
  match_id: id,
  home_team: { home_team_id: h[0], home_team_name: h[1], country: { name: 'Spain' } },
  away_team: { away_team_id: a[0], away_team_name: a[1], country: { name: 'Spain' } },
});
const side = (
  team_id: number,
  team_name: string,
  players: [number, string, string | null, string[]][],
): SbLineup => ({
  team_id,
  team_name,
  lineup: players.map(([player_id, player_name, player_nickname, pos]) => ({
    player_id,
    player_name,
    player_nickname,
    positions: pos.map((position) => ({ position })),
  })),
});

describe('statsbomb provider (pure transformation)', () => {
  it('selects only men’s leagues with European season names and major tournaments', () => {
    const picked = wantedCompetitions([
      comp(11, 1, 'La Liga', '2004/2005'),
      comp(11, 2, 'La Liga', '1973/1974'),
      comp(9, 3, 'Major League Soccer', '2023'),
      comp(2, 4, 'Premier League', '2003/2004', 'female'),
      comp(43, 5, 'FIFA World Cup', '2018'),
      comp(16, 6, 'Champions League', '2018/2019'),
      comp(44, 7, 'Liga Profesional', '1981'),
    ]);
    expect(picked.map((c) => `${c.competition_name} ${c.season_name}`)).toEqual([
      'La Liga 2004/2005',
      'La Liga 1973/1974',
      'FIFA World Cup 2018',
    ]);
  });

  it('maps positions and merges seasons into contiguous spells', () => {
    expect(positionGroup('Center Back')).toBe('DEF');
    expect(positionGroup('Left Wing Back')).toBe('DEF');
    expect(positionGroup('Right Defensive Midfield')).toBe('MID');
    expect(positionGroup('Left Wing')).toBe('FWD');
    expect(positionGroup('Goalkeeper')).toBe('GK');
    expect(contiguousRanges([2006, 2004, 2005, 2009, 2005])).toEqual([
      [2004, 2006],
      [2009, 2009],
    ]);
  });

  const liga = comp(11, 37, 'La Liga', '2004/2005');
  const liga2 = comp(11, 38, 'La Liga', '2005/2006');
  const wc = comp(43, 3, 'FIFA World Cup', '2018');
  const inputs: SbInput[] = [
    {
      competition: liga,
      matches: [
        {
          match: match(1, [217, 'Barcelona'], [220, 'Real Madrid']),
          lineups: [
            side(217, 'Barcelona', [
              [5503, 'Lionel Andrés Messi Cuccittini', 'Lionel Messi', ['Right Wing']],
              [9999, 'Bench Warmer', null, []],
            ]),
            side(220, 'Real Madrid', [[1, 'Iker Casillas', null, ['Goalkeeper']]]),
          ],
        },
      ],
    },
    {
      competition: liga2,
      matches: [
        {
          match: match(2, [217, 'Barcelona'], [220, 'Real Madrid']),
          lineups: [
            side(217, 'Barcelona', [
              [5503, 'Lionel Andrés Messi Cuccittini', 'Lionel Messi', ['Right Wing']],
            ]),
            side(220, 'Real Madrid', []),
          ],
        },
      ],
    },
    {
      competition: wc,
      matches: [
        {
          match: match(3, [779, 'Argentina'], [800, 'France']),
          lineups: [
            side(779, 'Argentina', [
              [5503, 'Lionel Andrés Messi Cuccittini', 'Lionel Messi', ['Right Wing']],
            ]),
            side(800, 'France', []),
          ],
        },
      ],
    },
  ];
  const ds = buildStatsBombDataset(inputs, '2026-01-01T00:00:00.000Z');
  const idx = new FootballIndex(ds);

  it('derives dated affiliations and league memberships from played lineups only', () => {
    const messi = ds.players.find((p) => p.id === 'sb-p5503')!;
    expect(messi).toMatchObject({ name: 'Lionel Messi', position: 'FWD' });
    expect(messi.aliases).toContain('Lionel Andrés Messi Cuccittini');
    expect(ds.players.find((p) => p.id === 'sb-p9999')).toBeUndefined(); // unused substitute
    const barca = ds.affiliations.filter(
      (a) => a.playerId === 'sb-p5503' && a.teamId === 'sb-t217',
    );
    expect(barca).toEqual([
      expect.objectContaining({ fromSeason: 2004, toSeason: 2005, precision: 'season' }),
    ]);
    const arg = ds.affiliations.find((a) => a.teamId === 'sb-t779')!;
    expect(arg).toMatchObject({ precision: 'unknown', fromSeason: null });
    expect(ds.teams.find((t) => t.id === 'sb-t779')!.kind).toBe('national');
    expect(ds.memberships).toContainEqual(
      expect.objectContaining({
        teamId: 'sb-t217',
        competitionId: 'sb-c11',
        fromSeason: 2004,
        toSeason: 2005,
      }),
    );
    expect(ds.meta).toMatchObject({ kind: 'live', sourceId: 'statsbomb' });
  });

  it('validates through the same rules the game uses; absent records are rejected, not guessed', () => {
    const club = (n: string) => idx.criterionFor('club', ds.teams.find((t) => t.name === n)!.id)!;
    const league = idx.criterionFor('league', 'sb-c11')!;
    expect(idx.verdict('sb-p5503', club('Barcelona')).ok).toBe(true);
    expect(idx.verdict('sb-p5503', league).ok).toBe(true);
    expect(idx.verdict('sb-p5503', idx.criterionFor('national', 'sb-t779')!).ok).toBe(true);
    expect(idx.verdict('sb-p5503', club('Real Madrid')).ok).toBe(false);
    // Casillas played for Real Madrid in 2004 → La Liga valid via the 2004 membership
    expect(idx.verdict('sb-p1', league).ok).toBe(true);
  });

  it('applies a fame proxy that weights tournaments', () => {
    expect(ds.players.find((p) => p.id === 'sb-p5503')!.tier).toBe(3); // tiny fixture: 3 apps + 1 tournament = 18 < 30
    const many: SbInput[] = [
      {
        competition: liga,
        matches: Array.from({ length: 90 }, (_, i) => ({
          match: match(100 + i, [217, 'Barcelona'], [220, 'Real Madrid']),
          lineups: [
            side(217, 'Barcelona', [[7, 'Star Player', null, ['Center Forward']]]),
            side(220, 'Real Madrid', []),
          ],
        })),
      },
    ];
    expect(buildStatsBombDataset(many, '2026-01-01T00:00:00.000Z').players[0]!.tier).toBe(1);
  });

  it('fetches via the HTTP client with a disk cache and no network on a second run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
    const files: Record<string, unknown> = {
      'competitions.json': [liga],
      'matches/11/37.json': [match(1, [217, 'Barcelona'], [220, 'Real Madrid'])],
      'lineups/1.json': inputs[0]!.matches[0]!.lineups,
    };
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      const rel = url.split('/data/')[1]!;
      return rel in files
        ? new Response(JSON.stringify(files[rel]), { status: 200 })
        : new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const p = statsbombProvider({
      cacheDir: dir,
      fetchImpl,
      sleep: async () => undefined,
      concurrency: 2,
    });
    const first = await p.fetchDataset({ log: silentLogger });
    expect(first.players.length).toBe(2);
    const before = calls;
    expect(before).toBe(3);
    await p.fetchDataset({ log: silentLogger });
    expect(calls).toBe(before); // served from cache
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Real-data checks run only when the StatsBomb cache exists locally (after `npm run sync -- --provider statsbomb`),
 * so CI without network stays green while developers get a live regression test.
 */
const cacheDir = path.resolve('.data/statsbomb-cache');
describe.skipIf(!fs.existsSync(path.join(cacheDir, 'competitions.json')))(
  'statsbomb real data (cached)',
  () => {
    it('knows well-known facts and builds playable grids', async () => {
      const p = statsbombProvider({
        cacheDir,
        fetchImpl: (async () => {
          throw new Error('network disabled in test');
        }) as unknown as typeof fetch,
      });
      const ds = await p.fetchDataset({ log: silentLogger });
      const idx = new FootballIndex(ds);
      const find = (q: string) => idx.searchPlayers(q, 1)[0]!;
      const team = (n: string, k: 'club' | 'national') =>
        idx.criterionFor(k, ds.teams.find((t) => t.kind === k && t.name === n)!.id)!;
      expect(idx.verdict(find('Messi').id, team('Barcelona', 'club')).ok).toBe(true);
      expect(idx.verdict(find('Messi').id, team('Real Madrid', 'club')).ok).toBe(false);
      expect(idx.verdict(find('Messi').id, team('Argentina', 'national')).ok).toBe(true);
      expect(idx.verdict(find('Thierry Henry').id, team('Arsenal', 'club')).ok).toBe(true);
      expect(idx.searchPlayers('mbappe', 3).some((x) => x.name.includes('Mbapp'))).toBe(true);
      for (const d of ['easy', 'medium', 'hard'] as const) {
        const g = idx.generateGrid(seededRng(3), d);
        expect(g, d).not.toBeNull();
      }
    }, 60_000);
  },
);
