import type { WebSocket } from 'ws';
import { GameError } from '../../shared/games/types';
import {
  addPlayer,
  applyCommand,
  buildRoomView,
  createRoom,
  generateRoomCode,
  nextDeadline,
  normalizeRoomCode,
  removePlayer,
  setConnected,
  tickRoom,
  validateNickname,
  type GameSummary,
  type RoomEnv,
} from '../../shared/room/room';
import type { Command, Room, RoomPlayer, ServerMessage } from '../../shared/room/types';
import { randomRng } from '../../shared/util/rng';
import type { FootballService } from '../football/sync';
import { errInfo, type Logger } from '../log';
import { randomToken, sha256 } from '../security';

interface Session {
  playerId: string;
  tokenHash: string;
}
interface Runtime {
  room: Room;
  sessions: Map<string, Session>; // tokenHash -> session
  sockets: Map<string, Set<WebSocket>>; // playerId -> sockets
  seenNonces: Map<string, string[]>; // playerId -> recent nonces
  disconnectTimers: Map<string, NodeJS.Timeout>;
}

export interface RoomManagerOptions {
  idleMs: number;
  /** A disconnected player is removed from a lobby after this long. */
  lobbyGraceMs: number;
  maxRooms: number;
  onGameFinished?: (s: GameSummary) => void;
}

export class RoomManager {
  private rooms = new Map<string, Runtime>();
  private ticker: NodeJS.Timeout;
  private rng = randomRng();

  constructor(
    private football: FootballService,
    private log: Logger,
    private opts: RoomManagerOptions,
  ) {
    this.ticker = setInterval(() => this.tickAll(), 500);
    this.ticker.unref();
  }

  private env(): RoomEnv {
    return { now: Date.now(), rng: this.rng, football: this.football.index };
  }

  get size() {
    return this.rooms.size;
  }

  has(code: string) {
    return this.rooms.has(normalizeRoomCode(code));
  }

  summary(code: string) {
    const rt = this.rooms.get(normalizeRoomCode(code));
    if (!rt) return null;
    return {
      code: rt.room.code,
      players: rt.room.players.length,
      status: rt.room.status,
      gameId: rt.room.gameId,
      joinable: rt.room.status !== 'playing' && rt.room.players.length < 12,
    };
  }

  create(
    rawName: string,
    profileId: string | null,
  ): { code: string; playerId: string; token: string } {
    if (this.rooms.size >= this.opts.maxRooms)
      throw new GameError('busy', 'The server is at capacity. Try again in a few minutes.');
    const name = validateNickname(rawName);
    let code = generateRoomCode(this.rng);
    for (let i = 0; this.rooms.has(code) && i < 20; i++) code = generateRoomCode(this.rng);
    if (this.rooms.has(code))
      throw new GameError('busy', 'Could not allocate a room code. Try again.');
    const env = this.env();
    const host = this.newPlayer(name, profileId, env.now);
    const room = createRoom(code, host.player, env);
    room.players[0]!.connected = false; // becomes connected when its socket attaches
    const rt: Runtime = {
      room,
      sessions: new Map(),
      sockets: new Map(),
      seenNonces: new Map(),
      disconnectTimers: new Map(),
    };
    rt.sessions.set(sha256(host.token), {
      playerId: host.player.id,
      tokenHash: sha256(host.token),
    });
    this.rooms.set(code, rt);
    this.log.info('room created', { code });
    return { code, playerId: host.player.id, token: host.token };
  }

  join(
    code: string,
    rawName: string,
    profileId: string | null,
  ): { code: string; playerId: string; token: string } {
    const rt = this.rooms.get(normalizeRoomCode(code));
    if (!rt) throw new GameError('no-room', 'No room with that code. Check it and try again.');
    const name = validateNickname(rawName);
    const env = this.env();
    const p = this.newPlayer(name, profileId, env.now);
    p.player.connected = false;
    addPlayer(rt.room, p.player, env);
    rt.sessions.set(sha256(p.token), { playerId: p.player.id, tokenHash: sha256(p.token) });
    this.log.info('player joined', { code: rt.room.code, players: rt.room.players.length });
    this.broadcast(rt);
    return { code: rt.room.code, playerId: p.player.id, token: p.token };
  }

  private newPlayer(name: string, profileId: string | null, now: number) {
    const token = randomToken(24);
    const player: RoomPlayer = {
      id: randomToken(9),
      name,
      connected: true,
      joinedAt: now,
      profileId,
    };
    return { player, token };
  }

  /** Authenticates and attaches a WebSocket. Returns a detach function. */
  attach(code: string, token: string, ws: WebSocket): { playerId: string; detach: () => void } {
    const rt = this.rooms.get(normalizeRoomCode(code));
    const session = rt?.sessions.get(sha256(token));
    if (!rt || !session || !rt.room.players.some((p) => p.id === session.playerId))
      throw new GameError(
        'unauthorized',
        'Your seat in this room is gone. Join again with the room code.',
      );
    const { playerId } = session;
    const set = rt.sockets.get(playerId) ?? new Set();
    set.add(ws);
    rt.sockets.set(playerId, set);
    const timer = rt.disconnectTimers.get(playerId);
    if (timer) clearTimeout(timer);
    rt.disconnectTimers.delete(playerId);
    setConnected(rt.room, playerId, true, this.env());
    this.send(ws, { t: 'state', view: buildRoomView(rt.room, playerId, this.env()) });
    this.broadcast(rt, playerId);
    return {
      playerId,
      detach: () => {
        set.delete(ws);
        if (set.size > 0 || !this.rooms.has(rt.room.code)) return;
        setConnected(rt.room, playerId, false, this.env());
        this.broadcast(rt);
        // In the lobby (nothing to lose) drop players who never come back.
        const t = setTimeout(() => {
          rt.disconnectTimers.delete(playerId);
          const p = rt.room.players.find((x) => x.id === playerId);
          if (p && !p.connected && rt.room.status !== 'playing')
            this.removeAndBroadcast(rt, playerId);
        }, this.opts.lobbyGraceMs);
        t.unref();
        rt.disconnectTimers.set(playerId, t);
      },
    };
  }

  handle(code: string, playerId: string, cmd: Command, nonce: string | undefined, ws: WebSocket) {
    const rt = this.rooms.get(normalizeRoomCode(code));
    if (!rt) return;
    // Duplicate-submission protection: a repeated nonce is acknowledged but not re-applied.
    if (nonce) {
      const seen = rt.seenNonces.get(playerId) ?? [];
      if (seen.includes(nonce)) return this.send(ws, { t: 'ack', nonce });
      seen.push(nonce);
      if (seen.length > 50) seen.shift();
      rt.seenNonces.set(playerId, seen);
    }
    try {
      const summary = applyCommand(rt.room, playerId, cmd, this.env());
      if (summary) this.finished(summary);
      if (cmd.type === 'room.kick') this.dropSockets(rt, cmd.playerId, 'kicked');
      if (cmd.type === 'room.leave') this.dropSockets(rt, playerId, 'closed');
      if (nonce) this.send(ws, { t: 'ack', nonce });
      this.broadcast(rt);
    } catch (e) {
      if (e instanceof GameError)
        this.send(ws, { t: 'error', code: e.code, message: e.message, nonce });
      else {
        this.log.error('command failed', { cmd: cmd.type, ...errInfo(e) });
        this.send(ws, {
          t: 'error',
          code: 'internal',
          message: 'Something went wrong on our side.',
          nonce,
        });
      }
    }
  }

  private dropSockets(rt: Runtime, playerId: string, why: 'kicked' | 'closed') {
    for (const ws of rt.sockets.get(playerId) ?? []) {
      this.send(
        ws,
        why === 'kicked' ? { t: 'kicked' } : { t: 'closed', reason: 'You left the room.' },
      );
      ws.close(4000, why);
    }
    rt.sockets.delete(playerId);
    for (const [h, s] of rt.sessions) if (s.playerId === playerId) rt.sessions.delete(h);
    if (rt.room.players.length === 0) this.rooms.delete(rt.room.code);
  }

  private removeAndBroadcast(rt: Runtime, playerId: string) {
    const s = removePlayer(rt.room, playerId, this.env());
    if (s) this.finished(s);
    this.dropSockets(rt, playerId, 'closed');
    if (this.rooms.has(rt.room.code)) this.broadcast(rt);
  }

  private finished(s: GameSummary) {
    this.log.info('game finished', { game: s.gameId, players: s.playerCount });
    try {
      this.opts.onGameFinished?.(s);
    } catch (e) {
      this.log.error('result hook failed', errInfo(e));
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Each player gets their own projection: hidden roles and answers never share a payload. */
  private broadcast(rt: Runtime, except?: string) {
    const env = this.env();
    for (const p of rt.room.players) {
      if (p.id === except) continue;
      const socks = rt.sockets.get(p.id);
      if (!socks?.size) continue;
      const view = buildRoomView(rt.room, p.id, env);
      for (const ws of socks) this.send(ws, { t: 'state', view });
    }
  }

  private tickAll() {
    const now = Date.now();
    for (const [code, rt] of this.rooms) {
      try {
        const due = nextDeadline(rt.room);
        if (due !== null && due <= now + 5) {
          const summary = tickRoom(rt.room, this.env());
          if (summary) this.finished(summary);
          this.broadcast(rt);
        }
        const connected = rt.room.players.some((p) => p.connected);
        const idle = now - rt.room.lastActivity;
        if (
          idle > this.opts.idleMs ||
          (!connected && idle > Math.min(this.opts.idleMs, 15 * 60_000))
        ) {
          for (const set of rt.sockets.values())
            for (const ws of set) {
              this.send(ws, { t: 'closed', reason: 'This room expired due to inactivity.' });
              ws.close(4001, 'expired');
            }
          for (const t of rt.disconnectTimers.values()) clearTimeout(t);
          this.rooms.delete(code);
          this.log.info('room expired', { code });
        }
      } catch (e) {
        this.log.error('tick failed', { code, ...errInfo(e) });
      }
    }
  }

  /** Forces a sync-and-view push after the dataset changes under running rooms. */
  close() {
    clearInterval(this.ticker);
    for (const rt of this.rooms.values()) {
      for (const t of rt.disconnectTimers.values()) clearTimeout(t);
      for (const set of rt.sockets.values())
        for (const ws of set) ws.close(1001, 'server shutting down');
    }
  }
}
