import type { ComponentType } from 'react';
import { Grid3x3, Link2, Route, ScanSearch, UserSearch, VenetianMask } from 'lucide-react';
import type { GameId } from '@shared/games/types';

/** Static, dependency-light game descriptions (safe for the landing page bundle). */
export interface GameMeta {
  id: GameId;
  title: string;
  kicker: string;
  tagline: string;
  blurb: string;
  players: string;
  length: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  rules: string[];
}

export const gameMeta: Record<GameId, GameMeta> = {
  impostor: {
    id: 'impostor',
    title: 'Football Impostor',
    kicker: 'Social deduction',
    tagline: 'Everyone knows the footballer. One of you doesn’t.',
    blurb:
      'Crew members all see the same footballer. The impostor sees nothing. Take turns dropping clues, argue it out, then vote the faker off.',
    players: '3–12 players',
    length: '10–20 min',
    icon: VenetianMask,
    rules: [
      'Everyone privately sees a role. Crew see the footballer’s name; the impostor sees only an optional hint.',
      'Take turns giving a one-word or short-phrase clue. Never say the name.',
      'Discuss, then vote. The most-voted player is ejected — ties eject nobody.',
      'Scoring: crew +2 for voting an impostor, +1 more if the crew win the round. Impostors score +3 for surviving, +1 for each innocent accused.',
    ],
  },
  tictactoe: {
    id: 'tictactoe',
    title: 'Football Tic-Tac-Toe',
    kicker: 'Knowledge duel',
    tagline: 'Name a footballer who fits the row and the column.',
    blurb:
      'Every row and column is a club, nation or league. Claim a square by naming a player who matches both — the server checks every answer against dated records.',
    players: '2–8 players',
    length: '5–15 min',
    icon: Grid3x3,
    rules: [
      'Players split into X and O and take turns. Tap a square, then search for a footballer.',
      'A valid answer matches both the row and the column. Wrong answers lose your turn.',
      'A footballer can be used once per round. Three in a line wins the round.',
      'Only confirmed records count. League squares need dated club spells that overlap the club’s time in that league.',
      'Scoring: +1 per claimed square, +3 for each member of the winning side, +1 each for a draw.',
    ],
  },
  linkup: {
    id: 'linkup',
    title: 'Link-Up',
    kicker: 'Quick fire',
    tagline: 'Two badges. Name a footballer who played for both.',
    blurb:
      'Two clubs, nations or leagues appear. Be the first to name a footballer who fits both — shout it out in person, or search and submit online.',
    players: '1–12 players',
    length: '3–8 min',
    icon: Link2,
    rules: [
      'Two badges appear. Name any footballer who played for both.',
      'In person: say it out loud, the host taps who got it. Online: search a footballer — the first correct answer wins the round.',
      'Online you get 3 wrong guesses per round.',
      'Every answer is checked against confirmed records.',
    ],
  },
  career: {
    id: 'career',
    title: 'Career Path',
    kicker: 'Quick fire',
    tagline: 'The clubs, in order. Who is it?',
    blurb:
      'A famous footballer’s clubs appear, oldest first. Guess who it is before anyone else does.',
    players: '1–12 players',
    length: '3–8 min',
    icon: Route,
    rules: [
      'You see the clubs a famous footballer played for, oldest first.',
      'In person: shout your guess, the host reveals and taps who got it. Online: search and submit — first correct wins.',
      'Only well-known footballers are used.',
    ],
  },
  oddone: {
    id: 'oddone',
    title: 'Odd One Out',
    kicker: 'Quick fire',
    tagline: 'Three played for the club. One didn’t. Spot him.',
    blurb: 'Four footballers, one club. Three of them played there — find the one who never did.',
    players: '1–12 players',
    length: '3–8 min',
    icon: ScanSearch,
    rules: [
      'You see a club and four footballers. Three played for the club; one never did.',
      'In person: say your pick, the host reveals and taps who got it. Online: tap a name — the first correct pick wins; a wrong pick locks you out of that round.',
    ],
  },
  whoareya: {
    id: 'whoareya',
    title: 'Who Are Ya?',
    kicker: 'Guessing game',
    tagline: 'Guess the hidden footballer from the clues.',
    blurb:
      'A famous footballer is hidden. Take turns guessing — each guess tells you how close it is: nation, position, birth year and clubs in common.',
    players: '1–8 players',
    length: '5–15 min',
    icon: UserSearch,
    rules: [
      'Take turns naming a footballer. Green means it matches the hidden player.',
      'Born: the arrow points toward the hidden player’s birth year.',
      'Shared clubs show where your guess and the hidden player both played.',
      'Fewer guesses means more points for whoever solves it.',
    ],
  },
};

export const gameMetaList = Object.values(gameMeta);
