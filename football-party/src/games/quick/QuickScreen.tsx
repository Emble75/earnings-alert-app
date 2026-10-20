import { useEffect, useRef, useState } from 'react';
import { Eye, Search } from 'lucide-react';
import type { PlayerCard } from '@shared/football/types';
import type { ClubTile, QuickView } from '@shared/games/quick';
import { cue } from '@/lib/prefs';
import type { RoomController } from '@/lib/room-controller';
import { Button, Monogram, useToast } from '@/ui/kit';
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
import { PlayerPicker } from '../tictactoe/PlayerPicker';

function Badge({ label, short, color }: { label: string; short: string; color?: string }) {
  return (
    <div className="qbadge">
      <Monogram short={short} color={color} size={56} />
      <span className="qbadge-label">{label}</span>
    </div>
  );
}

function Prompt({ v }: { v: QuickView }) {
  const p = v.prompt;
  if (p.kind === 'linkup')
    return (
      <div className="qprompt" aria-label={`${p.a.label} and ${p.b.label}`}>
        <Badge label={p.a.label} short={p.a.short} color={p.a.color} />
        <span className="qx" aria-hidden>
          ×
        </span>
        <Badge label={p.b.label} short={p.b.short} color={p.b.color} />
      </div>
    );
  return (
    <div className="qprompt trail" aria-label="Career, oldest club first">
      {p.clubs.map((c: ClubTile, i) => (
        <div key={`${c.label}-${i}`} className="qstep">
          <Badge label={c.label} short={c.short} color={c.color} />
          {i < p.clubs.length - 1 && (
            <span className="qarrow" aria-hidden>
              →
            </span>
          )}
        </div>
      ))}
      {p.position && <span className="chip">{p.position}</span>}
    </div>
  );
}

export function QuickScreen({ ctl }: { ctl: RoomController }) {
  const { view } = ctl;
  const v = view.game!.view as QuickView;
  const act = useAct(ctl);
  const toast = useToast();
  const isHost = view.you === view.hostId || ctl.mode === 'local';
  const spoken = v.config.spoken;
  const [picking, setPicking] = useState(false);
  const lastSeq = useRef(v.event?.seq ?? 0);
  const out = v.out.includes(view.you);

  useEffect(() => {
    const e = v.event;
    if (!e || e.seq === lastSeq.current) return;
    lastSeq.current = e.seq;
    cue(e.kind === 'correct' ? 'success' : e.kind === 'timeout' ? 'tap' : 'fail');
  }, [v.event]);

  useEffect(() => {
    if (v.phase !== 'playing') setPicking(false);
  }, [v.phase]);

  if (v.phase === 'final')
    return (
      <div className="game-body">
        <FinalPanel
          ctl={ctl}
          title="No winner"
          subtitle={`${v.totalRounds} rounds`}
          scores={v.scores}
        />
      </div>
    );

  const submit = async (p: PlayerCard) => {
    setPicking(false);
    try {
      await ctl.send(gameAction({ type: 'guess', playerId: p.id }));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t go through.');
    }
  };
  const question = v.kind === 'linkup' ? 'Name a footballer who played for both' : 'Who is it?';
  const players = view.players;

  return (
    <div className="game-body">
      <header className="phase-head">
        <div className="eyebrow lime">
          Round {v.round}/{v.totalRounds}
        </div>
        {v.phase === 'playing' &&
          (v.config.timers ? (
            <Countdown deadline={v.deadline} offset={ctl.clockOffset} label="Time left" />
          ) : (
            <NoTimer />
          ))}
      </header>

      <section className="card qcard">
        <p className="qquestion">{question}</p>
        <Prompt v={v} />

        {v.phase === 'playing' && spoken && (
          <>
            <p className="qsay">Say it out loud!</p>
            <Button size="lg" block onClick={() => act(gameAction({ type: 'reveal' }))}>
              <Eye aria-hidden /> Reveal answer
            </Button>
          </>
        )}

        {v.phase === 'playing' && !spoken && (
          <>
            <Button size="lg" block disabled={out} onClick={() => setPicking(true)}>
              <Search aria-hidden /> {out ? 'Out of guesses' : 'Name a footballer'}
            </Button>
            {isHost && (
              <Button variant="ghost" size="sm" onClick={() => act(gameAction({ type: 'reveal' }))}>
                Give up — show answer
              </Button>
            )}
          </>
        )}

        {v.phase === 'reveal' && (
          <div className="qreveal">
            <div className="eyebrow">{v.kind === 'career' ? 'It was' : 'For example'}</div>
            <ul className="qanswers">
              {(v.reveal ?? []).map((p) => (
                <li key={p.id}>{p.name}</li>
              ))}
            </ul>
            {spoken ? (
              <>
                <div className="eyebrow">Who got it?</div>
                <div className="row wrap">
                  {players.map((p) => (
                    <Button
                      key={p.id}
                      variant="secondary"
                      size="sm"
                      onClick={() => act(gameAction({ type: 'award', to: p.id }))}
                    >
                      {p.name}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => act(gameAction({ type: 'award', to: null }))}
                  >
                    Nobody
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="turn-name">
                  {v.winner ? `${nameOf(view, v.winner)} got it` : 'Nobody got it'}
                </p>
                {isHost && v.deadline === null && (
                  <Button onClick={() => act(gameAction({ type: 'next' }))}>Next round</Button>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {v.event && !spoken && (
        <p
          className={`event ${v.event.kind === 'correct' ? 'claimed' : 'rejected'}`}
          key={v.event.seq}
          role="status"
        >
          {v.event.by && <strong>{nameOf(view, v.event.by)}: </strong>}
          {v.event.message}
        </p>
      )}
      {!v.event && <Live>Round started.</Live>}

      <aside className="card">
        <div className="eyebrow">Points</div>
        <Standings
          you={view.you}
          rows={players.map((p) => ({
            id: p.id,
            name: p.name,
            points: v.scores[p.id] ?? 0,
            total: 0,
          }))}
        />
      </aside>

      <PlayerPicker
        open={picking}
        onClose={() => setPicking(false)}
        search={ctl.searchPlayers}
        usedIds={new Set()}
        cellLabel={question}
        onPick={submit}
      />
    </div>
  );
}
