import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Search, X } from 'lucide-react';
import type { PlayerCard } from '@shared/football/types';
import type { GuessRow, WhoAreYaView } from '@shared/games/whoareya';
import type { RoomController } from '@/lib/room-controller';
import { Button, useToast } from '@/ui/kit';
import { Countdown, FinalPanel, NoTimer, Standings, gameAction, nameOf, useAct } from '../shared';
import { PlayerPicker } from '../tictactoe/PlayerPicker';

function Tile({
  title,
  hit,
  children,
}: {
  title: string;
  hit: 'match' | 'miss' | 'unknown' | 'older' | 'younger';
  children: React.ReactNode;
}) {
  return (
    <div className={`wtile ${hit}`} title={title}>
      <span className="wtile-t">{title}</span>
      <span className="wtile-v">{children}</span>
    </div>
  );
}

function Row({ g, view }: { g: GuessRow; view: RoomController['view'] }) {
  return (
    <li className={`wrow ${g.correct ? 'correct' : ''}`}>
      <div className="wrow-head">
        <strong>{g.player.name}</strong>
        <span className="field-hint">{nameOf(view, g.by)}</span>
      </div>
      <div className="wtiles">
        <Tile title="Nation" hit={g.nation.hit}>
          {g.nation.label ?? '?'}
        </Tile>
        <Tile title="Position" hit={g.position.hit}>
          {g.position.label ?? '?'}
        </Tile>
        <Tile title="Born" hit={g.born.hit}>
          {g.born.year ?? '?'}
          {g.born.hit === 'older' && <ArrowDown size={14} aria-label="target is younger" />}
          {g.born.hit === 'younger' && <ArrowUp size={14} aria-label="target is older" />}
        </Tile>
      </div>
      <div className={`wclubs ${g.sharedClubs.length ? 'has' : ''}`}>
        {g.sharedClubs.length ? (
          <>
            <Check size={14} aria-hidden /> Also played for: {g.sharedClubs.join(', ')}
          </>
        ) : (
          <>
            <X size={14} aria-hidden /> No club in common
          </>
        )}
      </div>
    </li>
  );
}

export function WhoAreYaScreen({ ctl }: { ctl: RoomController }) {
  const { view } = ctl;
  const v = view.game!.view as WhoAreYaView;
  const act = useAct(ctl);
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const isHost = view.you === view.hostId || ctl.mode === 'local';
  const myTurn = v.turnPlayerId === view.you;

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

  return (
    <div className="game-body">
      <header className="phase-head">
        <div className="eyebrow lime">
          Round {v.round}/{v.totalRounds} · guess {Math.min(v.guesses.length + 1, v.maxGuesses)}/
          {v.maxGuesses}
        </div>
        {v.phase === 'playing' &&
          (v.config.timers ? (
            <Countdown deadline={v.deadline} offset={ctl.clockOffset} label="Time left" />
          ) : (
            <NoTimer />
          ))}
      </header>

      <section className="card qcard">
        {v.phase === 'playing' ? (
          <>
            <p className="qquestion">Who is the hidden footballer?</p>
            <p className="turn-name">
              {myTurn ? 'Your guess' : `${nameOf(view, v.turnPlayerId)}’s turn`}
            </p>
            <Button size="lg" block disabled={!myTurn} onClick={() => setPicking(true)}>
              <Search aria-hidden /> {myTurn ? 'Make a guess' : 'Waiting…'}
            </Button>
            {isHost && v.guesses.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => act(gameAction({ type: 'giveup' }))}>
                Give up — show answer
              </Button>
            )}
          </>
        ) : (
          <div className="qreveal">
            <div className="eyebrow">
              {v.solvedBy ? `${nameOf(view, v.solvedBy)} got it` : 'Nobody got it'}
            </div>
            <ul className="qanswers">
              <li>{v.reveal?.name}</li>
            </ul>
            {isHost ? (
              <Button onClick={() => act(gameAction({ type: 'next' }))}>
                {v.round >= v.totalRounds ? 'See results' : 'Next round'}
              </Button>
            ) : (
              <span className="field-hint">Waiting for the host…</span>
            )}
          </div>
        )}
      </section>

      {v.guesses.length > 0 && (
        <ol className="wlist" aria-label="Guesses so far">
          {[...v.guesses].reverse().map((g) => (
            <Row key={g.player.id} g={g} view={view} />
          ))}
        </ol>
      )}

      <aside className="card">
        <div className="eyebrow">Points</div>
        <Standings
          you={view.you}
          rows={view.players.map((p) => ({
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
        usedIds={new Set(v.guesses.map((g) => g.player.id))}
        cellLabel="Guess the footballer"
        onPick={submit}
      />
    </div>
  );
}
