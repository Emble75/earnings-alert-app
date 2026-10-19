import { useSyncExternalStore } from 'react';
import { store } from './storage';

export interface Prefs {
  sound: boolean;
  haptics: boolean;
  calm: boolean;
}
const KEY = 'pitchside.prefs';
let prefs: Prefs = {
  sound: false,
  haptics: true,
  calm: false,
  ...store.getJson<Partial<Prefs>>(KEY, {}),
};
const listeners = new Set<() => void>();

function apply() {
  document.documentElement.dataset.motion = prefs.calm ? 'reduced' : 'full';
}
if (typeof document !== 'undefined') apply();

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  prefs = { ...prefs, [k]: v };
  store.set(KEY, JSON.stringify(prefs));
  apply();
  listeners.forEach((l) => l());
}
export const getPrefs = () => prefs;
export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => prefs,
  );
}

/* ---- Optional feedback: sound is OFF by default and fully user-controlled; haptics only where supported. ---- */
let ctx: AudioContext | null = null;
function tone(freq: number, dur: number, when = 0, type: OscillatorType = 'sine', gain = 0.06) {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime + when);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + dur);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + when);
    o.stop(ctx.currentTime + when + dur + 0.02);
  } catch {
    /* audio blocked or unsupported */
  }
}

export type Cue = 'tap' | 'success' | 'fail' | 'reveal' | 'whistle' | 'turn';
export function cue(kind: Cue) {
  if (prefs.haptics && 'vibrate' in navigator) {
    const pattern = {
      tap: 8,
      success: [14, 40, 14],
      fail: [40, 30, 40],
      reveal: [20, 60, 60],
      whistle: 25,
      turn: 12,
    }[kind];
    try {
      navigator.vibrate(pattern);
    } catch {
      /* unsupported */
    }
  }
  if (!prefs.sound) return;
  switch (kind) {
    case 'tap':
      return tone(520, 0.06, 0, 'triangle');
    case 'turn':
      return tone(660, 0.1, 0, 'triangle');
    case 'success':
      return (tone(523, 0.12), tone(784, 0.2, 0.1));
    case 'fail':
      return (tone(220, 0.18, 0, 'sawtooth', 0.04), tone(170, 0.25, 0.12, 'sawtooth', 0.04));
    case 'reveal':
      return (tone(392, 0.14), tone(523, 0.14, 0.14), tone(784, 0.3, 0.28));
    case 'whistle':
      return tone(2200, 0.35, 0, 'sine', 0.05);
  }
}
