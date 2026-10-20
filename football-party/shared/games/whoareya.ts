import { z } from 'zod';
import type { PlayerCard } from '../football';
import { GameError, type GameContext, type GameModule } from './types';

/**
 * "Who Are Ya?": a famous footballer is hidden. Players take turns guessing; every guess shows how it
 * compares (nation, position, birth year, shared clubs). Fewer guesses = more points.
 */
export const WhoAreYaConfigSchema = z.object({
  timers: z.boolean().default(false),
  seconds: z.number().int().min(10).max(180).default(45),
  rounds: z.number().int().min(1).max(15).default(5),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('easy'),
  maxGuesses: z.number().int().min(4).max(12).default(8),
});
export type WhoAreYaConfig = z.infer<typeof WhoAreYaConfigSchema>;

export const WhoAreYaActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('guess'), playerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('giveup') }),
]);
export type WhoAreYaAction = z.infer<typeof WhoAreYaActionSchema>;

export type Hit = 'match' | 'miss' | 'unknown';
export interface GuessRow {
  by: string;
  player: PlayerCard;
  nation: { label: string | null; hit: Hit };
  position: { label: string | null; hit: Hit };
  born: { year: number | null; hit: 'match' | 'older' | 'younger' | 'unknown' };
  sharedClubs: string[];
  correct: boolean;
}

export interface WhoAreYaState {
  config: WhoAreYaConfig;
  round: number;
  phase: 'playing' | 'reveal' | 'final';
  order: string[];
  turn: number;
  deadline: number | null;
  target: string;
  guesses: GuessRow[];
  solvedBy: string | null;
  used: string[];
  scores: Record<string, number>;
}

export interface WhoAreYaView {
  phase: WhoAreYaState['phase'];
  round: number;
  totalRounds: number;
  turnPlayerId: string | null;
  deadline: number | null;
  guesses: GuessRow[];
  maxGuesses: number;
  solvedBy: string | null;
  reveal: PlayerCard | null;
  scores: Record<string, number>;
  config: WhoAreYaConfig;
}

const dl = (s: WhoAreYaState, ctx: GameContext) =>
  s.config.timers ? ctx.now + s.config.seconds * 1000 : null;

function startRound(prev: WhoAreYaState, ctx: GameContext): WhoAreYaState {
  const s = structuredClone(prev);
  const pool = ctx.football
    .impostorPool('all', s.config.difficulty)
    .filter((p) => !s.used.includes(p.id) && ctx.football.nationOf(p.id));
  const pick = pool.length ? pool[Math.floor(ctx.rng() * pool.length)]! : null;
  if (!pick) {
    if (s.round === 0)
      throw new GameError(
        'insufficient-data',
        'Not enough well-known footballers in the data yet.',
      );
    s.phase = 'final';
    s.deadline = null;
    return s;
  }
  s.round += 1;
  s.phase = 'playing';
  s.target = pick.id;
  s.used.push(pick.id);
  s.guesses = [];
  s.solvedBy = null;
  s.turn = (s.round - 1) % s.order.length; // the first guesser rotates
  s.deadline = dl(s, ctx);
  return s;
}

function compare(target: string, guess: string, by: string, ctx: GameContext): GuessRow {
  const f = ctx.football;
  const t = f.getPlayer(target)!;
  const g = f.getPlayer(guess)!;
  const tn = f.nationOf(target);
  const gn = f.nationOf(guess);
  const tClubs = new Map(f.careerOf(target).map((c) => [c.id, c.label]));
  const shared = f
    .careerOf(guess)
    .filter((c) => tClubs.has(c.id))
    .map((c) => c.label);
  const born: GuessRow['born']['hit'] =
    t.birthYear === null || g.birthYear === null
      ? 'unknown'
      : t.birthYear === g.birthYear
        ? 'match'
        : t.birthYear > g.birthYear
          ? 'younger'
          : 'older';
  return {
    by,
    player: f.card(guess)!,
    nation: {
      label: gn?.label ?? null,
      hit: !tn || !gn ? 'unknown' : tn.id === gn.id ? 'match' : 'miss',
    },
    position: {
      label: g.position,
      hit: !t.position || !g.position ? 'unknown' : t.position === g.position ? 'match' : 'miss',
    },
    born: { year: g.birthYear, hit: born },
    sharedClubs: shared.slice(0, 5),
    correct:
      guess === target ||
      (!!f.card(target) && f.card(target)!.name === g.name && t.birthYear === g.birthYear),
  };
}

function settle(state: WhoAreYaState, ctx: GameContext): WhoAreYaState {
  let s = state;
  if (s.phase === 'playing' && s.deadline !== null && s.deadline <= ctx.now) {
    s = structuredClone(s);
    s.turn = (s.turn + 1) % s.order.length;
    s.deadline = dl(s, ctx);
  }
  return s;
}

export const whoAreYaGame: GameModule<WhoAreYaConfig, WhoAreYaState, WhoAreYaAction, WhoAreYaView> =
  {
    id: 'whoareya',
    title: 'Who Are Ya?',
    tagline: 'Guess the hidden footballer. Every guess shows how close you are.',
    minPlayers: 1,
    maxPlayers: 8,
    defaultConfig: WhoAreYaConfigSchema.parse({}),
    configSchema: WhoAreYaConfigSchema,
    actionSchema: WhoAreYaActionSchema,

    start(ctx, config) {
      const order = ctx.players.map((p) => p.id);
      const blank: WhoAreYaState = {
        config,
        round: 0,
        phase: 'playing',
        order,
        turn: 0,
        deadline: null,
        target: '',
        guesses: [],
        solvedBy: null,
        used: [],
        scores: Object.fromEntries(order.map((id) => [id, 0])),
      };
      return startRound(blank, ctx);
    },

    reduce(state, action, actorId, ctx) {
      const s = settle(state, ctx);
      if (action.type === 'next') {
        if (s.phase !== 'reveal') throw new GameError('wrong-phase', 'Nothing to skip.');
        return s.round >= s.config.rounds
          ? { ...s, phase: 'final', deadline: null }
          : startRound(s, ctx);
      }
      if (s.phase !== 'playing') throw new GameError('wrong-phase', 'This round is over.');
      if (action.type === 'giveup') return { ...s, phase: 'reveal', deadline: null };
      if (s.order[s.turn] !== actorId) throw new GameError('not-your-turn', 'It’s not your turn.');
      const card = ctx.football.card(action.playerId);
      if (!card) throw new GameError('unknown-player', 'Unknown footballer — pick from the list.');
      if (s.guesses.some((g) => g.player.id === card.id))
        throw new GameError('duplicate', `${card.name} was already guessed.`);
      const next = structuredClone(s);
      const row = compare(s.target, card.id, actorId, ctx);
      next.guesses.push(row);
      if (row.correct) {
        next.solvedBy = actorId;
        next.scores[actorId] =
          (next.scores[actorId] ?? 0) +
          Math.max(1, next.config.maxGuesses + 1 - next.guesses.length);
        next.phase = 'reveal';
        next.deadline = null;
        return next;
      }
      if (next.guesses.length >= next.config.maxGuesses) {
        next.phase = 'reveal';
        next.deadline = null;
        return next;
      }
      next.turn = (next.turn + 1) % next.order.length;
      next.deadline = dl(next, ctx);
      return next;
    },

    hostOnly: (a) => a.type === 'next' || a.type === 'giveup',
    tick: (s, ctx) => settle(s, ctx),
    sync: (s, ctx) => settle(s, ctx),
    deadline: (s) => s.deadline,

    view(s, _viewer, ctx): WhoAreYaView {
      return {
        phase: s.phase,
        round: s.round,
        totalRounds: s.config.rounds,
        turnPlayerId: s.phase === 'playing' ? (s.order[s.turn] ?? null) : null,
        deadline: s.deadline,
        guesses: s.guesses,
        maxGuesses: s.config.maxGuesses,
        solvedBy: s.solvedBy,
        reveal: s.phase === 'playing' ? null : ctx.football.card(s.target),
        scores: s.scores,
        config: s.config,
      };
    },

    scores: (s) => s.scores,
    isOver: (s) => s.phase === 'final',
    playerLeft(state, playerId) {
      const s = structuredClone(state);
      const idx = s.order.indexOf(playerId);
      if (idx < 0) return s;
      s.order.splice(idx, 1);
      if (s.order.length === 0) return { ...s, phase: 'final', deadline: null };
      if (s.turn > idx) s.turn -= 1;
      s.turn %= s.order.length;
      return s;
    },
  };
