import { describe, expect, it } from 'vitest';
import type { QuickState } from '../shared/games/quick';
import type { WhoAreYaState } from '../shared/games/whoareya';
import { applyCommand, buildRoomView, cmd, football, makeEnv, makeRoom } from './helpers';

function start(game: 'oddone' | 'whoareya', names: string[], config: Record<string, unknown> = {}) {
  const env = makeEnv(11);
  const room = makeRoom(names, env);
  applyCommand(room, names[0]!, cmd.select(game), env);
  applyCommand(room, names[0]!, cmd.config({ difficulty: 'easy', rounds: 3, ...config }), env);
  applyCommand(room, names[0]!, cmd.start(), env);
  return { room, env };
}

describe('odd one out', () => {
  it('three played for the club, one did not; the answer stays hidden until reveal', () => {
    const { room, env } = start('oddone', ['ana', 'ben'], { timers: false });
    const s = room.game!.state as QuickState;
    if (s.prompt.kind !== 'oddone') throw new Error('prompt');
    const club = s.prompt.club;
    const inClub = s.prompt.options.filter((o) => football.verdict(o.id, club).ok);
    expect(s.prompt.options).toHaveLength(4);
    expect(inClub).toHaveLength(3);
    const odd = s.prompt.options.find((o) => !football.verdict(o.id, club).ok)!;
    expect(s.target).toBe(odd.id);
    expect(JSON.stringify(buildRoomView(room, 'ben', env))).not.toContain('"target"');
    const wrong = inClub[0]!;
    applyCommand(room, 'ben', cmd.act({ type: 'guess', playerId: wrong.id }), env);
    expect((room.game!.state as QuickState).wrong.ben).toBe(1);
    expect(() =>
      applyCommand(room, 'ben', cmd.act({ type: 'guess', playerId: odd.id }), env),
    ).toThrow(/out of guesses/i);
    applyCommand(room, 'ana', cmd.act({ type: 'guess', playerId: odd.id }), env);
    expect((room.game!.state as QuickState).winner).toBe('ana');
  });
});

describe('who are ya', () => {
  it('takes turns, shows clue tiles, hides the target, and scores fewer guesses higher', () => {
    const { room, env } = start('whoareya', ['ana', 'ben'], { timers: false });
    const st = () => room.game!.state as WhoAreYaState;
    const target = st().target;
    const name = football.card(target)!.name;
    expect(JSON.stringify(buildRoomView(room, 'ben', env))).not.toContain(name);
    const other = football.allPlayers().find((p) => p.id !== target && p.name !== name)!;
    expect(() =>
      applyCommand(room, 'ben', cmd.act({ type: 'guess', playerId: other.id }), env),
    ).toThrow(/not your turn/i);
    applyCommand(room, 'ana', cmd.act({ type: 'guess', playerId: other.id }), env);
    expect(st().guesses[0]!.nation.hit).toMatch(/match|miss|unknown/);
    expect(() =>
      applyCommand(room, 'ben', cmd.act({ type: 'guess', playerId: other.id }), env),
    ).toThrow(/already guessed/i);
    applyCommand(room, 'ben', cmd.act({ type: 'guess', playerId: target }), env);
    expect(st().phase).toBe('reveal');
    expect(st().solvedBy).toBe('ben');
    expect(st().scores.ben).toBe(st().config.maxGuesses + 1 - 2);
    applyCommand(room, 'ana', cmd.act({ type: 'next' }), env);
    expect(st().round).toBe(2);
  });
});
