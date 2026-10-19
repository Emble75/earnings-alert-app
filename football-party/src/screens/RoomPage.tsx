import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DoorOpen, Loader2 } from 'lucide-react';
import { normalizeRoomCode } from '@shared/room/code';
import { ApiError, api } from '@/lib/api';
import { nickname, seats, type Seat } from '@/lib/storage';
import { useRoomConnection } from '@/lib/useRoomConnection';
import { Button, Field, Skeleton } from '@/ui/kit';
import { CenterMessage, Footer, Header, Page } from './Shell';
import { RoomFrame } from './RoomFrame';

export function RoomPage() {
  const { code: raw = '' } = useParams();
  const code = normalizeRoomCode(raw);
  const [seat, setSeat] = useState<Seat | null>(() => seats.get(code));
  useEffect(() => setSeat(seats.get(code)), [code]);

  if (code.length !== 5)
    return (
      <Page>
        <CenterMessage
          eyebrow="Offside"
          title="That’s not a room code"
          actions={
            <Link className="btn" to="/play">
              Enter a code
            </Link>
          }
        >
          Room codes are five characters, like K7QX2. Check the link your friend sent.
        </CenterMessage>
      </Page>
    );
  return seat ? (
    <Session seat={seat} onLost={() => setSeat(null)} />
  ) : (
    <JoinGate code={code} onJoined={setSeat} />
  );
}

function Session({ seat, onLost }: { seat: Seat; onLost: () => void }) {
  const nav = useNavigate();
  const { view, status, closedReason, clockOffset, send } = useRoomConnection(seat);

  if (status === 'kicked')
    return (
      <Page>
        <CenterMessage
          eyebrow="Red card"
          title="You were removed from the room"
          actions={
            <Link className="btn" to="/play">
              Back to play
            </Link>
          }
        >
          The host removed you. You can create your own room anytime.
        </CenterMessage>
      </Page>
    );
  if (status === 'unauthorized')
    return (
      <Page>
        <CenterMessage
          eyebrow="Seat lost"
          title="Your seat in this room is gone"
          actions={<Button onClick={onLost}>Join again</Button>}
        >
          The room may have expired or you were removed. If it still exists you can rejoin with the
          code.
        </CenterMessage>
      </Page>
    );
  if (status === 'closed')
    return (
      <Page>
        <CenterMessage
          eyebrow="Full-time"
          title={closedReason ?? 'This room has closed'}
          actions={<Button onClick={() => nav('/play')}>Back to play</Button>}
        />
      </Page>
    );
  if (!view)
    return (
      <>
        <Header />
        <main
          id="main"
          tabIndex={-1}
          className="container"
          style={{ paddingTop: 'var(--s-6)' }}
          aria-busy
        >
          <div className="stack" role="status" aria-label="Connecting to the room">
            <Skeleton h={28} w={160} />
            <Skeleton h={160} />
            <Skeleton h={220} />
            <p className="field-hint">
              {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting to the room…'}
            </p>
          </div>
        </main>
        <Footer />
      </>
    );
  return (
    <RoomFrame
      status={status}
      ctl={{
        mode: 'online',
        view,
        clockOffset,
        send,
        searchPlayers: (q, signal) => api.searchPlayers(q, signal),
      }}
    />
  );
}

function JoinGate({ code, onJoined }: { code: string; onJoined: (s: Seat) => void }) {
  const [info, setInfo] = useState<
    'loading' | 'missing' | 'error' | { players: number; joinable: boolean; status: string }
  >('loading');
  const [name, setName] = useState(nickname.get());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setInfo('loading');
    api.roomInfo(code).then(
      (r) => alive && setInfo(r),
      (e) => alive && setInfo(e instanceof ApiError && e.code === 'no-room' ? 'missing' : 'error'),
    );
    return () => {
      alive = false;
    };
  }, [code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onJoined(await api.joinRoom(code, name.trim()));
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not join.');
      setBusy(false);
    }
  };

  return (
    <Page narrow>
      {info === 'loading' && (
        <div className="center-msg" role="status">
          <Loader2 className="spin" aria-label="Looking for the room" />
        </div>
      )}
      {info === 'missing' && (
        <CenterMessage
          eyebrow="Offside"
          title={`No room “${code}”`}
          actions={
            <>
              <Link className="btn" to="/play">
                Enter another code
              </Link>
              <Link className="btn secondary" to="/play">
                Create a room
              </Link>
            </>
          }
        >
          That room doesn’t exist or has expired. Rooms close after a few hours of inactivity — ask
          your host for a fresh link.
        </CenterMessage>
      )}
      {info === 'error' && (
        <CenterMessage
          eyebrow="Connection"
          title="Can’t reach the server"
          actions={<Button onClick={() => location.reload()}>Try again</Button>}
        >
          Check your connection. If you’re offline you can still practice on this device.
        </CenterMessage>
      )}
      {typeof info === 'object' && (
        <form className="card paper join-gate" onSubmit={submit} noValidate>
          <div className="eyebrow">You’re invited</div>
          <h1>
            Join room <span className="mono">{code}</span>
          </h1>
          <p>
            {info.players} {info.players === 1 ? 'player is' : 'players are'} in the lobby.
          </p>
          {!info.joinable && (
            <p className="banner red" role="alert">
              {info.status === 'playing'
                ? 'A game is in progress. Ask the host to return to the lobby, then try again.'
                : 'This room is full.'}
            </p>
          )}
          <Field label="Your nickname" error={err} hint="No account needed.">
            {(p) => (
              <input
                {...p}
                className="input"
                autoFocus
                value={name}
                maxLength={16}
                autoComplete="nickname"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Button
            variant="paper"
            size="lg"
            block
            type="submit"
            loading={busy}
            disabled={!info.joinable}
          >
            <DoorOpen aria-hidden /> Join the squad
          </Button>
        </form>
      )}
    </Page>
  );
}
