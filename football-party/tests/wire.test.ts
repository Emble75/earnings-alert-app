import { describe, expect, it } from 'vitest';
import { FootballIndex } from '../shared/football';
import { compactDataset, expandDataset } from '../shared/football/wire';
import { seededRng } from '../shared/util/rng';
import { sampleDataset } from '../data/sample/sample';

describe('compact dataset wire format', () => {
  it('round-trips to an index that behaves identically', () => {
    const a = new FootballIndex(sampleDataset);
    const wire = JSON.parse(JSON.stringify(compactDataset(sampleDataset)));
    const b = new FootballIndex(expandDataset(wire));
    expect(b.counts).toEqual(a.counts);
    for (const d of ['easy', 'medium', 'hard'] as const)
      expect(b.generateGrid(seededRng(5), d)?.rows.map((r) => r.id)).toEqual(
        a.generateGrid(seededRng(5), d)?.rows.map((r) => r.id),
      );
    for (const [p, t] of [
      ['gianluigi-buffon', 'serie-b'],
      ['zinedine-zidane', 'serie-b'],
      ['cristiano-ronaldo', 'premier-league'],
    ] as const)
      expect(b.verdict(p, b.criterionFor('league', t)!).ok).toBe(
        a.verdict(p, a.criterionFor('league', t)!).ok,
      );
    expect(JSON.stringify(compactDataset(sampleDataset)).length).toBeLessThan(
      JSON.stringify(sampleDataset).length * 0.7,
    );
  });
});
