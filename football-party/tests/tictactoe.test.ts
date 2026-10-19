import { describe, expect, it } from 'vitest';
import type { TttState } from '../shared/games/tictactoe';
import {
  advanceMany,
  advanceTime,
  applyCommand,
  cmd,
  football,
  makeEnv,
  makeRoom,
} from './helpers';
import type { Room } from '../shared/room/types';

const st = (room: Room) => room.game!.state as TttState;

function start(names = ['ana', 'ben'], config: Record<string, unknown> = {}, seed = 3) {
  const env = makeEnv(seed);
  const room = makeRoom(names, env);
  applyCommand(room, names[0]!, cmd.select('tictactoe'), env);
  applyCommand(room, names[0]!, cmd.config({ rounds: 3, difficulty: 'easy', ...config }), env);
  applyCommand(room, names[0]!, cmd.start(), env);
  return { room, env };
}
const turn = (room: Room) => {
  const s = st(room);
  const side = (s.firstSide + s.turn) % 2;
  return s.teams[side]![Math.floor(s.turn / 2) % s.teams[side]!.length]!;
};
const guess = (room: Room, who: string, cell: number, playerId: string, env = makeEnv()) =>
  applyCommand(room, who, cmd.act({ type: 'guess', cell, playerId }), env);

/** A valid answer for a cell that's not been used */
function answerFor(room: Room, cell: number) {
  const s = st(room);
  const r = s.grid.rows[Math.floor(cell / 3)]!;
  const c = s.grid.cols[cell % 3]!;
  return football.validAnswers(r, c).find((id) => !s.used.includes(id))!;
}
function wrongFor(room: Room, cell: number) {
  const s = st(room);
  const r = s.grid.rows[Math.floor(cell / 3)]!;
  const c = s.grid.cols[cell % 3]!;
  return football
    .allPlayers()
    .find(
      (p) =>
        !s.used.includes(p.id) && (!football.verdict(p.id, r).ok || !football.verdict(p.id, c).ok),
    )!.id;
}

describe('football tic-tac-toe', () => {
  it('starts with a fully answerable grid and X to move', () => {
    const { room } = start();
    expect(st(room).grid.rows).toHaveLength(3);
    expect(Math.min(...st(room).grid.answerCounts)).toBeGreaterThanOrEqual(3);
    expect(turn(room)).toBe('ana');
  });

  it('claims a cell for a server-validated answer and passes the turn', () => {
    const { room, env } = start();
    guess(room, 'ana', 4, answerFor(room, 4), env);
    expect(st(room).cells[4]).toMatchObject({ side: 0, by: 'ana' });
    expect(st(room).event?.kind).toBe('claimed');
    expect(turn(room)).toBe('ben');
  });

  it('rejects an invalid answer and loses the turn, without claiming the cell', () => {
    const { room, env } = start();
    guess(room, 'ana', 0, wrongFor(room, 0), env);
    expect(st(room).cells[0]).toBeNull();
    expect(st(room).event).toMatchObject({ kind: 'rejected' });
    expect(turn(room)).toBe('ben');
  });

  it('enforces turns, taken cells, unknown footballers and duplicates', () => {
    const { room, env } = start();
    expect(() => guess(room, 'ben', 0, answerFor(room, 0), env)).toThrowError(/not your turn/);
    expect(() => guess(room, 'ana', 0, 'not-a-real-id', env)).toThrowError(/Unknown footballer/);
    const a = answerFor(room, 4);
    guess(room, 'ana', 4, a, env);
    expect(() => guess(room, 'ben', 4, answerFor(room, 4), env)).toThrowError(/already claimed/);
    // duplicate prevention: same footballer cannot be reused even in another valid cell
    const s = st(room);
    const dupCell = [0, 1, 2, 3, 5, 6, 7, 8].find((c) =>
      football.validAnswers(s.grid.rows[Math.floor(c / 3)]!, s.grid.cols[c % 3]!).includes(a),
    );
    if (dupCell !== undefined)
      expect(() => guess(room, 'ben', dupCell, a, env)).toThrowError(/already been used/);
    expect(turn(room)).toBe('ben'); // duplicate attempts don't consume the turn
  });

  it('detects a winning line, scores it and moves to round-over', () => {
    const { room, env } = start();
    // X: 0,1,2  O: 3,4 (O answers may be wrong; they only need to pass the turn)
    const plan: [string, number][] = [
      ['ana', 0],
      ['ben', 3],
      ['ana', 1],
      ['ben', 4],
      ['ana', 2],
    ];
    for (const [who, cell] of plan) {
      expect(turn(room)).toBe(who);
      if (who === 'ana') guess(room, who, cell, answerFor(room, cell), env);
      else guess(room, who, cell, wrongFor(room, cell), env); // O keeps failing
    }
    expect(st(room).phase).toBe('round-over');
    expect(st(room).roundWinner).toBe(0);
    expect(st(room).line).toEqual([0, 1, 2]);
    expect(st(room).sideWins).toEqual([1, 0]);
    expect(st(room).scores.ana).toBe(3 + 3); // 3 claims + 3 win
    expect(st(room).scores.ben).toBe(0);
  });

  it('auto-starts the next round, alternates the first mover, and ends at majority', () => {
    const { room, env } = start(['ana', 'ben'], { rounds: 3 });
    const winRound = () => {
      const first = turn(room);
      const second = first === 'ana' ? 'ben' : 'ana';
      for (const cell of [0, 1, 2]) {
        guess(room, turn(room), cell, answerFor(room, cell), env);
        if (cell < 2) guess(room, turn(room), cell + 3, wrongFor(room, cell + 3), env);
      }
      return { first, second };
    };
    const r1 = winRound();
    expect(r1.first).toBe('ana');
    advanceTime(room, env, 8100);
    expect(st(room).round).toBe(2);
    expect(turn(room)).toBe('ben'); // O starts round 2
    const r2 = winRound();
    expect(r2.first).toBe('ben');
    // ana won round 1, ben won round 2 → round 3 decides
    advanceTime(room, env, 8100);
    expect(st(room).round).toBe(3);
    winRound();
    expect(room.status).toBe('finished');
    expect(st(room).phase).toBe('final');
    expect(room.totals.ana! + room.totals.ben!).toBeGreaterThan(0);
  });

  it('draws score a point each', () => {
    const { room, env } = start(['ana', 'ben'], { rounds: 1 });
    // fill the board so no line completes: X O X / X O O / O X X (X at 0,2,3,7,8; O at 1,4,5,6)
    const xCells = [0, 2, 3, 7, 8];
    const oCells = [1, 4, 5, 6];
    for (let i = 0; i < 9; i++) {
      const who = turn(room);
      const cell = who === 'ana' ? xCells.shift()! : oCells.shift()!;
      guess(room, who, cell, answerFor(room, cell), env);
    }
    expect(st(room).roundWinner).toBeNull();
    expect(st(room).roundHistory).toEqual([{ winner: null }]);
    expect(room.status).toBe('finished');
  });

  it('passes the turn on timeout and on disconnect', () => {
    const { room, env } = start(['ana', 'ben'], { turnSeconds: 10 });
    advanceTime(room, env, 10_001);
    expect(st(room).event?.kind).toBe('timeout');
    expect(turn(room)).toBe('ben');
    room.players.find((p) => p.id === 'ben')!.connected = false;
    advanceTime(room, env, 0);
    advanceTime(room, env, 3100);
    expect(turn(room)).toBe('ana');
  });

  it('rotates team members and supports >2 players', () => {
    const { room, env } = start(['p1', 'p2', 'p3', 'p4'], { turnSeconds: 10 });
    expect(st(room).teams).toEqual([
      ['p1', 'p3'],
      ['p2', 'p4'],
    ]);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(turn(room));
      advanceTime(room, env, 10_001);
    }
    expect(seen).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('refuses to start when data cannot support a verifiable grid', () => {
    const env = makeEnv();
    const room = makeRoom(['a', 'b'], env);
    const empty = {
      ...env,
      football: new (football.constructor as new (d: unknown) => typeof football)({
        ...football.dataset,
        players: [],
      }),
    };
    applyCommand(room, 'a', cmd.select('tictactoe'), empty);
    expect(() => applyCommand(room, 'a', cmd.start(), empty)).toThrowError(/can’t support/);
    expect(room.status).toBe('lobby');
  });
});

describe('tic-tac-toe with timers switched off', () => {
  it('waits for the player indefinitely; the host can skip the turn and start the next round', () => {
    const { room, env } = start(['ana', 'ben'], { timers: false, rounds: 3 });
    expect(st(room).deadline).toBeNull();
    advanceMany(room, env, 600_000, 5000);
    expect(turn(room)).toBe('ana');
    expect(st(room).event).toBeNull();
    expect(() => applyCommand(room, 'ben', cmd.act({ type: 'skip' }), env)).toThrowError(/host/);
    applyCommand(room, 'ana', cmd.act({ type: 'skip' }), env);
    expect(turn(room)).toBe('ben');
    expect(st(room).event?.message).toMatch(/host skipped/i);
    expect(st(room).deadline).toBeNull();
    // finish a round: it must wait for the host instead of auto-starting
    const plan: [string, number][] = [
      ['ben', 0],
      ['ana', 3],
      ['ben', 1],
      ['ana', 4],
      ['ben', 2],
    ];
    for (const [who, cell] of plan) {
      if (who === 'ben') guess(room, who, cell, answerFor(room, cell), env);
      else guess(room, who, cell, wrongFor(room, cell), env);
    }
    expect(st(room).phase).toBe('round-over');
    expect(st(room).deadline).toBeNull();
    advanceMany(room, env, 600_000, 5000);
    expect(st(room).round).toBe(1);
    applyCommand(room, 'ana', cmd.act({ type: 'next' }), env);
    expect(st(room).round).toBe(2);
  });
});
