import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FootballIndex } from '@shared/football';
import type { GameId } from '@shared/games/types';
import type { ImpostorState } from '@shared/games/impostor';
import type { TttState } from '@shared/games/tictactoe';
import { chooseBotMove } from '@shared/games/bot';
import { getGame } from '@shared/games/registry';
import {
  addPlayer,
  applyCommand,
  buildRoomView,
  createRoom,
  tickRoom,
  type RoomEnv,
} from '@shared/room/room';
import type { Command, Room, RoomView } from '@shared/room/types';
import { randomRng } from '@shared/util/rng';
import type { RoomController } from './room-controller';

let indexPromise: Promise<FootballIndex> | null = null;
/**
 * Football data for the one-phone party mode: the server's active dataset when reachable (so it
 * plays on the same real data as online rooms), otherwise the bundled sample set (offline).
 * Code-split: only party mode pays for it.
 */
export function loadPartyIndex() {
  indexPromise ??= (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch('/api/dataset', { signal: ctrl.signal }).finally(() =>
        clearTimeout(t),
      );
      if (res.ok) {
        // Same-origin, server-produced, compact tuples: expand directly (schema validation already ran server-side).
        const { expandDataset } = await import('@shared/football/wire');
        return new FootballIndex(expandDataset(await res.json()));
      }
    } catch {
      /* offline or server unavailable: fall through to the bundled sample */
    }
    const m = await import('../../data/sample/sample');
    return new FootballIndex(m.sampleDataset);
  })();
  return indexPromise;
}

export type LocalSetup =
  | {
      game: 'tictactoe';
      opponent: 'bot' | 'friend';
      names: string[];
      config: Record<string, unknown>;
    }
  | {
      game: 'impostor' | 'linkup' | 'career' | 'oddone' | 'whoareya';
      names: string[];
      config: Record<string, unknown>;
    };

export interface LocalRoom {
  controller: RoomController | null;
  error: string | null;
  /** Pass-and-play: the player who should be holding the device right now. */
  actingId: string | null;
  names: Record<string, string>;
  restart: () => void;
}

const BOT_ID = 'bot';

function actingPlayer(room: Room, setup: LocalSetup): string {
  const hostId = room.hostId;
  const game = room.game;
  if (!game || room.status !== 'playing') return hostId;
  if (setup.game === 'tictactoe') {
    const s = game.state as TttState;
    if (setup.opponent === 'bot') return 'p0';
    const side = (s.firstSide + s.turn) % 2;
    return s.phase === 'playing'
      ? s.teams[side as 0 | 1][Math.floor(s.turn / 2) % s.teams[side as 0 | 1].length]!
      : hostId;
  }
  if (setup.game === 'linkup' || setup.game === 'career' || setup.game === 'oddone') return hostId; // all actions are the host's
  if (setup.game === 'whoareya') {
    const w = game.state as { phase: string; order: string[]; turn: number };
    return w.phase === 'playing' ? (w.order[w.turn] ?? hostId) : hostId;
  }
  const s = game.state as ImpostorState;
  if (s.phase === 'reveal') return s.participants.find((p) => !s.ready.includes(p)) ?? hostId;
  if (s.phase === 'clues') return s.turnOrder[s.turnIndex] ?? hostId;
  if (s.phase === 'voting') return s.participants.find((p) => s.votes[p] === undefined) ?? hostId;
  return hostId;
}

/** Runs the shared room engine entirely in the browser: offline practice and pass-and-play. */
export function useLocalRoom(setup: LocalSetup | null): LocalRoom {
  const [football, setFootball] = useState<FootballIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const roomRef = useRef<Room | null>(null);
  // Game clock = wall clock minus time spent paused (ad breaks), so timers don't run during an ad.
  const skew = useRef(0);
  const paused = useRef(false);
  const rng = useMemo(() => randomRng(), []);
  const setupKey = setup ? JSON.stringify(setup) : '';

  useEffect(() => {
    let alive = true;
    loadPartyIndex().then(
      (i) => alive && setFootball(i),
      () => alive && setError('Could not load the practice data.'),
    );
    return () => {
      alive = false;
    };
  }, []);

  const env = useCallback(
    (): RoomEnv => ({ now: Date.now() - skew.current, rng, football: football! }),
    [football, rng],
  );

  // (Re)create the room whenever the setup changes.
  useEffect(() => {
    if (!setup || !football) return;
    try {
      const e = env();
      const ids = setup.names.map((_, i) => `p${i}`);
      const mk = (id: string, name: string) => ({
        id,
        name,
        connected: true,
        joinedAt: e.now,
        profileId: null,
      });
      const room = createRoom('LOCAL', mk(ids[0]!, setup.names[0]!), e);
      ids.slice(1).forEach((id, i) => addPlayer(room, mk(id, setup.names[i + 1]!), e));
      if (setup.game === 'tictactoe' && setup.opponent === 'bot')
        addPlayer(room, mk(BOT_ID, 'Computer'), e);
      applyCommand(room, ids[0]!, { type: 'game.select', gameId: setup.game }, e);
      applyCommand(room, ids[0]!, { type: 'game.config', config: setup.config }, e);
      applyCommand(room, ids[0]!, { type: 'game.start' }, e);
      roomRef.current = room;
      setError(null);
      bump((n) => n + 1);
    } catch (err) {
      roomRef.current = null;
      setError(err instanceof Error ? err.message : 'Could not start the practice game.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupKey, football, epoch]);

  // Timers + the bot's turn.
  useEffect(() => {
    if (!setup || !football) return;
    const id = setInterval(() => {
      const room = roomRef.current;
      if (!room || paused.current) return;
      const before = room.version;
      tickRoom(room, env());
      if (room.version !== before) bump((n) => n + 1);
    }, 250);
    return () => clearInterval(id);
  }, [setupKey, football, env, setup]);

  const room = roomRef.current;
  useEffect(() => {
    if (!setup || setup.game !== 'tictactoe' || setup.opponent !== 'bot' || !room || !football)
      return;
    if (room.status !== 'playing' || !room.game || paused.current) return;
    const s = room.game.state as TttState;
    if (s.phase !== 'playing') return;
    const side = (s.firstSide + s.turn) % 2;
    const who = s.teams[side as 0 | 1][Math.floor(s.turn / 2) % s.teams[side as 0 | 1].length]!;
    if (who !== BOT_ID) return;
    const t = setTimeout(
      () => {
        const r = roomRef.current;
        if (!r?.game || r.status !== 'playing') return;
        const st = r.game.state as TttState;
        const move = chooseBotMove(st, side as 0 | 1, football, rng);
        try {
          if (move)
            applyCommand(
              r,
              BOT_ID,
              { type: 'game.action', action: { type: 'guess', ...move } },
              env(),
            );
          else tickRoom(r, { ...env(), now: st.deadline ?? Date.now() });
        } catch {
          tickRoom(r, { ...env(), now: (st.deadline ?? Date.now()) + 1 });
        }
        bump((n) => n + 1);
      },
      1100 + Math.random() * 900,
    );
    return () => clearTimeout(t);
  });

  const send = useCallback(
    async (cmd: Command) => {
      const r = roomRef.current;
      if (!r || !setup) return;
      // Moves belong to whoever holds the device; room-level commands (start, rematch, end) to the host.
      // Host-only game actions (skip a turn, close a vote…) are performed by the host, not by whoever holds the phone.
      const g = r.game ? getGame(r.game.id) : undefined;
      const parsed = cmd.type === 'game.action' ? g?.actionSchema.safeParse(cmd.action) : undefined;
      const hostAction = !!(parsed?.success && g?.hostOnly?.(parsed.data));
      const actor = cmd.type === 'game.action' && !hostAction ? actingPlayer(r, setup) : r.hostId;
      try {
        applyCommand(r, actor, cmd, env());
      } finally {
        bump((n) => n + 1);
      }
    },
    [env, setup],
  );

  const pauseWhile = useCallback(async (p: Promise<unknown>) => {
    const start = Date.now();
    paused.current = true;
    try {
      await p;
    } finally {
      skew.current += Date.now() - start;
      paused.current = false;
      bump((n) => n + 1);
    }
  }, []);

  const names = Object.fromEntries((room?.players ?? []).map((p) => [p.id, p.name]));
  const actingId = room && setup ? actingPlayer(room, setup) : null;
  const searchPlayers = useCallback(
    async (q: string) => football?.searchPlayers(q, 8) ?? [],
    [football],
  );

  const view: RoomView | null =
    room && football && actingId ? buildRoomView(room, actingId, env()) : null;
  const controller: RoomController | null = view
    ? {
        mode: 'local',
        view,
        clockOffset: -skew.current,
        send,
        searchPlayers,
        actingAs: actingId ?? undefined,
        pauseWhile,
      }
    : null;

  return { controller, error, actingId, names, restart: () => setEpoch((n) => n + 1) };
}

export type { GameId };
