import 'node:process';
import { loadConfig } from './config';
import { createLogger, errInfo } from './log';
import { openDb } from './db';
import { migrate } from './db/migrate';
import { FootballService } from './football/sync';
import { ProfileService } from './profiles';
import { RoomManager } from './rooms/manager';
import { buildApp } from './http/app';

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const log = createLogger(config.LOG_LEVEL);
  const db = await openDb(config, log);
  await migrate(db, log);
  const football = new FootballService(db, config, log);
  await football.init();
  const profiles = new ProfileService(db);
  const rooms = new RoomManager(football, log, {
    idleMs: config.ROOM_IDLE_MINUTES * 60_000,
    lobbyGraceMs: 90_000,
    maxRooms: 2000,
    onGameFinished: (s) =>
      void profiles.recordResult(s).catch((e) => log.error('recording result failed', errInfo(e))),
  });
  const app = await buildApp({ config, db, log, football, rooms, profiles });
  football.startScheduler();
  // Live providers: refresh on boot when there is nothing but fallback data.
  if (football.usingFallback) void football.sync('startup');
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info('pitchside listening', {
    port: config.PORT,
    provider: football.provider.sourceId,
    db: db.kind,
  });
  if (!config.ADMIN_TOKEN) log.info('admin disabled (set ADMIN_TOKEN to enable /admin)');

  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    rooms.close();
    football.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  return { app, config, db, football, rooms, profiles, log };
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server/main.ts') ||
  process.argv[1]?.endsWith('dist-server/main.js')
) {
  startServer().catch((e) => {
    console.error('fatal: could not start', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
