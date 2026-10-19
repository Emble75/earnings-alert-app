import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyCommand,
  buildRoomView,
  normalizeRoomCode,
  setConnected,
  validateNickname,
  generateRoomCode,
} from '../shared/room/room';
import { cmd, makeEnv, makeRoom, player } from './helpers';
import { seededRng } from '../shared/util/rng';
import { CommandSchema } from '../shared/room/types';

describe('room engine', () => {
  it('generates readable codes and normalises user input', () => {
    const code = generateRoomCode(seededRng(5));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(normalizeRoomCode(' ab-c d2e ')).toBe('ABCD2');
  });

  it('validates and cleans nicknames', () => {
    expect(validateNickname('  Ana   B ')).toBe('Ana B');
    expect(validateNickname('Zoë‮')).toBe('Zoë');
    expect(() => validateNickname('a')).toThrow();
    expect(() => validateNickname('   ')).toThrow();
    expect(() => validateNickname('!!!!')).toThrow();
    expect(() => validateNickname('x'.repeat(17))).toThrow();
  });

  it('rejects duplicate nicknames accent/case-insensitively and enforces capacity', () => {
    const env = makeEnv();
    const room = makeRoom(['Zoë'], env);
    expect(() => addPlayer(room, player('p2', 'zoe'), env)).toThrowError(/nickname/);
    for (let i = 0; i < 11; i++) addPlayer(room, player(`q${i}`, `Player ${i}`), env);
    expect(() => addPlayer(room, player('late', 'Late'), env)).toThrowError(/full/);
  });

  it('only the host can change game, settings, start, kick', () => {
    const env = makeEnv();
    const room = makeRoom(['host', 'guest', 'third'], env);
    for (const c of [
      cmd.select('tictactoe'),
      cmd.config({ rounds: 5 }),
      cmd.start(),
      { type: 'room.kick' as const, playerId: 'third' },
    ])
      expect(() => applyCommand(room, 'guest', c, env)).toThrowError(/host/);
    applyCommand(room, 'host', cmd.select('tictactoe'), env);
    expect(room.gameId).toBe('tictactoe');
  });

  it('validates settings against the selected game schema', () => {
    const env = makeEnv();
    const room = makeRoom(['host', 'guest'], env);
    applyCommand(room, 'host', cmd.select('tictactoe'), env);
    expect(() => applyCommand(room, 'host', cmd.config({ rounds: 4 }), env)).toThrowError(
      /out of range/,
    );
    applyCommand(room, 'host', cmd.config({ rounds: 5 }), env);
    expect((buildRoomView(room, 'host', env).config as { rounds: number }).rounds).toBe(5);
  });

  it('reassigns host on disconnect and restores a host when everyone is gone', () => {
    const env = makeEnv();
    const room = makeRoom(['host', 'guest'], env);
    setConnected(room, 'host', false, env);
    expect(room.hostId).toBe('guest');
    setConnected(room, 'guest', false, env);
    setConnected(room, 'host', true, env);
    expect(room.hostId).toBe('host');
  });

  it('blocks late joins mid-game and bumps the version on every change', () => {
    const env = makeEnv();
    const room = makeRoom(['a1', 'b2', 'c3'], env);
    const v0 = room.version;
    applyCommand(room, 'a1', cmd.start(), env);
    expect(room.version).toBeGreaterThan(v0);
    expect(() => addPlayer(room, player('late', 'Late'), env)).toThrowError(/in progress/);
  });

  it('kicking removes the player; rename keeps names unique', () => {
    const env = makeEnv();
    const room = makeRoom(['host', 'guest'], env);
    applyCommand(room, 'guest', { type: 'room.rename', name: 'Gus' }, env);
    expect(room.players[1]!.name).toBe('Gus');
    expect(() =>
      applyCommand(room, 'guest', { type: 'room.rename', name: 'HOST' }, env),
    ).toThrowError(/nickname/);
    applyCommand(room, 'host', { type: 'room.kick', playerId: 'guest' }, env);
    expect(room.players.map((p) => p.id)).toEqual(['host']);
    expect(() => applyCommand(room, 'guest', cmd.start(), env)).toThrowError(/not in this room/);
  });

  it('is always a lobby/finished → playing → finished state machine', () => {
    const env = makeEnv();
    const room = makeRoom(['a1', 'b2'], env);
    expect(() => applyCommand(room, 'a1', { type: 'game.rematch' }, env)).toThrowError(
      /isn’t finished/,
    );
    applyCommand(room, 'a1', cmd.select('tictactoe'), env);
    applyCommand(room, 'a1', cmd.start(), env);
    expect(room.status).toBe('playing');
    expect(() => applyCommand(room, 'a1', cmd.start(), env)).toThrowError(/already running/);
    expect(() => applyCommand(room, 'a1', cmd.select('impostor'), env)).toThrowError(
      /Finish or end/,
    );
    applyCommand(room, 'a1', { type: 'game.end' }, env);
    expect(room.status).toBe('lobby');
    expect(room.game).toBeNull();
  });

  it('command schema rejects malformed input', () => {
    expect(CommandSchema.safeParse({ type: 'game.select', gameId: 'nope' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'game.start', extra: 1 }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'drop-tables' }).success).toBe(false);
  });
});
