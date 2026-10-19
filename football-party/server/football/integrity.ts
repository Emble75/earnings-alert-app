import type { Dataset } from '../../shared/football/types';

/** Referential and logical checks beyond the zod schema. Returns human-readable problems. */
export function checkDatasetIntegrity(ds: Dataset): string[] {
  const problems: string[] = [];
  const teamIds = new Set<string>();
  const compIds = new Set<string>();
  const playerIds = new Set<string>();
  for (const t of ds.teams) {
    if (teamIds.has(t.id)) problems.push(`duplicate team id ${t.id}`);
    teamIds.add(t.id);
  }
  for (const c of ds.competitions) {
    if (compIds.has(c.id)) problems.push(`duplicate competition id ${c.id}`);
    compIds.add(c.id);
  }
  for (const p of ds.players) {
    if (playerIds.has(p.id)) problems.push(`duplicate player id ${p.id}`);
    playerIds.add(p.id);
  }
  for (const m of ds.memberships) {
    if (!teamIds.has(m.teamId)) problems.push(`membership references unknown team ${m.teamId}`);
    if (!compIds.has(m.competitionId))
      problems.push(`membership references unknown competition ${m.competitionId}`);
    if (m.toSeason !== null && m.toSeason < m.fromSeason)
      problems.push(`membership ${m.teamId}/${m.competitionId} ends before it starts`);
  }
  // A club cannot be in two leagues in the same season.
  const byTeam = new Map<string, typeof ds.memberships>();
  for (const m of ds.memberships) byTeam.set(m.teamId, [...(byTeam.get(m.teamId) ?? []), m]);
  for (const [team, list] of byTeam) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const aTo = a.toSeason ?? ds.meta.currentSeason;
        const bTo = b.toSeason ?? ds.meta.currentSeason;
        if (Math.max(a.fromSeason, b.fromSeason) <= Math.min(aTo, bTo))
          problems.push(
            `team ${team}: overlapping memberships ${a.competitionId}[${a.fromSeason}-${a.toSeason}] and ${b.competitionId}[${b.fromSeason}-${b.toSeason}]`,
          );
      }
  }
  for (const a of ds.affiliations) {
    if (!playerIds.has(a.playerId))
      problems.push(`affiliation references unknown player ${a.playerId}`);
    if (!teamIds.has(a.teamId)) problems.push(`affiliation references unknown team ${a.teamId}`);
  }
  return problems;
}
