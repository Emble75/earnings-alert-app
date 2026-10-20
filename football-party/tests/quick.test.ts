import { describe, expect, it } from 'vitest';
import type { QuickState } from '../shared/games/quick';
import {
  advanceTime,
  applyCommand,
  buildRoomView,
  cmd,
  football,
  makeEnv,
  makeRoom,
} from './helpers';
import type { Room } from '../shared/room/types';

const st = (room: Room) => room.game!.state as QuickState;

function start(
  game: 'linkup' | 'career',
  names = ['ana', 'ben'],
  config: Record<string, unknown> = {},
) {
  const env = makeEnv(5);
  const room = makeRoom(names, env);
  applyCommand(room, names[0]!, cmd.select(game), env);
  applyCommand(room, names[0]!, cmd.config({ rounds: 3, difficulty: 'easy', ...config }), env);
  applyCommand(room, names[0]!, cmd.start(), env);
  return { room, env };
}
const guess = (room: Room, who: string, playerId: string, env = makeEnv()) =>
  applyCommand(room, who, cmd.act({ type: 'guess', playerId }), env);

describe('link-up', () => {
  it('shows two badges that really share well-known footballers', () => {
    const { room } = start('linkup');
    const s = st(room);
    expect(s.prompt.kind).toBe('linkup');
    if (s.prompt.kind !== 'linkup') return;
    expect(football.validAnswers(s.prompt.a, s.prompt.b).length).toBeGreaterThanOrEqual(3);
    expect(s.answers.length).toBeGreaterThanOrEqual(3);
  });

  it('first correct answer wins the round; a wrong one costs a guess, never a point', () => {
    const { room, env } = start('linkup');
    const s = st(room);
    if (s.prompt.kind !== 'linkup') throw new Error('prompt');
    const { a, b } = s.prompt;
    const wrong = football.allPlayers().find((p) => !football.verdict(p.id, a).ok)!.id;
    expect(() => guess(room, 'ben', wrong, env)).not.toThrow();
    expect(st(room).scores.ben).toBe(0);
    expect(st(room).wrong.ben).toBe(1);
    guess(room, 'ana', s.answers[0]!, env);
    expect(st(room).phase).toBe('reveal');
    expect(st(room).winner).toBe('ana');
    expect(st(room).scores.ana).toBe(1);
    expect(football.verdict(s.answers[0]!, b).ok).toBe(true);
  });

  it('locks a player out after three wrong guesses', () => {
    const { room, env } = start('linkup');
    const s = st(room);
    if (s.prompt.kind !== 'linkup') throw new Error('prompt');
    const { a } = s.prompt;
    const wrongs = football
      .allPlayers()
      .filter((p) => !football.verdict(p.id, a).ok)
      .slice(0, 4);
    for (const w of wrongs.slice(0, 3)) guess(room, 'ben', w.id, env);
    expect(() => guess(room, 'ben', s.answers[0]!, env)).toThrow(/out of guesses/i);
    expect(() => guess(room, 'ana', s.answers[0]!, env)).not.toThrow();
  });

  it('times out into the answer screen and then moves to the next round', () => {
    const { room, env } = start('linkup', ['ana', 'ben'], { seconds: 10 });
    advanceTime(room, env, 11_000);
    expect(st(room).phase).toBe('reveal');
    expect(st(room).winner).toBeNull();
    advanceTime(room, env, 7_000);
    expect(st(room).round).toBe(2);
    expect(st(room).phase).toBe('playing');
  });

  it('never repeats a pair within a game and ends after the last round', () => {
    const { room, env } = start('linkup', ['ana'], { timers: false, spoken: true, rounds: 5 });
    for (let i = 0; i < 5; i++) {
      applyCommand(room, 'ana', cmd.act({ type: 'reveal' }), env);
      applyCommand(room, 'ana', cmd.act({ type: 'award', to: 'ana' }), env);
    }
    expect(st(room).phase).toBe('final');
    expect(new Set(st(room).used).size).toBe(st(room).used.length);
    expect(st(room).scores.ana).toBe(5);
  });
});

describe('spoken (one phone) mode', () => {
  it('has no typing: guesses are refused, the host reveals and awards', () => {
    const { room, env } = start('linkup', ['ana', 'ben'], { spoken: true, timers: false });
    expect(() => guess(room, 'ana', 'x', env)).toThrow(/out loud/i);
    applyCommand(room, 'ana', cmd.act({ type: 'reveal' }), env);
    expect(() => applyCommand(room, 'ben', cmd.act({ type: 'award', to: 'ben' }), env)).toThrow();
    applyCommand(room, 'ana', cmd.act({ type: 'award', to: 'ben' }), env);
    expect(st(room).scores.ben).toBe(1);
    expect(st(room).round).toBe(2);
  });
});

describe('career path', () => {
  it('never sends the footballer to clients before the reveal', () => {
    const { room, env } = start('career');
    const s = st(room);
    if (s.prompt.kind !== 'career') throw new Error('prompt');
    expect(s.prompt.clubs.length).toBeGreaterThanOrEqual(3);
    const name = football.card(s.target!)!.name;
    const during = JSON.stringify(buildRoomView(room, 'ben', env));
    expect(during).not.toContain(name);
    guess(room, 'ana', s.target!, env);
    expect(JSON.stringify(buildRoomView(room, 'ben', env))).toContain(name);
  });

  it('wins on the target and rejects someone else', () => {
    const { room, env } = start('career');
    const target = st(room).target!;
    const other = football
      .allPlayers()
      .find((p) => p.id !== target && p.name !== football.card(target)!.name)!;
    guess(room, 'ben', other.id, env);
    expect(st(room).winner).toBeNull();
    guess(room, 'ana', target, env);
    expect(st(room).winner).toBe('ana');
  });
});
