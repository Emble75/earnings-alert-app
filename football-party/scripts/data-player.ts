import { loadConfig } from '../server/config';
import { createLogger } from '../server/log';
import { openDb } from '../server/db';
import { migrate } from '../server/db/migrate';
import { loadDataset } from '../server/football/repository';
import { FootballIndex } from '../shared/football';

/**
 * Debug one footballer: what the stored data says and why a claim passes or fails.
 * Usage: npm run data:player -- "Granit Xhaka" [--source dcaribou]
 */
const args = process.argv.slice(2);
const si = args.indexOf('--source');
const source = si >= 0 ? args.splice(si, 2)[1]! : 'dcaribou';
const query = args.join(' ');
const config = loadConfig();
const log = createLogger('warn');
const db = await openDb(config, log);
await migrate(db, log);
const ds = await loadDataset(db, source);
if (!ds) {
  console.error(`No data stored for "${source}".`);
  process.exit(2);
}
const idx = new FootballIndex(ds);
const hits = idx.searchPlayers(query, 5);
if (!hits.length)
  console.log(`No player matching "${query}" in ${source} (${ds.players.length} players).`);
for (const h of hits) {
  const p = idx.getPlayer(h.id)!;
  console.log(`\n== ${p.name} (${p.id}) born ${p.birthYear ?? '?'} · fame ${p.fame}`);
  for (const a of [...idx.affiliationsOf(p.id)].sort(
    (x, y) => (x.fromSeason ?? 0) - (y.fromSeason ?? 0),
  )) {
    const t = ds.teams.find((x) => x.id === a.teamId);
    const leagues = ds.memberships
      .filter((m) => m.teamId === a.teamId)
      .map((m) => ds.competitions.find((c) => c.id === m.competitionId)?.name)
      .filter((n, i, arr) => n && arr.indexOf(n) === i)
      .slice(0, 3)
      .join(', ');
    console.log(
      `  ${String(a.fromSeason ?? '?').padStart(4)}–${String(a.toSeason ?? 'now').padEnd(4)} ${a.precision.padEnd(6)} ${a.status.padEnd(9)} ${t?.name ?? a.teamId}${leagues ? `  [${leagues}]` : ''}`,
    );
  }
  const leagueIds = new Set(
    idx
      .affiliationsOf(p.id)
      .flatMap((a) =>
        ds.memberships.filter((m) => m.teamId === a.teamId).map((m) => m.competitionId),
      ),
  );
  for (const id of leagueIds) {
    const c = ds.competitions.find((x) => x.id === id)!;
    const crit = idx.criterionFor('league', id);
    if (crit) console.log(`  league ${c.name}: ${JSON.stringify(idx.verdict(p.id, crit))}`);
  }
}
await db.close();
process.exit(0);
