import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { z, ZodError } from 'zod';
import { gameList } from '../../shared/games/registry';
import { GameError } from '../../shared/games/types';
import { normalizeRoomCode } from '../../shared/room/room';
import { ClientMessageSchema, type ServerMessage } from '../../shared/room/types';
import type { Config } from '../config';
import type { Db } from '../db';
import type { FootballService } from '../football/sync';
import { errInfo, type Logger } from '../log';
import type { ProfileService } from '../profiles';
import type { RoomManager } from '../rooms/manager';
import { RateLimiter, safeEqual, TokenBucket } from '../security';

export interface AppDeps {
  config: Config;
  db: Db;
  log: Logger;
  football: FootballService;
  rooms: RoomManager;
  profiles: ProfileService;
}

const NameBody = z.object({
  name: z.string().max(60),
  profileToken: z.string().max(100).optional(),
});

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, log, football, rooms, profiles } = deps;
  const app = Fastify({
    logger: false,
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 16 * 1024,
  });

  const limits = {
    create: new RateLimiter(10, 60_000),
    join: new RateLimiter(30, 60_000),
    lookup: new RateLimiter(60, 60_000),
    search: new RateLimiter(240, 60_000),
    profile: new RateLimiter(10, 60_000),
    admin: new RateLimiter(30, 60_000),
    wsConnect: new RateLimiter(60, 60_000),
  };
  const limit = (name: keyof typeof limits) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!limits[name].take(req.ip)) {
      return reply
        .code(429)
        .header('Retry-After', '30')
        .send({ error: { code: 'rate-limited', message: 'Slow down a little and try again.' } });
    }
    return undefined;
  };

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!req.url.startsWith('/api/')) reply.header('Content-Security-Policy', CSP);
    else reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GameError)
      return reply
        .code(err.code === 'no-room' ? 404 : 400)
        .send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError)
      return reply
        .code(400)
        .send({ error: { code: 'invalid-request', message: 'Invalid request.' } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.code(status).send({ error: { code: 'bad-request', message: 'Bad request.' } });
    log.error('request failed', { url: req.url.split('?')[0], ...errInfo(err) });
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });

  // ---- Public API ---------------------------------------------------------------------------
  app.get('/api/health', async () => ({
    ok: true,
    rooms: rooms.size,
    db: deps.db.kind,
    data: { kind: football.index.meta.kind, players: football.index.counts.players },
  }));

  app.get('/api/meta', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return {
      data: football.freshness(),
      games: gameList.map((g) => ({
        id: g.id,
        title: g.title,
        tagline: g.tagline,
        minPlayers: g.minPlayers,
        maxPlayers: g.maxPlayers,
      })),
    };
  });

  app.get('/api/players/search', { preHandler: limit('search') }, async (req, reply) => {
    const q = z
      .object({ q: z.string().max(60), limit: z.coerce.number().int().min(1).max(12).default(8) })
      .parse(req.query);
    reply.header('Cache-Control', 'private, max-age=30');
    return { results: football.index.searchPlayers(q.q, q.limit) };
  });

  app.get('/api/rooms/:code', { preHandler: limit('lookup') }, async (req) => {
    const { code } = z.object({ code: z.string().max(12) }).parse(req.params);
    const s = rooms.summary(code);
    if (!s) throw new GameError('no-room', 'No room with that code. Check it and try again.');
    return s;
  });

  const profileIdFor = async (token?: string) =>
    token ? ((await profiles.authenticate(token))?.id ?? null) : null;

  app.post('/api/rooms', { preHandler: limit('create') }, async (req) => {
    const body = NameBody.parse(req.body);
    return rooms.create(body.name, await profileIdFor(body.profileToken));
  });

  app.post('/api/rooms/:code/join', { preHandler: limit('join') }, async (req) => {
    const { code } = z.object({ code: z.string().max(12) }).parse(req.params);
    const body = NameBody.parse(req.body);
    return rooms.join(code, body.name, await profileIdFor(body.profileToken));
  });

  // ---- Profiles -----------------------------------------------------------------------------
  const bearer = (req: FastifyRequest) =>
    /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

  app.post('/api/profile', { preHandler: limit('profile') }, async (req) => {
    const body = z.object({ nickname: z.string().max(60) }).parse(req.body);
    return profiles.create(body.nickname);
  });
  app.get('/api/profile', { preHandler: limit('lookup') }, async (req, reply) => {
    const p = await profiles.authenticate(bearer(req));
    if (!p)
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Profile not found.' } });
    return profiles.stats(p.id);
  });
  app.delete('/api/profile', { preHandler: limit('profile') }, async (req, reply) => {
    const p = await profiles.authenticate(bearer(req));
    if (!p)
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Profile not found.' } });
    await profiles.delete(p.id);
    return { ok: true };
  });

  // ---- Admin (disabled unless ADMIN_TOKEN is set) -------------------------------------------
  const adminGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!limits.admin.take(req.ip))
      return reply
        .code(429)
        .send({ error: { code: 'rate-limited', message: 'Too many attempts.' } });
    const token = config.ADMIN_TOKEN;
    const given = bearer(req);
    if (!token)
      return reply
        .code(404)
        .send({ error: { code: 'disabled', message: 'Admin is disabled. Set ADMIN_TOKEN.' } });
    if (!given || !safeEqual(given, token))
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Invalid admin token.' } });
    return undefined;
  };
  app.get('/api/admin/status', { preHandler: adminGuard }, async () => ({
    ...(await football.adminStatus()),
    rooms: rooms.size,
    db: deps.db.kind,
  }));
  app.post('/api/admin/sync', { preHandler: adminGuard }, async () => {
    const run = await football.sync('manual');
    return { run, status: await football.adminStatus() };
  });

  // ---- Static client ------------------------------------------------------------------------
  const dist = path.resolve(process.cwd(), 'dist');
  const serve =
    config.SERVE_STATIC === 'on' ||
    (config.SERVE_STATIC === 'auto' && fs.existsSync(path.join(dist, 'index.html')));
  if (serve) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.header(
          'Cache-Control',
          hashed
            ? 'public, max-age=31536000, immutable'
            : base === 'sw.js' || base.endsWith('.html')
              ? 'no-cache'
              : 'public, max-age=3600',
        );
      },
    });
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws'))
        return reply.code(404).send({ error: { code: 'not-found', message: 'Not found.' } });
      return reply
        .header('Cache-Control', 'no-cache')
        .type('text/html')
        .send(fs.readFileSync(path.join(dist, 'index.html')));
    });
  } else {
    app.get('/', async () => ({
      name: 'pitchside-api',
      hint: 'Run `npm run dev` for the web client, or `npm run build && npm start`.',
    }));
  }

  // ---- WebSocket ----------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const ip =
      (config.NODE_ENV === 'production'
        ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        : undefined) ??
      req.socket.remoteAddress ??
      'unknown';
    if (!limits.wsConnect.take(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return socket.destroy();
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok: boolean;
      try {
        const o = new URL(origin);
        ok =
          o.host === req.headers.host ||
          (config.PUBLIC_ORIGIN ? o.origin === new URL(config.PUBLIC_ORIGIN).origin : false) ||
          o.hostname === 'localhost';
      } catch {
        ok = false;
      }
      if (!ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const code = normalizeRoomCode(url.searchParams.get('code') ?? '');
      // The token travels in the first message (not the URL) so it never lands in access logs.
      const authTimer = setTimeout(() => ws.close(4401, 'auth timeout'), 8000);
      let session: { playerId: string; detach: () => void } | null = null;
      const bucket = new TokenBucket(20, 10);
      const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

      ws.on('message', (raw) => {
        if (!bucket.take())
          return send({
            t: 'error',
            code: 'rate-limited',
            message: 'Too many actions — slow down.',
          });
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send({ t: 'error', code: 'bad-message', message: 'Malformed message.' });
        }
        if (!session) {
          const auth = z
            .object({ t: z.literal('auth'), token: z.string().min(10).max(100) })
            .safeParse(msg);
          if (!auth.success) return ws.close(4401, 'auth required');
          try {
            session = rooms.attach(code, auth.data.token, ws);
            clearTimeout(authTimer);
          } catch (e) {
            if (e instanceof GameError) {
              send({ t: 'error', code: e.code, message: e.message });
              return ws.close(4401, 'unauthorized');
            }
            log.error('ws attach failed', errInfo(e));
            return ws.close(1011, 'error');
          }
          return;
        }
        const parsed = ClientMessageSchema.safeParse(msg);
        if (!parsed.success)
          return send({ t: 'error', code: 'bad-message', message: 'Unrecognised message.' });
        if (parsed.data.t === 'ping') return send({ t: 'pong', serverNow: Date.now() });
        rooms.handle(code, session.playerId, parsed.data.cmd, parsed.data.nonce, ws);
      });
      ws.on('close', () => {
        clearTimeout(authTimer);
        session?.detach();
      });
      ws.on('error', (e) => log.debug('ws error', errInfo(e)));
    });
  });
  app.addHook('onClose', async () => {
    wss.close();
  });

  return app;
}
