import { z } from 'zod';
import type { Criterion, PlayerCard } from '../football';
import { normalizeText } from '../football/normalize';
import { GameError, type GameContext, type GameId, type GameModule } from './types';

/**
 * Two quick football games on one engine:
 *  - linkup: two badges (clubs / a nation / a league) — name a footballer who fits both.
 *  - career: a footballer's clubs in order — who is it?
 * In person (`spoken`) players shout the answer; the phone shows the prompt, reveals the answer and
 * the host taps who got it. Online, players search and submit; the first correct answer wins the round.
 */
export const QuickConfigSchema = z.object({
  timers: z.boolean().default(true),
  seconds: z.number().int().min(5).max(120).default(20),
  rounds: z.number().int().min(3).max(30).default(10),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('easy'),
  spoken: z.boolean().default(false),
});
export type QuickConfig = z.infer<typeof QuickConfigSchema>;

export const QuickActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('guess'), playerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal('reveal') }), // host: give up on this round
  z.object({ type: z.literal('award'), to: z.string().min(1).max(64).nullable() }), // in person: who got it
  z.object({ type: z.literal('next') }), // host: leave the answer screen
]);
export type QuickAction = z.infer<typeof QuickActionSchema>;

export interface ClubTile {
  label: string;
  short: string;
  color: string;
}
export type QuickPrompt =
  | { kind: 'linkup'; a: Criterion; b: Criterion }
  | { kind: 'career'; clubs: ClubTile[]; position: string | null };

export interface QuickEvent {
  seq: number;
  kind: 'correct' | 'wrong' | 'timeout' | 'locked';
  by: string | null;
  message: string;
}

export interface QuickState {
  kind: 'linkup' | 'career';
  config: QuickConfig;
  round: number;
  phase: 'playing' | 'reveal' | 'final';
  deadline: number | null;
  prompt: QuickPrompt;
  /** Career: the hidden footballer. Link-Up: unused. */
  target: string | null;
  /** Link-Up: shared answers, best-known first (revealed after the round). */
  answers: string[];
  winner: string | null;
  wrong: Record<string, number>;
  used: string[];
  event: QuickEvent | null;
  eventSeq: number;
  scores: Record<string, number>;
}

export interface QuickView {
  kind: QuickState['kind'];
  phase: QuickState['phase'];
  round: number;
  totalRounds: number;
  deadline: number | null;
  prompt: QuickPrompt;
  winner: string | null;
  /** Revealed only after the round: the footballer (career) or some valid answers (link-up). */
  reveal: PlayerCard[] | null;
  event: QuickEvent | null;
  scores: Record<string, number>;
  /** Players who used up their guesses this round. */
  out: string[];
  config: QuickConfig;
}

const MAX_WRONG = 3;
const REVEAL_MS = 6000;
const fameOf = (ctx: GameContext, id: string) => ctx.football.fameOf(id);

function startRound(prev: QuickState, ctx: GameContext): QuickState {
  const s = structuredClone(prev);
  s.round += 1;
  s.phase = 'playing';
  s.winner = null;
  s.wrong = {};
  s.event = null;
  s.deadline = s.config.timers ? ctx.now + s.config.seconds * 1000 : null;
  if (s.kind === 'linkup') {
    const pair = ctx.football.generatePair(ctx.rng, s.config.difficulty, new Set(s.used));
    if (!pair) {
      if (s.round === 1)
        throw new GameError(
          'insufficient-data',
          'The football data can’t support this game at this difficulty yet.',
        );
      s.round -= 1;
      s.phase = 'final';
      s.deadline = null;
      return s;
    }
    s.used.push(`${pair.a.type}:${pair.a.id}|${pair.b.type}:${pair.b.id}`);
    s.prompt = { kind: 'linkup', a: pair.a, b: pair.b };
    s.answers = [...pair.answers].sort((x, y) => fameOf(ctx, y) - fameOf(ctx, x));
    s.target = null;
    return s;
  }
  const minClubs = { easy: 3, medium: 3, hard: 4 }[s.config.difficulty];
  const pool = ctx.football
    .impostorPool('all', s.config.difficulty)
    .filter((p) => !s.used.includes(p.id) && ctx.football.careerOf(p.id).length >= minClubs);
  const pick = pool.length ? pool[Math.floor(ctx.rng() * pool.length)]! : null;
  if (!pick) {
    if (s.round === 1)
      throw new GameError(
        'insufficient-data',
        'Not enough well-known footballers with a clear career in the data yet.',
      );
    s.round -= 1;
    s.phase = 'final';
    s.deadline = null;
    return s;
  }
  s.used.push(pick.id);
  s.target = pick.id;
  s.answers = [];
  const clubs = ctx.football.careerOf(pick.id).slice(0, 7);
  s.prompt = {
    kind: 'career',
    clubs: clubs.map((c) => ({ label: c.label, short: c.short, color: c.color ?? '#2b3a33' })),
    position: pick.position,
  };
  return s;
}

function toReveal(s: QuickState, ctx: GameContext): QuickState {
  const next = structuredClone(s);
  next.phase = 'reveal';
  // Online results stay visible a few seconds; in person the host decides when to continue.
  next.deadline = !next.config.spoken && next.config.timers ? ctx.now + REVEAL_MS : null;
  return next;
}

function advance(s: QuickState, ctx: GameContext): QuickState {
  if (s.round >= s.config.rounds) return { ...s, phase: 'final', deadline: null };
  return startRound(s, ctx);
}

function push(s: QuickState, e: Omit<QuickEvent, 'seq'>) {
  s.eventSeq += 1;
  s.event = { ...e, seq: s.eventSeq };
}

function settle(state: QuickState, ctx: GameContext): QuickState {
  let s = state;
  if (s.deadline !== null && s.deadline <= ctx.now) {
    if (s.phase === 'playing') {
      s = toReveal(s, ctx);
      push(s, { kind: 'timeout', by: null, message: 'Time’s up!' });
    } else if (s.phase === 'reveal') {
      s = advance(s, ctx);
    }
  }
  return s;
}

const isTarget = (ctx: GameContext, targetId: string, guessId: string) => {
  if (targetId === guessId) return true;
  const t = ctx.football.card(targetId);
  const g = ctx.football.card(guessId);
  return (
    !!t && !!g && normalizeText(t.name) === normalizeText(g.name) && t.birthYear === g.birthYear
  );
};

function makeGame(
  id: GameId,
  kind: QuickState['kind'],
  meta: { title: string; tagline: string; seconds: number },
): GameModule<QuickConfig, QuickState, QuickAction, QuickView> {
  return {
    id,
    title: meta.title,
    tagline: meta.tagline,
    minPlayers: 1,
    maxPlayers: 12,
    defaultConfig: QuickConfigSchema.parse({ seconds: meta.seconds }),
    configSchema: QuickConfigSchema,
    actionSchema: QuickActionSchema,

    start(ctx, config) {
      const blank: QuickState = {
        kind,
        config,
        round: 0,
        phase: 'playing',
        deadline: null,
        prompt: { kind: 'career', clubs: [], position: null },
        target: null,
        answers: [],
        winner: null,
        wrong: {},
        used: [],
        event: null,
        eventSeq: 0,
        scores: Object.fromEntries(ctx.players.map((p) => [p.id, 0])),
      };
      return startRound(blank, ctx);
    },

    reduce(state, action, actorId, ctx) {
      const s = settle(state, ctx);
      switch (action.type) {
        case 'guess': {
          if (s.config.spoken)
            throw new GameError('spoken', 'In person you say the answer out loud.');
          if (s.phase !== 'playing') throw new GameError('wrong-phase', 'This round is over.');
          if ((s.wrong[actorId] ?? 0) >= MAX_WRONG)
            throw new GameError('locked', 'You’re out of guesses this round.');
          const card = ctx.football.card(action.playerId);
          if (!card)
            throw new GameError('unknown-player', 'Unknown footballer — pick from the list.');
          let ok: boolean;
          let why = '';
          if (s.kind === 'linkup' && s.prompt.kind === 'linkup') {
            const v1 = ctx.football.verdict(card.id, s.prompt.a);
            const v2 = ctx.football.verdict(card.id, s.prompt.b);
            ok = v1.ok && v2.ok;
            if (!ok) {
              const failed = !v1.ok ? s.prompt.a : s.prompt.b;
              why = `${card.name} isn’t confirmed for ${failed.label}.`;
            }
          } else {
            ok = !!s.target && isTarget(ctx, s.target, card.id);
            if (!ok) why = `Not ${card.name}.`;
          }
          const next = structuredClone(s);
          if (ok) {
            next.winner = actorId;
            next.scores[actorId] = (next.scores[actorId] ?? 0) + 1;
            const r = toReveal(next, ctx);
            push(r, { kind: 'correct', by: actorId, message: `${card.name} — correct!` });
            return r;
          }
          next.wrong[actorId] = (next.wrong[actorId] ?? 0) + 1;
          const left = MAX_WRONG - next.wrong[actorId]!;
          push(next, {
            kind: left > 0 ? 'wrong' : 'locked',
            by: actorId,
            message:
              left > 0
                ? `${why} ${left} ${left === 1 ? 'guess' : 'guesses'} left.`
                : `${why} You’re out for this round.`,
          });
          return next;
        }
        case 'reveal': {
          if (s.phase !== 'playing') throw new GameError('wrong-phase', 'Already revealed.');
          const r = toReveal(s, ctx);
          push(r, { kind: 'timeout', by: null, message: 'Here’s the answer.' });
          return r;
        }
        case 'award': {
          if (s.phase !== 'reveal') throw new GameError('wrong-phase', 'Reveal the answer first.');
          const next = structuredClone(s);
          if (action.to !== null) {
            if (!ctx.players.some((p) => p.id === action.to))
              throw new GameError('unknown-player', 'Unknown player.');
            next.scores[action.to] = (next.scores[action.to] ?? 0) + 1;
            next.winner = action.to;
          }
          return advance(next, ctx);
        }
        case 'next': {
          if (s.phase !== 'reveal') throw new GameError('wrong-phase', 'Nothing to skip.');
          return advance(s, ctx);
        }
      }
    },

    hostOnly: (a) => a.type !== 'guess',
    tick: (s, ctx) => settle(s, ctx),
    sync: (s, ctx) => settle(s, ctx),
    deadline: (s) => s.deadline,

    view(s, _viewer, ctx): QuickView {
      let reveal: PlayerCard[] | null = null;
      if (s.phase !== 'playing') {
        if (s.kind === 'career' && s.target) {
          const c = ctx.football.card(s.target);
          reveal = c ? [c] : null;
        } else
          reveal = s.answers
            .slice(0, 4)
            .map((i) => ctx.football.card(i))
            .filter((c): c is PlayerCard => !!c);
      }
      return {
        kind: s.kind,
        phase: s.phase,
        round: s.round,
        totalRounds: s.config.rounds,
        deadline: s.deadline,
        prompt: s.prompt,
        winner: s.winner,
        reveal,
        event: s.event,
        scores: s.scores,
        out: Object.entries(s.wrong)
          .filter(([, n]) => n >= MAX_WRONG)
          .map(([p]) => p),
        config: s.config,
      };
    },

    scores: (s) => s.scores,
    isOver: (s) => s.phase === 'final',
    playerLeft: (s) => s,
  };
}

export const linkUpGame = makeGame('linkup', 'linkup', {
  title: 'Link-Up',
  tagline: 'Two badges. Name a footballer who played for both.',
  seconds: 15,
});
export const careerGame = makeGame('career', 'career', {
  title: 'Career Path',
  tagline: 'The clubs, in order. Who is it?',
  seconds: 30,
});
