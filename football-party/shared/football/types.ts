import { z } from 'zod';

/**
 * Normalized football domain model. Every fact carries provenance (`source`) and the dataset
 * carries a generation timestamp, so the UI can state honestly how fresh the data is.
 *
 * Seasons are identified by their START year: 2003 means 2003-04 (1 Jul 2003 – 30 Jun 2004).
 */

export const TeamKind = z.enum(['club', 'national']);
export const CompetitionKind = z.enum(['league', 'cup', 'international']);
/**
 * How precisely an affiliation is dated.
 *  - season:  from/to are season start-years and the player was registered during those seasons.
 *  - year:    the provider only gave calendar years; season mapping is ambiguous.
 *  - unknown: the affiliation is established but no dates are (e.g. national-team caps).
 */
export const Precision = z.enum(['season', 'year', 'unknown']);
/** `unknown` records are kept for transparency but are never used for validation. */
export const FactStatus = z.enum(['confirmed', 'unknown']);
export const PositionGroup = z.enum(['GK', 'DEF', 'MID', 'FWD']);

const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/);

export const TeamSchema = z.object({
  id: idSchema,
  kind: TeamKind,
  name: z.string().min(1).max(80),
  shortName: z.string().min(1).max(24),
  country: z.string().max(60),
  /** Kit colour hint for text-based identity badges (no crests are bundled). */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#2b3a33'),
  aliases: z.array(z.string().max(80)).default([]),
  source: z.string(),
  providerIds: z.record(z.string(), z.string()).default({}),
});

export const CompetitionSchema = z.object({
  id: idSchema,
  kind: CompetitionKind,
  name: z.string().min(1).max(80),
  shortName: z.string().min(1).max(24),
  country: z.string().max(60).optional(),
  aliases: z.array(z.string().max(80)).default([]),
  source: z.string(),
  providerIds: z.record(z.string(), z.string()).default({}),
});

/** A team was part of a competition for season range [fromSeason, toSeason] (null = ongoing). */
export const MembershipSchema = z.object({
  teamId: idSchema,
  competitionId: idSchema,
  fromSeason: z.number().int().min(1850).max(2200),
  toSeason: z.number().int().min(1850).max(2200).nullable(),
  status: FactStatus.default('confirmed'),
  source: z.string(),
});

export const PlayerSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  aliases: z.array(z.string().max(80)).default([]),
  birthYear: z.number().int().min(1850).max(2100).nullable().default(null),
  position: PositionGroup.nullable().default(null),
  /** Fame tier for difficulty: 1 = global star, 2 = well known, 3 = for fans. */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  source: z.string(),
  providerIds: z.record(z.string(), z.string()).default({}),
});

export const AffiliationSchema = z
  .object({
    playerId: idSchema,
    teamId: idSchema,
    fromSeason: z.number().int().nullable(),
    toSeason: z.number().int().nullable(),
    precision: Precision,
    status: FactStatus.default('confirmed'),
    source: z.string(),
  })
  .refine((a) => a.precision === 'unknown' || a.fromSeason !== null, {
    message: 'dated affiliations need fromSeason',
  })
  .refine((a) => a.fromSeason === null || a.toSeason === null || a.toSeason >= a.fromSeason, {
    message: 'toSeason must not precede fromSeason',
  });

export const DatasetMetaSchema = z.object({
  sourceId: z.string(),
  label: z.string(),
  /** `sample` data is hand-curated demo data and must never be presented as live or complete. */
  kind: z.enum(['sample', 'live', 'import']),
  generatedAt: z.string(),
  license: z.string(),
  attribution: z.string(),
  notes: z.string().default(''),
  /** Latest season that is considered "ongoing" for open-ended records. */
  currentSeason: z.number().int(),
});

export const DatasetSchema = z.object({
  meta: DatasetMetaSchema,
  teams: z.array(TeamSchema),
  competitions: z.array(CompetitionSchema),
  memberships: z.array(MembershipSchema),
  players: z.array(PlayerSchema),
  affiliations: z.array(AffiliationSchema),
});

export type Team = z.infer<typeof TeamSchema>;
export type Competition = z.infer<typeof CompetitionSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type FootballPlayer = z.infer<typeof PlayerSchema>;
export type Affiliation = z.infer<typeof AffiliationSchema>;
export type DatasetMeta = z.infer<typeof DatasetMetaSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;
export type PositionGroupT = z.infer<typeof PositionGroup>;

/** A Tic-Tac-Toe row/column requirement. */
export const CriterionSchema = z.object({
  type: z.enum(['club', 'national', 'league']),
  id: z.string(),
  label: z.string(),
  short: z.string(),
  color: z.string().optional(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export type Verdict =
  { ok: true } | { ok: false; reason: 'not-confirmed' | 'unverified-record' | 'unknown-player' };

/** Public player shape sent to clients (search results, answers). */
export interface PlayerCard {
  id: string;
  name: string;
  position: PositionGroupT | null;
  birthYear: number | null;
  /** Short context to disambiguate players with the same name, e.g. "b. 1985 · FWD". */
  hint: string;
}
