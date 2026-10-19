import type { ComponentType } from 'react';
import { Grid3x3, VenetianMask } from 'lucide-react';
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
};

export const gameMetaList = Object.values(gameMeta);
