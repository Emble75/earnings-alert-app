import { normalizeText } from './normalize';

/**
 * Clubs a casual fan is likely to recognise. This is NOT football data and asserts no facts about
 * players or seasons — it only steers Easy/Medium grid generation away from obscure clubs when the
 * dataset has no popularity signal of its own (e.g. StatsBomb Open Data). Matching is by normalized
 * name; unknown names simply don't match. Extend freely.
 */
const NAMES = [
  'Barcelona',
  'FC Barcelona',
  'Real Madrid',
  'Atletico Madrid',
  'Sevilla',
  'Valencia',
  'Villarreal',
  'Athletic Club',
  'Athletic Bilbao',
  'Real Sociedad',
  'Real Betis',
  'Manchester United',
  'Manchester City',
  'Liverpool',
  'Chelsea',
  'Arsenal',
  'Tottenham Hotspur',
  'Leicester City',
  'Everton',
  'Newcastle United',
  'West Ham United',
  'Aston Villa',
  'Bayern Munich',
  'Borussia Dortmund',
  'Bayer Leverkusen',
  'Schalke 04',
  'RB Leipzig',
  'Juventus',
  'Inter Milan',
  'Inter',
  'AC Milan',
  'Milan',
  'Napoli',
  'AS Roma',
  'Roma',
  'Lazio',
  'Fiorentina',
  'Paris Saint-Germain',
  'Paris Saint Germain',
  'Marseille',
  'Olympique de Marseille',
  'Lyon',
  'Olympique Lyonnais',
  'AS Monaco',
  'Monaco',
  'Ajax',
  'PSV Eindhoven',
  'Benfica',
  'FC Porto',
  'Porto',
  'Sporting CP',
  'Celtic',
  'Rangers',
];
const SET = new Set(NAMES.map(normalizeText));

export const isProminentClub = (name: string) => SET.has(normalizeText(name));
