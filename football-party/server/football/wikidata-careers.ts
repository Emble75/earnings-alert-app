import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log';
import { createClient } from './http';

/**
 * Wikidata career enrichment (CC0). Wikidata links footballers and clubs to their Transfermarkt ids
 * (P2446 player, P2448 team), so careers from "member of sports team" (P54) merge exactly with the
 * dcaribou dataset — this fills the pre-2012 gap that match appearances can't cover.
 *
 * Only dated statements are used, and only at year precision: they prove "played for this club"
 * but never claim league seasons. Undated statements are ignored (fail-closed).
 */
export interface WdSpell {
  tm: string; // Transfermarkt player id
  club: string; // Transfermarkt club id
  clubName: string;
  from: number; // calendar year of start
  to: number; // calendar year of end (= from when only the start is known)
}

const SPARQL = 'https://query.wikidata.org/sparql';

export const careerQuery = (tmIds: string[]) => `
SELECT ?tm ?club ?clubLabel ?s ?e WHERE {
  VALUES ?tm { ${tmIds.map((i) => `"${i.replace(/\D/g, '')}"`).join(' ')} }
  ?p wdt:P2446 ?tm .
  ?p p:P54 ?st . ?st ps:P54 ?team . ?st pq:P580 ?s .
  OPTIONAL { ?st pq:P582 ?e }
  ?team wdt:P2448 ?club .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

interface Binding {
  [k: string]: { value: string } | undefined;
}
const yearOf = (v: string | undefined) => {
  const m = /^(-?\d{4})-/.exec(v ?? '');
  return m ? Number(m[1]) : null;
};

export function parseCareers(json: { results?: { bindings?: Binding[] } }): WdSpell[] {
  const out: WdSpell[] = [];
  for (const b of json.results?.bindings ?? []) {
    const from = yearOf(b.s?.value);
    if (!b.tm || !b.club || from === null || from < 1900) continue;
    const to = yearOf(b.e?.value) ?? from;
    if (to < from) continue;
    const label = b.clubLabel?.value ?? '';
    out.push({
      tm: b.tm.value,
      club: b.club.value,
      clubName: /^Q\d+$/.test(label) ? '' : label,
      from,
      to,
    });
  }
  return out;
}

export interface CareerFetchOptions {
  cacheFile: string;
  userAgent: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
}

/** Fetches careers in batches; cached on disk so reruns are instant. A failed batch is skipped, never fatal. */
export async function fetchCareers(tmIds: string[], o: CareerFetchOptions): Promise<WdSpell[]> {
  const cache: Record<string, WdSpell[]> = fs.existsSync(o.cacheFile)
    ? (JSON.parse(fs.readFileSync(o.cacheFile, 'utf8')) as Record<string, WdSpell[]>)
    : {};
  const todo = tmIds.filter((i) => !(i in cache));
  const size = o.batchSize ?? 150;
  const http = createClient({
    userAgent: o.userAgent,
    minIntervalMs: 1500,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    log: o.log,
    timeoutMs: 90_000,
    retries: 3,
  });
  let failed = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    try {
      const url = `${SPARQL}?format=json&query=${encodeURIComponent(careerQuery(batch))}`;
      const rows = parseCareers(await http.json(url));
      for (const id of batch) cache[id] = [];
      for (const r of rows) cache[r.tm]!.push(r);
      fs.mkdirSync(path.dirname(o.cacheFile), { recursive: true });
      fs.writeFileSync(o.cacheFile, JSON.stringify(cache));
      o.log.info('wikidata careers', { done: Math.min(i + size, todo.length), of: todo.length });
    } catch (e) {
      failed += 1;
      o.log.warn('wikidata batch failed; continuing without it', {
        error: e instanceof Error ? e.message : String(e),
      });
      if (failed >= 3 && failed === Math.ceil((i + size) / size)) break; // unreachable service: stop early
    }
  }
  return tmIds.flatMap((i) => cache[i] ?? []);
}
