import { useEffect, useRef } from 'react';
import { useConsent, setConsent } from '@/lib/consent';
import { ensureAds } from '@/lib/ads';
import { useSite } from '@/lib/site';
import { Button } from './kit';

/** Always-on banner slot. Renders nothing unless ads are configured and the visitor consented. */
export function AdBanner() {
  const site = useSite();
  const consent = useConsent();
  const ref = useRef<HTMLModElement>(null);
  const pushed = useRef(false);
  const slot = site.ads?.bannerSlot;
  useEffect(() => {
    if (!site.ads || !slot || consent !== 'granted' || pushed.current) return;
    void ensureAds().then((ok) => {
      if (!ok || pushed.current || !ref.current) return;
      pushed.current = true;
      try {
        ((window.adsbygoogle = window.adsbygoogle || []) as unknown[]).push({});
      } catch {
        /* ad blocked */
      }
    });
  }, [site.ads, slot, consent]);
  if (!site.ads || !slot || consent !== 'granted') return null;
  return (
    <aside className="ad-banner" aria-label="Advertisement">
      <ins
        ref={ref}
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={site.ads.client}
        data-ad-slot={slot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}

/** Asks before any ad script loads. Only shown when the site actually has ads configured. */
export function ConsentBanner() {
  const site = useSite();
  const consent = useConsent();
  if (!site.ads || consent !== null) return null;
  return (
    <div className="consent" role="dialog" aria-label="Advertising choices">
      <p>
        Pitchside is free and paid for by ads. May we load ads (Google AdSense, which uses cookies
        and similar technology)? You can change this any time under “Ad settings” at the bottom.{' '}
        <a href="/privacy">Privacy</a>
      </p>
      <div className="row wrap">
        <Button size="sm" onClick={() => setConsent('granted')}>
          Allow ads
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setConsent('denied')}>
          No thanks
        </Button>
      </div>
    </div>
  );
}
