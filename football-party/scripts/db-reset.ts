import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from './_env';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { saveDataset } from '../server/football/repository';
import { sampleDataset } from '../data/sample/sample';

/**
 * DESTRUCTIVE for the configured database: drops everything and re-creates schema + sample data.
 * Refuses to run against a remote Postgres unless --yes is passed explicitly.
 */
loadDotEnv();
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const yes = process.argv.includes('--yes');

if (config.DATABASE_URL) {
  const host = new URL(config.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!local && !yes) {
    console.error(
      `Refusing to reset remote database "${host}". Re-run with --yes if you really mean it.`,
    );
    process.exit(1);
  }
  const db = await openDb(config, log);
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, log);
  await db.tx((q) => saveDataset(q, sampleDataset));
  await db.close();
} else {
  if (config.DB_MODE !== 'memory')
    fs.rmSync(path.resolve(config.PGLITE_DIR), { recursive: true, force: true });
  const db = await openDb(config, log);
  await migrate(db, log);
  await db.tx((q) => saveDataset(q, sampleDataset));
  await db.close();
}
console.log('Database reset and seeded with SAMPLE data.');
