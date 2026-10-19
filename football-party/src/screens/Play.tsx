import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DoorOpen, Plus, Smartphone, WifiOff } from 'lucide-react';
import { normalizeRoomCode } from '@shared/room/code';
import { gameMetaList } from '@/games/meta';
import { ApiError, api } from '@/lib/api';
import { nickname } from '@/lib/storage';
import { Button, Field, LinkButton, PitchLines } from '@/ui/kit';
import { Page } from './Shell';

export function Play() {
  const nav = useNavigate();
  const { hash } = useLocation();
  const [name, setName] = useState(nickname.get());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [netErr, setNetErr] = useState<string | null>(null);

  useEffect(() => {
    if (hash === '#join') document.querySelector<HTMLInputElement>('input[name=code]')?.focus();
  }, [hash]);

  const checkName = () => {
    const n = name.trim();
    if (n.length < 2 || n.length > 16) {
      setNameErr('Pick a nickname between 2 and 16 characters.');
      return null;
    }
    setNameErr(null);
    return n;
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setNetErr(null);
    const n = checkName();
    if (!n) return;
    setBusy('create');
    try {
      const seat = await api.createRoom(n);
      nav(`/r/${seat.code}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid-name') setNameErr(err.message);
      else setNetErr(err instanceof Error ? err.message : 'Could not create a room.');
      setBusy(null);
    }
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setNetErr(null);
    const c = normalizeRoomCode(code);
    if (c.length !== 5) return setCodeErr('Room codes are 5 characters, like K7QX2.');
    setCodeErr(null);
    const n = checkName();
    if (!n) return;
    setBusy('join');
    try {
      const seat = await api.joinRoom(c, n);
      nav(`/r/${seat.code}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid-name') setNameErr(err.message);
      else if (err instanceof ApiError && err.code === 'name-taken') setNameErr(err.message);
      else if (
        err instanceof ApiError &&
        (err.code === 'no-room' || err.code === 'room-full' || err.code === 'in-progress')
      )
        setCodeErr(err.message);
      else setNetErr(err instanceof Error ? err.message : 'Could not join.');
      setBusy(null);
    }
  };

  return (
    <Page>
      <div className="play-head">
        <div className="eyebrow lime">Multiplayer</div>
        <h1>Get the squad in</h1>
      </div>
      <div className="play-grid">
        <form
          className="card paper play-card"
          onSubmit={create}
          noValidate
          aria-labelledby="create-h"
        >
          <PitchLines variant="circle" />
          <div className="eyebrow">Host</div>
          <h2 id="create-h">Create a room</h2>
          <Field
            label="Your nickname"
            error={nameErr}
            hint="Shown to everyone in the room. No account needed."
          >
            {(p) => (
              <input
                {...p}
                className="input"
                value={name}
                maxLength={16}
                autoComplete="nickname"
                placeholder="e.g. Sandro"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button variant="paper" size="lg" block type="submit" loading={busy === 'create'}>
            <Plus aria-hidden /> Create room
          </Button>
        </form>

        <form className="card play-card join" onSubmit={join} noValidate aria-labelledby="join-h">
          <div className="eyebrow">Player</div>
          <h2 id="join-h">Join with a code</h2>
          <Field label="Room code" error={codeErr}>
            {(p) => (
              <input
                {...p}
                name="code"
                className="input code"
                value={code}
                maxLength={7}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="K7QX2"
                onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
              />
            )}
          </Field>
          <Field label="Your nickname" error={null}>
            {(p) => (
              <input
                {...p}
                className="input"
                value={name}
                maxLength={16}
                autoComplete="nickname"
                placeholder="e.g. Sandro"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button size="lg" block type="submit" loading={busy === 'join'}>
            <DoorOpen aria-hidden /> Join room
          </Button>
        </form>
      </div>

      {netErr && (
        <p className="banner red" role="alert" style={{ marginTop: 'var(--s-5)' }}>
          <WifiOff aria-hidden size={18} /> {netErr}
        </p>
      )}

      <section className="practice" aria-labelledby="practice-h">
        <div className="section-head">
          <div className="eyebrow">No friends online? No signal?</div>
          <h2 id="practice-h">Practice on this device</h2>
          <p>
            Runs entirely in your browser with the built-in sample data — pass-and-play or against
            the computer. <strong>This is local practice, not cross-device multiplayer.</strong>
          </p>
        </div>
        <div className="practice-grid">
          {gameMetaList.map((g) => (
            <div key={g.id} className="card practice-card">
              <g.icon size={28} aria-hidden />
              <h3>{g.title}</h3>
              <p>
                {g.id === 'impostor'
                  ? 'Pass-and-play with 3–8 people sharing one phone.'
                  : 'Face the computer or a friend on the same device.'}
              </p>
              <LinkButton to={`/practice/${g.id}`} variant="secondary" size="sm">
                <Smartphone aria-hidden size={18} /> Practice offline
              </LinkButton>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}
