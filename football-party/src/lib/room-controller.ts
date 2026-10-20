import type { Command, RoomView } from '@shared/room/types';
import type { PlayerCard } from '@shared/football/types';

/**
 * What the game UI needs from a room, regardless of transport. Two implementations exist:
 *  - useRoomConnection: real cross-device multiplayer over WebSocket (server-authoritative)
 *  - useLocalRoom:      offline practice / pass-and-play, running the same engine in the browser
 */
export interface RoomController {
  mode: 'online' | 'local';
  view: RoomView;
  /** serverNow - Date.now(): add to local time to get server time (0 for local). */
  clockOffset: number;
  send: (cmd: Command) => Promise<void>;
  searchPlayers: (q: string, signal?: AbortSignal) => Promise<PlayerCard[]>;
  /** Local pass-and-play only: who the device is currently acting as. */
  actingAs?: string;
  /** Local only: stops the game clock while `p` runs (used for ad breaks). */
  pauseWhile?: (p: Promise<unknown>) => Promise<void>;
}
