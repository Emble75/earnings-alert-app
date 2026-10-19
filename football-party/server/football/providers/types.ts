import type { Dataset } from '../../../shared/football/types';
import type { Logger } from '../../log';

export interface ProviderContext {
  log: Logger;
  signal?: AbortSignal;
}

/**
 * A football data provider adapts one upstream source to the normalized `Dataset`. Providers do
 * the network I/O, retries and rate limiting; the sync pipeline does validation and persistence.
 * Provider secrets come from server-side env only and must never reach the client.
 */
export interface FootballProvider {
  /** Matches `Dataset.meta.sourceId`. */
  sourceId: string;
  label: string;
  kind: 'sample' | 'live' | 'import';
  fetchDataset(ctx: ProviderContext): Promise<Dataset>;
}
