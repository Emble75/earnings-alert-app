import type { FootballIndex } from '../football';
import type { Rng } from '../util/rng';
import { LINES, type TttState } from './tictactoe';

export interface BotMove {
  cell: number;
  playerId: string;
}

const ACCURACY = { easy: 0.45, medium: 0.7, hard: 0.92 } as const;

/**
 * Practice-mode opponent for Tic-Tac-Toe. It only ever answers from the same validated data the
 * server uses, so it can't "know" anything a player couldn't look up. Mistakes are deliberate
 * (accuracy scales with difficulty) to keep practice fun.
 */
export function chooseBotMove(
  state: TttState,
  side: 0 | 1,
  football: FootballIndex,
  rng: Rng,
): BotMove | null {
  const empty = state.cells.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  if (empty.length === 0) return null;
  const answers = (cell: number) =>
    football
      .validAnswers(state.grid.rows[Math.floor(cell / 3)]!, state.grid.cols[cell % 3]!)
      .filter((id) => !state.used.includes(id));
  const playable = empty.filter((c) => answers(c).length > 0);

  const completes = (cell: number, s: 0 | 1) =>
    LINES.some((l) => l.includes(cell) && l.every((i) => i === cell || state.cells[i]?.side === s));
  const pool = playable.length ? playable : empty;
  const pickCell =
    pool.find((c) => completes(c, side)) ??
    pool.find((c) => completes(c, (1 - side) as 0 | 1)) ??
    (pool.includes(4) ? 4 : pool[Math.floor(rng() * pool.length)]!);

  const good = answers(pickCell);
  if (good.length > 0 && rng() < ACCURACY[state.config.difficulty]) {
    return { cell: pickCell, playerId: good[Math.floor(rng() * good.length)]! };
  }
  // A plausible wrong answer: some other player that doesn't fit this square.
  const wrong = football
    .allPlayers()
    .filter((p) => !state.used.includes(p.id) && !good.includes(p.id));
  if (wrong.length === 0) return null;
  return { cell: pickCell, playerId: wrong[Math.floor(rng() * wrong.length)]!.id };
}
