import { z } from 'zod';
import type { DatasetMeta } from '../football/types';
import type { GameId } from '../games/types';
import type { ImpostorView } from '../games/impostor';
import type { QuickView } from '../games/quick';
import type { TttView } from '../games/tictactoe';

export const MAX_ROOM_PLAYERS = 12;
export { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants';

export interface RoomPlayer {
  id: string;
  name: string;
  connected: boolean;
  joinedAt: number;
  /** Optional persistent profile (server-side only; never sent to other clients). */
  profileId: string | null;
}

export interface Room {
  code: string;
  createdAt: number;
  lastActivity: number;
  hostId: string;
  players: RoomPlayer[];
  gameId: GameId;
  configs: Partial<Record<GameId, unknown>>;
  status: 'lobby' | 'playing' | 'finished';
  game: { id: GameId; state: unknown; startedAt: number } | null;
  /** Cumulative points across all games played in this room session. */
  totals: Record<string, number>;
  gamesPlayed: number;
  version: number;
}

export type GameViewEnvelope =
  | { id: 'impostor'; view: ImpostorView }
  | { id: 'tictactoe'; view: TttView }
  | { id: 'linkup'; view: QuickView }
  | { id: 'career'; view: QuickView };

export interface RoomPlayerView {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
  total: number;
}

export interface RoomView {
  code: string;
  version: number;
  /** Server clock at send time. Clients derive an offset so countdowns match across devices. */
  serverNow: number;
  you: string;
  hostId: string;
  players: RoomPlayerView[];
  gameId: GameId;
  config: unknown;
  status: Room['status'];
  game: GameViewEnvelope | null;
  gamesPlayed: number;
  limits: { min: number; max: number };
  data: Pick<DatasetMeta, 'kind' | 'label' | 'generatedAt' | 'currentSeason'>;
}

export const NonceSchema = z.string().min(1).max(40).optional();

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('game.select'),
    gameId: z.enum(['impostor', 'tictactoe', 'linkup', 'career']),
  }),
  z.object({ type: z.literal('game.config'), config: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('game.start') }),
  z.object({ type: z.literal('game.action'), action: z.unknown() }),
  z.object({ type: z.literal('game.rematch') }),
  z.object({ type: z.literal('game.end') }),
  z.object({ type: z.literal('room.kick'), playerId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('room.rename'), name: z.string().max(60) }),
  z.object({ type: z.literal('room.leave') }),
]);
export type Command = z.infer<typeof CommandSchema>;

export const ClientMessageSchema = z.union([
  z.object({ t: z.literal('cmd'), nonce: NonceSchema, cmd: CommandSchema }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { t: 'state'; view: RoomView }
  | { t: 'error'; code: string; message: string; nonce?: string }
  | { t: 'ack'; nonce: string }
  | { t: 'pong'; serverNow: number }
  | { t: 'kicked' }
  | { t: 'closed'; reason: string };

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 16;
