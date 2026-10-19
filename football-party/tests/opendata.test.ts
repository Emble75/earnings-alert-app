import { describe, expect, it } from 'vitest';
import { FootballIndex } from '../shared/football';
import {
  buildOpenDataset,
  parseCsv,
  positionOf,
  type TransferRow,
  type WcPlayerRow,
  type WcSquadRow,
} from '../server/football/providers/opendata';

const row = (o: Partial<TransferRow>): TransferRow => ({
  club_name: '',
  player_name: '',
  age: '25',
  position: 'Left-Back',
  club_involved_name: '',
  fee: '€1.00m',
  fee_cleaned: '1',
  transfer_movement: 'in',
  transfer_period: 'Summer',
  league_name: 'Premier League',
  year: '2000',
  country: 'England',
  ...o,
});
const young = (
  club: string,
  other: string,
  dir: 'in' | 'out',
  year: number,
  period: 'Summer' | 'Winter',
  league: string,
  age: number,
  country = 'England',
) =>
  row({
    club_name: club,
    player_name: 'Ashley Young',
    club_involved_name: other,
    transfer_movement: dir,
    year: String(year),
    transfer_period: period,
    league_name: league,
    age: String(age),
    country,
    fee_cleaned: '13',
  });

// Real-world shape: every transfer is listed on both sides, with DIFFERENT names for the counterpart.
const transfers: TransferRow[] = [
  young('Aston Villa', 'Watford', 'in', 2006, 'Winter', 'Premier League', 21),
  young('Watford FC', 'Aston Villa', 'out', 2006, 'Winter', 'Championship', 21),
  young('Manchester United', 'Aston Villa', 'in', 2011, 'Summer', 'Premier League', 25),
  young('Aston Villa', 'Man Utd', 'out', 2011, 'Summer', 'Premier League', 25),
  young('Inter Milan', 'Man Utd', 'in', 2019, 'Winter', 'Serie A', 34, 'Italy'),
  young('Manchester United', 'Inter', 'out', 2019, 'Winter', 'Premier League', 34),
  // junk counterpart must never become a club
  row({
    club_name: 'Manchester United',
    player_name: 'Some Keeper',
    age: '30',
    transfer_movement: 'out',
    club_involved_name: 'Retired',
    year: '2015',
    league_name: 'Premier League',
  }),
  // a team that only exists as a counterpart (outside covered leagues)
  row({
    club_name: 'Aston Villa',
    player_name: 'Brazil Guy',
    age: '24',
    club_involved_name: 'Santos FC',
    year: '2013',
    league_name: 'Premier League',
    position: 'Centre-Forward',
  }),
  // loan out and end of loan
  row({
    club_name: 'Chelsea FC',
    player_name: 'Loan Kid',
    age: '19',
    transfer_movement: 'in',
    year: '2010',
    club_involved_name: 'Lyon',
    league_name: 'Premier League',
  }),
  row({
    club_name: 'Chelsea FC',
    player_name: 'Loan Kid',
    age: '20',
    transfer_movement: 'out',
    year: '2011',
    club_involved_name: 'Everton',
    league_name: 'Premier League',
    fee: 'loan transfer',
  }),
  row({
    club_name: 'Everton FC',
    player_name: 'Loan Kid',
    age: '20',
    transfer_movement: 'in',
    year: '2011',
    club_involved_name: 'Chelsea',
    league_name: 'Premier League',
    fee: 'loan transfer',
  }),
  row({
    club_name: 'Everton FC',
    player_name: 'Loan Kid',
    age: '21',
    transfer_movement: 'out',
    year: '2012',
    club_involved_name: 'Chelsea',
    league_name: 'Premier League',
    fee: 'End of loanMay',
  }),
  row({
    club_name: 'Chelsea FC',
    player_name: 'Loan Kid',
    age: '21',
    transfer_movement: 'in',
    year: '2012',
    club_involved_name: 'Everton',
    league_name: 'Premier League',
    fee: 'End of loanMay',
  }),
  // two different people with the same name (ages 10 years apart)
  row({
    club_name: 'Arsenal FC',
    player_name: 'Danny Murphy',
    age: '22',
    year: '2000',
    league_name: 'Premier League',
  }),
  row({
    club_name: 'Everton FC',
    player_name: 'Danny Murphy',
    age: '25',
    year: '2010',
    league_name: 'Premier League',
  }),
  // bad ages are ignored, not guessed
  row({ club_name: 'Arsenal FC', player_name: 'Glitch Age', age: '0', year: '2005' }),
  row({
    club_name: 'Arsenal FC',
    player_name: 'Glitch Age',
    age: '120',
    year: '2006',
    transfer_movement: 'out',
  }),
];
const wcPlayers: WcPlayerRow[] = [
  {
    player_id: 'P-1',
    family_name: 'Young',
    given_name: 'Ashley',
    birth_date: '1985-07-09',
    female: '0',
  },
  {
    player_id: 'P-2',
    family_name: 'Murphy',
    given_name: 'Danny',
    birth_date: '1977-03-18',
    female: '0',
  },
];
const wcSquads: WcSquadRow[] = [
  {
    tournament_name: "2010 FIFA Men's World Cup",
    team_id: 'T-9',
    team_name: 'England',
    player_id: 'P-1',
    family_name: 'Young',
    given_name: 'Ashley',
    position_code: 'MF',
  },
  {
    tournament_name: "2014 FIFA Men's World Cup",
    team_id: 'T-9',
    team_name: 'England',
    player_id: 'P-1',
    family_name: 'Young',
    given_name: 'Ashley',
    position_code: 'MF',
  },
  {
    tournament_name: "1998 FIFA Men's World Cup",
    team_id: 'T-9',
    team_name: 'West Germany',
    player_id: 'P-2',
    family_name: 'Murphy',
    given_name: 'Danny',
    position_code: 'MF',
  },
];

const ds = buildOpenDataset({ transfers, wcSquads, wcPlayers }, '2026-01-01T00:00:00.000Z');
const idx = new FootballIndex(ds);
const club = (n: string) => idx.criterionFor('club', ds.teams.find((t) => t.name === n)!.id)!;
const league = (n: string) =>
  idx.criterionFor('league', ds.competitions.find((c) => c.name === n)!.id)!;
const ashley = ds.players.find((p) => p.name === 'Ashley Young')!;

describe('open-data career reconstruction', () => {
  it('rebuilds Ashley Young: Aston Villa → Man United → Inter, with league overlap', () => {
    expect(idx.searchPlayers('ashley young')[0]?.id).toBe(ashley.id);
    expect(idx.verdict(ashley.id, club('Aston Villa')).ok).toBe(true);
    expect(idx.verdict(ashley.id, club('Manchester United')).ok).toBe(true);
    expect(idx.verdict(ashley.id, club('Inter Milan')).ok).toBe(true);
    expect(idx.verdict(ashley.id, league('Premier League')).ok).toBe(true);
    expect(idx.verdict(ashley.id, league('Serie A')).ok).toBe(true);
    expect(idx.verdict(ashley.id, club('Chelsea FC')).ok).toBe(false);
    const spells = ds.affiliations.filter(
      (a) => a.playerId === ashley.id && a.teamId === 'tm-c-aston-villa',
    );
    // joined in the January 2007 window of season 2006 → left in summer 2011 → last season 2010
    expect(spells).toEqual([
      expect.objectContaining({ fromSeason: 2006, toSeason: 2010, precision: 'season' }),
    ]);
    const united = ds.affiliations.find(
      (a) => a.playerId === ashley.id && a.teamId === 'tm-c-manchester-united',
    )!;
    expect([united.fromSeason, united.toSeason]).toEqual([2011, 2019]); // left in the January 2020 window: he was still there for the first half of 2019/20
  });

  it('links World Cup squads by name AND birth year, and merges West Germany into Germany', () => {
    expect(ashley.birthYear).toBe(1985);
    const eng = ds.teams.find((t) => t.name === 'England' && t.kind === 'national')!;
    expect(idx.verdict(ashley.id, idx.criterionFor('national', eng.id)!).ok).toBe(true);
    expect(ds.teams.some((t) => t.name === 'West Germany')).toBe(false);
    expect(ds.teams.some((t) => t.name === 'Germany' && t.kind === 'national')).toBe(true);
  });

  it('unifies counterpart aliases and never turns junk into clubs', () => {
    const names = ds.teams.map((t) => t.name);
    expect(names).not.toContain('Man Utd');
    expect(names).not.toContain('Retired');
    expect(names).toContain('Santos FC'); // genuine outside club kept, dates unknown
    const santos = ds.affiliations.find((a) => a.teamId === 'tm-x-santos-fc')!;
    expect(santos).toMatchObject({ precision: 'unknown', status: 'confirmed' });
  });

  it('handles loans: separate spells at the parent club, spell at the loan club', () => {
    const kid = ds.players.find((p) => p.name === 'Loan Kid')!;
    const aff = ds.affiliations.filter(
      (a) => a.playerId === kid.id && a.teamId.startsWith('tm-c-'),
    );
    // Chelsea 2010, loan to Everton 2011, back at Chelsea from 2012 (no later move recorded → end unknown, year precision).
    expect(
      aff.map((a) => `${a.teamId}:${a.fromSeason}-${a.toSeason}:${a.precision}`).sort(),
    ).toEqual([
      'tm-c-chelsea-fc:2010-2010:season',
      'tm-c-chelsea-fc:2012-2012:year',
      'tm-c-everton-fc:2011-2011:season',
    ]);
  });

  it('keeps same-named people apart and ignores impossible ages', () => {
    expect(ds.players.filter((p) => p.name === 'Danny Murphy')).toHaveLength(2);
    expect(ds.players.find((p) => p.name === 'Glitch Age')!.birthYear).toBeNull();
  });

  it('classifies leagues with season memberships', () => {
    expect(ds.competitions.map((c) => c.name).sort()).toEqual([
      'Championship',
      'Premier League',
      'Serie A',
    ]);
    expect(
      ds.memberships.some((m) => m.teamId === 'tm-c-inter-milan' && m.fromSeason === 2019),
    ).toBe(true);
  });
});

describe('csv + position helpers', () => {
  it('parses quoted fields, escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2\r\n');
    expect(rows).toEqual([
      { a: 'x, y', b: 'say "hi"' },
      { a: '1', b: '2' },
    ]);
  });
  it('maps messy position labels', () => {
    expect(
      [
        'Centre-Back',
        'defence',
        'Goalkeeper',
        'Defensive Midfield',
        'Left Winger',
        'attack',
        'Sweeper',
        '?',
      ].map(positionOf),
    ).toEqual(['DEF', 'DEF', 'GK', 'MID', 'FWD', 'FWD', 'DEF', null]);
  });
});

/** Real-data regression: runs only when the cache exists (after `npm run sync -- --provider opendata`). */
import fs from 'node:fs';
import path from 'node:path';
import { openDataProvider } from '../server/football/providers/opendata';
import { silentLogger } from '../server/log';
import { seededRng } from '../shared/util/rng';

const cacheDir = path.resolve('.data/opendata-cache');
describe.skipIf(
  !fs.existsSync(path.join(cacheDir, 'ewenme_transfers_master_data_premier-league.csv')),
)('open data (cached real files)', () => {
  it('covers wide careers (Ashley Young, Premier League × Inter) and builds playable grids', async () => {
    const p = openDataProvider({
      cacheDir,
      fetchImpl: (async () => {
        throw new Error('network disabled');
      }) as unknown as typeof fetch,
    });
    const real = await p.fetchDataset({ log: silentLogger });
    const i = new FootballIndex(real);
    expect(real.players.length).toBeGreaterThan(30_000);
    const y = i.searchPlayers('ashley young')[0]!;
    const c = (n: string) =>
      i.criterionFor('club', real.teams.find((t) => t.kind === 'club' && t.name === n)!.id)!;
    const l = (n: string) =>
      i.criterionFor('league', real.competitions.find((x) => x.name === n)!.id)!;
    expect(i.verdict(y.id, l('Premier League')).ok).toBe(true);
    expect(i.verdict(y.id, c('Inter Milan')).ok).toBe(true);
    expect(i.validAnswers(l('Premier League'), c('Inter Milan')).includes(y.id)).toBe(true);
    for (const d of ['easy', 'medium', 'hard'] as const)
      expect(i.generateGrid(seededRng(2), d), d).not.toBeNull();
  }, 120_000);
});
