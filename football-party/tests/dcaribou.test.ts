import { describe, expect, it } from 'vitest';
import { buildDcaribouDataset, type DcaribouTexts } from '../server/football/providers/dcaribou';
import { FootballIndex } from '../shared/football';

const t: DcaribouTexts = {
  players: [
    '"player_id","name","date_of_birth","country_of_citizenship","position","current_club_id","highest_market_value_in_eur"',
    '"1","Ann Wing","1990-01-01 00:00:00","England","Attack","10","5000000"',
    ...Array.from(
      { length: 13 },
      (_, i) => `"${100 + i}","Mate ${i}","1991-01-01 00:00:00","England","Attack","10","1000000"`,
    ),
  ].join('\n'),
  transfers: [
    '"player_id","transfer_date","transfer_season","from_club_id","to_club_id","from_club_name","to_club_name","transfer_fee","market_value_in_eur","player_name"',
    '"1","2019-07-01","19/20","10","20","Alpha FC","Beta FC","0","0","Ann Wing"',
    '"1","2015-07-01","15/16","30","10","Gamma U19","Alpha FC","0","0","Ann Wing"',
    '"1","2030-06-30","25/26","20","40","Beta FC","Retired","0","0","Ann Wing"',
  ].join('\n'),
  clubs: '"club_id","name"\n"10","Alpha FC"\n"20","Beta FC"',
  competitions:
    '"competition_id","name","sub_type","type"\n"XX1","Top League","first_tier","domestic_league"\n"FIWC","World Cup","","national_team_competition"',
  games: [
    '"game_id","competition_id","season","home_club_id","away_club_id","home_club_name","away_club_name"',
    ...[2015, 2016, 2017, 2018].map((y) => `"g${y}","XX1","${y}","10","20","Alpha FC","Beta FC"`),
  ].join('\n'),
  appearances: [
    '"appearance_id","game_id","player_id","player_club_id","player_current_club_id","date","player_name","competition_id"',
    ...Array.from(
      { length: 14 },
      (_, i) => `"a${i}","g1","${i === 0 ? 1 : 99 + i}","900","1","2020-01-01","P","FIWC"`,
    ),
  ].join('\n'),
  national_teams: '"national_team_id","name"\n"900","England"',
};

describe('dcaribou provider (fixture)', () => {
  const ds = buildDcaribouDataset(t, '2026-10-20T00:00:00Z');
  const idx = new FootballIndex(ds);
  const ann = ds.players.find((p) => p.name === 'Ann Wing')!;

  it('re-dates contract-end placeholders instead of trusting a 2030 date', () => {
    expect(ds.affiliations.every((a) => (a.toSeason ?? 0) < 2030)).toBe(true);
  });
  it('builds league membership from games and validates a league claim', () => {
    const league = idx.criterionFor(
      'league',
      ds.competitions.find((c) => c.name === 'Top League')!.id,
    )!;
    expect(idx.verdict(ann.id, league).ok).toBe(true);
  });
  it('credits nations only for players with senior appearances', () => {
    const nat = ds.teams.find((x) => x.kind === 'national');
    expect(nat?.name).toBe('England');
    expect(ds.affiliations.some((a) => a.playerId === ann.id && a.teamId === nat!.id)).toBe(true);
  });
  it('fails loudly with the actual columns when a header is missing', () => {
    expect(() => buildDcaribouDataset({ ...t, clubs: '"x"\n"1"' }, '2026-10-20T00:00:00Z')).toThrow(
      /missing columns/,
    );
  });
});
