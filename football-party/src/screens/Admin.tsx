import { useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { api, type AdminStatus } from '@/lib/api';
import { Button, Field, useToast } from '@/ui/kit';
import { Page } from './Shell';

/** Admin-visible sync status. The token lives only in memory for this tab. */
export function Admin() {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setStatus(await api.adminStatus(token));
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Failed');
      setStatus(null);
    }
    setBusy(false);
  };
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.adminSync(token);
      setStatus(r.status);
      toast(
        r.run.status === 'success'
          ? 'Sync finished.'
          : `Sync failed: ${r.run.error ?? 'unknown error'}`,
        r.run.status === 'success' ? 'info' : 'error',
      );
    } catch (x) {
      toast(x instanceof Error ? x.message : 'Sync failed');
    }
    setBusy(false);
  };

  return (
    <Page>
      <div className="eyebrow lime">Admin</div>
      <h1 className="page-title">Data sync status</h1>
      {!status ? (
        <form className="card stack" onSubmit={load} style={{ maxWidth: 480 }}>
          <Field
            label="Admin token"
            error={err}
            hint="Set ADMIN_TOKEN on the server. Kept in memory only."
          >
            {(p) => (
              <input
                {...p}
                className="input"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={busy} disabled={token.length < 8}>
            Unlock
          </Button>
        </form>
      ) : (
        <div className="stack" style={{ ['--stack' as string]: 'var(--s-5)' }}>
          <div className="card">
            <div className="row wrap">
              {status.stale ? (
                <span className="chip red">
                  <AlertTriangle size={12} aria-hidden /> stale
                </span>
              ) : (
                <span className="chip lime">
                  <CheckCircle2 size={12} aria-hidden />{' '}
                  {status.isSample ? 'sample (static)' : 'fresh'}
                </span>
              )}
              {status.fallback && <span className="chip red">serving sample as fallback</span>}
              <span className="spacer" />
              <Button
                size="sm"
                onClick={sync}
                loading={busy}
                disabled={status.isSample && status.provider === 'sample' && false}
              >
                <RefreshCw size={16} aria-hidden /> Resync now
              </Button>
            </div>
            <dl className="facts" style={{ marginTop: 'var(--s-4)' }}>
              <dt>Provider</dt>
              <dd>
                {status.provider} — {status.label}
              </dd>
              <dt>Last successful sync</dt>
              <dd>
                {status.lastSuccessAt
                  ? `${new Date(status.lastSuccessAt).toLocaleString()} (${status.ageHours?.toFixed(1)}h ago)`
                  : 'never'}
              </dd>
              <dt>Stale after</dt>
              <dd>
                {status.staleAfterHours}h {status.isSample && '(not applied to sample data)'}
              </dd>
              <dt>Scheduled sync</dt>
              <dd>{status.scheduleHours ? `every ${status.scheduleHours}h` : 'off'}</dd>
              <dt>Counts</dt>
              <dd>
                {status.counts.players} players · {status.counts.teams} teams ·{' '}
                {status.counts.affiliations} affiliations · {status.counts.memberships} memberships
              </dd>
              <dt>Database</dt>
              <dd>
                {status.db} · {status.rooms} live rooms
              </dd>
              <dt>Conflicts</dt>
              <dd>
                {status.conflicts.length
                  ? status.conflicts.map((c) => `${c.kind}: ${c.n}`).join(', ')
                  : 'none recorded'}
              </dd>
            </dl>
          </div>
          <div className="card">
            <h2 className="card-title">Recent runs</h2>
            <div className="table-wrap">
              <table className="runs">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Source</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {status.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.id}</td>
                      <td>{r.sourceId}</td>
                      <td>{r.trigger}</td>
                      <td>
                        <span
                          className={`chip ${r.status === 'success' ? 'lime' : r.status === 'failed' ? 'red' : ''}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="mono">{new Date(r.startedAt).toLocaleString()}</td>
                      <td>
                        {r.error ??
                          `${(r.stats as { changed?: number }).changed ?? 0} changed · ${(r.stats as { removed?: number }).removed ?? 0} removed`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
