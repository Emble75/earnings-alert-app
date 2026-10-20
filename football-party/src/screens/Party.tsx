import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, X } from 'lucide-react';
import type { GameId } from '@shared/games/types';
import { maxImpostors } from '@shared/games/impostor';
import { gameMeta, gameMetaList } from '@/games/meta';
import { useLocalRoom, type LocalSetup } from '@/lib/useLocalRoom';
import { Avatar, Button, Segmented, Stepper } from '@/ui/kit';
import { CenterMessage, Page } from './Shell';
import { RoomFrame } from './RoomFrame';
import { store } from '@/lib/storage';

const LIMITS = {
  tictactoe: { min: 2, max: 8 },
  impostor: { min: 3, max: 8 },
  linkup: { min: 1, max: 8 },
  career: { min: 1, max: 8 },
} as const;
const isQuick = (g: GameId) => g === 'linkup' || g === 'career';
const NAMES_KEY = 'pitchside.party.names';

/** One-phone party mode: set up, then pass the device around. Same engine as online rooms, in the browser. */
export function Party() {
  const { game } = useParams();
  const [setup, setSetup] = useState<LocalSetup | null>(null);
  if (!setup)
    return (
      <PartySetup
        initial={
          game === 'tictactoe' || game === 'impostor' || game === 'linkup' || game === 'career'
            ? game
            : undefined
        }
        onStart={setSetup}
      />
    );
  return <PartyRun setup={setup} onExit={() => setSetup(null)} />;
}

function PartySetup({ initial, onStart }: { initial?: GameId; onStart: (s: LocalSetup) => void }) {
  const [game, setGame] = useState<GameId>(initial ?? 'impostor');
  const saved = store.getJson<string[]>(NAMES_KEY, []);
  const [names, setNames] = useState<string[]>(
    saved.length >= 2 ? saved : ['Player 1', 'Player 2', 'Player 3'],
  );
  const [vsComputer, setVsComputer] = useState(false);
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [rounds, setRounds] = useState<1 | 3 | 5>(1);
  const [discSecs, setDiscSecs] = useState(180);
  const [timersOn, setTimersOn] = useState(true);
  const [secs, setSecs] = useState(45);
  const [quickRounds, setQuickRounds] = useState(10);
  const hint = 'position' as const; // the impostor gets a position hint
  const setName = (i: number, v: string) => setNames((n) => n.map((x, j) => (j === i ? v : x)));

  const lim = LIMITS[game];
  const ttBot = game === 'tictactoe' && vsComputer;
  const active = ttBot ? ['You'] : names.slice(0, lim.max);
  const clean = active.map((n) => n.trim());
  const impostors = clean.length >= 7 ? 2 : 1; // automatic: more players, a second impostor
  const dup = new Set(clean.map((n) => n.toLowerCase())).size !== clean.length;
  const invalid =
    !ttBot && (clean.some((n) => n.length < 2 || n.length > 16) || dup || clean.length < lim.min);
  const impCap = Math.min(3, maxImpostors(Math.max(clean.length, 3)));

  const start = () => {
    if (!ttBot) store.set(NAMES_KEY, JSON.stringify(clean));
    if (game === 'tictactoe')
      onStart({
        game,
        opponent: ttBot ? 'bot' : 'friend',
        names: clean,
        config: { difficulty, rounds, timers: timersOn, turnSeconds: secs },
      });
    else if (isQuick(game))
      onStart({
        game: game as 'linkup' | 'career',
        names: clean,
        config: {
          difficulty,
          rounds: quickRounds,
          timers: timersOn,
          seconds: secs,
          spoken: true,
        },
      });
    else
      onStart({
        game: 'impostor',
        names: clean,
        config: {
          rounds: 99, // endless: "Next round" until you stop
          spoken: true, // in person: see your card, talk, reveal — no clue rounds or voting
          timers: timersOn,
          discussionSeconds: discSecs,
          impostors: Math.min(impostors, impCap),
          impostorHint: hint,
        },
      });
  };

  const teams = useMemo(
    () => [clean.filter((_, i) => i % 2 === 0), clean.filter((_, i) => i % 2 === 1)],
    [clean],
  );

  return (
    <Page narrow>
      <Link to="/" className="back-link">
        <ArrowLeft size={16} aria-hidden /> Back
      </Link>
      <div className="eyebrow lime">One phone · pass it around</div>
      <h1 className="page-title">Party mode</h1>
      <p className="lede">
        Everyone plays on this one phone. Secrets are hidden between hand-overs; clues are said out
        loud.
      </p>

      <ol className="setup-steps">
        <li className="card step-card" aria-labelledby="s1">
          <div className="step-head">
            <span className="step-no mono">01</span>
            <h2 id="s1">Pick the game</h2>
          </div>
          <div className="game-options" role="radiogroup" aria-labelledby="s1">
            {gameMetaList.map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={game === g.id}
                className={`game-option ${game === g.id ? 'on' : ''}`}
                onClick={() => {
                  setGame(g.id);
                  setSecs(g.id === 'career' ? 30 : isQuick(g.id) ? 15 : 45);
                }}
              >
                <g.icon size={28} aria-hidden />
                <span className="go-title">{g.title}</span>
                <span className="go-tag">
                  {g.id === 'impostor'
                    ? '3–8 players · find the faker'
                    : g.id === 'tictactoe'
                      ? '2–8 players · or vs the computer'
                      : g.id === 'linkup'
                        ? '1–8 players · name the link'
                        : '1–8 players · guess the career'}
                </span>
              </button>
            ))}
          </div>
        </li>

        <li className="card step-card" aria-labelledby="s2">
          <div className="step-head">
            <span className="step-no mono">02</span>
            <h2 id="s2">Who’s playing?</h2>
          </div>
          {game === 'tictactoe' && (
            <Segmented
              label="Opponent"
              value={vsComputer ? 'cpu' : 'friends'}
              onChange={(v) => setVsComputer(v === 'cpu')}
              options={[
                { value: 'friends', label: 'Friends' },
                { value: 'cpu', label: 'Computer' },
              ]}
            />
          )}
          {ttBot ? (
            <p className="field-hint">You play X against the computer.</p>
          ) : (
            <div
              className="stack"
              style={{ ['--stack' as string]: 'var(--s-3)', marginTop: 'var(--s-3)' }}
            >
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
                  {names.length > lim.min && (
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
              {names.length < lim.max && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setNames((x) => [...x, `Player ${x.length + 1}`])}
                >
                  <Plus size={16} aria-hidden /> Add player
                </Button>
              )}
              {names.length < lim.min && (
                <p className="field-error" role="alert">
                  {gameMeta[game].title} needs at least {lim.min} players.
                </p>
              )}
              {invalid && names.length >= lim.min && (
                <p className="field-error" role="alert">
                  Names must be 2–16 characters and unique.
                </p>
              )}
              {game === 'tictactoe' && !invalid && (
                <p className="teams-preview">
                  <strong>X</strong> {teams[0]!.join(', ')} <span aria-hidden>·</span>{' '}
                  <strong>O</strong> {teams[1]!.join(', ')}
                </p>
              )}
            </div>
          )}
        </li>

        <li className="card step-card" aria-labelledby="s3">
          <div className="step-head">
            <span className="step-no mono">03</span>
            <h2 id="s3">Settings</h2>
          </div>
          {game === 'tictactoe' || isQuick(game) ? (
            <div className="config-grid">
              <div className="span-2">
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
              </div>
              <div className="span-2">
                {isQuick(game) ? (
                  <Segmented
                    label="Rounds"
                    value={quickRounds}
                    onChange={setQuickRounds}
                    options={[
                      { value: 5, label: '5' },
                      { value: 10, label: '10' },
                      { value: 15, label: '15' },
                    ]}
                  />
                ) : (
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
                )}
              </div>
            </div>
          ) : null}
          <div className="config-grid" style={{ marginTop: 'var(--s-3)' }}>
            <div className="span-2">
              <Segmented
                label="Timers"
                value={timersOn ? 'on' : 'off'}
                onChange={(v) => setTimersOn(v === 'on')}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off — take your time' },
                ]}
              />
            </div>
            {timersOn && (
              <div className="span-2">
                {game === 'tictactoe' || isQuick(game) ? (
                  <Stepper
                    label={isQuick(game) ? 'Seconds per round' : 'Seconds per turn'}
                    value={secs}
                    min={10}
                    max={180}
                    step={5}
                    suffix="s"
                    onChange={setSecs}
                  />
                ) : (
                  <Stepper
                    label="Discussion time"
                    value={discSecs}
                    min={30}
                    max={600}
                    step={30}
                    suffix="s"
                    onChange={setDiscSecs}
                  />
                )}
              </div>
            )}
          </div>
        </li>
      </ol>

      <div className="start-bar">
        <Button size="lg" block onClick={start} disabled={invalid}>
          Kick off
        </Button>
      </div>
    </Page>
  );
}

function PartyRun({ setup, onExit }: { setup: LocalSetup; onExit: () => void }) {
  const nav = useNavigate();
  const local = useLocalRoom(setup);

  if (local.error)
    return (
      <Page>
        <CenterMessage
          eyebrow="Offside"
          title="Can’t start the game"
          actions={
            <>
              <Button onClick={onExit}>Back to setup</Button>
              <Button variant="secondary" onClick={() => nav('/play')}>
                Home
              </Button>
            </>
          }
        >
          {local.error}
        </CenterMessage>
      </Page>
    );
  if (!local.controller)
    return (
      <Page>
        <div className="center-msg" role="status">
          <Loader2 className="spin" aria-label="Loading football data" />
          <span>Loading football data…</span>
        </div>
      </Page>
    );

  const ctl = local.controller;
  // No hand-over screens: Tic-Tac-Toe is public, and Impostor deals its secret cards one tap at a time.
  return <RoomFrame ctl={ctl} local={{ onExit, onRestart: local.restart }} />;
}
