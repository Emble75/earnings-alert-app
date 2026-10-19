import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.string().default('development'),
  PUBLIC_ORIGIN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DB_MODE: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  FOOTBALL_PROVIDER: z
    .enum(['sample', 'opendata', 'statsbomb', 'wikidata', 'file'])
    .default('sample'),
  FOOTBALL_IMPORT_FILE: z.string().optional(),
  SYNC_INTERVAL_HOURS: z.coerce.number().min(0).default(0),
  STALE_AFTER_HOURS: z.coerce.number().min(1).default(72),
  OPENDATA_CACHE_DIR: z.string().default('.data/opendata-cache'),
  STATSBOMB_CACHE_DIR: z.string().default('.data/statsbomb-cache'),
  STATSBOMB_MAX_MATCHES: z.coerce.number().int().min(0).default(0),
  WIKIDATA_USER_AGENT: z.string().optional(),
  WIKIDATA_QID_FILE: z.string().optional(),
  WIKIDATA_MAX_PLAYERS: z.coerce.number().int().min(10).max(5000).default(400),
  ADMIN_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  ROOM_IDLE_MINUTES: z.coerce.number().min(1).default(180),
  SERVE_STATIC: z.enum(['auto', 'on', 'off']).default('auto'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Blank values in .env files mean "unset".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  return parsed.data;
}
