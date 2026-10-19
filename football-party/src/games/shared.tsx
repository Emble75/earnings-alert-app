import { useEffect, useRef, useState } from 'react';
import { Crown, RotateCcw, Trophy, Undo2 } from 'lucide-react';
import type { RoomView } from '@shared/room/types';
import { fmtClock, useCountdown } from '@/lib/clock';
import type { RoomController } from '@/lib/room-controller';
import { Avatar, Button, useToast } from '@/ui/kit';

/** Sends a command and surfaces rule violations as toasts (the server is the judge). */
export function useAct(ctl: RoomController) {
  const toast = useToast();
  return async (cmd: Parameters<RoomController['send']>[0]) => {
    try {
      await ctl.send(cmd);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work.');
      return false;
    }
  };
}

export const gameAction = (action: unknown) => ({ type: 'game.action' as const, action });

export function nameOf(view: RoomView, id: string | null | undefined) {
  if (!id) return '—';
  return view.players.find((p) => p.id === id)?.name ?? 'Former player';
}

/** Countdown bound to a server deadline, with a progress bar that knows the phase's full length. */
export function Countdown({
  deadline,
  offset,
  label,
}: {
  deadline: number | null;
  offset: number;
  label?: string;
}) {
  const remaining = useCountdown(deadline, offset);
  const total = useRef(1);
  const seen = useRef<number | null>(null);
  if (deadline !== seen.current) {
    seen.current = deadline;
    total.current = Math.max(1, remaining ?? 1);
  }
  if (remaining === null) return null;
  const low = remaining < 6000;
  const pct = Math.min(1, remaining / total.current);
  return (
    <div style={{ minWidth: 120 }}>
      <div className={`timer ${low ? 'low' : ''}`}>
        <span className="sr-only">{label ?? 'Time left'}: </span>
        <span aria-hidden={false}>{fmtClock(remaining)}</span>
      </div>
      <div className={`timer-bar ${low ? 'low' : ''}`} aria-hidden>
        <span style={{ transform: `scaleX(${pct})` }} />
      </div>
    </div>
  );
}

/** Announces a short message to screen readers without moving focus. */
export function Live({ children }: { children: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {children}
    </div>
  );
}

export interface StandingRow {
  id: string;
  name: string;
  points: number;
  delta?: number;
  total: number;
  host?: boolean;
}

export function Standings({
  rows,
  you,
  showTotal,
}: {
  rows: StandingRow[];
  you: string;
  showTotal?: boolean;
}) {
  const sorted = [...rows].sort((a, b) => b.points - a.points);
  let rank = 0;
  let prev = Number.NaN;
  return (
    <ol className="standings">
      {sorted.map((r, i) => {
        if (r.points !== prev) rank = i + 1;
        prev = r.points;
        return (
          <li key={r.id} className={r.id === you ? 'me' : ''} style={{ ['--i' as string]: i }}>
            <span className="rank mono">{rank}</span>
            <Avatar id={r.id} name={r.name} size={36} />
            <span className="who">
              {r.name}
              {r.id === you && (
                <span className="chip" style={{ marginLeft: 8 }}>
                  you
                </span>
              )}
              {r.host && (
                <Crown size={14} aria-label="host" style={{ marginLeft: 6, verticalAlign: -2 }} />
              )}
            </span>
            {r.delta !== undefined && r.delta > 0 && <span className="delta mono">+{r.delta}</span>}
            <span className="pts mono">{r.points}</span>
            {showTotal && (
              <span className="tot mono" title="Session total">
                {r.total}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** End-of-game panel shared by every game: standings + rematch controls. */
export function FinalPanel({
  ctl,
  title,
  subtitle,
  scores,
  note,
}: {
  ctl: RoomController;
  title: string;
  subtitle?: string;
  scores: Record<string, number>;
  note?: string | null;
}) {
  const { view } = ctl;
  const act = useAct(ctl);
  const isHost = view.hostId === view.you || ctl.mode === 'local';
  const rows: StandingRow[] = Object.keys(scores).map((id) => ({
    id,
    name: nameOf(view, id),
    points: scores[id] ?? 0,
    total: view.players.find((p) => p.id === id)?.total ?? 0,
    host: id === view.hostId,
  }));
  const top = Math.max(0, ...rows.map((r) => r.points));
  const winners = rows.filter((r) => r.points === top && top > 0).map((r) => r.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [view.version]);
  return (
    <section className="final card paper" aria-labelledby="final-title">
      <div className="eyebrow">Full-time</div>
      <h2 id="final-title" className="final-title">
        <Trophy aria-hidden size={36} />
        {winners.length ? `${winners.join(' & ')} ${winners.length > 1 ? 'win' : 'wins'}` : title}
      </h2>
      {subtitle && <p className="final-sub">{subtitle}</p>}
      {note && (
        <p className="banner" style={{ margin: '12px 0' }}>
          {note}
        </p>
      )}
      <Standings rows={rows} you={view.you} showTotal={view.gamesPlayed > 1} />
      {view.gamesPlayed > 1 && (
        <p className="field-hint" style={{ color: 'var(--paper-dim)' }}>
          Right column: your running total in this room.
        </p>
      )}
      <div className="row wrap" style={{ marginTop: 'var(--s-5)' }}>
        {isHost ? (
          <>
            <Button
              variant="paper"
              size="lg"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                if (!(await act({ type: 'game.rematch' }))) setBusy(false);
              }}
            >
              <RotateCcw aria-hidden size={20} /> Rematch
            </Button>
            <Button
              variant="secondary"
              className="on-paper"
              onClick={() => act({ type: 'game.end' })}
            >
              <Undo2 aria-hidden size={18} /> Back to lobby
            </Button>
          </>
        ) : (
          <p className="field-hint" style={{ color: 'var(--paper-dim)' }}>
            Waiting for the host to start a rematch…
          </p>
        )}
      </div>
    </section>
  );
}
