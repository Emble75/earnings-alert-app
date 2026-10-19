import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, ShieldCheck } from 'lucide-react';
import { gameMetaList } from '@/games/meta';
import { api, type Meta } from '@/lib/api';
import { LinkButton } from '@/ui/kit';
import { Page } from './Shell';

export function Rules() {
  return (
    <Page narrow>
      <div className="eyebrow lime">The laws of the game</div>
      <h1 className="page-title">Rules</h1>
      {gameMetaList.map((g) => (
        <section key={g.id} className="card rules-card" aria-labelledby={`r-${g.id}`}>
          <div className="row">
            <g.icon size={28} aria-hidden />
            <h2 id={`r-${g.id}`}>{g.title}</h2>
          </div>
          <p className="lede">{g.blurb}</p>
          <ol className="rule-list">
            {g.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
          <LinkButton to={`/practice/${g.id}`} variant="secondary" size="sm">
            Practice offline
          </LinkButton>
        </section>
      ))}
    </Page>
  );
}

export function DataPolicy() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.meta().then(setMeta, () => setFailed(true));
  }, []);
  const d = meta?.data;
  return (
    <Page narrow>
      <div className="eyebrow lime">Transparency</div>
      <h1 className="page-title">Data &amp; rights</h1>

      <section className="card paper" aria-labelledby="fresh-h">
        <div className="row">
          <Database aria-hidden /> <h2 id="fresh-h">What data is running right now</h2>
        </div>
        {failed && (
          <p className="banner red">
            Couldn’t load live data info (offline?). Offline practice always uses the bundled sample
            set.
          </p>
        )}
        {!d && !failed && <p>Loading…</p>}
        {d && (
          <dl className="facts">
            <dt>Source</dt>
            <dd>
              {d.label} {d.isSample && <span className="chip yellow">sample</span>}
              {d.fallback && <span className="chip red">fallback</span>}
            </dd>
            <dt>Snapshot / generated</dt>
            <dd>{new Date(d.generatedAt).toLocaleString()}</dd>
            <dt>Season treated as “current”</dt>
            <dd>
              {d.currentSeason}–{String(d.currentSeason + 1).slice(2)}
            </dd>
            <dt>Coverage</dt>
            <dd>
              {d.counts.players} players · {d.counts.teams} teams · {d.counts.competitions}{' '}
              competitions · {d.counts.affiliations} dated affiliations
            </dd>
            <dt>Licence</dt>
            <dd>{d.license}</dd>
            <dt>Attribution</dt>
            <dd>{d.attribution}</dd>
            {d.notes && (
              <>
                <dt>Caveats</dt>
                <dd>{d.notes}</dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section className="card stack" style={{ marginTop: 'var(--s-5)' }}>
        <div className="row">
          <ShieldCheck aria-hidden /> <h2>How answers are validated</h2>
        </div>
        <ul className="rule-list plain">
          <li>
            Tic-Tac-Toe never guesses. Each criterion is checked against stored records: player →
            team with explicit <strong>season</strong> ranges, and club → league memberships with
            season ranges.
          </li>
          <li>
            A <em>league</em> square needs a confirmed, season-precise club spell that overlaps the
            club’s time in that league (so a club’s season in a lower division is modelled, not
            assumed).
          </li>
          <li>
            Records with unknown status, year-only dates or missing dates are kept for transparency
            but <strong>excluded from validation</strong>. They never make a wrong answer right.
          </li>
          <li>
            Sample data is hand-curated, limited to a set of clubs, and may contain errors. It is
            never presented as live or complete.
          </li>
        </ul>
      </section>

      <section className="card stack" style={{ marginTop: 'var(--s-5)' }}>
        <h2>Crests, photos, flags &amp; trademarks</h2>
        <p>
          Pitchside ships <strong>no</strong> club crests, player photos or federation logos, and
          never hot-links them. Teams are shown as text monograms in a kit colour. If a licensed
          image source is added later, its terms (and attribution) will be recorded here and in the
          data layer first. Club and competition names are used only to identify the facts; no
          endorsement is implied.
        </p>
      </section>

      <section className="card stack" style={{ marginTop: 'var(--s-5)' }}>
        <h2>Your data</h2>
        <p>
          No accounts are required to play. Rooms live in server memory and expire after inactivity.
          Nicknames are shown only to people in your room. An optional profile stores a nickname and
          per-game scores against a random secret kept on your device — delete it anytime from{' '}
          <Link to="/profile">Profile</Link>.
        </p>
      </section>
    </Page>
  );
}
