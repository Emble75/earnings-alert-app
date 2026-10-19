import { z } from 'zod';
import type { Criterion, GridSpec, PlayerCard } from '../football';
import { GameError, type GameContext, type GameModule } from './types';

export const TttConfigSchema = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  rounds: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(3),
  turnSeconds: z.number().int().min(10).max(120).default(30),
});
export type TttConfig = z.infer<typeof TttConfigSchema>;

export const TttActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('guess'),
    cell: z.number().int().min(0).max(8),
    playerId: z.string().min(1).max(80),
  }),
  z.object({ type: z.literal('next') }), // host: skip the between-rounds pause
]);
export type TttAction = z.infer<typeof TttActionSchema>;

type Side = 0 | 1; // 0 = X, 1 = O

export interface TttCell {
  side: Side;
  by: string;
  footballerId: string;
  name: string;
}

export interface TttEvent {
  seq: number;
  kind: 'claimed' | 'rejected' | 'timeout';
  by: string;
  cell: number | null;
  name: string | null;
  message: string;
}

export interface TttState {
  config: TttConfig;
  teams: [string[], string[]];
  round: number;
  firstSide: Side;
  turn: number;
  phase: 'playing' | 'round-over' | 'final';
  deadline: number | null;
  grid: GridSpec;
  cells: (TttCell | null)[];
  used: string[];
  event: TttEvent | null;
  eventSeq: number;
  roundWinner: Side | null; // for round-over
  line: number[] | null;
  roundHistory: { winner: Side | null }[];
  sideWins: [number, number];
  scores: Record<string, number>;
}

export interface TttView {
  phase: TttState['phase'];
  round: number;
  totalRounds: number;
  teams: [string[], string[]];
  turnSide: Side | null;
  turnPlayerId: string | null;
  deadline: number | null;
  rows: Criterion[];
  cols: Criterion[];
  cells: (TttCell | null)[];
  event: TttEvent | null;
  roundWinner: Side | null;
  line: number[] | null;
  sideWins: [number, number];
  roundHistory: { winner: Side | null }[];
  scores: Record<string, number>;
  usedCount: number;
  config: TttConfig;
}

export const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const BETWEEN_ROUNDS_MS = 8000;
const DISCONNECT_SKIP_MS = 3000;
export const TTT_MAX_PLAYERS = 8;

function turnSide(s: TttState): Side {
  return ((s.firstSide + s.turn) % 2) as Side;
}
/** Which member of the active team acts: rotates through the team each time that team plays. */
function turnPlayer(s: TttState): string {
  const side = turnSide(s);
  const team = s.teams[side];
  const nth = Math.floor(s.turn / 2); // turns alternate sides, so each side acts every 2nd turn
  return team[(nth + s.round - 1) % team.length]!;
}

function winningLine(cells: (TttCell | null)[]): { side: Side; line: number[] } | null {
  for (const line of LINES) {
    const [a, b, c] = line as [number, number, number];
    const ca = cells[a];
    if (ca && cells[b]?.side === ca.side && cells[c]?.side === ca.side)
      return { side: ca.side, line };
  }
  return null;
}

function newGrid(ctx: GameContext, config: TttConfig) {
  const grid = ctx.football.generateGrid(ctx.rng, config.difficulty);
  if (!grid)
    throw new GameError(
      'insufficient-data',
      'The football data can’t support a fully verifiable grid at this difficulty yet. Try an easier setting or sync more data.',
    );
  return grid;
}

function startRoundState(prev: TttState, ctx: GameContext): TttState {
  const round = prev.round + 1;
  const firstSide = (round % 2 === 0 ? 1 : 0) as Side;
  return {
    ...prev,
    round,
    firstSide: (firstSide === 0 ? 0 : 1) as Side,
    turn: 0,
    phase: 'playing',
    grid: newGrid(ctx, prev.config),
    cells: Array(9).fill(null),
    used: [],
    event: null,
    roundWinner: null,
    line: null,
    deadline: ctx.now + prev.config.turnSeconds * 1000,
  };
}

function finishRound(
  s: TttState,
  winner: Side | null,
  line: number[] | null,
  ctx: GameContext,
): TttState {
  const next = structuredClone(s);
  next.roundWinner = winner;
  next.line = line;
  next.roundHistory.push({ winner });
  if (winner !== null) {
    next.sideWins[winner] += 1;
    for (const p of next.teams[winner]) next.scores[p] = (next.scores[p] ?? 0) + 3;
  } else {
    for (const p of [...next.teams[0], ...next.teams[1]])
      next.scores[p] = (next.scores[p] ?? 0) + 1;
  }
  const need = Math.ceil(next.config.rounds / 2);
  const over =
    next.round >= next.config.rounds || next.sideWins[0] >= need || next.sideWins[1] >= need;
  next.phase = over ? 'final' : 'round-over';
  next.deadline = over ? null : ctx.now + BETWEEN_ROUNDS_MS;
  return next;
}

function pushEvent(s: TttState, e: Omit<TttEvent, 'seq'>) {
  s.eventSeq += 1;
  s.event = { ...e, seq: s.eventSeq };
}

function passTurn(s: TttState, ctx: GameContext) {
  s.turn += 1;
  s.deadline = ctx.now + s.config.turnSeconds * 1000;
}

function settle(state: TttState, ctx: GameContext): TttState {
  let s = state;
  for (let i = 0; i < 32; i++) {
    if (s.phase === 'playing') {
      const online = new Set(ctx.players.filter((p) => p.connected).map((p) => p.id));
      const who = turnPlayer(s);
      if (!online.has(who) && s.deadline !== null && s.deadline > ctx.now + DISCONNECT_SKIP_MS) {
        s = { ...s, deadline: ctx.now + DISCONNECT_SKIP_MS };
      }
      if (s.deadline !== null && s.deadline <= ctx.now) {
        const c = structuredClone(s);
        pushEvent(c, {
          kind: 'timeout',
          by: who,
          cell: null,
          name: null,
          message: 'Out of time — turn passes.',
        });
        passTurn(c, ctx);
        s = c;
        continue;
      }
    } else if (s.phase === 'round-over' && s.deadline !== null && s.deadline <= ctx.now) {
      s = startRoundState(s, ctx);
      continue;
    }
    break;
  }
  return s;
}

export const ticTacToeGame: GameModule<TttConfig, TttState, TttAction, TttView> = {
  id: 'tictactoe',
  title: 'Football Tic-Tac-Toe',
  tagline: 'Name a footballer who fits both the row and the column. Three in a line wins.',
  minPlayers: 2,
  maxPlayers: TTT_MAX_PLAYERS,
  defaultConfig: TttConfigSchema.parse({}),
  configSchema: TttConfigSchema,
  actionSchema: TttActionSchema,

  start(ctx, config) {
    if (ctx.players.length < 2)
      throw new GameError('not-enough-players', 'Tic-Tac-Toe needs at least 2 players.');
    const teams: [string[], string[]] = [[], []];
    ctx.players.forEach((p, i) => teams[i % 2]!.push(p.id));
    const blank: TttState = {
      config,
      teams,
      round: 0,
      firstSide: 0,
      turn: 0,
      phase: 'playing',
      deadline: null,
      grid: { rows: [], cols: [], answerCounts: [] },
      cells: Array(9).fill(null),
      used: [],
      event: null,
      eventSeq: 0,
      roundWinner: null,
      line: null,
      roundHistory: [],
      sideWins: [0, 0],
      scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])),
    };
    return settle(startRoundState(blank, ctx), ctx);
  },

  reduce(state, action, actorId, ctx) {
    if (action.type === 'next') {
      if (state.phase !== 'round-over') throw new GameError('wrong-phase', 'No pause to skip.');
      return settle(startRoundState(state, ctx), ctx);
    }
    if (state.phase !== 'playing') throw new GameError('wrong-phase', 'The round is over.');
    const s = settle(state, ctx);
    if (s.phase !== 'playing') throw new GameError('wrong-phase', 'The round is over.');
    if (turnPlayer(s) !== actorId) throw new GameError('not-your-turn', 'It’s not your turn.');
    if (action.cell < 0 || action.cell > 8 || s.cells[action.cell])
      throw new GameError('cell-taken', 'That square is already claimed.');
    const card = ctx.football.card(action.playerId);
    if (!card)
      throw new GameError('unknown-player', 'Unknown footballer — pick one from the search list.');
    if (s.used.includes(action.playerId))
      throw new GameError('duplicate', `${card.name} has already been used this round.`);

    const next = structuredClone(s);
    const rowC = next.grid.rows[Math.floor(action.cell / 3)]!;
    const colC = next.grid.cols[action.cell % 3]!;
    const v1 = ctx.football.verdict(action.playerId, rowC);
    const v2 = ctx.football.verdict(action.playerId, colC);
    if (v1.ok && v2.ok) {
      next.used.push(action.playerId); // only successful claims burn a footballer
      const side = turnSide(next);
      next.cells[action.cell] = { side, by: actorId, footballerId: card.id, name: card.name };
      next.scores[actorId] = (next.scores[actorId] ?? 0) + 1;
      pushEvent(next, {
        kind: 'claimed',
        by: actorId,
        cell: action.cell,
        name: card.name,
        message: `${card.name} fits both.`,
      });
      const win = winningLine(next.cells);
      if (win) return finishRound(next, win.side, win.line, ctx);
      if (next.cells.every(Boolean)) return finishRound(next, null, null, ctx);
    } else {
      const failed = !v1.ok ? rowC : colC;
      const verdict = !v1.ok ? v1 : v2;
      const why =
        !verdict.ok && verdict.reason === 'unverified-record'
          ? `We can’t verify ${card.name} for ${failed.label} from our data — only confirmed records count.`
          : `${card.name} isn’t confirmed for ${failed.label}.`;
      pushEvent(next, {
        kind: 'rejected',
        by: actorId,
        cell: action.cell,
        name: card.name,
        message: `${why} Turn passes.`,
      });
    }
    passTurn(next, ctx);
    return settle(next, ctx);
  },

  hostOnly: (a) => a.type === 'next',
  tick: (s, ctx) => settle(s, ctx),
  sync: (s, ctx) => settle(s, ctx),
  deadline: (s) => s.deadline,

  view(s): TttView {
    const playing = s.phase === 'playing';
    return {
      phase: s.phase,
      round: s.round,
      totalRounds: s.config.rounds,
      teams: s.teams,
      turnSide: playing ? turnSide(s) : null,
      turnPlayerId: playing ? turnPlayer(s) : null,
      deadline: s.deadline,
      rows: s.grid.rows,
      cols: s.grid.cols,
      cells: s.cells,
      event: s.event,
      roundWinner: s.roundWinner,
      line: s.line,
      sideWins: s.sideWins,
      roundHistory: s.roundHistory,
      scores: s.scores,
      usedCount: s.used.length,
      config: s.config,
    };
  },

  scores: (s) => s.scores,
  isOver: (s) => s.phase === 'final',

  playerLeft(state, playerId, ctx) {
    const s = structuredClone(state);
    s.teams = [s.teams[0].filter((p) => p !== playerId), s.teams[1].filter((p) => p !== playerId)];
    if (s.teams[0].length === 0 || s.teams[1].length === 0) {
      s.phase = 'final';
      s.deadline = null;
      return s;
    }
    return settle(s, ctx);
  },
};

export type { PlayerCard };
