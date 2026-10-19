import { readFileSync } from 'node:fs';
import { DatasetSchema } from '../shared/football/types';
import { sampleDataset } from '../data/sample/sample';
import { checkDatasetIntegrity } from '../server/football/integrity';

/** Usage: npm run data:validate [-- path/to/dataset.json]  (default: bundled sample dataset) */
const file = process.argv[2];
const dataset = file ? DatasetSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : sampleDataset;
const problems = checkDatasetIntegrity(dataset);
console.log(
  `${dataset.meta.label}: ${dataset.players.length} players, ${dataset.teams.length} teams, ` +
    `${dataset.affiliations.length} affiliations, ${dataset.memberships.length} memberships`,
);
if (problems.length) {
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}
console.log('  ✓ schema and referential integrity OK');
