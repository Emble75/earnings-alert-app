import { loadDotEnv } from './_env';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { saveDataset } from '../server/football/repository';
import { sampleDataset } from '../data/sample/sample';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const db = await openDb(config, log);
await migrate(db, log);
const stats = await db.tx((q) => saveDataset(q, sampleDataset));
console.log('Seeded SAMPLE data (demo only, not live):', stats);
await db.close();
