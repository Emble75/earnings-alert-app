import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../server/log';
import { fetchCareers, parseCareers } from '../server/football/wikidata-careers';

const body = {
  results: {
    bindings: [
      {
        tm: { value: '3226' },
        club: { value: '11' },
        clubLabel: { value: 'Arsenal F.C.' },
        s: { value: '1997-03-01T00:00:00Z' },
        e: { value: '1999-08-01T00:00:00Z' },
      },
      {
        tm: { value: '3226' },
        club: { value: '418' },
        clubLabel: { value: 'Real Madrid CF' },
        s: { value: '1999-08-01T00:00:00Z' },
      },
      { tm: { value: '3226' }, club: { value: '5' }, clubLabel: { value: 'Q123' } }, // undated: ignored
    ],
  },
};

describe('wikidata careers', () => {
  it('keeps dated statements only and uses the start year when the end is unknown', () => {
    const rows = parseCareers(body);
    expect(rows.map((r) => [r.club, r.from, r.to])).toEqual([
      ['11', 1997, 1999],
      ['418', 1999, 1999],
    ]);
  });

  it('caches results on disk and never fails the sync when the service is down', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
    const cacheFile = path.join(dir, 'c.json');
    const log = createLogger('error');
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const o = { cacheFile, userAgent: 't', log, sleep: async () => {} };
    const first = await fetchCareers(['3226'], { ...o, fetchImpl: ok });
    expect(first).toHaveLength(2);
    await fetchCareers(['3226'], { ...o, fetchImpl: ok });
    expect(calls).toBe(1); // second run served from the cache

    const down = (async () => new Response('x', { status: 503 })) as typeof fetch;
    const none = await fetchCareers(['999'], { ...o, fetchImpl: down });
    expect(none).toEqual([]);
  });
});
