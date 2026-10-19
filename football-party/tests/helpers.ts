import { FootballIndex } from '../shared/football';
import { sampleDataset } from '../data/sample/sample';
import { seededRng } from '../shared/util/rng';
import {
  addPlayer,
  applyCommand,
  buildRoomView,
  createRoom,
  tickRoom,
  type RoomEnv,
} from '../shared/room/room';
import type { Command, Room, RoomPlayer } from '../shared/room/types';

export const football = new FootballIndex(sampleDataset);

export function makeEnv(seed = 1, now = 1_000_000): RoomEnv & { now: number } {
  return { now, rng: seededRng(seed), football };
}

export function player(id: string, name = id): RoomPlayer {
  return { id, name, connected: true, joinedAt: 0, profileId: null };
}

export function makeRoom(names: string[], env = makeEnv()): Room {
  const room = createRoom('ABCDE', player(names[0]!), env);
  for (const n of names.slice(1)) addPlayer(room, player(n), env);
  return room;
}

export const cmd = {
  select: (gameId: 'impostor' | 'tictactoe'): Command => ({ type: 'game.select', gameId }),
  config: (config: Record<string, unknown>): Command => ({ type: 'game.config', config }),
  start: (): Command => ({ type: 'game.start' }),
  act: (action: unknown): Command => ({ type: 'game.action', action }),
};

export function advanceTime(room: Room, env: { now: number }, ms: number) {
  env.now += ms;
  return tickRoom(room, env as RoomEnv);
}

export { applyCommand, buildRoomView };

/** Ticks the room in steps (like the server ticker), so each elapsed deadline is processed. */
export function advanceMany(room: Room, env: { now: number }, totalMs: number, step = 1000) {
  for (let t = 0; t < totalMs; t += step) advanceTime(room, env, Math.min(step, totalMs - t));
}
