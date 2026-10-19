import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Hand, Loader2, Plus, X } from 'lucide-react';
import { gameMeta } from '@/games/meta';
import { useLocalRoom, type LocalSetup } from '@/lib/useLocalRoom';
import { Avatar, Button, Field, Segmented, Stepper } from '@/ui/kit';
import { Page, CenterMessage } from './Shell';
import { RoomFrame } from './RoomFrame';

export function Practice() {
  const { game } = useParams();
  const nav = useNavigate();
  const [setup, setSetup] = useState<LocalSetup | null>(null);
  if (game !== 'tictactoe' && game !== 'impostor') {
    return (
      <Page>
        <CenterMessage
          eyebrow="Offside"
          title="Unknown game"
          actions={<Button onClick={() => nav('/play')}>Back to play</Button>}
        >
          That game isn’t in the registry.
        </CenterMessage>
      </Page>
    );
  }
  if (!setup) return <PracticeSetup game={game} onStart={setSetup} />;
  return <PracticeRun setup={setup} onExit={() => setSetup(null)} />;
}

function PracticeSetup({
  game,
  onStart,
}: {
  game: 'tictactoe' | 'impostor';
  onStart: (s: LocalSetup) => void;
}) {
  const meta = gameMeta[game];
  const [opponent, setOpponent] = useState<'bot' | 'friend'>('bot');
  const [names, setNames] = useState(['Player 1', 'Player 2', 'Player 3']);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [rounds, setRounds] = useState<1 | 3 | 5>(1);
  const [impRounds, setImpRounds] = useState(2);
  const setName = (i: number, v: string) => setNames((n) => n.map((x, j) => (j === i ? v : x)));
  const clean = names.map((n) => n.trim());
  const dup = new Set(clean.map((n) => n.toLowerCase())).size !== clean.length;
  const bad = clean.some((n) => n.length < 2 || n.length > 16) || dup;

  const start = () => {
    if (game === 'tictactoe') {
      const players =
        opponent === 'bot' ? ['You'] : [clean[0] || 'Player 1', clean[1] || 'Player 2'];
      onStart({
        game,
        opponent,
        names: players,
        config: { difficulty, rounds, turnSeconds: opponent === 'bot' ? 45 : 60 },
      });
    } else {
      onStart({
        game,
        names: clean,
        config: {
          rounds: impRounds,
          clueRounds: 1,
          clueSeconds: 60,
          discussionSeconds: 90,
          voteSeconds: 90,
          impostors: 1,
        },
      });
    }
  };

  return (
    <Page narrow>
      <Link to="/play" className="back-link">
        <ArrowLeft size={16} aria-hidden /> Back
      </Link>
      <div className="eyebrow lime">Offline practice · sample data</div>
      <h1 className="page-title">{meta.title}</h1>
      <p className="lede" style={{ maxWidth: '52ch' }}>
        Runs on this device only. It is <strong>not</strong> online multiplayer — to play across
        devices, create a room instead.
      </p>

      <div
        className="card stack"
        style={{ marginTop: 'var(--s-5)', ['--stack' as string]: 'var(--s-5)' }}
      >
        {game === 'tictactoe' ? (
          <>
            <Segmented
              label="Opponent"
              value={opponent}
              onChange={setOpponent}
              options={[
                { value: 'bot', label: 'Computer' },
                { value: 'friend', label: 'Friend (same device)' },
              ]}
            />
            {opponent === 'friend' && (
              <div className="config-grid">
                {[0, 1].map((i) => (
                  <Field key={i} label={`Player ${i + 1}`}>
                    {(p) => (
                      <input
                        {...p}
                        className="input"
                        value={names[i]}
                        maxLength={16}
                        onChange={(e) => setName(i, e.target.value)}
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}
            <Segmented
              label="Difficulty"
              value={difficulty}
              onChange={setDifficulty}
              options={[
                { value: 'easy', label: 'Easy' },
                { value: 'medium', label: 'Medium' },
                { value: 'hard', label: 'Hard' },
              ]}
            />
            <Segmented
              label="Rounds"
              value={rounds}
              onChange={setRounds}
              options={[
                { value: 1, label: 'Single' },
                { value: 3, label: 'Best of 3' },
                { value: 5, label: 'Best of 5' },
              ]}
            />
          </>
        ) : (
          <>
            <div className="stack" style={{ ['--stack' as string]: 'var(--s-3)' }}>
              <span className="field-label">
                Players ({names.length}) — pass the phone between you
              </span>
              {names.map((n, i) => (
                <div key={i} className="row">
                  <Avatar id={`p${i}`} name={n || '?'} size={36} />
                  <input
                    aria-label={`Player ${i + 1} name`}
                    className="input"
                    value={n}
                    maxLength={16}
                    onChange={(e) => setName(i, e.target.value)}
                  />
                  {names.length > 3 && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove player ${i + 1}`}
                      onClick={() => setNames((x) => x.filter((_, j) => j !== i))}
                    >
                      <X size={18} aria-hidden />
                    </button>
                  )}
                </div>
              ))}
              {names.length < 8 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setNames((x) => [...x, `Player ${x.length + 1}`])}
                >
                  <Plus size={16} aria-hidden /> Add player
                </Button>
              )}
              {bad && (
                <p className="field-error" role="alert">
                  Names must be 2–16 characters and unique.
                </p>
              )}
            </div>
            <Stepper label="Rounds" value={impRounds} min={1} max={5} onChange={setImpRounds} />
          </>
        )}
        <Button size="lg" block onClick={start} disabled={game === 'impostor' && bad}>
          Kick off
        </Button>
      </div>
    </Page>
  );
}

function PracticeRun({ setup, onExit }: { setup: LocalSetup; onExit: () => void }) {
  const local = useLocalRoom(setup);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const passAndPlay =
    setup.game === 'impostor' || (setup.game === 'tictactoe' && setup.opponent === 'friend');
  const names = local.names;
  const gate = useMemo(
    () => passAndPlay && local.actingId !== null && confirmed !== local.actingId,
    [passAndPlay, local.actingId, confirmed],
  );

  if (local.error)
    return (
      <Page>
        <CenterMessage
          eyebrow="Offside"
          title="Can’t start practice"
          actions={<Button onClick={onExit}>Back</Button>}
        >
          {local.error}
        </CenterMessage>
      </Page>
    );
  if (!local.controller)
    return (
      <Page>
        <div className="center-msg">
          <Loader2 className="spin" aria-label="Loading practice data" />
        </div>
      </Page>
    );

  const ctl = local.controller;
  if (gate && local.actingId) {
    const who = names[local.actingId] ?? 'next player';
    const finished = ctl.view.status === 'finished';
    if (!finished)
      return (
        <div className="pass-gate" role="dialog" aria-modal aria-label={`Pass the phone to ${who}`}>
          <Hand size={48} aria-hidden />
          <div className="eyebrow lime">Pass the phone</div>
          <h1>{who}</h1>
          <p>Hand the device over. Make sure nobody else is peeking, then tap.</p>
          <Button size="lg" onClick={() => setConfirmed(local.actingId)}>
            I’m {who} — show my screen
          </Button>
        </div>
      );
  }
  return (
    <RoomFrame
      ctl={ctl}
      local={{ onExit, onRestart: () => (setConfirmed(null), local.restart()) }}
    />
  );
}
