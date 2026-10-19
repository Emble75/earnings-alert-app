import { loadDotEnv } from '../server/env';
import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { loadDataset } from '../server/football/repository';
import { FootballIndex, type Criterion } from '../shared/football';
import { normalizeText } from '../shared/football/normalize';
import { seededRng } from '../shared/util/rng';

/**
 * Data quality report for one stored source.
 * Usage: npm run data:report [-- --source statsbomb|sample|wikidata|import]
 * Prints coverage, spot-checks against well-known facts, and whether playable grids can be built.
 */
loadDotEnv();
const args = process.argv.slice(2);
const source =
  args[args.indexOf('--source') + 1] ?? loadConfig().FOOTBALL_PROVIDER.replace('file', 'import');
const config = loadConfig();
const db = await openDb(config, createLogger('warn'));
await migrate(db, createLogger('warn'));
const ds = await loadDataset(db, source);
if (!ds || ds.players.length === 0) {
  console.error(`No data stored for source "${source}". Run: npm run sync -- --provider ${source}`);
  process.exit(2);
}
const idx = new FootballIndex(ds);
const line = (s = '') => console.log(s);

line(`\n=== ${ds.meta.label} (${ds.meta.kind}) — generated ${ds.meta.generatedAt} ===`);
line(
  `players ${idx.counts.players} · teams ${idx.counts.teams} · competitions ${idx.counts.competitions} · affiliations ${idx.counts.affiliations} · memberships ${idx.counts.memberships}`,
);
line(ds.meta.notes);

line('\n--- League coverage (clubs per competition, seasons with data) ---');
for (const c of ds.competitions.filter((x) => x.kind === 'league')) {
  const ms = ds.memberships.filter((m) => m.competitionId === c.id);
  const seasons = new Set<number>();
  for (const m of ms)
    for (let y = m.fromSeason; y <= (m.toSeason ?? m.fromSeason); y++) seasons.add(y);
  line(
    `${c.name.padEnd(16)} clubs ${String(new Set(ms.map((m) => m.teamId)).size).padStart(3)}  seasons ${seasons.size}  [${[...seasons].sort().join(', ')}]`,
  );
}

line('\n--- Richest teams (players with confirmed affiliation) ---');
const byTeam = new Map<string, number>();
for (const a of ds.affiliations) byTeam.set(a.teamId, (byTeam.get(a.teamId) ?? 0) + 1);
for (const [t, n] of [...byTeam].sort((a, b) => b[1] - a[1]).slice(0, 12))
  line(`${(idx.getTeam(t)?.name ?? t).padEnd(28)} ${n}`);

// ---- Spot checks: well-known facts. Only judged when the player AND the team exist in this data.
type Check = {
  player: string;
  kind: 'club' | 'national' | 'league';
  target: string;
  expect: boolean;
};
const checks: Check[] = [
  { player: 'Lionel Messi', kind: 'club', target: 'Barcelona', expect: true },
  { player: 'Lionel Messi', kind: 'league', target: 'La Liga', expect: true },
  { player: 'Lionel Messi', kind: 'national', target: 'Argentina', expect: true },
  { player: 'Lionel Messi', kind: 'club', target: 'Real Madrid', expect: false },
  { player: 'Cristiano Ronaldo', kind: 'club', target: 'Real Madrid', expect: true },
  { player: 'Cristiano Ronaldo', kind: 'club', target: 'Barcelona', expect: false },
  { player: 'Cristiano Ronaldo', kind: 'national', target: 'Portugal', expect: true },
  { player: 'Thierry Henry', kind: 'club', target: 'Arsenal', expect: true },
  { player: 'Thierry Henry', kind: 'league', target: 'Premier League', expect: true },
  { player: 'Harry Kane', kind: 'club', target: 'Tottenham Hotspur', expect: true },
  { player: 'Harry Kane', kind: 'national', target: 'England', expect: true },
  { player: 'Sergio Agüero', kind: 'club', target: 'Manchester City', expect: true },
  { player: 'Sergio Agüero', kind: 'club', target: 'Chelsea', expect: false },
  { player: 'Wayne Rooney', kind: 'club', target: 'Manchester United', expect: true },
  { player: 'Zlatan Ibrahimović', kind: 'club', target: 'Barcelona', expect: true },
  { player: 'Kylian Mbappé', kind: 'national', target: 'France', expect: true },
  { player: 'Luka Modrić', kind: 'national', target: 'Croatia', expect: true },
];
const findTeam = (name: string, kind: 'club' | 'national') =>
  ds.teams.find((t) => t.kind === kind && normalizeText(t.name) === normalizeText(name));
const findLeague = (name: string) =>
  ds.competitions.find((c) => c.kind === 'league' && normalizeText(c.name) === normalizeText(name));

line('\n--- Spot checks against well-known facts ---');
let pass = 0,
  fail = 0,
  skip = 0;
for (const c of checks) {
  const p = idx.searchPlayers(c.player, 1)[0];
  const crit: Criterion | null =
    c.kind === 'league'
      ? findLeague(c.target)
        ? idx.criterionFor('league', findLeague(c.target)!.id)
        : null
      : findTeam(c.target, c.kind)
        ? idx.criterionFor(c.kind, findTeam(c.target, c.kind)!.id)
        : null;
  const label = `${c.player} · ${c.kind} · ${c.target} → expect ${c.expect ? 'VALID' : 'INVALID'}`;
  if (!p || normalizeText(p.name).split(' ').pop() !== normalizeText(c.player).split(' ').pop()) {
    line(`  ·  NOT IN DATA  ${label} (player)`);
    skip++;
    continue;
  }
  if (!crit) {
    line(`  ·  NOT IN DATA  ${label} (team/league)`);
    skip++;
    continue;
  }
  const ok = idx.verdict(p.id, crit).ok;
  // An expected-INVALID answer is only meaningful as "correctly rejected"; an expected-VALID miss is a coverage gap, not a wrong fact.
  if (ok === c.expect) {
    line(`  ✓  PASS         ${label}`);
    pass++;
  } else if (c.expect && !ok) {
    line(`  ○  COVERAGE GAP ${label}  (true fact, not in this data → game would reject)`);
    skip++;
  } else {
    line(`  ✗  WRONG        ${label}  (data says valid but fact is false!)`);
    fail++;
  }
}
line(
  `\nSpot checks: ${pass} pass · ${fail} WRONG (data error) · ${skip} not-in-data/coverage gaps`,
);

line('\n--- Playability: can we build verified 3x3 grids? (60 seeds each) ---');
for (const d of ['easy', 'medium', 'hard'] as const) {
  let ok = 0,
    minSum = 0;
  for (let s = 1; s <= 60; s++) {
    const g = idx.generateGrid(seededRng(s), d);
    if (g) {
      ok++;
      minSum += Math.min(...g.answerCounts);
    }
  }
  line(
    `${d.padEnd(7)} ${ok}/60 grids${ok ? `  (avg min answers per cell ${(minSum / ok).toFixed(1)})` : ''}`,
  );
}
const g = idx.generateGrid(seededRng(7), 'medium');
if (g) {
  line('\nExample medium grid (answers per cell):');
  line(`            ${g.cols.map((c) => c.label.slice(0, 14).padEnd(15)).join('')}`);
  g.rows.forEach((r, i) =>
    line(
      `${r.label.slice(0, 11).padEnd(12)}${[0, 1, 2].map((j) => String(g.answerCounts[i * 3 + j]).padEnd(15)).join('')}`,
    ),
  );
}
const pool = idx.criteriaPool();
line(
  `\nPlayable criteria: ${pool.filter((c) => c.type === 'club').length} clubs · ${pool.filter((c) => c.type === 'national').length} nations · ${pool.filter((c) => c.type === 'league').length} leagues`,
);
await db.close();
process.exit(fail > 0 ? 1 : 0);
