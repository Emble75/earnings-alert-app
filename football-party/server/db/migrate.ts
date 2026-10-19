import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index';
import type { Logger } from '../log';

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db/migrations');

/** Applies pending `NNN_name.sql` files in order, each atomically. Idempotent. */
export async function migrate(db: Db, log: Logger, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // One simple-protocol script = one implicit transaction on both pg and PGlite: all or nothing.
    // File names are validated by the regex above, so inlining the literal is safe.
    await db.exec(
      `${sql}\n;\nINSERT INTO schema_migrations (name) VALUES ('${f.replace(/'/g, "''")}');`,
    );
    log.info('migration applied', { file: f });
    applied.push(f);
  }
  return applied;
}
