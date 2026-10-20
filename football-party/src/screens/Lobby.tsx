import { useEffect, useState } from 'react';
import { Crown, Database, Loader2, Play, UserMinus } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { clientGameList, clientGames } from '@/games/registry';
import type { RoomController } from '@/lib/room-controller';
import { Avatar, IconButton, Button, useToast } from '@/ui/kit';
import { shareUrl } from './RoomFrame';

export function Lobby({ ctl }: { ctl: RoomController }) {
  const { view } = ctl;
  const toast = useToast();
  const isHost = view.you === view.hostId;
  const game = clientGames[view.gameId];
  const connected = view.players.filter((p) => p.connected).length;
  const [starting, setStarting] = useState(false);
  const [kick, setKick] = useState<string | null>(null);
  const wanted = (useLocation().state as { game?: string } | null)?.game;
  useEffect(() => {
    if (isHost && wanted && wanted in clientGames && wanted !== view.gameId)
      ctl.send({ type: 'game.select', gameId: wanted as never }).catch(() => undefined);
    // only once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (cmd: Parameters<RoomController['send']>[0]) => {
    try {
      await ctl.send(cmd);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work.');
      return false;
    }
  };
  const need = Math.max(0, view.limits.min - connected);
  const startReason =
    need > 0 ? `Need ${need} more player${need > 1 ? 's' : ''} for ${game.title}` : null;
  const Config = game.Config;

  return (
    <div className="lobby">
      <section className="invite card paper" aria-labelledby="invite-h">
        <div className="eyebrow" id="invite-h">
          Room code
        </div>
        <div className="invite-code mono" aria-label={`Room code ${view.code.split('').join(' ')}`}>
          {view.code.split('').map((ch, i) => (
            <span key={i}>{ch}</span>
          ))}
        </div>
        <p className="invite-url mono">{shareUrl(view.code).replace(/^https?:\/\//, '')}</p>
        <p className="field-hint" style={{ color: 'var(--paper-dim)' }}>
          Friends can scan, tap the link, or type the code at <strong>/play</strong>. Anyone can
          join while you’re in the lobby.
        </p>
      </section>

      <section className="roster card" aria-labelledby="roster-h">
        <div className="eyebrow">02 · Who’s in</div>
        <div className="row">
          <h2 id="roster-h" className="card-title" style={{ margin: 0 }}>
            Squad
          </h2>
          <span className="chip">{view.players.length}/12</span>
        </div>
        <ul className="plain-list roster-list">
          {view.players.map((p) => (
            <li key={p.id} className="roster-row">
              <Avatar id={p.id} name={p.name} />
              <div className="who">
                <span className="name">
                  {p.name}
                  {p.isHost && (
                    <Crown
                      size={14}
                      aria-label="Host"
                      style={{ marginLeft: 6, verticalAlign: -2, color: 'var(--card-yellow)' }}
                    />
                  )}
                </span>
                <span className="sub">
                  <i className={`dot ${p.connected ? 'on' : 'warn'}`} />{' '}
                  {p.connected ? 'Ready' : 'Reconnecting'}
                  {p.id === view.you && ' · you'}
                </span>
              </div>
              {view.gamesPlayed > 0 && (
                <span className="chip mono" title="Points across all games in this room">
                  {p.total} pts
                </span>
              )}
              {isHost && p.id !== view.you && (
                <IconButton label={`Remove ${p.name}`} onClick={() => setKick(p.id)}>
                  <UserMinus size={18} aria-hidden />
                </IconButton>
              )}
              {kick === p.id && (
                <span className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => (
                      await run({ type: 'room.kick', playerId: p.id }),
                      setKick(null)
                    )}
                  >
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setKick(null)}>
                    Cancel
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="picker-games" aria-labelledby="game-h">
        <h2 id="game-h" className="card-title">
          {isHost ? 'Choose the game' : 'Tonight’s game'}
        </h2>
        <div className="game-options" role="radiogroup" aria-labelledby="game-h">
          {clientGameList.map((g) => (
            <button
              key={g.id}
              type="button"
              role="radio"
              aria-checked={view.gameId === g.id}
              disabled={!isHost}
              className={`game-option ${view.gameId === g.id ? 'on' : ''}`}
              onClick={() => isHost && run({ type: 'game.select', gameId: g.id })}
            >
              <g.icon size={28} aria-hidden />
              <span className="go-title">{g.title}</span>
              <span className="go-tag">{g.tagline}</span>
              <span className="row wrap">
                <span className="chip">{g.players}</span>
                <span className="chip">{g.length}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="card settings" aria-labelledby="settings-h">
        <div className="eyebrow">04 · Match settings</div>
        <div className="row">
          <h2 id="settings-h" className="card-title" style={{ margin: 0 }}>
            Settings
          </h2>
          {!isHost && <span className="chip">Host controls</span>}
        </div>
        <Config
          config={view.config as never}
          onChange={(patch: Record<string, unknown>) => run({ type: 'game.config', config: patch })}
          disabled={!isHost}
          playerCount={view.players.length}
        />
        <details className="rules-mini" style={{ marginTop: 'var(--s-4)' }}>
          <summary>Rules in 20 seconds</summary>
          <ul>
            {game.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      </section>

      <section className="start-bar" aria-label="Start game">
        {isHost ? (
          <>
            <Button
              size="lg"
              block
              disabled={!!startReason}
              loading={starting}
              onClick={async () => {
                setStarting(true);
                const ok = await run({ type: 'game.start' });
                if (!ok) setStarting(false);
              }}
            >
              <Play aria-hidden /> Kick off {game.title}
            </Button>
            {startReason && (
              <p className="field-hint" role="status">
                {startReason}.
              </p>
            )}
          </>
        ) : (
          <p className="waiting">
            <Loader2 className="spin" size={18} aria-hidden /> Waiting for the host to start…
          </p>
        )}
      </section>

      <DataNotice data={view.data} />
    </div>
  );
}

export function DataNotice({
  data,
}: {
  data: { kind: string; label: string; generatedAt: string; currentSeason: number };
}) {
  const sample = data.kind === 'sample';
  const date = new Date(data.generatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  if (!sample)
    return (
      <p className="data-note field-hint">
        Football data as of {date}. <Link to="/data">How it works</Link>
      </p>
    );
  return (
    <aside className="banner data-notice" aria-label="Football data freshness">
      <Database size={18} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
      <span>
        <strong>Sample football data.</strong> A small hand-curated set (snapshot {date}), not live
        or complete — answers outside it can’t be verified. <Link to="/data">How this works</Link>
      </span>
    </aside>
  );
}
