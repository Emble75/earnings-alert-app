import { loadDotEnv } from '../server/env';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { FootballService } from '../server/football/sync';

/**
 * Usage: npm run sync [-- --provider sample|dcaribou|file] [--file path.json]
 * Runs one synchronous sync of the chosen provider into the configured database.
 */
loadDotEnv();
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (arg('provider')) process.env.FOOTBALL_PROVIDER = arg('provider');
if (arg('file')) process.env.FOOTBALL_IMPORT_FILE = arg('file');

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = await openDb(config, log);
await migrate(db, log);
const svc = new FootballService(db, config, log);
await svc.init();
const run = await svc.sync('cli');
console.log(JSON.stringify(run, null, 2));
await db.close();
process.exit(run.status === 'success' ? 0 : 1);
