import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants';
import type { Rng } from '../util/rng';

export function generateRoomCode(rng: Rng): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++)
    out += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length)];
  return out;
}

export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}
