import { describe, expect, it } from 'vitest';
import { buildDcaribouDataset, type DcaribouTexts } from '../server/football/providers/dcaribou';
import { FootballIndex } from '../shared/football';

const t: DcaribouTexts = {
  players: [
    '"player_id","name","date_of_birth","country_of_citizenship","position","current_club_id","highest_market_value_in_eur"',
    '"1","Ann Wing","1990-01-01 00:00:00","England","Attack","10","5000000"',
    '"200","Cy Late","1995-01-01 00:00:00","England","Defender","20","1000000"',
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
    '"x1","g2","200","20","20","2019-08-10","Cy Late","XX1"',
    '"x2","g3","200","20","20","2020-03-01","Cy Late","XX1"',
    '"x3","g4","200","20","20","2020-09-05","Cy Late","XX1"',
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
  it('derives club spells from match appearances when transfers are missing', () => {
    const cy = ds.players.find((p) => p.name === 'Cy Late')!;
    const beta = ds.teams.find((x) => x.name === 'Beta FC')!;
    const spells = ds.affiliations.filter((a) => a.playerId === cy.id && a.teamId === beta.id);
    expect(spells.map((a) => [a.fromSeason, a.toSeason])).toEqual([[2019, 2020]]);
    const club = idx.criterionFor('club', beta.id)!;
    expect(idx.verdict(cy.id, club).ok).toBe(true);
  });
  it('adds pre-2012 club spells from Wikidata (year precision, club squares only)', () => {
    const wd = [{ tm: '1', club: '999', clubName: 'Old Town FC', from: 1999, to: 2001 }];
    const d2 = buildDcaribouDataset(t, '2026-10-20T00:00:00Z', wd);
    const i2 = new FootballIndex(d2);
    const old = d2.teams.find((x) => x.name === 'Old Town FC');
    const ann2 = d2.players.find((p) => p.name === 'Ann Wing')!;
    expect(old).toBeTruthy();
    expect(i2.verdict(ann2.id, i2.criterionFor('club', old!.id)!).ok).toBe(true);
    // year-precision evidence must not prove a league claim
    expect(d2.affiliations.find((a) => a.teamId === old!.id)?.precision).toBe('year');
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

describe('dcaribou provider (database sync)', () => {
  it('stores the dataset under its own source id', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { openDb } = await import('../server/db');
    const { migrate } = await import('../server/db/migrate');
    const { loadConfig } = await import('../server/config');
    const { createLogger } = await import('../server/log');
    const { FootballService } = await import('../server/football/sync');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcaribou-'));
    for (const [k, v] of Object.entries(t)) fs.writeFileSync(path.join(dir, `${k}.csv`), v);
    const log = createLogger('error');
    const config = loadConfig({
      FOOTBALL_PROVIDER: 'dcaribou',
      DCARIBOU_DIR: dir,
      DB_MODE: 'memory',
    } as never);
    const db = await openDb(config, log);
    await migrate(db, log);
    const svc = new FootballService(db, config, log);
    await svc.init();
    const run = await svc.sync('cli');
    expect(run.error).toBeNull();
    expect(run.status).toBe('success');
    await db.close();
  });
});
