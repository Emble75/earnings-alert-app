import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, LogOut, Share2, Users, Wifi, WifiOff } from 'lucide-react';
import { clientGames } from '@/games/registry';
import { seats } from '@/lib/storage';
import type { RoomController } from '@/lib/room-controller';
import type { ConnStatus } from '@/lib/useRoomConnection';
import { Button, IconButton, Sheet, useToast } from '@/ui/kit';
import { Footer, Header } from './Shell';
import { Lobby } from './Lobby';

export interface LocalHooks {
  onExit: () => void;
  onRestart: () => void;
}

export function shareUrl(code: string) {
  return `${location.origin}/r/${code}`;
}

export function RoomFrame({
  ctl,
  status = 'open',
  local,
}: {
  ctl: RoomController;
  status?: ConnStatus;
  local?: LocalHooks;
}) {
  const { view } = ctl;
  const nav = useNavigate();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Local practice has no lobby: finishing "back to lobby" returns to setup.
  useEffect(() => {
    if (local && view.status === 'lobby') local.onExit();
  }, [local, view.status]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(view.code));
      setCopied(true);
      toast('Invite link copied', 'info');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast(`Copy this link: ${shareUrl(view.code)}`, 'info');
    }
  };
  const share = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Pitchside',
          text: `Join my Pitchside room ${view.code}`,
          url: shareUrl(view.code),
        });
        return;
      } catch {
        /* dismissed */
      }
    }
    void copy();
  };

  const leave = async () => {
    if (local) return local.onExit();
    try {
      await ctl.send({ type: 'room.leave' });
    } catch {
      /* leaving anyway */
    }
    seats.clear(view.code);
    nav('/');
  };

  const Screen = view.game ? clientGames[view.game.id].Screen : null;
  const online = status === 'open';

  return (
    <>
      <Header>
        {local ? (
          <span className="chip yellow">One phone</span>
        ) : (
          <>
            <button
              type="button"
              className="code-chip"
              onClick={copy}
              aria-label={`Room code ${view.code.split('').join(' ')}. Copy invite link`}
            >
              <span className="mono">{view.code}</span>
              {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
            </button>
            <IconButton label="Share invite" onClick={share}>
              <Share2 size={20} aria-hidden />
            </IconButton>
            <span className="conn hide-sm" role="status">
              {online ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />}
              {online ? 'Live' : 'Reconnecting…'}
            </span>
          </>
        )}
        <span className="chip hide-sm">
          <Users size={12} aria-hidden /> {view.players.length}
        </span>
        <IconButton label={local ? 'End game' : 'Leave room'} onClick={() => setLeaving(true)}>
          <LogOut size={20} aria-hidden />
        </IconButton>
      </Header>

      {!online && !local && (
        <div className="reconnect-bar" role="status">
          <WifiOff size={16} aria-hidden /> Connection lost — reconnecting. Your seat is saved and
          the game keeps going.
        </div>
      )}

      <main id="main" tabIndex={-1} className="container room-main">
        {local && (
          <p className="banner" style={{ marginBottom: 'var(--s-4)' }}>
            <span>
              <strong>One phone, in person.</strong> Not online multiplayer ·{' '}
              {view.data.kind === 'sample' ? 'built-in sample data' : view.data.label}
            </span>
          </p>
        )}
        {view.status === 'lobby' || !Screen ? <Lobby ctl={ctl} /> : <Screen ctl={ctl} />}
      </main>
      <Footer />

      <Sheet
        open={leaving}
        onClose={() => setLeaving(false)}
        title={local ? 'End this game?' : 'Leave this room?'}
      >
        <p style={{ color: 'var(--chalk-dim)', marginBottom: 'var(--s-5)' }}>
          {local
            ? 'Your practice game will end.'
            : view.status === 'playing'
              ? 'A game is in progress. You’ll lose your seat and your points for this game.'
              : 'You can rejoin later with the room code while the room exists.'}
        </p>
        <div className="row wrap">
          <Button variant="danger" onClick={leave}>
            {local ? 'End game' : 'Leave room'}
          </Button>
          <Button variant="secondary" onClick={() => setLeaving(false)}>
            Stay
          </Button>
        </div>
      </Sheet>
    </>
  );
}
