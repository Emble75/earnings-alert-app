import { useEffect, useState, type FormEvent } from 'react';
import { Trash2, UserRound } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { nickname, profileToken } from '@/lib/storage';
import { Button, Field, useToast } from '@/ui/kit';
import { Page } from './Shell';

type Stats = Awaited<ReturnType<typeof api.profile>>;

export function Profile() {
  const toast = useToast();
  const [token, setToken] = useState(profileToken.get());
  const [stats, setStats] = useState<Stats | null>(null);
  const [name, setName] = useState(nickname.get());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return setStats(null);
    api.profile(token).then(setStats, (e) => {
      if (e instanceof ApiError && e.status === 401) {
        profileToken.clear();
        setToken(null);
      } else toast('Could not load your profile.');
    });
  }, [token, toast]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProfile(name.trim());
      profileToken.set(p.token);
      nickname.set(p.nickname);
      setToken(p.token);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not create a profile.');
    }
    setBusy(false);
  };

  return (
    <Page narrow>
      <div className="eyebrow lime">Optional</div>
      <h1 className="page-title">Profile</h1>
      {!token ? (
        <form className="card paper stack" onSubmit={create} noValidate>
          <UserRound aria-hidden />
          <p>
            Playing never needs an account. A profile just remembers your scores on this device. It
            stores a nickname and your results — no email, no password. The secret is kept in this
            browser; clear it and the profile is unreachable.
          </p>
          <Field label="Nickname" error={err}>
            {(p) => (
              <input
                {...p}
                className="input"
                value={name}
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button variant="paper" type="submit" loading={busy}>
            Create profile
          </Button>
        </form>
      ) : (
        <div className="card stack">
          {!stats ? (
            <p>Loading…</p>
          ) : (
            <>
              <h2>{stats.nickname}</h2>
              <p className="lede">
                {stats.gamesPlayed} games played · {stats.wins} wins
              </p>
              <ul className="plain-list">
                {Object.entries(stats.byGame).map(([g, s]) => (
                  <li key={g} className="row">
                    <strong>
                      {g === 'tictactoe' ? 'Football Tic-Tac-Toe' : 'Football Impostor'}
                    </strong>
                    <span className="spacer" />
                    <span className="mono">
                      {s.played} played · {s.wins} wins · {s.points} pts
                    </span>
                  </li>
                ))}
                {Object.keys(stats.byGame).length === 0 && (
                  <li className="field-hint">
                    No games yet — your next online match will show up here.
                  </li>
                )}
              </ul>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  try {
                    await api.deleteProfile(token);
                  } catch {
                    /* already gone */
                  }
                  profileToken.clear();
                  setToken(null);
                  toast('Profile and results deleted.', 'info');
                }}
              >
                <Trash2 aria-hidden size={16} /> Delete profile &amp; results
              </Button>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
