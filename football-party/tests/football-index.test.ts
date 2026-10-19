import { describe, expect, it } from 'vitest';
import { FootballIndex } from '../shared/football';
import { sampleDataset } from '../data/sample/sample';
import { checkDatasetIntegrity } from '../server/football/integrity';
import { DatasetSchema, type Dataset } from '../shared/football/types';
import { normalizeText } from '../shared/football/normalize';
import { seededRng } from '../shared/util/rng';

const idx = new FootballIndex(sampleDataset);
const club = (id: string) => idx.criterionFor('club', id)!;
const league = (id: string) => idx.criterionFor('league', id)!;
const nation = (c: string) => idx.criterionFor('national', `nt-${c}`)!;

describe('sample dataset', () => {
  it('passes schema and referential integrity', () => {
    expect(checkDatasetIntegrity(sampleDataset)).toEqual([]);
    expect(() => DatasetSchema.parse(sampleDataset)).not.toThrow();
  });
  it('is labelled as sample data', () => {
    expect(idx.meta.kind).toBe('sample');
  });
});

describe('normalization & search', () => {
  it('is accent, case and punctuation insensitive', () => {
    expect(normalizeText('Kylian Mbappé')).toBe('kylian mbappe');
    expect(normalizeText("N'Golo Kanté")).toBe('ngolo kante');
    expect(normalizeText('Müller')).toBe('muller');
  });
  it('finds players regardless of accents and via aliases', () => {
    expect(idx.searchPlayers('mbappe')[0]?.name).toBe('Kylian Mbappé');
    expect(idx.searchPlayers('MULLER')[0]?.name).toBe('Thomas Müller');
    expect(idx.searchPlayers('cr7')[0]?.name).toBe('Cristiano Ronaldo');
    expect(idx.searchPlayers('kun')[0]?.name).toBe('Sergio Agüero');
  });
  it('returns nothing for gibberish or too-short queries and honours exclusions', () => {
    expect(idx.searchPlayers('zzzzqx')).toEqual([]);
    expect(idx.searchPlayers('m')).toEqual([]);
    const res = idx.searchPlayers('messi', 8, new Set(['lionel-messi']));
    expect(res).toEqual([]);
  });
});

describe('criteria validation (historical affiliations)', () => {
  it('validates clubs and national teams from confirmed records', () => {
    expect(idx.verdict('lionel-messi', club('barcelona')).ok).toBe(true);
    expect(idx.verdict('lionel-messi', club('real-madrid')).ok).toBe(false);
    expect(idx.verdict('lionel-messi', nation('arg')).ok).toBe(true);
    expect(idx.verdict('lionel-messi', nation('bra')).ok).toBe(false);
  });
  it('validates leagues through club membership during the affiliation seasons', () => {
    expect(idx.verdict('cristiano-ronaldo', league('premier-league')).ok).toBe(true);
    expect(idx.verdict('cristiano-ronaldo', league('bundesliga')).ok).toBe(false);
  });
  it('respects seasons a club spent outside a league (Juventus in Serie B 2006-07)', () => {
    // Buffon stayed with Juventus through 2006-07, so Serie B is valid for him…
    expect(idx.verdict('gianluigi-buffon', league('serie-b')).ok).toBe(true);
    // …Zidane left Juventus in 2001, so he never played in Serie B with them.
    expect(idx.verdict('zinedine-zidane', league('serie-b')).ok).toBe(false);
    // Ibrahimović was at Juventus 2004-05 only (before the relegation) and Inter afterwards.
    expect(idx.verdict('zlatan-ibrahimovic', league('serie-b')).ok).toBe(false);
  });
  it('respects Atlético Madrid being outside La Liga in 2000-01 and 2001-02', () => {
    // Torres: Atlético 2001-2006 → overlaps La Liga from 2002.
    expect(idx.verdict('fernando-torres', league('la-liga')).ok).toBe(true);
  });
  it('rejects unknown players', () => {
    expect(idx.verdict('nobody', club('barcelona'))).toEqual({
      ok: false,
      reason: 'unknown-player',
    });
  });
});

describe('unknown / ambiguous data is never used for validation', () => {
  const base = sampleDataset;
  const withExtra = (affs: Dataset['affiliations']): FootballIndex =>
    new FootballIndex({ ...base, affiliations: [...base.affiliations, ...affs] });

  it('ignores status=unknown affiliations but reports them as unverified', () => {
    const i = withExtra([
      {
        playerId: 'lionel-messi',
        teamId: 'real-madrid',
        fromSeason: 2010,
        toSeason: 2011,
        precision: 'season',
        status: 'unknown',
        source: 't',
      },
    ]);
    const v = i.verdict('lionel-messi', i.criterionFor('club', 'real-madrid')!);
    expect(v).toEqual({ ok: false, reason: 'unverified-record' });
    expect(i.verdict('lionel-messi', i.criterionFor('league', 'la-liga')!).ok).toBe(true); // via Barcelona
  });
  it('year-precision affiliations count for clubs but not for leagues', () => {
    const i = withExtra([
      {
        playerId: 'xavi',
        teamId: 'milan',
        fromSeason: 2005,
        toSeason: 2006,
        precision: 'year',
        status: 'confirmed',
        source: 't',
      },
    ]);
    expect(i.verdict('xavi', i.criterionFor('club', 'milan')!).ok).toBe(true);
    expect(i.verdict('xavi', i.criterionFor('league', 'serie-a')!)).toEqual({
      ok: false,
      reason: 'unverified-record',
    });
  });
  it('unknown memberships do not establish league membership', () => {
    const i = new FootballIndex({
      ...base,
      memberships: base.memberships.map((m) =>
        m.teamId === 'roma' ? { ...m, status: 'unknown' as const } : m,
      ),
    });
    expect(i.verdict('francesco-totti', i.criterionFor('league', 'serie-a')!).ok).toBe(false);
  });
});

describe('grid generation', () => {
  for (const diff of ['easy', 'medium', 'hard'] as const) {
    it(`builds a fully answerable ${diff} grid`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const g = idx.generateGrid(seededRng(seed), diff);
        expect(g).not.toBeNull();
        expect(g!.answerCounts).toHaveLength(9);
        const min = { easy: 3, medium: 2, hard: 1 }[diff];
        expect(Math.min(...g!.answerCounts)).toBeGreaterThanOrEqual(min);
        const all = [...g!.rows, ...g!.cols].map((c) => `${c.type}:${c.id}`);
        expect(new Set(all).size).toBe(6);
      }
    });
  }
  it('returns null (unplayable) when data cannot support a grid', () => {
    const tiny = new FootballIndex({
      ...sampleDataset,
      players: sampleDataset.players.slice(0, 3),
    });
    expect(tiny.generateGrid(seededRng(1), 'easy')).toBeNull();
  });
  it('is deterministic for a seed', () => {
    const a = idx.generateGrid(seededRng(42), 'medium')!;
    const b = idx.generateGrid(seededRng(42), 'medium')!;
    expect(a.rows.map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
  });
});

describe('impostor pool', () => {
  it('filters by tier, category', () => {
    expect(idx.impostorPool('all', 'easy').every((p) => p.tier === 1)).toBe(true);
    expect(idx.impostorPool('legends', 'hard').every((p) => (p.birthYear ?? 9999) <= 1980)).toBe(
      true,
    );
    expect(idx.impostorPool('serie-a', 'hard').some((p) => p.id === 'andrea-pirlo')).toBe(true);
    expect(idx.impostorPool('bundesliga', 'hard').some((p) => p.id === 'cristiano-ronaldo')).toBe(
      false,
    );
  });
});

describe('impostor pool is limited to genuinely famous players', () => {
  it('is ranked by fame, capped per difficulty, and prefers curated famous names', () => {
    const easy = idx.impostorPool('all', 'easy');
    expect(easy.length).toBeLessThanOrEqual(100);
    const fames = easy.map((p) => idx.fameOf(p.id));
    expect(fames).toEqual([...fames].sort((a, b) => b - a));
    expect(easy[0]!.name).toBe('Lionel Messi'); // top of the curated list
    expect(idx.impostorPool('all', 'hard').length).toBeLessThanOrEqual(400);
  });
  it('never offers an unknown player, even when the dataset is huge', () => {
    const base = sampleDataset.players[0]!;
    const obscure = {
      ...base,
      id: 'volodymyr-lyutyi',
      name: 'Volodymyr Lyutyi',
      aliases: [],
      tier: 2 as const,
      fame: 5,
    };
    const many = Array.from({ length: 700 }, (_, i) => ({
      ...base,
      id: `filler-${i}`,
      name: `Filler Star ${i}`,
      aliases: [],
      tier: 1 as const,
      fame: 6 + i,
    }));
    const big = new FootballIndex({
      ...sampleDataset,
      players: [...sampleDataset.players, obscure, ...many],
    });
    for (const d of ['easy', 'medium', 'hard'] as const)
      expect(big.impostorPool('all', d).some((p) => p.id === 'volodymyr-lyutyi')).toBe(false);
  });
  it('ranks search results by fame among equal text matches', () => {
    const base = sampleDataset.players[0]!;
    const twin = {
      ...base,
      id: 'obscure-twin',
      name: 'Lionel Messi',
      aliases: [],
      tier: 3 as const,
      fame: 1,
    };
    const i2 = new FootballIndex({ ...sampleDataset, players: [twin, ...sampleDataset.players] });
    expect(i2.searchPlayers('lionel messi')[0]!.id).toBe('lionel-messi');
  });
});
