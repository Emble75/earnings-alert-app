import { describe, expect, it } from 'vitest';
import { GameError } from '../shared/games/types';
import { sanitizeClue, type ImpostorState } from '../shared/games/impostor';
import {
  advanceMany,
  advanceTime,
  applyCommand,
  buildRoomView,
  cmd,
  makeEnv,
  makeRoom,
} from './helpers';
import type { Room } from '../shared/room/types';

const state = (room: Room) => room.game!.state as ImpostorState;
const act = (room: Room, who: string, action: unknown, env = makeEnv()) =>
  applyCommand(room, who, cmd.act(action), env);

function startedRoom(names = ['ana', 'ben', 'cy', 'dee'], config: Record<string, unknown> = {}) {
  const env = makeEnv(7);
  const room = makeRoom(names, env);
  applyCommand(room, names[0]!, cmd.select('impostor'), env);
  applyCommand(room, names[0]!, cmd.config({ rounds: 2, clueRounds: 1, ...config }), env);
  applyCommand(room, names[0]!, cmd.start(), env);
  return { room, env };
}

/** everyone confirms their role → clue phase */
function toClues(room: Room, env: ReturnType<typeof makeEnv>) {
  for (const p of room.players) act(room, p.id, { type: 'ready' }, env);
}
function playClues(room: Room, env: ReturnType<typeof makeEnv>, clue = 'left foot') {
  while (state(room).phase === 'clues') {
    const who = state(room).turnOrder[state(room).turnIndex]!;
    act(room, who, { type: 'clue', text: clue }, env);
  }
}

describe('football impostor', () => {
  it('requires at least 3 players', () => {
    const env = makeEnv();
    const room = makeRoom(['a', 'b'], env);
    expect(() => applyCommand(room, 'a', cmd.start(), env)).toThrowError(/at least 3/);
  });

  it('never leaks the footballer to the impostor or the impostor identity to crew', () => {
    const { room, env } = startedRoom();
    const s = state(room);
    const secretName = s.secret.name;
    const impostor = s.secret.impostors[0]!;
    for (const p of room.players) {
      const json = JSON.stringify(buildRoomView(room, p.id, env));
      if (p.id === impostor) {
        expect(json).not.toContain(secretName);
        expect(json).not.toContain(s.secret.footballerId);
        expect(buildRoomView(room, p.id, env).game!.view).toMatchObject({
          you: { role: 'impostor', footballer: null },
        });
      } else {
        expect(json).toContain(secretName);
        // crew must not learn who the impostor is
        expect(JSON.stringify(buildRoomView(room, p.id, env).game)).not.toContain('"impostors":[');
        expect(buildRoomView(room, p.id, env).game!.view).toMatchObject({
          you: { role: 'crew', partners: [] },
        });
      }
    }
  });

  it('plays a full round: reveal → clues → discussion → voting → result → next round → final', () => {
    const { room, env } = startedRoom();
    expect(state(room).phase).toBe('reveal');
    toClues(room, env);
    expect(state(room).phase).toBe('clues');
    playClues(room, env);
    expect(state(room).phase).toBe('discussion');
    expect(state(room).clues).toHaveLength(4);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env); // host skips discussion
    expect(state(room).phase).toBe('voting');

    const impostor = state(room).secret.impostors[0]!;
    for (const p of room.players) {
      const target = p.id === impostor ? room.players.find((q) => q.id !== p.id)!.id : impostor;
      act(room, p.id, { type: 'vote', target }, env);
    }
    expect(state(room).phase).toBe('result');
    const res = state(room).result!;
    expect(res.crewWon).toBe(true);
    expect(res.ejected).toBe(impostor);
    // crew: +2 correct vote +1 team win; caught impostor: 0
    for (const p of room.players) expect(res.deltas[p.id] ?? 0).toBe(p.id === impostor ? 0 : 3);
    // result is now visible to everyone, including who the impostor was
    const v = buildRoomView(room, impostor, env).game!.view as { result: { impostors: string[] } };
    expect(v.result.impostors).toEqual([impostor]);

    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(state(room).round).toBe(2);
    expect(state(room).phase).toBe('reveal');
    expect(state(room).usedFootballers).toHaveLength(2);
    expect(new Set(state(room).usedFootballers).size).toBe(2); // no repeats
  });

  it('scores a surviving impostor and handles ties as no ejection', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy', 'dee']);
    toClues(room, env);
    playClues(room, env);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    const impostor = state(room).secret.impostors[0]!;
    const crew = room.players.map((p) => p.id).filter((p) => p !== impostor);
    // 2–2 tie between two crew members → nobody ejected
    act(room, crew[0]!, { type: 'vote', target: crew[1]! }, env);
    act(room, crew[1]!, { type: 'vote', target: crew[0]! }, env);
    act(room, crew[2]!, { type: 'vote', target: crew[0]! }, env);
    act(room, impostor, { type: 'vote', target: crew[1]! }, env);
    const res = state(room).result!;
    expect(res.ejected).toBeNull();
    expect(res.crewWon).toBe(false);
    // impostor: 3 for surviving + 1 per crew vote on an innocent (all 3)
    expect(res.deltas[impostor]).toBe(6);
  });

  it('enforces turn order, phase, host-only and self-vote rules', () => {
    const { room, env } = startedRoom();
    expect(() => act(room, 'ben', { type: 'clue', text: 'x' }, env)).toThrow(GameError); // not clue phase
    toClues(room, env);
    const first = state(room).turnOrder[0]!;
    const other = room.players.find((p) => p.id !== first)!.id;
    expect(() => act(room, other, { type: 'clue', text: 'wing' }, env)).toThrowError(/turn/);
    expect(() => act(room, first, { type: 'clue', text: '   ' }, env)).toThrow(GameError);
    expect(() => act(room, first, { type: 'bogus' }, env)).toThrowError(/isn’t valid/);
    // non-host cannot skip phases
    expect(() => applyCommand(room, 'ben', cmd.act({ type: 'advance' }), env)).toThrowError(/host/);
    playClues(room, env);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(() => act(room, 'ben', { type: 'vote', target: 'ben' }, env)).toThrowError(/yourself/);
    expect(() => act(room, 'ben', { type: 'vote', target: 'ghost' }, env)).toThrow(GameError);
  });

  it('rejects crew clues containing the name but never checks the impostor', () => {
    const { room, env } = startedRoom();
    toClues(room, env);
    const s = state(room);
    const lastName = s.secret.name.split(' ').pop()!;
    let seenCrew = false;
    let seenImpostor = false;
    while (state(room).phase === 'clues' && !(seenCrew && seenImpostor)) {
      const who = state(room).turnOrder[state(room).turnIndex]!;
      if (state(room).secret.impostors.includes(who)) {
        act(room, who, { type: 'clue', text: lastName }, env); // accepted: impostor can't know
        seenImpostor = true;
      } else if (!seenCrew) {
        expect(() =>
          act(room, who, { type: 'clue', text: lastName.toUpperCase() }, env),
        ).toThrowError(/name/);
        seenCrew = true;
        act(room, who, { type: 'clue', text: 'ok' }, env);
      } else act(room, who, { type: 'clue', text: 'ok' }, env);
    }
    expect(seenCrew && seenImpostor).toBe(true);
  });

  it('sanitises clues', () => {
    expect(sanitizeClue('  <b>Left</b>   foot‮!! ')).toBe('bLeftb foot!!');
    expect(sanitizeClue('x'.repeat(100))).toHaveLength(32);
  });

  it('timers: skipped turns, discussion, voting and result auto-advance', () => {
    const { room, env } = startedRoom(undefined, {
      clueSeconds: 10,
      discussionSeconds: 15,
      voteSeconds: 10,
    });
    advanceTime(room, env, 26_000); // reveal timeout → clues
    expect(state(room).phase).toBe('clues');
    advanceTime(room, env, 10_001);
    expect(state(room).clues).toEqual([expect.objectContaining({ text: null })]);
    advanceMany(room, env, 40_000); // all remaining turns time out → discussion
    expect(state(room).phase).toBe('discussion');
    advanceTime(room, env, 15_001);
    expect(state(room).phase).toBe('voting');
    advanceTime(room, env, 10_001); // nobody voted → no ejection
    expect(state(room).phase).toBe('result');
    expect(state(room).result!.ejected).toBeNull();
    advanceTime(room, env, 41_000);
    expect(state(room).round).toBe(2);
    advanceMany(room, env, 400_000); // idle through round 2
    expect(room.status).toBe('finished');
    expect(state(room).phase).toBe('final');
  });

  it('banks scores into room totals once and supports rematch', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy'], { rounds: 1 });
    toClues(room, env);
    playClues(room, env);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    for (const p of room.players) act(room, p.id, { type: 'vote', target: 'skip' }, env);
    expect(state(room).phase).toBe('result');
    const summary = advanceTime(room, env, 41_000);
    expect(summary).not.toBeNull();
    expect(room.status).toBe('finished');
    const total = Object.values(room.totals).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(advanceTime(room, env, 10_000)).toBeNull(); // not double counted
    expect(Object.values(room.totals).reduce((a, b) => a + b, 0)).toBe(total);
    applyCommand(room, 'ana', { type: 'game.rematch' }, env);
    expect(room.status).toBe('playing');
    expect(state(room).round).toBe(1);
    expect(room.gamesPlayed).toBe(1);
  });

  it('caps impostors to a safe fraction of players', () => {
    const { room } = startedRoom(['a1', 'b2', 'c3'], { impostors: 3 });
    expect(state(room).secret.impostors).toHaveLength(1);
  });

  it('ends cleanly if the impostor leaves mid-game', () => {
    const { room, env } = startedRoom();
    const impostor = state(room).secret.impostors[0]!;
    const host = room.hostId;
    if (impostor === host) return;
    const summary = applyCommand(room, impostor, { type: 'room.leave' }, env);
    expect(summary).not.toBeNull();
    expect(state(room).phase).toBe('final');
    expect(state(room).abortedReason).toMatch(/impostor left/i);
  });

  it('skips a disconnected player’s clue turn quickly', () => {
    const { room, env } = startedRoom(undefined, { clueSeconds: 60 });
    toClues(room, env);
    const gone = state(room).turnOrder[0]!;
    // simulate disconnect via room engine
    const p = room.players.find((x) => x.id === gone)!;
    p.connected = false;
    // sync happens on tick
    advanceTime(room, env, 0);
    expect(state(room).deadline! - env.now).toBeLessThanOrEqual(3000);
    advanceTime(room, env, 3100);
    expect(state(room).turnIndex).toBe(1);
  });
});

describe('impostor with timers switched off', () => {
  it('has no deadlines, never auto-advances, and the host can skip stuck turns / close the vote', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy'], {
      timers: false,
      clueRounds: 1,
      rounds: 1,
    });
    expect(state(room).deadline).toBeNull();
    advanceMany(room, env, 600_000, 5000); // ten minutes pass: nothing may change
    expect(state(room).phase).toBe('reveal');
    toClues(room, env);
    expect(state(room).phase).toBe('clues');
    expect(state(room).deadline).toBeNull();
    advanceMany(room, env, 300_000, 5000);
    expect(state(room).turnIndex).toBe(0);
    // host skips the first (absent) player's clue; the others answer
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(state(room).clues).toEqual([expect.objectContaining({ text: null })]);
    playClues(room, env);
    expect(state(room).phase).toBe('discussion');
    advanceMany(room, env, 600_000, 5000);
    expect(state(room).phase).toBe('discussion'); // waits for the host
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(state(room).phase).toBe('voting');
    expect(state(room).deadline).toBeNull();
    act(room, 'ana', { type: 'vote', target: 'ben' }, env);
    advanceMany(room, env, 600_000, 5000);
    expect(state(room).phase).toBe('voting'); // not everyone has voted, nothing forces it
    expect(() => applyCommand(room, 'ben', cmd.act({ type: 'advance' }), env)).toThrowError(/host/);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env); // host closes the vote
    expect(state(room).phase).toBe('result');
    expect(state(room).deadline).toBeNull();
    advanceMany(room, env, 600_000, 5000);
    expect(state(room).phase).toBe('result'); // waits for the host
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(state(room).phase).toBe('final');
  });

  it('still skips a disconnected player quickly, and not once they are back', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy'], { timers: false, clueRounds: 1 });
    toClues(room, env);
    const gone = state(room).turnOrder[0]!;
    const p = room.players.find((x) => x.id === gone)!;
    p.connected = false;
    advanceTime(room, env, 0);
    expect(state(room).deadline).not.toBeNull();
    p.connected = true; // comes back in time
    advanceTime(room, env, 1000);
    expect(state(room).deadline).toBeNull();
    expect(state(room).turnIndex).toBe(0);
    p.connected = false;
    advanceTime(room, env, 0);
    advanceMany(room, env, 4000, 500);
    expect(state(room).turnIndex).toBe(1);
  });
});

describe('impostor with spoken clues (in-person play)', () => {
  it('rejects typed clues and advances speakers via the host; no clue text is stored', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy'], {
      spoken: true,
      clueRounds: 1,
      rounds: 1,
    });
    toClues(room, env);
    const first = state(room).turnOrder[0]!;
    expect(() => act(room, first, { type: 'clue', text: 'left foot' }, env)).toThrowError(
      /out loud/,
    );
    const view = buildRoomView(room, 'ana', env).game!.view as {
      turnOrder: string[];
      turnIndex: number;
    };
    expect(view.turnOrder).toHaveLength(3);
    for (let i = 0; i < 3; i++) applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    expect(state(room).phase).toBe('discussion');
    expect(state(room).clues).toEqual([]);
  });

  it('still times a speaker out when timers are on, without recording a "ran out of time" clue', () => {
    const { room, env } = startedRoom(['ana', 'ben', 'cy'], {
      spoken: true,
      clueRounds: 1,
      clueSeconds: 10,
    });
    toClues(room, env);
    advanceMany(room, env, 10_500, 500);
    expect(state(room).turnIndex).toBe(1);
    expect(state(room).clues).toEqual([]);
  });
});

describe('impostor group verdict (in-person)', () => {
  const inPerson = () =>
    startedRoom(['ana', 'ben', 'cy', 'dee'], {
      spoken: true,
      timers: false,
      clueRounds: 1,
      rounds: 1,
    });
  const toVerdict = (room: Room, env: ReturnType<typeof makeEnv>) => {
    toClues(room, env);
    for (let i = 0; i < 4; i++) applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env);
    applyCommand(room, 'ana', cmd.act({ type: 'advance' }), env); // discussion → verdict
    expect(state(room).phase).toBe('voting');
    expect(state(room).deadline).toBeNull();
  };

  it('scores the group pick: correct accusation → crew +3, impostor 0', () => {
    const { room, env } = inPerson();
    toVerdict(room, env);
    const impostor = state(room).secret.impostors[0]!;
    applyCommand(room, 'ana', cmd.act({ type: 'accuse', target: impostor }), env);
    const res = state(room).result!;
    expect(state(room).phase).toBe('result');
    expect(res.ejected).toBe(impostor);
    expect(res.crewWon).toBe(true);
    for (const p of room.players) expect(res.deltas[p.id] ?? 0).toBe(p.id === impostor ? 0 : 3);
    expect(state(room).deadline).toBeNull(); // in person: waits for the group
  });

  it('wrong accusation lets the impostor win; "no majority" ejects nobody', () => {
    const a = inPerson();
    toVerdict(a.room, a.env);
    const imp = state(a.room).secret.impostors[0]!;
    const innocent = a.room.players.map((p) => p.id).find((id) => id !== imp)!;
    applyCommand(a.room, 'ana', cmd.act({ type: 'accuse', target: innocent }), a.env);
    expect(state(a.room).result!.crewWon).toBe(false);
    expect(state(a.room).result!.deltas[imp]).toBeGreaterThanOrEqual(3);

    const b = inPerson();
    toVerdict(b.room, b.env);
    applyCommand(b.room, 'ana', cmd.act({ type: 'accuse', target: 'skip' }), b.env);
    expect(state(b.room).result!.ejected).toBeNull();
  });

  it('rejects accusations outside in-person voting, from non-hosts, and for unknown players', () => {
    const online = startedRoom(['ana', 'ben', 'cy']);
    toClues(online.room, online.env);
    expect(() =>
      applyCommand(online.room, 'ana', cmd.act({ type: 'accuse', target: 'ben' }), online.env),
    ).toThrowError(/no group verdict/i);
    const { room, env } = inPerson();
    toVerdict(room, env);
    expect(() =>
      applyCommand(room, 'ben', cmd.act({ type: 'accuse', target: 'cy' }), env),
    ).toThrowError(/host/);
    expect(() =>
      applyCommand(room, 'ana', cmd.act({ type: 'accuse', target: 'ghost' }), env),
    ).toThrow(GameError);
  });

  it('waits for every card to be seen: no auto-start of the round', () => {
    const { room, env } = inPerson();
    expect(state(room).deadline).toBeNull();
    advanceMany(room, env, 600_000, 5000);
    expect(state(room).phase).toBe('reveal');
  });
});
