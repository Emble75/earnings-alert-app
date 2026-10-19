import { buildSampleDataset } from '../../../data/sample/sample';
import type { FootballProvider } from './types';

/** Bundled, hand-curated demo data. Always available, never live. */
export const sampleProvider: FootballProvider = {
  sourceId: 'sample',
  label: 'Pitchside sample data',
  kind: 'sample',
  async fetchDataset() {
    return buildSampleDataset();
  },
};
