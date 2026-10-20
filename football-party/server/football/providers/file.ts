import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DatasetSchema } from '../../../shared/football/types';
import type { FootballProvider } from './types';

/**
 * Imports a normalized dataset from a JSON file (e.g. exported from a licensed provider by your own
 * ETL, or hand-curated). Validated against the same schema as every other provider.
 */
export function fileProvider(path: string): FootballProvider {
  return {
    sourceId: 'import',
    label: 'File import',
    kind: 'import',
    async fetchDataset() {
      const buf = fs.readFileSync(path);
      const raw = JSON.parse((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
      const ds = DatasetSchema.parse(raw);
      return { ...ds, meta: { ...ds.meta, sourceId: 'import', kind: 'import' } };
    },
  };
}
