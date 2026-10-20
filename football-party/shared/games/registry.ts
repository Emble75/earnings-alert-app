import { impostorGame } from './impostor';
import { careerGame, linkUpGame } from './quick';
import { ticTacToeGame } from './tictactoe';
import type { AnyGameModule, GameId } from './types';

/**
 * The game registry. To add a game: implement `GameModule`, register it here, add its view type to
 * `GameViews` in shared/room/types.ts and a screen in src/games/registry.tsx.
 */
export const games: Record<GameId, AnyGameModule> = {
  impostor: impostorGame,
  tictactoe: ticTacToeGame,
  linkup: linkUpGame,
  career: careerGame,
};

export const gameList = Object.values(games);

export function getGame(id: string): AnyGameModule | undefined {
  return (games as Record<string, AnyGameModule | undefined>)[id];
}
