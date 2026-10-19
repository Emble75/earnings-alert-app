import { describe, expect, it } from 'vitest';
import { chooseBotMove } from '../shared/games/bot';
import { seededRng } from '../shared/util/rng';
import type { TttState } from '../shared/games/tictactoe';
import { applyCommand, cmd, football, makeEnv, makeRoom } from './helpers';

function started(difficulty: 'easy' | 'hard') {
  const env = makeEnv(11);
  const room = makeRoom(['me', 'bot'], env);
  applyCommand(room, 'me', cmd.select('tictactoe'), env);
  applyCommand(room, 'me', cmd.config({ difficulty, rounds: 1 }), env);
  applyCommand(room, 'me', cmd.start(), env);
  return room.game!.state as TttState;
}

describe('practice bot', () => {
  it('only plays empty squares and unused footballers', () => {
    const s = started('easy');
    for (let seed = 1; seed < 40; seed++) {
      const m = chooseBotMove(s, 1, football, seededRng(seed))!;
      expect(s.cells[m.cell]).toBeNull();
      expect(s.used).not.toContain(m.playerId);
      expect(football.getPlayer(m.playerId)).toBeDefined();
    }
  });
  it('is far more accurate on hard than on easy', () => {
    const rate = (d: 'easy' | 'hard') => {
      const s = started(d);
      let ok = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const m = chooseBotMove(s, 1, football, seededRng(seed))!;
        const r = s.grid.rows[Math.floor(m.cell / 3)]!;
        const c = s.grid.cols[m.cell % 3]!;
        if (football.verdict(m.playerId, r).ok && football.verdict(m.playerId, c).ok) ok++;
      }
      return ok / 200;
    };
    expect(rate('hard')).toBeGreaterThan(rate('easy') + 0.25);
  });
});
