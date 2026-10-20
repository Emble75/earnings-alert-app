import { getConsent } from './consent';
import { loadSite } from './site';

/**
 * Google AdSense / H5 Games Ads glue. Nothing here runs unless the server has ADS_CLIENT configured
 * AND the visitor consented. Ad breaks follow Google's `adBreak` placement API (natural pauses only).
 */
type AdBreak = (o: Record<string, unknown>) => void;
declare global {
  interface Window {
    adsbygoogle?: unknown[];
    adBreak?: AdBreak;
    adConfig?: AdBreak;
  }
}

let scriptPromise: Promise<boolean> | null = null;

/** Loads Google's ad script once, after consent. Resolves false when ads are off or blocked. */
export function ensureAds(): Promise<boolean> {
  if (getConsent() !== 'granted') return Promise.resolve(false);
  scriptPromise ??= loadSite().then(
    (site) =>
      new Promise<boolean>((resolve) => {
        if (!site.ads) return resolve(false);
        window.adsbygoogle = window.adsbygoogle || [];
        const push: AdBreak = (o) => (window.adsbygoogle as unknown[]).push(o);
        window.adBreak = window.adConfig = push;
        const s = document.createElement('script');
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.setAttribute('data-ad-client', site.ads.client);
        s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
        s.onload = () => {
          window.adConfig?.({ preloadAdBreaks: 'on', sound: 'on' });
          resolve(true);
        };
        s.onerror = () => resolve(false); // ad blocker: the game goes on
        document.head.appendChild(s);
      }),
  );
  return scriptPromise;
}

/**
 * A short ad at a natural pause. Always resolves (never blocks the game for long): immediately when
 * ads are off, blocked or no ad is available, otherwise when the ad is done.
 */
export async function showBreak(name: string): Promise<void> {
  if (!(await ensureAds()) || !window.adBreak) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 45_000); // safety net
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    window.adBreak!({ type: 'next', name, afterAd: done, adBreakDone: done });
  });
}
