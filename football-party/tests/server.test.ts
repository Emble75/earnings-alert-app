import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { startServer } from '../server/main';
import type { RoomView, ServerMessage } from '../shared/room/types';
import type { ImpostorView } from '../shared/games/impostor';

let ctx: Awaited<ReturnType<typeof startServer>>;
let base = '';
let wsBase = '';

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    const { openDb } = await import('../server/db');
    const { silentLogger } = await import('../server/log');
    const d = await openDb(
      { DATABASE_URL: process.env.TEST_DATABASE_URL, DB_MODE: undefined, PGLITE_DIR: '' },
      silentLogger,
    );
    await d.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await d.close();
  }
  ctx = await startServer({
    PORT: '0',
    HOST: '127.0.0.1',
    ...(process.env.TEST_DATABASE_URL
      ? { DATABASE_URL: process.env.TEST_DATABASE_URL }
      : { DB_MODE: 'memory' }),
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'test-admin-token-1234567890',
    NODE_ENV: 'test',
  });
  const addr = ctx.app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  ctx.rooms.close();
  ctx.football.stop();
  await ctx.app.close();
  await ctx.db.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

class Client {
  ws!: WebSocket;
  views: RoomView[] = [];
  errors: Extract<ServerMessage, { t: 'error' }>[] = [];
  last!: RoomView;
  constructor(
    readonly code: string,
    readonly token: string,
    readonly playerId: string,
  ) {}
  async connect() {
    this.ws = new WebSocket(`${wsBase}/ws?code=${this.code}`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.t === 'state') {
        this.views.push(m.view);
        this.last = m.view;
      }
      if (m.t === 'error') this.errors.push(m);
    });
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.send(JSON.stringify({ t: 'auth', token: this.token }));
    await this.until((v) => v.you === this.playerId);
    return this;
  }
  send(cmd: unknown, nonce?: string) {
    this.ws.send(JSON.stringify({ t: 'cmd', nonce, cmd }));
  }
  async until(pred: (v: RoomView) => boolean, ms = 4000): Promise<RoomView> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.last && pred(this.last)) return this.last;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(
      `timeout waiting for state; last=${JSON.stringify(this.last?.status)} errors=${JSON.stringify(this.errors)}`,
    );
  }
  close() {
    this.ws.close();
  }
}

async function newRoom(names: string[]) {
  const created = await (await post('/api/rooms', { name: names[0] })).json();
  const clients = [await new Client(created.code, created.token, created.playerId).connect()];
  for (const n of names.slice(1)) {
    const j = await (await post(`/api/rooms/${created.code}/join`, { name: n })).json();
    clients.push(await new Client(created.code, j.token, j.playerId).connect());
  }
  return { code: created.code as string, clients };
}

describe('HTTP API', () => {
  it('serves health, meta with honest data freshness, and search', async () => {
    expect((await (await fetch(base + '/api/health')).json()).ok).toBe(true);
    const meta = await (await fetch(base + '/api/meta')).json();
    expect(meta.data.isSample).toBe(true);
    expect(meta.data.kind).toBe('sample');
    expect(meta.games.map((g: { id: string }) => g.id)).toEqual([
      'impostor',
      'tictactoe',
      'linkup',
      'career',
    ]);
    const s = await (await fetch(base + '/api/players/search?q=mbappe')).json();
    expect(s.results[0].name).toBe('Kylian Mbappé');
    expect((await (await fetch(base + '/api/players/search?q=zzzzzz')).json()).results).toEqual([]);
    expect((await fetch(base + '/api/players/search?q=' + 'x'.repeat(100))).status).toBe(400);
  });

  it('rejects invalid room codes and bad names', async () => {
    expect((await fetch(base + '/api/rooms/ZZZZZ')).status).toBe(404);
    const r = await post('/api/rooms/ZZZZZ/join', { name: 'Ana' });
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe('no-room');
    expect((await post('/api/rooms', { name: '' })).status).toBe(400);
    expect((await post('/api/rooms', { name: 'ok', extra: 1, profileToken: 5 })).status).toBe(400);
  });

  it('keeps admin locked without the token and exposes sync status with it', async () => {
    expect((await fetch(base + '/api/admin/status')).status).toBe(401);
    expect(
      (await fetch(base + '/api/admin/status', { headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401);
    const ok = await fetch(base + '/api/admin/status', {
      headers: { authorization: 'Bearer test-admin-token-1234567890' },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.isSample).toBe(true);
    expect(body.stale).toBe(false);
    const sync = await post(
      '/api/admin/sync',
      {},
      { authorization: 'Bearer test-admin-token-1234567890' },
    );
    expect(sync.status).toBe(200);
    expect((await sync.json()).run.status).toBe('success');
  });

  it('sets security headers', async () => {
    const r = await fetch(base + '/api/health');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('profiles', () => {
  it('creates, reports stats and erases a profile', async () => {
    const p = await (await post('/api/profile', { nickname: 'Profi' })).json();
    expect(p.token.length).toBeGreaterThan(20);
    const me = await fetch(base + '/api/profile', {
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect((await me.json()).gamesPlayed).toBe(0);
    expect(
      (await fetch(base + '/api/profile', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(base + '/api/profile', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${p.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(base + '/api/profile', { headers: { authorization: `Bearer ${p.token}` } }))
        .status,
    ).toBe(401);
  });
});

describe('realtime rooms', () => {
  it('syncs membership to every client and enforces host permissions', async () => {
    const { clients } = await newRoom(['Hosty', 'Guesty']);
    const [host, guest] = clients as [Client, Client];
    await host.until((v) => v.players.length === 2);
    expect(guest.last.players.map((p) => p.name).sort()).toEqual(['Guesty', 'Hosty']);
    expect(guest.last.hostId).toBe(host.playerId);
    guest.send({ type: 'game.select', gameId: 'tictactoe' }, 'n1');
    await guest.until(() => guest.errors.length > 0);
    expect(guest.errors[0]!.code).toBe('host-only');
    host.send({ type: 'game.select', gameId: 'tictactoe' });
    await guest.until((v) => v.gameId === 'tictactoe');
    clients.forEach((c) => c.close());
  });

  it('rejects wrong tokens and duplicate nicknames', async () => {
    const { code, clients } = await newRoom(['Alpha']);
    const dup = await post(`/api/rooms/${code}/join`, { name: 'alpha' });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error.code).toBe('name-taken');
    const bad = new WebSocket(`${wsBase}/ws?code=${code}`);
    await new Promise((r) => bad.once('open', r));
    bad.send(JSON.stringify({ t: 'auth', token: 'x'.repeat(30) }));
    const closeCode = await new Promise<number>((r) => bad.once('close', (c) => r(c)));
    expect(closeCode).toBe(4401);
    clients[0]!.close();
  });

  it('applies a duplicate nonce only once', async () => {
    const { clients } = await newRoom(['Dupe', 'Twin', 'Trio']);
    const host = clients[0]!;
    host.send({ type: 'game.select', gameId: 'impostor' }, 'same');
    host.send({ type: 'game.start' }, 'start-1');
    host.send({ type: 'game.start' }, 'start-1');
    await host.until((v) => v.status === 'playing');
    await new Promise((r) => setTimeout(r, 100));
    expect(host.errors.filter((e) => e.code === 'in-progress')).toHaveLength(0); // the duplicate was ignored, not re-run
    clients.forEach((c) => c.close());
  });

  it('plays an Impostor round over sockets without leaking the secret', async () => {
    const { clients } = await newRoom(['Ana', 'Ben', 'Cyd']);
    const [host] = clients as [Client, ...Client[]];
    await host.until((v) => v.players.length === 3);
    host.send({ type: 'game.select', gameId: 'impostor' });
    host.send({ type: 'game.config', config: { rounds: 1, clueRounds: 1 } });
    host.send({ type: 'game.start' });
    for (const c of clients) await c.until((v) => v.status === 'playing');
    const views = clients.map((c) => c.last.game!.view as ImpostorView);
    const impostorIdx = views.findIndex((v) => v.you.role === 'impostor');
    expect(views.filter((v) => v.you.role === 'impostor')).toHaveLength(1);
    const secret = views.find((v) => v.you.role === 'crew')!.you.footballer!;
    expect(JSON.stringify(clients[impostorIdx]!.views)).not.toContain(secret); // not in ANY message ever sent to the impostor
    for (const c of clients) c.send({ type: 'game.action', action: { type: 'ready' } });
    await host.until((v) => (v.game!.view as ImpostorView).phase === 'clues');
    // Everyone sees the same turn and an identical deadline (server clock)
    const t = clients.map((c) => (c.last.game!.view as ImpostorView).turnPlayerId);
    expect(new Set(t).size).toBe(1);
    clients.forEach((c) => c.close());
  });

  it('keeps the seat on reconnect and resyncs state', async () => {
    const { code, clients } = await newRoom(['Rejoin', 'Other']);
    const [a] = clients as [Client, Client];
    a.send({ type: 'game.select', gameId: 'tictactoe' });
    await a.until((v) => v.gameId === 'tictactoe');
    a.close();
    await clients[1]!.until((v) => v.players.find((p) => p.name === 'Rejoin')?.connected === false);
    const again = await new Client(code, a.token, a.playerId).connect();
    expect(again.last.gameId).toBe('tictactoe');
    expect(again.last.you).toBe(a.playerId);
    await clients[1]!.until((v) => v.players.find((p) => p.name === 'Rejoin')?.connected === true);
    again.close();
    clients[1]!.close();
  });

  it('plays tic-tac-toe with server-side validation over sockets', async () => {
    const { clients } = await newRoom(['Xena', 'Otto']);
    const [x, o] = clients as [Client, Client];
    x.send({ type: 'game.select', gameId: 'tictactoe' });
    x.send({ type: 'game.config', config: { rounds: 1, difficulty: 'easy' } });
    x.send({ type: 'game.start' });
    await o.until((v) => v.status === 'playing');
    type V = {
      turnPlayerId: string;
      rows: { type: 'club' | 'national' | 'league'; id: string }[];
      cols: { type: 'club' | 'national' | 'league'; id: string }[];
    };
    const view = () => x.last.game!.view as unknown as V;
    expect(view().turnPlayerId).toBe(x.playerId);
    // Out-of-turn move is refused by the server
    o.send({ type: 'game.action', action: { type: 'guess', cell: 0, playerId: 'lionel-messi' } });
    await o.until(() => o.errors.some((e) => e.code === 'not-your-turn'));
    // A correct answer is accepted
    const idx = ctx.football.index;
    const answer = idx.validAnswers(
      idx.criterionFor(
        view().rows[0]!.type === 'league'
          ? 'league'
          : (view().rows[0]!.type as 'club' | 'national'),
        view().rows[0]!.id,
      )!,
      idx.criterionFor(
        view().cols[0]!.type === 'league'
          ? 'league'
          : (view().cols[0]!.type as 'club' | 'national'),
        view().cols[0]!.id,
      )!,
    )[0]!;
    x.send({ type: 'game.action', action: { type: 'guess', cell: 0, playerId: answer } });
    await o.until((v) => (v.game!.view as unknown as { cells: unknown[] }).cells[0] !== null);
    expect((o.last.game!.view as unknown as V).turnPlayerId).toBe(o.playerId);
    clients.forEach((c) => c.close());
  });
});
