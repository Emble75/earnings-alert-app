import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';
import { openDb, type Db } from '../server/db';
import { migrate } from '../server/db/migrate';
import { silentLogger } from '../server/log';
import { FootballService, sanitizeDataset } from '../server/football/sync';
import { loadDataset, saveDataset } from '../server/football/repository';
import { sampleDataset } from '../data/sample/sample';
import { sampleProvider } from '../server/football/providers/sample';
import { createJsonClient, HttpError } from '../server/football/http';
import {
  deriveAffiliation,
  seasonOf,
  wikidataProvider,
  type WbEntity,
} from '../server/football/providers/wikidata';
import { FootballIndex } from '../shared/football';
import type { Dataset } from '../shared/football/types';
import type { FootballProvider } from '../server/football/providers/types';

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

let db: Db;
const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({
    ...(process.env.TEST_DATABASE_URL
      ? { DATABASE_URL: process.env.TEST_DATABASE_URL }
      : { DB_MODE: 'memory' }),
    LOG_LEVEL: 'silent',
    ...extra,
  });

beforeAll(async () => {
  db = await openDb(cfg(), silentLogger);
  if (db.kind === 'pg') await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, silentLogger);
});
afterAll(() => db.close());

describe('migrations', () => {
  it('are idempotent', async () => {
    expect(await migrate(db, silentLogger)).toEqual([]);
  });
});

describe('repository', () => {
  it('upserts idempotently and round-trips the dataset', async () => {
    const first = await db.tx((q) => saveDataset(q, sampleDataset));
    expect(first.changed).toBeGreaterThan(0);
    const second = await db.tx((q) => saveDataset(q, sampleDataset));
    expect(second.changed).toBe(0); // nothing rewritten
    expect(second.removed).toBe(0);
    const loaded = (await loadDataset(db, 'sample'))!;
    expect(loaded.players).toHaveLength(sampleDataset.players.length);
    expect(loaded.affiliations).toHaveLength(sampleDataset.affiliations.length);
    // Validation results are identical when served from the database
    const a = new FootballIndex(sampleDataset);
    const b = new FootballIndex(loaded);
    for (const [p, t] of [
      ['gianluigi-buffon', 'serie-b'],
      ['zinedine-zidane', 'serie-b'],
      ['cristiano-ronaldo', 'premier-league'],
    ] as const) {
      const crit = (i: FootballIndex) => i.criterionFor('league', t)!;
      expect(b.verdict(p, crit(b)).ok).toBe(a.verdict(p, crit(a)).ok);
    }
  });

  it('removes rows that vanished upstream, and applies changes', async () => {
    const slim: Dataset = {
      ...sampleDataset,
      players: sampleDataset.players.filter((p) => p.id !== 'xavi'),
      affiliations: sampleDataset.affiliations.filter((a) => a.playerId !== 'xavi'),
    };
    const s = await db.tx((q) => saveDataset(q, slim));
    expect(s.removed).toBeGreaterThan(0);
    expect((await loadDataset(db, 'sample'))!.players.find((p) => p.id === 'xavi')).toBeUndefined();
    await db.tx((q) => saveDataset(q, sampleDataset)); // restore
    expect((await loadDataset(db, 'sample'))!.players.find((p) => p.id === 'xavi')).toBeDefined();
  });
});

describe('sanitizeDataset', () => {
  it('reports dangling references and possible duplicates instead of silently dropping', () => {
    const bad: Dataset = {
      ...sampleDataset,
      players: [
        ...sampleDataset.players,
        { ...sampleDataset.players[0]!, id: 'dup-ronaldo', providerIds: {} },
      ],
      affiliations: [
        ...sampleDataset.affiliations,
        {
          playerId: 'cristiano-ronaldo',
          teamId: 'ghost-fc',
          fromSeason: 2000,
          toSeason: 2001,
          precision: 'season',
          status: 'confirmed',
          source: 't',
        },
      ],
    };
    const { dataset, conflicts } = sanitizeDataset(bad);
    expect(conflicts.map((c) => c.kind).sort()).toEqual([
      'dangling-reference',
      'possible-duplicate',
    ]);
    expect(dataset.affiliations.some((a) => a.teamId === 'ghost-fc')).toBe(false);
    expect(dataset.players.some((p) => p.id === 'dup-ronaldo')).toBe(true); // kept; flagged, never auto-merged
  });
});

describe('FootballService sync', () => {
  const failing: FootballProvider = {
    sourceId: 'sample',
    label: 'x',
    kind: 'live',
    fetchDataset: async () => {
      throw new Error('upstream exploded');
    },
  };

  it('records successful runs and reports honest freshness', async () => {
    const svc = new FootballService(db, cfg(), silentLogger, sampleProvider);
    await svc.init();
    const run = await svc.sync('manual');
    expect(run.status).toBe('success');
    const st = await svc.adminStatus();
    expect(st.isSample).toBe(true);
    expect(st.stale).toBe(false);
    expect(st.runs[0]!.status).toBe('success');
  });

  it('records failures without touching existing data', async () => {
    const svc = new FootballService(db, cfg(), silentLogger, failing);
    await svc.init();
    const before = svc.index.counts.players;
    const run = await svc.sync('manual');
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/upstream exploded/);
    expect(svc.index.counts.players).toBe(before);
  });

  it('shrink guard refuses a suspiciously small snapshot', async () => {
    const tiny: FootballProvider = {
      ...sampleProvider,
      fetchDataset: async () => ({
        ...sampleDataset,
        affiliations: sampleDataset.affiliations.slice(0, 10),
      }),
    };
    const svc = new FootballService(db, cfg(), silentLogger, tiny);
    await svc.init();
    const run = await svc.sync('manual');
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/shrink guard/);
    expect((await loadDataset(db, 'sample'))!.affiliations).toHaveLength(
      sampleDataset.affiliations.length,
    );
  });

  it('coalesces concurrent syncs', async () => {
    const svc = new FootballService(db, cfg(), silentLogger, sampleProvider);
    await svc.init();
    const [a, b] = await Promise.all([svc.sync('manual'), svc.sync('manual')]);
    expect(a.id).toBe(b.id);
  });

  it('falls back to labelled sample data when a live provider has none yet', async () => {
    const empty: FootballProvider = {
      sourceId: 'wikidata',
      label: 'wd',
      kind: 'live',
      fetchDataset: async () => {
        throw new Error('offline');
      },
    };
    const svc = new FootballService(
      db,
      cfg({ FOOTBALL_PROVIDER: 'wikidata' }),
      silentLogger,
      empty,
    );
    await svc.init();
    expect(svc.usingFallback).toBe(true);
    expect(svc.freshness().isSample).toBe(true);
    expect(svc.freshness().fallback).toBe(true);
  });
});

describe('http client', () => {
  it('retries with backoff and honours Retry-After', async () => {
    const calls: number[] = [];
    const delays: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      if (calls.length === 1) return res(429, {}, { 'retry-after': '2' });
      if (calls.length === 2) return res(503);
      return res(200, { ok: 1 });
    }) as unknown as typeof fetch;
    const get = createJsonClient({
      userAgent: 't',
      fetchImpl,
      sleep: async (ms) => void delays.push(ms),
      log: silentLogger,
      baseDelayMs: 100,
    });
    expect(await get('https://example.org/x')).toEqual({ ok: 1 });
    expect(delays).toEqual([2000, 200]);
  });
  it('does not retry client errors and gives up after max retries', async () => {
    const get404 = createJsonClient({
      userAgent: 't',
      fetchImpl: (async () => res(404)) as unknown as typeof fetch,
      sleep: async () => undefined,
      log: silentLogger,
    });
    await expect(get404('https://example.org/x')).rejects.toBeInstanceOf(HttpError);
    let n = 0;
    const get500 = createJsonClient({
      userAgent: 't',
      retries: 2,
      fetchImpl: (async () => (n++, res(500))) as unknown as typeof fetch,
      sleep: async () => undefined,
      log: silentLogger,
    });
    await expect(get500('https://example.org/x')).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(3);
  });
});

describe('wikidata provider (fixtures in the documented wbgetentities shape)', () => {
  const t = (iso: string, precision = 11) => ({ time: `+${iso}T00:00:00Z`, precision });
  const snakTime = (iso: string, precision = 11) => ({
    snaktype: 'value',
    datavalue: { value: t(iso, precision) },
  });
  const snakItem = (id: string) => ({ snaktype: 'value', datavalue: { value: { id } } });

  it('maps dates to seasons and refuses ambiguous transfer-window months', () => {
    expect(seasonOf(t('2009-07-15'), 'start')).toBe(2009);
    expect(seasonOf(t('2011-01-31'), 'start')).toBe(2010);
    expect(seasonOf(t('2010-06-10'), 'start')).toBeNull();
    expect(seasonOf(t('2013-05-20'), 'end')).toBe(2012);
    expect(seasonOf(t('2013-08-25'), 'end')).toBeNull();
    expect(seasonOf(t('2013-10-01'), 'end')).toBe(2013);
    expect(seasonOf(t('2013-00-00', 9), 'start')).toBeNull(); // year precision
  });

  it('derives season precision only when unambiguous', () => {
    expect(deriveAffiliation(t('2003-08-12'), t('2009-06-30'), false)).toEqual({
      fromSeason: 2003,
      toSeason: 2008,
      precision: 'season',
    });
    expect(deriveAffiliation(t('2003-06-12'), t('2009-06-30'), false).precision).toBe('year');
    expect(deriveAffiliation(t('2018-08-01'), null, true)).toEqual({
      fromSeason: 2018,
      toSeason: null,
      precision: 'season',
    });
    expect(deriveAffiliation(t('2018-08-01'), null, false).precision).toBe('year'); // open-ended but maybe just missing data
    expect(deriveAffiliation(null, null, false).precision).toBe('unknown');
  });

  it('builds a validated dataset from API payloads', async () => {
    const player: WbEntity = {
      id: 'Q100',
      labels: { en: { value: 'Test Striker' } },
      aliases: { en: [{ value: 'T. Striker' }] },
      sitelinks: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`s${i}`, {}])),
      claims: {
        P569: [{ mainsnak: snakTime('1990-03-02') }],
        P413: [{ mainsnak: snakItem('Q280658') }],
        P54: [
          {
            mainsnak: snakItem('Q200'),
            qualifiers: { P580: [snakTime('2010-08-01')], P582: [snakTime('2014-05-30')] },
          },
          { mainsnak: snakItem('Q300') },
          { mainsnak: snakItem('Q999') }, // youth/unknown kind → ignored
        ],
      },
    };
    const club: WbEntity = {
      id: 'Q200',
      labels: { en: { value: 'Test FC' } },
      claims: {
        P31: [{ mainsnak: snakItem('Q476028') }],
        P118: [{ mainsnak: snakItem('Q400'), qualifiers: { P580: [snakTime('1992-01-01', 9)] } }],
      },
    };
    const nat: WbEntity = {
      id: 'Q300',
      labels: { en: { value: 'Testland' } },
      claims: { P31: [{ mainsnak: snakItem('Q6979593') }] },
    };
    const other: WbEntity = {
      id: 'Q999',
      labels: { en: { value: 'Test U19' } },
      claims: { P31: [{ mainsnak: snakItem('Q1') }] },
    };
    const league: WbEntity = { id: 'Q400', labels: { en: { value: 'Test League' } } };
    const all: Record<string, WbEntity> = {
      Q100: player,
      Q200: club,
      Q300: nat,
      Q999: other,
      Q400: league,
    };
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.includes('query.wikidata.org'))
        return res(200, {
          results: { bindings: [{ p: { value: 'http://www.wikidata.org/entity/Q100' } }] },
        });
      const ids = new URL(url).searchParams.get('ids')!.split('|');
      return res(200, { entities: Object.fromEntries(ids.map((i) => [i, all[i]!])) });
    }) as unknown as typeof fetch;
    const provider = wikidataProvider({
      userAgent: 'Test/1 (t@example.org)',
      maxPlayers: 10,
      fetchImpl,
      sleep: async () => undefined,
      minIntervalMs: 0,
      now: () => new Date('2026-10-19T00:00:00Z'),
    });
    const ds = await provider.fetchDataset({ log: silentLogger });
    expect(ds.meta).toMatchObject({ kind: 'live', sourceId: 'wikidata', currentSeason: 2026 });
    expect(ds.players[0]).toMatchObject({
      id: 'wd-q100',
      tier: 1,
      position: 'FWD',
      birthYear: 1990,
    });
    expect(ds.teams.map((x) => x.id).sort()).toEqual(['wd-q200', 'wd-q300']);
    const clubAff = ds.affiliations.find((a) => a.teamId === 'wd-q200')!;
    expect(clubAff).toMatchObject({ fromSeason: 2010, toSeason: 2013, precision: 'season' });
    expect(ds.affiliations.find((a) => a.teamId === 'wd-q300')!.precision).toBe('unknown');
    expect(ds.memberships).toEqual([
      expect.objectContaining({ teamId: 'wd-q200', competitionId: 'wd-q400', fromSeason: 1992 }),
    ]);
    expect(seen.every((u) => u.startsWith('https://'))).toBe(true);
    // And it flows through the normal sync pipeline into a queryable index
    const idx = new FootballIndex(ds);
    expect(idx.verdict('wd-q100', idx.criterionFor('league', 'wd-q400')!).ok).toBe(true);
    expect(idx.verdict('wd-q100', idx.criterionFor('national', 'wd-q300')!).ok).toBe(true);
  });
});
