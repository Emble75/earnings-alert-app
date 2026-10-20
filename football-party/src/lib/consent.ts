import { useSyncExternalStore } from 'react';

export type Consent = 'granted' | 'denied' | null;
const KEY = 'pitchside.consent.ads';
const listeners = new Set<() => void>();

function read(): Consent {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}
let value: Consent = read();

export const getConsent = () => value;
export function setConsent(c: Consent) {
  value = c;
  try {
    if (c) localStorage.setItem(KEY, c);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the choice lasts for this visit only */
  }
  listeners.forEach((l) => l());
}
export function useConsent(): Consent {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => value,
  );
}
