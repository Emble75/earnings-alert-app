import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, Clock, Loader2, X as XIcon } from 'lucide-react';
import type { Criterion, PlayerCard } from '@shared/football/types';
import type { TttView } from '@shared/games/tictactoe';
import { cue } from '@/lib/prefs';
import type { RoomController } from '@/lib/room-controller';
import { Monogram, useToast } from '@/ui/kit';
import { Countdown, FinalPanel, Live, Standings, gameAction, nameOf } from '../shared';
import { PlayerPicker } from './PlayerPicker';

const SIDE = ['X', 'O'] as const;

function CriterionTile({ c, axis }: { c: Criterion; axis: 'row' | 'col' }) {
  const kind = c.type === 'club' ? 'Club' : c.type === 'national' ? 'Nation' : 'League';
  return (
    <div className={`crit ${axis}`} role={axis === 'row' ? 'rowheader' : 'columnheader'}>
      {c.type === 'league' ? (
        <span className="league-mark" aria-hidden>
          {c.short.slice(0, 3)}
        </span>
      ) : (
        <Monogram short={c.short} color={c.color} size={34} />
      )}
      <span className="crit-label">{c.label}</span>
      <span className="crit-kind mono">{kind}</span>
    </div>
  );
}

export function TicTacToeScreen({ ctl }: { ctl: RoomController }) {
  const { view } = ctl;
  const v = view.game!.view as TttView;
  const toast = useToast();
  const mySide = v.teams[0].includes(view.you) ? 0 : v.teams[1].includes(view.you) ? 1 : null;
  const myTurn = v.phase === 'playing' && v.turnPlayerId === view.you;
  const [pickCell, setPickCell] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [shake, setShake] = useState(0);
  const lastSeq = useRef(v.event?.seq ?? 0);

  const used = useMemo(
    () => new Set(v.cells.filter(Boolean).map((c) => c!.footballerId)),
    [v.cells],
  );

  // Feedback for every move any player makes.
  useEffect(() => {
    const e = v.event;
    if (!e || e.seq === lastSeq.current) return;
    lastSeq.current = e.seq;
    setPending(null);
    if (e.kind === 'claimed') cue('success');
    else {
      cue('fail');
      setShake((n) => n + 1);
    }
  }, [v.event]);

  // Close the picker if the turn moved on (timeout) while it was open.
  useEffect(() => {
    if (!myTurn) setPickCell(null);
  }, [myTurn]);

  const submit = async (cell: number, p: PlayerCard) => {
    setPickCell(null);
    setPending(cell);
    try {
      await ctl.send(gameAction({ type: 'guess', cell, playerId: p.id }));
    } catch (e) {
      setPending(null);
      toast(e instanceof Error ? e.message : 'That move didn’t go through.');
    }
  };

  const cellLabel = (i: number) => `${v.rows[Math.floor(i / 3)]!.label} × ${v.cols[i % 3]!.label}`;
  const turnName = nameOf(view, v.turnPlayerId);
  const sideNames = (s: 0 | 1) => v.teams[s].map((id) => nameOf(view, id)).join(', ');

  if (v.phase === 'final') {
    return (
      <div className="game-body">
        <FinalPanel
          ctl={ctl}
          title="Draw"
          subtitle={`Best of ${v.totalRounds} · ${SIDE[0]} ${v.sideWins[0]} – ${v.sideWins[1]} ${SIDE[1]}`}
          scores={v.scores}
        />
        <Board
          v={v}
          view={view}
          pending={null}
          shake={0}
          onCell={() => undefined}
          myTurn={false}
          cellLabel={cellLabel}
        />
      </div>
    );
  }

  return (
    <div className="game-body">
      <header className="phase-head ttt-head">
        <div className="scorebug" aria-label="Score">
          {([0, 1] as const).map((s) => (
            <div
              key={s}
              className={`scorebug-side ${v.turnSide === s ? 'on' : ''} ${mySide === s ? 'mine' : ''}`}
            >
              <span className="mark">{SIDE[s]}</span>
              <span className="side-names">{sideNames(s)}</span>
              <span className="wins mono" aria-label={`${v.sideWins[s]} round wins`}>
                {v.sideWins[s]}
              </span>
            </div>
          ))}
        </div>
        <div className="row" style={{ gap: 'var(--s-4)' }}>
          <div className="eyebrow lime">
            Round {v.round}/{v.totalRounds}
          </div>
          {v.phase === 'playing' && (
            <Countdown deadline={v.deadline} offset={ctl.clockOffset} label="Turn time left" />
          )}
        </div>
      </header>

      {v.phase === 'playing' ? (
        <div className={`turn-banner ${myTurn ? 'mine' : ''}`} aria-live="polite">
          <span className="turn-mark">{v.turnSide !== null ? SIDE[v.turnSide] : ''}</span>
          <div>
            <div className="eyebrow">{myTurn ? 'Your move' : 'Waiting'}</div>
            <div className="turn-name">
              {myTurn ? 'Pick a square, name a footballer' : `${turnName} is thinking…`}
            </div>
          </div>
          <Clock className="turn-clock" size={18} aria-hidden />
        </div>
      ) : (
        <div className="turn-banner round-over" aria-live="polite">
          <div>
            <div className="eyebrow">Round {v.round} over</div>
            <div className="turn-name">
              {v.roundWinner === null
                ? 'Dead level — a point each'
                : `${SIDE[v.roundWinner]} take it · ${sideNames(v.roundWinner)}`}
            </div>
          </div>
          <span className="field-hint">Next round starts shortly…</span>
        </div>
      )}

      <Board
        v={v}
        view={view}
        pending={pending}
        shake={shake}
        myTurn={myTurn}
        cellLabel={cellLabel}
        onCell={(i) => {
          if (!myTurn)
            return toast(
              v.phase === 'playing' ? `It’s ${turnName}’s turn.` : 'This round is over.',
              'info',
            );
          cue('tap');
          setPickCell(i);
        }}
      />

      {v.event && (
        <p className={`event ${v.event.kind}`} key={v.event.seq} role="status">
          <strong>{nameOf(view, v.event.by)}:</strong> {v.event.message}
        </p>
      )}
      {!v.event && <Live>Game started.</Live>}

      <details className="rules-mini">
        <summary>How validation works</summary>
        <p>
          Each answer is checked on the server against stored club, national-team and league records
          with season ranges. Only confirmed records count — if the data can’t verify something,
          it’s rejected rather than guessed. A wrong answer loses your turn; a footballer can be
          claimed only once per round.
        </p>
      </details>

      <aside className="card">
        <div className="eyebrow">Points this game</div>
        <Standings
          you={view.you}
          rows={[...v.teams[0], ...v.teams[1]].map((id) => ({
            id,
            name: nameOf(view, id),
            points: v.scores[id] ?? 0,
            total: 0,
          }))}
        />
      </aside>

      <PlayerPicker
        open={pickCell !== null}
        onClose={() => setPickCell(null)}
        search={ctl.searchPlayers}
        usedIds={used}
        cellLabel={pickCell !== null ? cellLabel(pickCell) : ''}
        onPick={(p) => pickCell !== null && submit(pickCell, p)}
      />
    </div>
  );
}

function Board({
  v,
  view,
  pending,
  shake,
  myTurn,
  onCell,
  cellLabel,
}: {
  v: TttView;
  view: RoomController['view'];
  pending: number | null;
  shake: number;
  myTurn: boolean;
  onCell: (i: number) => void;
  cellLabel: (i: number) => string;
}) {
  const win = new Set(v.line ?? []);
  return (
    <div className="board-wrap">
      <div
        className={`board ${shake ? `shake-${shake % 2}` : ''}`}
        role="grid"
        aria-label="Football tic-tac-toe board"
      >
        <div role="row" style={{ display: 'contents' }}>
          <div className="corner" role="presentation" />
          {v.cols.map((c) => (
            <CriterionTile key={`c-${c.type}-${c.id}`} c={c} axis="col" />
          ))}
        </div>
        {v.rows.map((r, ri) => (
          <div
            key={`r-${r.type}-${r.id}`}
            className="board-row"
            role="row"
            style={{ display: 'contents' }}
          >
            <CriterionTile c={r} axis="row" />
            {[0, 1, 2].map((ci) => {
              const i = ri * 3 + ci;
              const cell = v.cells[i];
              const isPending = pending === i;
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  className={`sq ${cell ? `taken s${cell.side}` : ''} ${win.has(i) ? 'win' : ''} ${myTurn && !cell ? 'playable' : ''}`}
                  aria-disabled={!!cell || !myTurn || undefined}
                  aria-label={
                    cell
                      ? `${cellLabel(i)}: ${cell.name}, ${SIDE[cell.side]}, by ${nameOf(view, cell.by)}`
                      : `${cellLabel(i)}: empty`
                  }
                  onClick={() => !cell && onCell(i)}
                >
                  {cell ? (
                    <>
                      <span className="sq-mark" aria-hidden>
                        {cell.side === 0 ? (
                          <XIcon strokeWidth={3} />
                        ) : (
                          <CircleDot strokeWidth={3} />
                        )}
                      </span>
                      <span className="sq-name">{cell.name}</span>
                    </>
                  ) : isPending ? (
                    <Loader2 className="spin" aria-label="Checking answer" />
                  ) : (
                    <span className="sq-plus" aria-hidden>
                      +
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
