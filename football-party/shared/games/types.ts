import type { z } from 'zod';
import type { FootballIndex } from '../football';
import type { Rng } from '../util/rng';

export type GameId = 'impostor' | 'tictactoe';

/** Expected, user-facing rule violation. `code` is stable for clients, `message` is displayable. */
export class GameError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

export interface GamePlayer {
  id: string;
  name: string;
  connected: boolean;
}

export interface GameContext {
  now: number;
  rng: Rng;
  football: FootballIndex;
  /** Everyone currently in the room, in join order. */
  players: readonly GamePlayer[];
}

/**
 * Contract every party game implements. All functions are pure with respect to the room: they
 * take state in and return new state, which keeps them unit-testable and lets the same code run
 * on the server (authoritative) and in the browser (offline practice mode).
 *
 * A new game = a new module + an entry in `registry.ts` + a client screen in `src/games`.
 * Rooms, identity, timers and cumulative scoring are handled by the room engine.
 */
export interface GameModule<Config, State, Action, View> {
  id: GameId;
  title: string;
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  defaultConfig: Config;
  configSchema: z.ZodType<Config>;
  actionSchema: z.ZodType<Action>;
  /** Builds the initial state. Throws GameError if the game cannot start (players, data). */
  start(ctx: GameContext, config: Config): State;
  /** Applies one player action. Throws GameError on illegal moves; must not mutate `state`. */
  reduce(state: State, action: Action, actorId: string, ctx: GameContext): State;
  /** Advances any elapsed timers. Idempotent. */
  tick(state: State, ctx: GameContext): State;
  /** Reconciles state with connection changes (e.g. skip disconnected players' turns). */
  sync(state: State, ctx: GameContext): State;
  /** Epoch ms of the next timer, or null. */
  deadline(state: State): number | null;
  /** Per-viewer projection. Must never include another player's secrets. */
  view(state: State, viewerId: string, ctx: GameContext): View;
  /** Points earned so far in this game (cumulative). */
  scores(state: State): Record<string, number>;
  isOver(state: State): boolean;
  /** Actions only the room host may send (e.g. skipping a waiting phase). */
  hostOnly?(action: Action): boolean;
  /** A player permanently left (kicked or quit). */
  playerLeft(state: State, playerId: string, ctx: GameContext): State;
}

export type AnyGameModule = GameModule<any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
