import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config';
import type { Logger } from '../log';

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  kind: 'pg' | 'pglite';
  /** Runs a multi-statement script (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(
  config: Pick<Config, 'DATABASE_URL' | 'DB_MODE' | 'PGLITE_DIR'>,
  log: Logger,
): Promise<Db> {
  if (config.DATABASE_URL) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      ssl: /sslmode=(require|verify)/.test(config.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    pool.on('error', (e) => log.error('pg pool error', { err: e.message }));
    await pool.query('select 1');
    log.info('database: postgres connected');
    return {
      kind: 'pg',
      query: (sql, params) => pool.query(sql, params as unknown[]) as Promise<{ rows: never[] }>,
      exec: async (sql) => {
        await pool.query(sql);
      },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({
            query: (s, p) => client.query(s, p as unknown[]) as Promise<{ rows: never[] }>,
          });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  let db;
  if (config.DB_MODE === 'memory') {
    db = new PGlite();
    log.info('database: PGlite in memory (data is lost on exit)');
  } else {
    const dir = path.resolve(config.PGLITE_DIR);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    db = new PGlite(dir);
    log.info('database: embedded PGlite', { dir });
  }
  await db.waitReady;
  return {
    kind: 'pglite',
    query: (sql, params) => db.query(sql, params as unknown[]) as Promise<{ rows: never[] }>,
    exec: async (sql) => {
      await db.exec(sql);
    },
    tx: (fn) =>
      db.transaction((t) =>
        fn({ query: (s, p) => t.query(s, p as unknown[]) as Promise<{ rows: never[] }> }),
      ),
    close: () => db.close(),
  };
}
