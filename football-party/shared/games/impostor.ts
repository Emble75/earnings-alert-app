import { z } from 'zod';
import { IMPOSTOR_CATEGORY_LABELS, type ImpostorCategory } from '../football';
import { normalizeText } from '../football/normalize';
import { shuffle } from '../util/rng';
import { GameError, type GameContext, type GameModule } from './types';

const CATEGORY_KEYS = Object.keys(IMPOSTOR_CATEGORY_LABELS) as [
  ImpostorCategory,
  ...ImpostorCategory[],
];

export const ImpostorConfigSchema = z.object({
  /** Master switch: false = no phase timers at all (phases end when everyone is done or the host skips). */
  timers: z.boolean().default(true),
  /** In-person play: clues are said aloud, so the app only tracks whose turn it is (no typing). */
  spoken: z.boolean().default(false),
  impostors: z.number().int().min(1).max(3).default(1),
  rounds: z.number().int().min(1).max(8).default(3),
  clueRounds: z.number().int().min(1).max(3).default(2),
  clueSeconds: z.number().int().min(10).max(90).default(25),
  discussionSeconds: z.number().int().min(15).max(300).default(60),
  voteSeconds: z.number().int().min(10).max(120).default(30),
  category: z.enum(CATEGORY_KEYS).default('all'),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('easy'), // easy = the 100 most famous footballers
  impostorHint: z.enum(['none', 'position', 'era']).default('position'),
});
export type ImpostorConfig = z.infer<typeof ImpostorConfigSchema>;

export const ImpostorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('clue'), text: z.string().max(80) }),
  z.object({ type: z.literal('vote'), target: z.string().max(64) }), // player id or 'skip'
  z.object({ type: z.literal('advance') }), // host: skip the current waiting phase
  z.object({ type: z.literal('accuse'), target: z.string().max(64) }), // in-person: the group's verdict (player id or 'skip')
]);
export type ImpostorAction = z.infer<typeof ImpostorActionSchema>;

type Phase = 'reveal' | 'clues' | 'discussion' | 'voting' | 'result' | 'final';

interface Clue {
  round: number;
  playerId: string;
  text: string | null; // null = skipped / timed out
}

export interface ImpostorResult {
  footballer: { id: string; name: string };
  impostors: string[];
  tally: Record<string, number>;
  votes: Record<string, string>;
  ejected: string | null;
  crewWon: boolean;
  deltas: Record<string, number>;
}

export interface ImpostorState {
  config: ImpostorConfig;
  round: number;
  phase: Phase;
  deadline: number | null;
  participants: string[];
  /** SERVER-ONLY secret. Never serialised into a view except as allowed in `view()`. */
  secret: {
    footballerId: string;
    name: string;
    position: string | null;
    era: string | null;
    impostors: string[];
  };
  ready: string[];
  clueRound: number;
  turnOrder: string[];
  turnIndex: number;
  clues: Clue[];
  votes: Record<string, string>;
  result: ImpostorResult | null;
  scores: Record<string, number>;
  impostorCounts: Record<string, number>;
  usedFootballers: string[];
  abortedReason: string | null;
}

export interface ImpostorView {
  phase: Phase;
  round: number;
  totalRounds: number;
  clueRound: number;
  clueRounds: number;
  deadline: number | null;
  participants: string[];
  turnPlayerId: string | null;
  /** Speaking order of the current clue lap and the position within it (not secret). */
  turnOrder: string[];
  turnIndex: number;
  clues: Clue[];
  you: {
    role: 'crew' | 'impostor' | null;
    footballer: string | null;
    hint: string | null;
    partners: string[];
    ready: boolean;
    voted: string | null;
  };
  voted: string[];
  /** Who has confirmed their role (not secret). */
  readyIds: string[];
  result: ImpostorResult | null;
  scores: Record<string, number>;
  abortedReason: string | null;
  config: ImpostorConfig;
}

/** Deadline `seconds` from now, or null when timers are switched off. */
const dl = (cfg: { timers: boolean }, ctx: { now: number }, seconds: number) =>
  cfg.timers ? ctx.now + seconds * 1000 : null;

/** In-person play waits for people (everyone must see their card; the group decides when to move on). */
const patient = (cfg: { spoken: boolean }) => cfg.spoken;

const REVEAL_SECONDS = 25;
const RESULT_SECONDS = 40;
const DISCONNECT_SKIP_MS = 3000;
export const IMPOSTOR_MIN_PLAYERS = 3;

export function maxImpostors(players: number) {
  return Math.max(1, Math.floor((players - 1) / 2));
}

function eraOf(birthYear: number | null) {
  return birthYear ? `${Math.floor(birthYear / 10) * 10}s` : null;
}

const POSITION_WORD = {
  GK: 'goalkeeper',
  DEF: 'defender',
  MID: 'midfielder',
  FWD: 'forward',
} as const;

/** Letters/numbers/space and light punctuation only; no markup, no control or bidi characters. */
export function sanitizeClue(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s'’\-.!?&]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

function containsName(clue: string, name: string) {
  const c = normalizeText(clue);
  return normalizeText(name)
    .split(' ')
    .filter((t) => t.length >= 3)
    .some((t) => c.split(' ').includes(t) || c.includes(t));
}

function startRound(
  prev: ImpostorState | null,
  ctx: GameContext,
  config: ImpostorConfig,
  participants: string[],
): ImpostorState {
  const used = prev?.usedFootballers ?? [];
  let pool = ctx.football
    .impostorPool(config.category, config.difficulty)
    .filter((p) => !used.includes(p.id));
  let usedNow = used;
  if (pool.length === 0) {
    pool = ctx.football.impostorPool(config.category, config.difficulty);
    usedNow = [];
  }
  if (pool.length === 0)
    throw new GameError(
      'no-footballers',
      'No footballers match this category and difficulty in the current data. Pick a wider category.',
    );
  const f = pool[Math.floor(ctx.rng() * pool.length)]!;
  const counts = { ...(prev?.impostorCounts ?? {}) };
  const k = Math.min(config.impostors, maxImpostors(participants.length));
  // Prefer people who have been impostor least often; shuffle to break ties.
  const sorted = shuffle(participants, ctx.rng).sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0));
  const impostors = sorted.slice(0, k);
  for (const i of impostors) counts[i] = (counts[i] ?? 0) + 1;
  return {
    config,
    round: (prev?.round ?? 0) + 1,
    phase: 'reveal',
    deadline: patient(config) ? null : dl(config, ctx, REVEAL_SECONDS),
    participants,
    secret: {
      footballerId: f.id,
      name: f.name,
      position: f.position ? POSITION_WORD[f.position] : null,
      era: eraOf(f.birthYear),
      impostors,
    },
    ready: [],
    clueRound: 1,
    turnOrder: [],
    turnIndex: 0,
    clues: [],
    votes: {},
    result: null,
    scores: prev?.scores ?? Object.fromEntries(participants.map((p) => [p, 0])),
    impostorCounts: counts,
    usedFootballers: [...usedNow, f.id],
    abortedReason: null,
  };
}

function beginClues(s: ImpostorState, ctx: GameContext): ImpostorState {
  const order = shuffle(s.participants, ctx.rng);
  return {
    ...s,
    phase: 'clues',
    clueRound: 1,
    turnOrder: order,
    turnIndex: 0,
    deadline: dl(s.config, ctx, s.config.clueSeconds),
  };
}

function advanceTurn(s: ImpostorState, ctx: GameContext): ImpostorState {
  const next = s.turnIndex + 1;
  if (next < s.turnOrder.length)
    return { ...s, turnIndex: next, deadline: dl(s.config, ctx, s.config.clueSeconds) };
  if (s.clueRound < s.config.clueRounds)
    return {
      ...s,
      clueRound: s.clueRound + 1,
      turnOrder: shuffle(s.participants, ctx.rng),
      turnIndex: 0,
      deadline: dl(s.config, ctx, s.config.clueSeconds),
    };
  return { ...s, phase: 'discussion', deadline: dl(s.config, ctx, s.config.discussionSeconds) };
}

function computeResult(s: ImpostorState, ctx: GameContext): ImpostorState {
  const tally: Record<string, number> = {};
  for (const [, target] of Object.entries(s.votes)) {
    if (target !== 'skip') tally[target] = (tally[target] ?? 0) + 1;
  }
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.entries(tally)
    .filter(([, n]) => n === max && max > 0)
    .map(([id]) => id);
  const ejected = top.length === 1 ? top[0]! : null; // ties eject nobody
  const impostors = s.secret.impostors;
  const crewWon = ejected !== null && impostors.includes(ejected);
  const deltas: Record<string, number> = {};
  const add = (id: string, n: number) => (deltas[id] = (deltas[id] ?? 0) + n);
  for (const p of s.participants) {
    if (impostors.includes(p)) {
      if (p !== ejected) {
        add(p, 3);
        // +1 for every crew member who accused an innocent
        for (const [voter, target] of Object.entries(s.votes))
          if (!impostors.includes(voter) && target !== 'skip' && !impostors.includes(target))
            add(p, 1);
      }
    } else {
      const v = s.votes[p];
      if (v && v !== 'skip' && impostors.includes(v)) add(p, 2);
      if (crewWon) add(p, 1);
    }
  }
  const scores = { ...s.scores };
  for (const [id, n] of Object.entries(deltas)) scores[id] = (scores[id] ?? 0) + n;
  return {
    ...s,
    phase: 'result',
    deadline: patient(s.config) ? null : dl(s.config, ctx, RESULT_SECONDS),
    scores,
    result: {
      footballer: { id: s.secret.footballerId, name: s.secret.name },
      impostors,
      tally,
      votes: { ...s.votes },
      ejected,
      crewWon,
      deltas,
    },
  };
}

function nextRound(s: ImpostorState, ctx: GameContext): ImpostorState {
  if (s.round >= s.config.rounds) return { ...s, phase: 'final', deadline: null };
  return startRound(s, ctx, s.config, s.participants);
}

function present(s: ImpostorState, ctx: GameContext) {
  const online = new Set(ctx.players.filter((p) => p.connected).map((p) => p.id));
  return s.participants.filter((p) => online.has(p));
}

function settle(s: ImpostorState, ctx: GameContext): ImpostorState {
  let cur = s;
  for (let i = 0; i < 64; i++) {
    const online = present(cur, ctx);
    if (
      cur.phase === 'reveal' &&
      cur.ready.length > 0 &&
      online.every((p) => cur.ready.includes(p))
    ) {
      cur = beginClues(cur, ctx);
      continue;
    }
    if (cur.phase === 'clues') {
      const turnPlayer = cur.turnOrder[cur.turnIndex]!;
      const gone = !online.includes(turnPlayer);
      if (gone && (cur.deadline === null || cur.deadline > ctx.now + DISCONNECT_SKIP_MS)) {
        cur = { ...cur, deadline: ctx.now + DISCONNECT_SKIP_MS };
      } else if (!gone && !cur.config.timers && cur.deadline !== null) {
        cur = { ...cur, deadline: null }; // came back before being skipped; with timers off the only deadline is the disconnect grace
      }
    }
    if (
      cur.phase === 'voting' &&
      online.length > 0 &&
      online.every((p) => cur.votes[p] !== undefined)
    ) {
      cur = computeResult(cur, ctx);
      continue;
    }
    if (cur.deadline !== null && cur.deadline <= ctx.now) {
      if (cur.phase === 'reveal') cur = beginClues(cur, ctx);
      else if (cur.phase === 'clues') {
        const turnPlayer = cur.turnOrder[cur.turnIndex]!;
        cur = advanceTurn(
          cur.config.spoken
            ? cur
            : {
                ...cur,
                clues: [...cur.clues, { round: cur.clueRound, playerId: turnPlayer, text: null }],
              },
          ctx,
        );
      } else if (cur.phase === 'discussion')
        cur = {
          ...cur,
          phase: 'voting',
          deadline: patient(cur.config) ? null : dl(cur.config, ctx, cur.config.voteSeconds),
        };
      else if (cur.phase === 'voting') cur = computeResult(cur, ctx);
      else if (cur.phase === 'result') cur = nextRound(cur, ctx);
      else break;
      continue;
    }
    break;
  }
  return cur;
}

export const impostorGame: GameModule<ImpostorConfig, ImpostorState, ImpostorAction, ImpostorView> =
  {
    id: 'impostor',
    title: 'Football Impostor',
    tagline: 'Everyone knows the footballer. One of you doesn’t. Find the faker.',
    minPlayers: IMPOSTOR_MIN_PLAYERS,
    maxPlayers: 12,
    defaultConfig: ImpostorConfigSchema.parse({}),
    configSchema: ImpostorConfigSchema,
    actionSchema: ImpostorActionSchema,

    start(ctx, config) {
      if (ctx.players.length < IMPOSTOR_MIN_PLAYERS)
        throw new GameError(
          'not-enough-players',
          `Football Impostor needs at least ${IMPOSTOR_MIN_PLAYERS} players.`,
        );
      const participants = ctx.players.map((p) => p.id);
      return settle(startRound(null, ctx, config, participants), ctx);
    },

    reduce(state, action, actorId, ctx) {
      if (!state.participants.includes(actorId))
        throw new GameError('not-in-game', 'You are not part of this game.');
      const s = structuredClone(state);
      switch (action.type) {
        case 'ready': {
          if (s.phase !== 'reveal')
            throw new GameError('wrong-phase', 'Roles are already revealed.');
          if (!s.ready.includes(actorId)) s.ready.push(actorId);
          return settle(s, ctx);
        }
        case 'clue': {
          if (s.phase !== 'clues') throw new GameError('wrong-phase', 'Not the clue phase.');
          if (s.config.spoken)
            throw new GameError('spoken-clues', 'Clues are said out loud in this game.');
          if (s.turnOrder[s.turnIndex] !== actorId)
            throw new GameError('not-your-turn', 'Wait for your turn.');
          const text = sanitizeClue(action.text);
          if (text.length < 1)
            throw new GameError('invalid-clue', 'Give a short clue (letters and numbers).');
          const isImpostor = s.secret.impostors.includes(actorId);
          // Only crew know the name, so only crew clues are checked — this leaks nothing to the impostor.
          if (!isImpostor && containsName(text, s.secret.name))
            throw new GameError(
              'name-in-clue',
              'Don’t say the footballer’s name — give a clue instead.',
            );
          s.clues.push({ round: s.clueRound, playerId: actorId, text });
          return settle(advanceTurn(s, ctx), ctx);
        }
        case 'vote': {
          if (s.phase !== 'voting') throw new GameError('wrong-phase', 'Voting is not open.');
          if (action.target !== 'skip') {
            if (action.target === actorId)
              throw new GameError('invalid-vote', 'You can’t vote for yourself.');
            if (!s.participants.includes(action.target))
              throw new GameError('invalid-vote', 'Unknown player.');
          }
          s.votes[actorId] = action.target;
          return settle(s, ctx);
        }
        case 'accuse': {
          // In-person verdict: the group points at someone and the phone holder taps them.
          if (!s.config.spoken || s.phase !== 'voting')
            throw new GameError('wrong-phase', 'There is no group verdict to give right now.');
          if (action.target !== 'skip' && !s.participants.includes(action.target))
            throw new GameError('invalid-vote', 'Unknown player.');
          for (const p of s.participants) {
            // Everyone except the accused (and the impostors, who bluff) "voted" for the group's pick.
            s.votes[p] =
              p === action.target || s.secret.impostors.includes(p) ? 'skip' : action.target;
          }
          return settle(computeResult(s, ctx), ctx);
        }
        case 'advance': {
          // Host-only: enforced by the room engine through `hostOnly`.
          if (s.phase === 'discussion') {
            s.phase = 'voting';
            s.deadline = patient(s.config) ? null : dl(s.config, ctx, s.config.voteSeconds);
          } else if (s.phase === 'result') return settle(nextRound(s, ctx), ctx);
          else if (s.phase === 'reveal') return settle(beginClues(s, ctx), ctx);
          else if (s.phase === 'voting')
            return settle(computeResult(s, ctx), ctx); // host closes the vote
          else if (s.phase === 'clues') {
            // Spoken play: "next speaker". Typed play: the host skips an absent/stuck player's clue.
            if (!s.config.spoken)
              s.clues.push({ round: s.clueRound, playerId: s.turnOrder[s.turnIndex]!, text: null });
            return settle(advanceTurn(s, ctx), ctx);
          } else throw new GameError('wrong-phase', 'Nothing to skip right now.');
          return settle(s, ctx);
        }
      }
    },

    hostOnly: (a) => a.type === 'advance' || a.type === 'accuse',
    tick: (state, ctx) => settle(state, ctx),
    sync: (state, ctx) => settle(state, ctx),
    deadline: (s) => s.deadline,

    view(s, viewerId): ImpostorView {
      const isParticipant = s.participants.includes(viewerId);
      const isImpostor = s.secret.impostors.includes(viewerId);
      const revealed = s.phase === 'result' || s.phase === 'final';
      let hint: string | null = null;
      if (isImpostor && s.config.impostorHint === 'position' && s.secret.position)
        hint = `The footballer is a ${s.secret.position}.`;
      if (isImpostor && s.config.impostorHint === 'era' && s.secret.era)
        hint = `The footballer was born in the ${s.secret.era}.`;
      return {
        phase: s.phase,
        round: s.round,
        totalRounds: s.config.rounds,
        clueRound: s.clueRound,
        clueRounds: s.config.clueRounds,
        deadline: s.deadline,
        participants: s.participants,
        turnPlayerId: s.phase === 'clues' ? (s.turnOrder[s.turnIndex] ?? null) : null,
        turnOrder: s.phase === 'clues' ? s.turnOrder : [],
        turnIndex: s.turnIndex,
        clues: s.clues,
        you: {
          role: !isParticipant ? null : isImpostor ? 'impostor' : 'crew',
          // The name goes ONLY to crew members; impostors get nothing but the optional hint.
          footballer: isParticipant && !isImpostor ? s.secret.name : null,
          hint,
          partners: isImpostor ? s.secret.impostors.filter((i) => i !== viewerId) : [],
          ready: s.ready.includes(viewerId),
          voted: s.votes[viewerId] ?? null,
        },
        voted: Object.keys(s.votes),
        readyIds: s.ready,
        result: revealed ? s.result : null,
        scores: s.scores,
        abortedReason: s.abortedReason,
        config: s.config,
      };
    },

    scores: (s) => s.scores,
    isOver: (s) => s.phase === 'final',

    playerLeft(state, playerId, ctx) {
      if (!state.participants.includes(playerId)) return state;
      const s = structuredClone(state);
      s.participants = s.participants.filter((p) => p !== playerId);
      s.turnOrder = s.turnOrder.filter((p) => p !== playerId);
      delete s.votes[playerId];
      s.ready = s.ready.filter((p) => p !== playerId);
      if (s.turnIndex >= s.turnOrder.length) s.turnIndex = Math.max(0, s.turnOrder.length - 1);
      const impostorsLeft = s.secret.impostors.filter((i) => i !== playerId);
      if (s.participants.length < IMPOSTOR_MIN_PLAYERS || impostorsLeft.length === 0) {
        s.phase = 'final';
        s.deadline = null;
        s.abortedReason =
          impostorsLeft.length === 0
            ? 'The impostor left the match.'
            : 'Not enough players left to continue.';
        return s;
      }
      s.secret.impostors = impostorsLeft;
      return settle(s, ctx);
    },
  };
