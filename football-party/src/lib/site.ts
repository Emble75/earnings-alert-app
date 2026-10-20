import { useEffect, useState } from 'react';

export interface SiteConfig {
  ads: { client: string; bannerSlot: string | null } | null;
  legal: { name: string | null; address: string | null; email: string | null };
}
const EMPTY: SiteConfig = { ads: null, legal: { name: null, address: null, email: null } };

let current: SiteConfig = EMPTY;
let loaded: Promise<SiteConfig> | null = null;
const listeners = new Set<() => void>();

export function loadSite(): Promise<SiteConfig> {
  loaded ??= fetch('/api/site')
    .then((r) => (r.ok ? (r.json() as Promise<SiteConfig>) : EMPTY))
    .catch(() => EMPTY)
    .then((c) => {
      current = c;
      listeners.forEach((l) => l());
      return c;
    });
  return loaded;
}

export function useSite(): SiteConfig {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void loadSite();
    return () => void listeners.delete(l);
  }, []);
  return current;
}
