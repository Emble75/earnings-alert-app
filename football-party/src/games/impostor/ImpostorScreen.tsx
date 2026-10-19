import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  Fingerprint,
  Gavel,
  MessageSquareQuote,
  SkipForward,
  UserX,
} from 'lucide-react';
import type { ImpostorView } from '@shared/games/impostor';
import { cue } from '@/lib/prefs';
import type { RoomController } from '@/lib/room-controller';
import { Avatar, Button, Field } from '@/ui/kit';
import {
  Countdown,
  FinalPanel,
  Live,
  NoTimer,
  Standings,
  gameAction,
  nameOf,
  useAct,
} from '../shared';

const PHASE_LABEL = {
  reveal: 'Kick-off',
  clues: 'First half · clues',
  discussion: 'Half-time · discuss',
  voting: 'VAR check · vote',
  result: 'Full-time · reveal',
  final: 'Final whistle',
} as const;

export function ImpostorScreen({ ctl }: { ctl: RoomController }) {
  const { view } = ctl;
  const v = view.game!.view as ImpostorView;
  const isHost = view.you === view.hostId || ctl.mode === 'local';
  const act = useAct(ctl);
  const prevPhase = useRef(v.phase);
  useEffect(() => {
    if (prevPhase.current !== v.phase) {
      cue(v.phase === 'result' ? 'reveal' : v.phase === 'voting' ? 'whistle' : 'turn');
      prevPhase.current = v.phase;
    }
  }, [v.phase]);

  if (v.phase === 'final') {
    return (
      <div className="game-body">
        <FinalPanel
          ctl={ctl}
          title="Match abandoned"
          subtitle={`${v.totalRounds} round${v.totalRounds > 1 ? 's' : ''} of Football Impostor`}
          scores={v.scores}
          note={v.abortedReason}
        />
        {v.result && <ResultCard ctl={ctl} v={v} compact />}
      </div>
    );
  }

  return (
    <div className="game-body">
      <header className="phase-head">
        <div>
          <div className="eyebrow lime">
            Round {v.round}/{v.totalRounds}
            {v.phase === 'clues' && ` · clue lap ${v.clueRound}/${v.clueRounds}`}
          </div>
          <h2 className="phase-title">{PHASE_LABEL[v.phase]}</h2>
        </div>
        {v.config.timers ? (
          <Countdown deadline={v.deadline} offset={ctl.clockOffset} label="Phase time left" />
        ) : (
          <NoTimer />
        )}
      </header>

      {v.phase === 'reveal' && <RevealPhase ctl={ctl} v={v} act={act} />}
      {v.phase === 'clues' && v.config.spoken && <SpokenCluesPhase ctl={ctl} v={v} act={act} />}
      {v.phase === 'clues' && !v.config.spoken && (
        <CluesPhase ctl={ctl} v={v} act={act} isHost={isHost} />
      )}
      {v.phase === 'discussion' && <DiscussionPhase ctl={ctl} v={v} act={act} isHost={isHost} />}
      {v.phase === 'voting' && <VotingPhase ctl={ctl} v={v} act={act} isHost={isHost} />}
      {v.phase === 'result' && (
        <>
          <ResultCard ctl={ctl} v={v} />
          <div className="row wrap">
            {isHost ? (
              <Button size="lg" onClick={() => act(gameAction({ type: 'advance' }))}>
                {v.round >= v.totalRounds ? 'See final standings' : 'Next round'}
              </Button>
            ) : (
              <p className="field-hint">
                Next round starts automatically — the host can skip ahead.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type Act = ReturnType<typeof useAct>;

/* ---------- Private role card ---------- */
function RoleCard({ v }: { v: ImpostorView }) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Hide again automatically so a glance over the shoulder can't catch it.
  const toggle = () => {
    clearTimeout(timer.current);
    setShown((s) => {
      if (!s) timer.current = setTimeout(() => setShown(false), 9000);
      return !s;
    });
    cue('tap');
  };
  const impostor = v.you.role === 'impostor';
  return (
    <div className={`role-card ${shown ? (impostor ? 'is-impostor' : 'is-crew') : 'is-hidden'}`}>
      <div className="eyebrow">{shown ? 'Only you can see this' : 'Your secret'}</div>
      {shown ? (
        impostor ? (
          <div aria-live="polite">
            <div className="role-big">Impostor</div>
            <p>You don’t know the footballer. Blend in with vague-but-plausible clues.</p>
            {v.you.hint && <p className="hint-line">{v.you.hint}</p>}
            {v.you.partners.length > 0 && (
              <p className="hint-line">
                Fellow impostor{v.you.partners.length > 1 ? 's' : ''}: {v.you.partners.join(', ')}
              </p>
            )}
          </div>
        ) : (
          <div aria-live="polite">
            <div className="role-label">The footballer is</div>
            <div className="role-big name">{v.you.footballer}</div>
            <p>Give clues that prove you know — without making it obvious to the impostor.</p>
          </div>
        )
      ) : (
        <div className="role-cover" aria-hidden>
          <Fingerprint size={56} strokeWidth={1.4} />
        </div>
      )}
      <Button variant={shown ? 'secondary' : 'primary'} onClick={toggle} aria-pressed={shown} block>
        {shown ? <EyeOff aria-hidden size={20} /> : <Eye aria-hidden size={20} />}
        {shown ? 'Hide' : 'Show my role'}
      </Button>
    </div>
  );
}

function RevealPhase({ ctl, v, act }: { ctl: RoomController; v: ImpostorView; act: Act }) {
  const { view } = ctl;
  const ready = new Set(v.readyIds);
  const waiting = v.participants.filter((p) => !ready.has(p));
  return (
    <div className="two-col">
      <div className="stack">
        <p className="lede">
          Everyone gets a secret. Most of you will see the same footballer — one of you won’t. Peek
          privately, then confirm.
        </p>
        <RoleCard v={v} />
        <Button
          size="lg"
          block
          disabled={v.you.ready}
          onClick={() => act(gameAction({ type: 'ready' }))}
        >
          <Check aria-hidden /> {v.you.ready ? 'Ready — waiting for others' : 'Got it — I’m ready'}
        </Button>
      </div>
      <aside className="card" aria-label="Who is ready">
        <div className="eyebrow">Players</div>
        <ul className="plain-list">
          {v.participants.map((id) => (
            <li key={id} className="row">
              <Avatar id={id} name={nameOf(view, id)} size={32} />
              <span>{nameOf(view, id)}</span>
              <span className="spacer" />
              {ready.has(id) ? (
                <span className="chip lime">ready</span>
              ) : (
                <span className="chip">
                  {view.players.find((p) => p.id === id)?.connected ? 'peeking' : 'offline'}
                </span>
              )}
            </li>
          ))}
        </ul>
        {waiting.length > 0 && (
          <p className="field-hint">
            The round starts when everyone is ready or the clock runs out.
          </p>
        )}
      </aside>
    </div>
  );
}

function ClueList({ ctl, v }: { ctl: RoomController; v: ImpostorView }) {
  const { view } = ctl;
  const laps = Array.from({ length: v.clueRounds }, (_, i) => i + 1);
  return (
    <div className="stack" style={{ ['--stack' as string]: 'var(--s-4)' }}>
      {laps.map((lap) => {
        const items = v.clues.filter((c) => c.round === lap);
        if (items.length === 0 && lap > v.clueRound) return null;
        return (
          <div key={lap}>
            <div className="eyebrow">Lap {lap}</div>
            <ul className="clue-list">
              {items.map((c, i) => (
                <li key={i} className={c.text === null ? 'skipped' : ''}>
                  <Avatar id={c.playerId} name={nameOf(view, c.playerId)} size={28} />
                  <span className="clue-who">{nameOf(view, c.playerId)}</span>
                  <span className="clue-text">{c.text ?? 'ran out of time'}</span>
                </li>
              ))}
              {items.length === 0 && (
                <li className="skipped">
                  <span className="clue-text">No clues yet</span>
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** In-person play: nobody types. The app just shows who speaks next and moves the turn along. */
function SpokenCluesPhase({ ctl, v, act }: { ctl: RoomController; v: ImpostorView; act: Act }) {
  const { view } = ctl;
  const speaker = nameOf(view, v.turnPlayerId);
  const last = v.turnIndex >= v.turnOrder.length - 1;
  return (
    <div className="two-col">
      <div className="stack">
        <div className="turn-banner mine">
          <Avatar id={v.turnPlayerId ?? ''} name={speaker} size={52} />
          <div>
            <div className="eyebrow">Say it out loud</div>
            <div className="turn-name">{speaker}, give your clue</div>
          </div>
        </div>
        <Live>{`${speaker} is giving a clue out loud.`}</Live>
        <p className="lede">
          One word or a short phrase — never the name. Everyone else listens for clues that fit… or
          try too hard.
        </p>
        <Button size="lg" onClick={() => act(gameAction({ type: 'advance' }))}>
          <SkipForward aria-hidden size={20} />{' '}
          {last ? 'Done — on to the discussion' : 'Done — next speaker'}
        </Button>
        <p className="field-hint">
          Lap {v.clueRound} of {v.clueRounds}.
        </p>
      </div>
      <aside className="card" aria-label="Speaking order">
        <div className="eyebrow">Speaking order · lap {v.clueRound}</div>
        <ol className="speak-order">
          {v.turnOrder.map((id, i) => (
            <li key={id} className={i === v.turnIndex ? 'now' : i < v.turnIndex ? 'done' : ''}>
              <Avatar id={id} name={nameOf(view, id)} size={28} />
              <span>{nameOf(view, id)}</span>
              <span className="spacer" />
              {i < v.turnIndex ? (
                <Check size={16} aria-label="done" />
              ) : i === v.turnIndex ? (
                <span className="chip lime">speaking</span>
              ) : null}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

function CluesPhase({
  ctl,
  v,
  act,
  isHost,
}: {
  ctl: RoomController;
  v: ImpostorView;
  act: Act;
  isHost: boolean;
}) {
  const { view } = ctl;
  const mine = v.turnPlayerId === view.you;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setBusy(false);
    if (mine) {
      setText('');
      input.current?.focus();
      cue('turn');
    }
  }, [mine, v.turnPlayerId, v.clues.length]);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (!(await act(gameAction({ type: 'clue', text })))) setBusy(false);
  };
  const turnName = nameOf(view, v.turnPlayerId);
  return (
    <div className="two-col">
      <div className="stack">
        <div className={`turn-banner ${mine ? 'mine' : ''}`}>
          <Avatar id={v.turnPlayerId ?? ''} name={turnName} size={44} />
          <div>
            <div className="eyebrow">{mine ? 'Your clue' : 'Now giving a clue'}</div>
            <div className="turn-name">{mine ? 'You’re up' : turnName}</div>
          </div>
        </div>
        <Live>{mine ? 'It is your turn to give a clue.' : `${turnName} is giving a clue.`}</Live>
        {mine ? (
          <form
            className="card paper"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field
              label="One word or a short phrase"
              hint={
                v.you.role === 'crew'
                  ? 'Don’t say the name. Prove you know without handing it over.'
                  : 'You’re the impostor — sound like you know.'
              }
            >
              {(p) => (
                <input
                  {...p}
                  ref={input}
                  className="input"
                  value={text}
                  maxLength={32}
                  autoComplete="off"
                  autoCapitalize="none"
                  enterKeyHint="send"
                  placeholder="e.g. left foot"
                  onChange={(e) => setText(e.target.value)}
                />
              )}
            </Field>
            <Button
              variant="paper"
              block
              size="lg"
              type="submit"
              loading={busy}
              disabled={!text.trim()}
              style={{ marginTop: 'var(--s-4)' }}
            >
              <MessageSquareQuote aria-hidden size={20} /> Drop the clue
            </Button>
          </form>
        ) : (
          <p className="lede">Listen for clues that fit — or that try a little too hard.</p>
        )}
        {isHost && !v.config.timers && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => act(gameAction({ type: 'advance' }))}
          >
            <SkipForward aria-hidden size={16} /> Skip this clue (host)
          </Button>
        )}
        <details className="peek">
          <summary>Peek at my role</summary>
          <RoleCard v={v} />
        </details>
      </div>
      <aside className="card" aria-label="Clues so far">
        <ClueList ctl={ctl} v={v} />
      </aside>
    </div>
  );
}

function DiscussionPhase({
  ctl,
  v,
  act,
  isHost,
}: {
  ctl: RoomController;
  v: ImpostorView;
  act: Act;
  isHost: boolean;
}) {
  return (
    <div className="two-col">
      <div className="stack">
        <p className="lede">
          Talk it out — out loud, in person or on a call. Who gave a clue that was too vague, too
          specific, or just off?
        </p>
        {isHost ? (
          <Button variant="secondary" onClick={() => act(gameAction({ type: 'advance' }))}>
            <SkipForward aria-hidden size={18} /> Skip to voting
          </Button>
        ) : (
          <p className="field-hint">Voting opens when the clock ends or the host skips ahead.</p>
        )}
        {!v.config.spoken && (
          <details className="peek">
            <summary>Peek at my role</summary>
            <RoleCard v={v} />
          </details>
        )}
      </div>
      {!v.config.spoken && (
        <aside className="card" aria-label="All clues">
          <ClueList ctl={ctl} v={v} />
        </aside>
      )}
    </div>
  );
}

function VotingPhase({
  ctl,
  v,
  act,
  isHost,
}: {
  ctl: RoomController;
  v: ImpostorView;
  act: Act;
  isHost: boolean;
}) {
  const { view } = ctl;
  const others = v.participants.filter((p) => p !== view.you);
  const mine = v.you.voted;
  const vote = async (target: string) => {
    cue('tap');
    await act(gameAction({ type: 'vote', target }));
  };
  return (
    <div className="two-col">
      <div className="stack">
        <p className="lede">
          Who’s the impostor? You can change your vote until everyone has voted or time is up. Ties
          eject nobody.
        </p>
        <div className="vote-grid" role="radiogroup" aria-label="Vote for the impostor">
          {others.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mine === id}
              className={`vote-card ${mine === id ? 'picked' : ''}`}
              onClick={() => vote(id)}
            >
              <Avatar id={id} name={nameOf(view, id)} size={48} />
              <span className="vote-name">{nameOf(view, id)}</span>
              {mine === id ? <Gavel aria-hidden size={18} /> : null}
            </button>
          ))}
        </div>
        <Button variant={mine === 'skip' ? 'primary' : 'secondary'} onClick={() => vote('skip')}>
          <UserX aria-hidden size={18} />{' '}
          {mine === 'skip' ? 'Skipping this vote' : 'I can’t tell — skip'}
        </Button>
        {isHost && !v.config.timers && (
          <Button variant="ghost" size="sm" onClick={() => act(gameAction({ type: 'advance' }))}>
            <Gavel aria-hidden size={16} /> Close voting now (host)
          </Button>
        )}
      </div>
      <aside className="card" aria-label="Voting progress">
        <div className="eyebrow">Votes in</div>
        <div className="vote-count mono">
          {v.voted.length}/{v.participants.length}
        </div>
        <ul className="plain-list">
          {v.participants.map((id) => (
            <li key={id} className="row">
              <Avatar id={id} name={nameOf(view, id)} size={28} />
              <span>{nameOf(view, id)}</span>
              <span className="spacer" />
              {v.voted.includes(id) ? (
                <Check size={18} aria-label="voted" color="var(--lime)" />
              ) : (
                <span className="chip">thinking</span>
              )}
            </li>
          ))}
        </ul>
        <Live>{`${v.voted.length} of ${v.participants.length} votes in.`}</Live>
      </aside>
    </div>
  );
}

function ResultCard({
  ctl,
  v,
  compact,
}: {
  ctl: RoomController;
  v: ImpostorView;
  compact?: boolean;
}) {
  const { view } = ctl;
  const r = v.result;
  if (!r) return null;
  const impostorNames = r.impostors.map((i) => nameOf(view, i));
  const verdict =
    r.ejected === null
      ? 'Nobody was ejected — the impostor walks free.'
      : r.crewWon
        ? `${nameOf(view, r.ejected)} was the impostor. Crew win the round.`
        : `${nameOf(view, r.ejected)} was innocent. The impostor wins the round.`;
  return (
    <section
      className={`reveal-card card paper ${compact ? 'compact' : ''}`}
      aria-label="Round result"
    >
      <div className="eyebrow">The footballer was</div>
      <div className="reveal-name">{r.footballer.name}</div>
      <div className="reveal-imp">
        <span className="chip red">Impostor{impostorNames.length > 1 ? 's' : ''}</span>
        <strong>{impostorNames.join(' & ')}</strong>
      </div>
      <p className={`verdict ${r.crewWon ? 'good' : 'bad'}`}>{verdict}</p>
      <Live>{verdict}</Live>
      {!compact && (
        <>
          <div className="eyebrow" style={{ marginTop: 'var(--s-4)' }}>
            Votes
          </div>
          <ul className="tally">
            {v.participants.map((id) => {
              const n = r.tally[id] ?? 0;
              return (
                <li key={id}>
                  <span>{nameOf(view, id)}</span>
                  <span className="bar">
                    <span
                      style={{ width: `${(n / Math.max(1, v.participants.length - 1)) * 100}%` }}
                      className={r.impostors.includes(id) ? 'imp' : ''}
                    />
                  </span>
                  <span className="mono">{n}</span>
                </li>
              );
            })}
          </ul>
          <div className="eyebrow" style={{ marginTop: 'var(--s-4)' }}>
            Standings
          </div>
          <Standings
            you={view.you}
            rows={v.participants.map((id) => ({
              id,
              name: nameOf(view, id),
              points: v.scores[id] ?? 0,
              delta: r.deltas[id],
              total: 0,
            }))}
          />
        </>
      )}
    </section>
  );
}
