import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { loadDataset } from '../server/football/repository';
import { DatasetSchema } from '../shared/football/types';
import { FootballIndex } from '../shared/football';

/**
 * Freezes one synced source into a single versioned snapshot file — "our own" dataset.
 * Usage: npm run data:export -- --source dcaribou [--out data/pitchside-dataset.json.gz]
 * Deploy the snapshot with FOOTBALL_PROVIDER=file FOOTBALL_IMPORT_FILE=<file>: no scraping or
 * third-party calls at runtime, and every deploy serves exactly the data you reviewed.
 */
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = arg('source') ?? 'dcaribou';
const out = arg('out') ?? 'data/pitchside-dataset.json.gz';
const config = loadConfig();
const db = await openDb(config, createLogger('warn'));
await migrate(db, createLogger('warn'));
const ds = await loadDataset(db, source);
if (!ds || ds.players.length === 0) {
  console.error(`No data stored for "${source}". Run: npm run sync -- --provider ${source}`);
  process.exit(2);
}
DatasetSchema.parse(ds); // refuse to freeze anything that would not load again
const idx = new FootballIndex(ds);
const json = JSON.stringify({ ...ds, meta: { ...ds.meta, generatedAt: new Date().toISOString() } });
fs.mkdirSync(out.replace(/[^/]*$/, '') || '.', { recursive: true });
fs.writeFileSync(out, gzipSync(json));
fs.writeFileSync(
  out.replace(/\.json\.gz$/, '') + '.manifest.json',
  JSON.stringify(
    {
      source,
      label: ds.meta.label,
      license: ds.meta.license,
      attribution: ds.meta.attribution,
      counts: idx.counts,
      exportedAt: new Date().toISOString(),
      note: 'Run `npm run data:report -- --source <source>` before exporting and keep the result with this file.',
    },
    null,
    2,
  ),
);
console.log(
  `Wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB) — ${JSON.stringify(idx.counts)}`,
);
await db.close();
process.exit(0);
