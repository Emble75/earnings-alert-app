import type { PlayerCard } from '@shared/football/types';
import { nickname, profileToken, seats, type Seat } from './storage';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      'network',
      'Can’t reach the server. Check your connection and try again.',
      0,
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(
      e?.code ?? 'error',
      e?.message ?? `Request failed (${res.status}).`,
      res.status,
    );
  }
  return body as T;
}

export interface DataInfo {
  sourceId: string;
  label: string;
  kind: 'sample' | 'live' | 'import';
  isSample: boolean;
  fallback: boolean;
  generatedAt: string;
  currentSeason: number;
  license: string;
  attribution: string;
  notes: string;
  counts: {
    players: number;
    teams: number;
    competitions: number;
    affiliations: number;
    memberships: number;
  };
}
export interface Meta {
  data: DataInfo;
  games: { id: string; title: string; tagline: string; minPlayers: number; maxPlayers: number }[];
}

export const api = {
  meta: () => request<Meta>('/api/meta'),
  roomInfo: (code: string) =>
    request<{ code: string; players: number; status: string; gameId: string; joinable: boolean }>(
      `/api/rooms/${encodeURIComponent(code)}`,
    ),
  async createRoom(name: string): Promise<Seat> {
    const r = await request<{ code: string; playerId: string; token: string }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, profileToken: profileToken.get() ?? undefined }),
    });
    const seat = { ...r, name };
    nickname.set(name);
    seats.set(seat);
    return seat;
  },
  async joinRoom(code: string, name: string): Promise<Seat> {
    const r = await request<{ code: string; playerId: string; token: string }>(
      `/api/rooms/${encodeURIComponent(code)}/join`,
      {
        method: 'POST',
        body: JSON.stringify({ name, profileToken: profileToken.get() ?? undefined }),
      },
    );
    const seat = { ...r, name };
    nickname.set(name);
    seats.set(seat);
    return seat;
  },
  async searchPlayers(q: string, signal?: AbortSignal): Promise<PlayerCard[]> {
    const r = await request<{ results: PlayerCard[] }>(
      `/api/players/search?q=${encodeURIComponent(q)}&limit=8`,
      { signal },
    );
    return r.results;
  },
  createProfile: (nick: string) =>
    request<{ id: string; nickname: string; token: string }>('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ nickname: nick }),
    }),
  profile: (token: string) =>
    request<{
      id: string;
      nickname: string;
      gamesPlayed: number;
      wins: number;
      byGame: Record<string, { played: number; wins: number; points: number }>;
    }>('/api/profile', {
      headers: { authorization: `Bearer ${token}` },
    }),
  deleteProfile: (token: string) =>
    request<{ ok: boolean }>('/api/profile', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),
  adminStatus: (token: string) =>
    request<AdminStatus>('/api/admin/status', { headers: { authorization: `Bearer ${token}` } }),
  adminSync: (token: string) =>
    request<{ run: AdminStatus['runs'][number]; status: AdminStatus }>('/api/admin/sync', {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}` },
    }),
};

export interface AdminStatus extends DataInfo {
  provider: string;
  lastSuccessAt: string | null;
  ageHours: number | null;
  stale: boolean;
  conflicts: { kind: string; n: number }[];
  runs: {
    id: number;
    sourceId: string;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    stats: Record<string, unknown>;
    error: string | null;
  }[];
  scheduleHours: number;
  rooms: number;
  db: string;
  staleAfterHours: number;
}
