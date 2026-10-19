import { loadDotEnv } from './_env';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = await openDb(config, log);
const applied = await migrate(db, log);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await db.close();
