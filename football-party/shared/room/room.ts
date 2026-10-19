import { cleanDisplayText, normalizeText } from '../football/normalize';
import { getGame } from '../games/registry';
import { GameError, type GameContext, type GameId } from '../games/types';
import {
  MAX_ROOM_PLAYERS,
  NICKNAME_MAX,
  NICKNAME_MIN,
  type Command,
  type Room,
  type RoomPlayer,
  type RoomView,
} from './types';
import type { Rng } from '../util/rng';
import type { FootballIndex } from '../football';

/** Environment the pure room engine needs. The server and the offline mode each supply one. */
export interface RoomEnv {
  now: number;
  rng: Rng;
  football: FootballIndex;
}

export interface GameSummary {
  gameId: GameId;
  scores: Record<string, number>;
  /** playerId -> profileId for players with a persistent profile */
  profiles: Record<string, string>;
  playerCount: number;
}

export { generateRoomCode, normalizeRoomCode } from './code';

export function validateNickname(raw: string): string {
  const name = cleanDisplayText(raw);
  if (name.length < NICKNAME_MIN || name.length > NICKNAME_MAX)
    throw new GameError(
      'invalid-name',
      `Nicknames are ${NICKNAME_MIN}–${NICKNAME_MAX} characters.`,
    );
  if (!/[\p{L}\p{N}]/u.test(name))
    throw new GameError('invalid-name', 'Nicknames need at least one letter or number.');
  return name;
}

export function createRoom(code: string, host: RoomPlayer, env: RoomEnv): Room {
  return {
    code,
    createdAt: env.now,
    lastActivity: env.now,
    hostId: host.id,
    players: [host],
    gameId: 'impostor',
    configs: {},
    status: 'lobby',
    game: null,
    totals: { [host.id]: 0 },
    gamesPlayed: 0,
    version: 1,
  };
}

function touch(room: Room, env: RoomEnv) {
  room.version += 1;
  room.lastActivity = env.now;
}

function ctxFor(room: Room, env: RoomEnv): GameContext {
  return {
    now: env.now,
    rng: env.rng,
    football: env.football,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
  };
}

function nameTaken(room: Room, name: string, exceptId?: string) {
  const n = normalizeText(name);
  return room.players.some((p) => p.id !== exceptId && normalizeText(p.name) === n);
}

export function addPlayer(room: Room, player: RoomPlayer, env: RoomEnv): void {
  if (room.players.length >= MAX_ROOM_PLAYERS)
    throw new GameError('room-full', 'This room is full.');
  if (room.status === 'playing')
    throw new GameError(
      'in-progress',
      'A game is in progress — ask the host to start a new one, then join.',
    );
  if (nameTaken(room, player.name))
    throw new GameError('name-taken', 'Someone in the room already has that nickname.');
  room.players.push(player);
  room.totals[player.id] ??= 0;
  touch(room, env);
}

export function setConnected(room: Room, playerId: string, connected: boolean, env: RoomEnv): void {
  const p = room.players.find((x) => x.id === playerId);
  if (!p || p.connected === connected) return;
  p.connected = connected;
  if (!connected && room.hostId === playerId) reassignHost(room);
  if (connected && !room.players.find((x) => x.id === room.hostId)?.connected)
    room.hostId = playerId;
  syncGame(room, env);
  touch(room, env);
}

function reassignHost(room: Room) {
  const next = room.players.find((p) => p.connected && p.id !== room.hostId);
  if (next) room.hostId = next.id;
}

export function removePlayer(room: Room, playerId: string, env: RoomEnv): GameSummary | null {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return null;
  const leaving = room.players[idx]!;
  room.players.splice(idx, 1);
  if (room.hostId === playerId) {
    const next = room.players.find((p) => p.connected) ?? room.players[0];
    if (next) room.hostId = next.id;
  }
  let summary: GameSummary | null = null;
  if (room.game && room.status === 'playing') {
    const mod = getGame(room.game.id)!;
    room.game.state = mod.playerLeft(room.game.state, leaving.id, ctxFor(room, env));
    summary = finalizeIfOver(room, env);
  }
  touch(room, env);
  return summary;
}

/** If the running game just ended, bank its scores into the room totals exactly once. */
function finalizeIfOver(room: Room, env: RoomEnv): GameSummary | null {
  if (room.status !== 'playing' || !room.game) return null;
  const mod = getGame(room.game.id)!;
  if (!mod.isOver(room.game.state)) return null;
  room.status = 'finished';
  room.gamesPlayed += 1;
  const scores = mod.scores(room.game.state) as Record<string, number>;
  for (const [id, pts] of Object.entries(scores)) room.totals[id] = (room.totals[id] ?? 0) + pts;
  touch(room, env);
  return {
    gameId: room.game.id,
    scores,
    profiles: Object.fromEntries(
      room.players.filter((p) => p.profileId).map((p) => [p.id, p.profileId!]),
    ),
    playerCount: Object.keys(scores).length,
  };
}

function syncGame(room: Room, env: RoomEnv) {
  if (room.status !== 'playing' || !room.game) return null;
  const mod = getGame(room.game.id)!;
  room.game.state = mod.sync(room.game.state, ctxFor(room, env));
  return finalizeIfOver(room, env);
}

/** Advance timers. Returns a summary if a game just finished. */
export function tickRoom(room: Room, env: RoomEnv): GameSummary | null {
  if (room.status !== 'playing' || !room.game) return null;
  const mod = getGame(room.game.id)!;
  const before = mod.deadline(room.game.state);
  room.game.state = mod.tick(room.game.state, ctxFor(room, env));
  const summary = finalizeIfOver(room, env);
  if (summary || before !== mod.deadline(room.game.state)) touch(room, env);
  return summary;
}

export function nextDeadline(room: Room): number | null {
  if (room.status !== 'playing' || !room.game) return null;
  return getGame(room.game.id)!.deadline(room.game.state);
}

function requireHost(room: Room, actorId: string) {
  if (room.hostId !== actorId) throw new GameError('host-only', 'Only the host can do that.');
}

function configFor(room: Room, gameId: GameId): unknown {
  return room.configs[gameId] ?? getGame(gameId)!.defaultConfig;
}

function startGame(room: Room, env: RoomEnv) {
  const mod = getGame(room.gameId)!;
  const players = room.players.filter((p) => p.connected);
  if (players.length < mod.minPlayers)
    throw new GameError(
      'not-enough-players',
      `${mod.title} needs at least ${mod.minPlayers} connected players.`,
    );
  if (players.length > mod.maxPlayers)
    throw new GameError(
      'too-many-players',
      `${mod.title} supports up to ${mod.maxPlayers} players.`,
    );
  // Disconnected players are not part of the match.
  const ctx = {
    ...ctxFor(room, env),
    players: players.map((p) => ({ id: p.id, name: p.name, connected: true })),
  };
  const config = mod.configSchema.parse(configFor(room, room.gameId));
  const state = mod.start(ctx, config);
  room.game = { id: room.gameId, state, startedAt: env.now };
  room.status = 'playing';
}

/**
 * Applies one command from `actorId`. Throws GameError for anything illegal. Returns a game summary
 * when the command caused a game to finish (for persistence).
 */
export function applyCommand(
  room: Room,
  actorId: string,
  cmd: Command,
  env: RoomEnv,
): GameSummary | null {
  if (!room.players.some((p) => p.id === actorId))
    throw new GameError('not-in-room', 'You are not in this room.');
  let summary: GameSummary | null = null;
  switch (cmd.type) {
    case 'game.select': {
      requireHost(room, actorId);
      if (room.status === 'playing')
        throw new GameError('in-progress', 'Finish or end the current game first.');
      room.gameId = cmd.gameId;
      break;
    }
    case 'game.config': {
      requireHost(room, actorId);
      if (room.status !== 'lobby')
        throw new GameError('in-progress', 'Settings can only change in the lobby.');
      const mod = getGame(room.gameId)!;
      const parsed = mod.configSchema.safeParse({
        ...(configFor(room, room.gameId) as object),
        ...cmd.config,
      });
      if (!parsed.success)
        throw new GameError('invalid-config', 'Those settings are out of range.');
      room.configs[room.gameId] = parsed.data;
      break;
    }
    case 'game.start': {
      requireHost(room, actorId);
      if (room.status === 'playing')
        throw new GameError('in-progress', 'A game is already running.');
      startGame(room, env);
      break;
    }
    case 'game.rematch': {
      requireHost(room, actorId);
      if (room.status !== 'finished')
        throw new GameError('wrong-phase', 'The game isn’t finished yet.');
      startGame(room, env);
      break;
    }
    case 'game.end': {
      requireHost(room, actorId);
      if (room.status === 'lobby') break;
      if (room.status === 'playing' && room.game) {
        // Abandoned games bank nothing.
        room.game = null;
        room.status = 'lobby';
      } else {
        room.game = null;
        room.status = 'lobby';
      }
      break;
    }
    case 'game.action': {
      if (room.status !== 'playing' || !room.game)
        throw new GameError('no-game', 'No game is running.');
      const mod = getGame(room.game.id)!;
      const parsed = mod.actionSchema.safeParse(cmd.action);
      if (!parsed.success) throw new GameError('invalid-action', 'That move isn’t valid.');
      if (mod.hostOnly?.(parsed.data)) requireHost(room, actorId);
      room.game.state = mod.reduce(room.game.state, parsed.data, actorId, ctxFor(room, env));
      summary = finalizeIfOver(room, env);
      break;
    }
    case 'room.kick': {
      requireHost(room, actorId);
      if (cmd.playerId === actorId)
        throw new GameError('invalid-target', 'You can’t kick yourself — leave instead.');
      summary = removePlayer(room, cmd.playerId, env);
      break;
    }
    case 'room.rename': {
      const name = validateNickname(cmd.name);
      if (nameTaken(room, name, actorId))
        throw new GameError('name-taken', 'Someone in the room already has that nickname.');
      room.players.find((p) => p.id === actorId)!.name = name;
      break;
    }
    case 'room.leave': {
      summary = removePlayer(room, actorId, env);
      break;
    }
  }
  touch(room, env);
  return summary;
}

/** Builds what one specific player is allowed to see. */
export function buildRoomView(room: Room, viewerId: string, env: RoomEnv): RoomView {
  const mod = getGame(room.gameId)!;
  const ctx = ctxFor(room, env);
  return {
    code: room.code,
    version: room.version,
    serverNow: env.now,
    you: viewerId,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      total: room.totals[p.id] ?? 0,
    })),
    gameId: room.gameId,
    config: configFor(room, room.gameId),
    status: room.status,
    game: room.game
      ? ({
          id: room.game.id,
          view: getGame(room.game.id)!.view(room.game.state, viewerId, ctx),
        } as RoomView['game'])
      : null,
    gamesPlayed: room.gamesPlayed,
    limits: { min: mod.minPlayers, max: mod.maxPlayers },
    data: {
      kind: env.football.meta.kind,
      label: env.football.meta.label,
      generatedAt: env.football.meta.generatedAt,
      currentSeason: env.football.meta.currentSeason,
    },
  };
}
