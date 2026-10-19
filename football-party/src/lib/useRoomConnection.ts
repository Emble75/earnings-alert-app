import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, RoomView, ServerMessage } from '@shared/room/types';
import { seats, type Seat } from './storage';

export type ConnStatus =
  'connecting' | 'open' | 'reconnecting' | 'kicked' | 'closed' | 'unauthorized';

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the WebSocket for one room seat: auth handshake, exponential-backoff reconnect, heartbeat,
 * resync-on-reconnect (the server always sends a full state first) and nonce-tracked commands.
 */
export function useRoomConnection(seat: Seat) {
  const [view, setView] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const attempt = useRef(0);
  const nonceN = useRef(0);
  const lastMsg = useRef(Date.now());
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (stopped.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?code=${seat.code}`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'auth', token: seat.token }));
        lastMsg.current = Date.now();
      };
      ws.onmessage = (ev) => {
        lastMsg.current = Date.now();
        let m: ServerMessage;
        try {
          m = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        if (m.t === 'state') {
          attempt.current = 0;
          setStatus('open');
          setClockOffset(m.view.serverNow - Date.now());
          setView((prev) =>
            prev &&
            m.view.version < prev.version &&
            m.view.code === prev.code &&
            prev.you === m.view.you
              ? prev
              : m.view,
          );
        } else if (m.t === 'ack' || m.t === 'error') {
          const p = m.nonce ? pending.current.get(m.nonce) : undefined;
          if (p && m.nonce) {
            clearTimeout(p.timer);
            pending.current.delete(m.nonce);
            if (m.t === 'ack') p.resolve();
            else p.reject(new Error(m.message));
          } else if (m.t === 'error' && m.code === 'unauthorized') {
            setStatus('unauthorized');
          }
        } else if (m.t === 'pong') {
          setClockOffset(m.serverNow - Date.now());
        } else if (m.t === 'kicked') {
          stopped.current = true;
          seats.clear(seat.code);
          setStatus('kicked');
        } else if (m.t === 'closed') {
          setClosedReason(m.reason);
        }
      };
      ws.onclose = (ev) => {
        wsRef.current = null;
        if (stopped.current) return;
        if (ev.code === 4401) {
          stopped.current = true;
          seats.clear(seat.code);
          setStatus('unauthorized');
          return;
        }
        if (ev.code === 4000 || ev.code === 4001) {
          stopped.current = true;
          if (ev.code === 4000) seats.clear(seat.code);
          setStatus('closed');
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(8000, 400 * 2 ** attempt.current++) + Math.random() * 300;
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    // Heartbeat: detect half-open sockets and keep NAT/proxies alive.
    const beat = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMsg.current > 45_000) return ws.close();
      ws.send(JSON.stringify({ t: 'ping' }));
    }, 15_000);

    const wake = () => {
      if (stopped.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        clearTimeout(retryTimer);
        attempt.current = 0;
        connect();
      }
    };
    window.addEventListener('online', wake);
    const vis = () => document.visibilityState === 'visible' && wake();
    document.addEventListener('visibilitychange', vis);

    const pend = pending.current;
    return () => {
      stopped.current = true;
      clearTimeout(retryTimer);
      clearInterval(beat);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', vis);
      wsRef.current?.close();
      pend.forEach((p) => clearTimeout(p.timer));
      pend.clear();
    };
  }, [seat.code, seat.token]);

  const send = useCallback((cmd: Command) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Reconnecting… try again in a moment.'));
    const nonce = `${Date.now().toString(36)}-${++nonceN.current}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(nonce);
        reject(new Error('No response from the server. Check your connection.'));
      }, 8000);
      pending.current.set(nonce, { resolve, reject, timer });
      ws.send(JSON.stringify({ t: 'cmd', nonce, cmd }));
    });
  }, []);

  return { view, status, closedReason, clockOffset, send };
}
