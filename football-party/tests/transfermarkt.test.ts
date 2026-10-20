import { describe, expect, it } from 'vitest';
import {
  buildTransfermarktDataset,
  type TmTexts,
} from '../server/football/providers/transfermarkt';
import { FootballIndex } from '../shared/football';

const seasonsHeader =
  'club_id,competition_id,competition_name,season_id,season_league_level_level_name,team_name';
const files: TmTexts = {
  profiles: [
    'player_id,player_name,date_of_birth,citizenship,main_position,current_club_id,on_loan_from_club_id,date_of_death',
    '1,Ann Wing (1),1990-01-01,England,Attack,10,,',
    '2,Bo Back,1992-02-02,England,Defender,,,',
  ].join('\n'),
  transfers: [
    'player_id,season_name,transfer_date,from_team_id,from_team_name,to_team_id,to_team_name,transfer_type,value_at_transfer,transfer_fee',
    '1,19/20,2019-07-01,10,Alpha FC,20,Beta FC,Transfer,1,0',
    '1,15/16,2015-07-01,30,Gamma U19,10,Alpha FC,Transfer,1,0',
    '2,16/17,2016-08-01,20,Beta FC,40,Retired,Transfer,1,0',
    '2,12/13,2012-07-01,30,Gamma U19,20,Beta FC,Transfer,1,0',
  ].join('\n'),
  national: 'player_id,team_id,matches\n',
  seasons: [
    seasonsHeader,
    ...[2015, 2016, 2017, 2018].map((y) => `10,XX1,Top League,${y},First Tier,Alpha FC`),
    ...[2019, 2020].map((y) => `20,XX1,Top League,${y},First Tier,Beta FC`),
    ...[2012, 2013, 2014, 2015].map((y) => `20,XX2,Second Division,${y},Second Tier,Beta FC`),
  ].join('\n'),
  children: 'parent_team_id,child_team_id\n10,10\n10,30\n',
  values: 'player_id,date_unix,value\n1,2020-01-01,5000000\n',
};

describe('transfermarkt provider (fixture)', () => {
  const ds = buildTransfermarktDataset(files, '2026-01-01T00:00:00Z');
  const idx = new FootballIndex(ds);
  const team = (n: string) => ds.teams.find((t) => t.name === n)!;

  it('builds clubs, ignoring youth sides, retirement and a parent listed as its own child', () => {
    expect(team('Alpha FC')).toBeTruthy();
    expect(ds.teams.some((t) => /U19|Retired/.test(t.name))).toBe(false);
  });

  it('strips the Transfermarkt id suffix from player names', () => {
    expect(ds.players.map((p) => p.name).sort()).toEqual(['Ann Wing', 'Bo Back']);
  });

  it('derives season-precise spells from transfer dates', () => {
    const ann = ds.players.find((p) => p.name === 'Ann Wing')!;
    const spells = ds.affiliations.filter((a) => a.playerId === ann.id);
    const alpha = spells.find((a) => a.teamId === team('Alpha FC').id)!;
    expect([alpha.fromSeason, alpha.toSeason]).toEqual([2015, 2018]);
    const beta = spells.find((a) => a.teamId === team('Beta FC').id)!;
    expect(beta.fromSeason).toBe(2019);
  });

  it('validates club and league claims, fail-closed', () => {
    const ann = ds.players.find((p) => p.name === 'Ann Wing')!;
    const bo = ds.players.find((p) => p.name === 'Bo Back')!;
    const league = idx.criterionFor(
      'league',
      ds.competitions.find((c) => c.name === 'Top League')!.id,
    )!;
    expect(idx.verdict(ann.id, league).ok).toBe(true);
    // Bo was at Beta only while it was second tier → not a Top League player.
    expect(idx.verdict(bo.id, league).ok).toBe(false);
  });
});
