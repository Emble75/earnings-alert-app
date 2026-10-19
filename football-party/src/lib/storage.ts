/** localStorage that never throws (private mode, blocked storage, SSR). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: the app still works, it just won't remember */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
};

export interface Seat {
  code: string;
  playerId: string;
  token: string;
  name: string;
}
const seatKey = (code: string) => `pitchside.seat.${code}`;
export const seats = {
  get: (code: string) => store.getJson<Seat | null>(seatKey(code), null),
  set: (s: Seat) => store.set(seatKey(s.code), JSON.stringify(s)),
  clear: (code: string) => store.remove(seatKey(code)),
};

export const nickname = {
  get: () => store.get('pitchside.nickname') ?? '',
  set: (n: string) => store.set('pitchside.nickname', n),
};
export const profileToken = {
  get: () => store.get('pitchside.profile'),
  set: (t: string) => store.set('pitchside.profile', t),
  clear: () => store.remove('pitchside.profile'),
};
