import { FootballIndex } from '../../shared/football';
import { normalizeText } from '../../shared/football/normalize';
import type { Dataset } from '../../shared/football/types';
import { sampleDataset } from '../../data/sample/sample';
import type { Config } from '../config';
import type { Db } from '../db';
import { errInfo, type Logger } from '../log';
import { checkDatasetIntegrity } from './integrity';
import type { FootballProvider } from './providers/types';
import { countSource, loadDataset, saveDataset, SyncGuardError } from './repository';
import { sampleProvider } from './providers/sample';
import { fileProvider } from './providers/file';
import { wikidataProvider } from './providers/wikidata';

export interface Conflict {
  entityType: string;
  entityId: string;
  kind: string;
  details: Record<string, unknown>;
}

/**
 * Splits a provider dataset into usable records and explicit conflicts. Nothing is silently
 * dropped: every rejected or ambiguous record is reported and persisted in `data_conflicts`.
 */
export function sanitizeDataset(ds: Dataset): { dataset: Dataset; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const teams = new Map(ds.teams.map((t) => [t.id, t]));
  const comps = new Map(ds.competitions.map((c) => [c.id, c]));
  const players = new Map(ds.players.map((p) => [p.id, p]));

  const affiliations = ds.affiliations.filter((a) => {
    if (!players.has(a.playerId) || !teams.has(a.teamId)) {
      conflicts.push({
        entityType: 'affiliation',
        entityId: `${a.playerId}|${a.teamId}`,
        kind: 'dangling-reference',
        details: { playerId: a.playerId, teamId: a.teamId },
      });
      return false;
    }
    return true;
  });
  const memberships = ds.memberships.filter((m) => {
    if (!teams.has(m.teamId) || !comps.has(m.competitionId)) {
      conflicts.push({
        entityType: 'membership',
        entityId: `${m.teamId}|${m.competitionId}`,
        kind: 'dangling-reference',
        details: {},
      });
      return false;
    }
    return true;
  });

  // Possible duplicate people: same normalized name and birth year under different ids. We do NOT
  // auto-merge (no fuzzy identity guessing); we surface them for review.
  const seen = new Map<string, string>();
  for (const p of ds.players) {
    if (p.birthYear === null) continue;
    const key = `${normalizeText(p.name)}|${p.birthYear}`;
    const other = seen.get(key);
    if (other && other !== p.id)
      conflicts.push({
        entityType: 'player',
        entityId: p.id,
        kind: 'possible-duplicate',
        details: { otherId: other, name: p.name, birthYear: p.birthYear },
      });
    else seen.set(key, p.id);
  }
  // Affiliation spells that overlap at two different clubs in the same season are legitimate
  // (loans, mid-season moves) so they are not flagged; contradictory memberships are.
  const filtered: Dataset = { ...ds, affiliations, memberships };
  for (const msg of checkDatasetIntegrity(filtered).filter((m) =>
    m.includes('overlapping memberships'),
  )) {
    conflicts.push({
      entityType: 'membership',
      entityId: msg.split(':')[0]!,
      kind: 'overlapping-memberships',
      details: { message: msg },
    });
  }
  return { dataset: filtered, conflicts };
}

export interface SyncRunRecord {
  id: number;
  sourceId: string;
  trigger: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown>;
  error: string | null;
}

export type SyncTrigger = 'manual' | 'schedule' | 'startup' | 'cli';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);

export function createProvider(config: Config): FootballProvider {
  switch (config.FOOTBALL_PROVIDER) {
    case 'wikidata':
      return wikidataProvider({
        userAgent:
          config.WIKIDATA_USER_AGENT ?? 'Pitchside/0.1 (set WIKIDATA_USER_AGENT with contact info)',
        maxPlayers: config.WIKIDATA_MAX_PLAYERS,
        qidFile: config.WIKIDATA_QID_FILE,
      });
    case 'file':
      if (!config.FOOTBALL_IMPORT_FILE)
        throw new Error('FOOTBALL_PROVIDER=file requires FOOTBALL_IMPORT_FILE');
      return fileProvider(config.FOOTBALL_IMPORT_FILE);
    default:
      return sampleProvider;
  }
}

/** Owns the live FootballIndex, sync runs, scheduling and freshness reporting. */
export class FootballService {
  private _index: FootballIndex;
  private running: Promise<SyncRunRecord> | null = null;
  private timer: NodeJS.Timeout | null = null;
  usingFallback = false;

  constructor(
    private db: Db,
    private config: Config,
    private log: Logger,
    readonly provider: FootballProvider = createProvider(config),
  ) {
    this._index = new FootballIndex(sampleDataset);
  }

  get index() {
    return this._index;
  }

  /** Loads the active source from the DB, seeding the sample dataset when nothing is there yet. */
  async init(): Promise<void> {
    await this.db.tx(async (q) => {
      const have = await countSource(q, 'sample');
      if (this.provider.sourceId === 'sample' && have.players === 0) {
        this.log.info('seeding sample dataset');
        await saveDataset(q, sampleDataset);
      }
    });
    let ds = await loadDataset(this.db, this.provider.sourceId);
    const empty = !ds || ds.players.length === 0;
    if (empty) {
      // Never leave games without data, but never pass sample data off as the live source either.
      this.log.warn('no data for configured provider yet; serving labelled sample data', {
        provider: this.provider.sourceId,
      });
      await this.db.tx((q) => saveDataset(q, sampleDataset));
      ds = await loadDataset(this.db, 'sample');
      this.usingFallback = this.provider.sourceId !== 'sample';
    }
    this._index = new FootballIndex(ds!);
    this.log.info('football index ready', this._index.counts);
  }

  private async rebuild() {
    const ds = await loadDataset(this.db, this.provider.sourceId);
    if (ds && ds.players.length > 0) {
      this._index = new FootballIndex(ds);
      this.usingFallback = false;
    }
  }

  /** Runs a sync; concurrent calls share the in-flight run. */
  sync(trigger: SyncTrigger): Promise<SyncRunRecord> {
    if (this.running) return this.running;
    this.running = this.doSync(trigger).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSync(trigger: SyncTrigger): Promise<SyncRunRecord> {
    const src = this.provider.sourceId;
    // Clear runs that were left 'running' by a crashed process.
    await this.db.query(
      `UPDATE sync_runs SET status='failed', finished_at=now(), error='interrupted' WHERE status='running' AND started_at < now() - interval '30 minutes'`,
    );
    const started = await this.db.query<{ id: string }>(
      `INSERT INTO sync_runs (source_id, trigger, status) VALUES ($1,$2,'running') RETURNING id`,
      [src, trigger],
    );
    const id = Number(started.rows[0]!.id);
    const log = this.log.child({ syncRun: id, source: src });
    log.info('sync started', { trigger });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20 * 60_000);
    try {
      const raw = await this.provider.fetchDataset({ log, signal: abort.signal });
      const { dataset, conflicts } = sanitizeDataset(raw);
      if (dataset.players.length === 0)
        throw new SyncGuardError('provider returned no players; refusing to replace existing data');
      const before = await countSource(this.db, src);
      if (before.affiliations > 0 && dataset.affiliations.length < before.affiliations * 0.5)
        throw new SyncGuardError(
          `shrink guard: ${dataset.affiliations.length} affiliations vs ${before.affiliations} stored (<50%); existing data kept`,
        );
      const stats = await this.db.tx(async (q) => {
        const s = await saveDataset(q, dataset);
        for (const c of conflicts) {
          await q.query(
            `INSERT INTO data_conflicts (source_id, entity_type, entity_id, kind, details, sync_run_id)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6)
             ON CONFLICT (source_id, entity_type, entity_id, kind) DO UPDATE SET details = EXCLUDED.details, detected_at = now(), sync_run_id = EXCLUDED.sync_run_id`,
            [src, c.entityType, c.entityId, c.kind, JSON.stringify(c.details), id],
          );
        }
        return { ...s, conflicts: conflicts.length };
      });
      await this.db.query(
        `UPDATE sync_runs SET status='success', finished_at=now(), stats=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(stats)],
      );
      await this.rebuild();
      log.info('sync finished', stats);
    } catch (e) {
      log.error('sync failed', errInfo(e));
      await this.db.query(
        `UPDATE sync_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
        [id, (e instanceof Error ? e.message : String(e)).slice(0, 500)],
      );
    } finally {
      clearTimeout(timeout);
    }
    return (await this.recentRuns(1, src))[0]!;
  }

  async recentRuns(limit = 10, sourceId?: string): Promise<SyncRunRecord[]> {
    const r = await this.db.query(
      `SELECT * FROM sync_runs ${sourceId ? 'WHERE source_id = $2' : ''} ORDER BY id DESC LIMIT $1`,
      sourceId ? [limit, sourceId] : [limit],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      sourceId: x.source_id,
      trigger: x.trigger,
      status: x.status,
      startedAt: iso(x.started_at)!,
      finishedAt: iso(x.finished_at),
      stats: x.stats,
      error: x.error,
    }));
  }

  /** Public freshness summary (safe to expose). */
  freshness() {
    const m = this._index.meta;
    return {
      sourceId: m.sourceId,
      label: m.label,
      kind: m.kind,
      generatedAt: m.generatedAt,
      currentSeason: m.currentSeason,
      license: m.license,
      attribution: m.attribution,
      notes: m.notes,
      counts: this._index.counts,
      isSample: m.kind === 'sample',
      fallback: this.usingFallback,
      staleAfterHours: this.config.STALE_AFTER_HOURS,
    };
  }

  /** Admin view: freshness + recent runs + unresolved conflicts + staleness verdict. */
  async adminStatus() {
    const f = this.freshness();
    const runs = await this.recentRuns(10);
    const lastOk = runs.find(
      (r) => r.status === 'success' && r.sourceId === this.provider.sourceId,
    );
    const ageHours = lastOk?.finishedAt
      ? (Date.now() - Date.parse(lastOk.finishedAt)) / 3_600_000
      : null;
    const conflicts = await this.db.query(
      `SELECT kind, count(*)::int n FROM data_conflicts WHERE source_id = $1 GROUP BY kind ORDER BY n DESC`,
      [this.provider.sourceId],
    );
    const sampleOnly = f.isSample;
    return {
      ...f,
      provider: this.provider.sourceId,
      lastSuccessAt: lastOk?.finishedAt ?? null,
      ageHours,
      stale: sampleOnly ? false : ageHours === null || ageHours > this.config.STALE_AFTER_HOURS,
      conflicts: conflicts.rows,
      runs,
      scheduleHours: this.config.SYNC_INTERVAL_HOURS,
    };
  }

  startScheduler() {
    const h = this.config.SYNC_INTERVAL_HOURS;
    if (!h || this.provider.kind === 'sample') return;
    this.timer = setInterval(() => void this.sync('schedule'), h * 3_600_000);
    this.timer.unref();
    this.log.info('scheduled sync enabled', { everyHours: h });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
