import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer } from '../server/main';

async function boot(extra: Record<string, string>) {
  const ctx = await startServer({
    PORT: '0',
    HOST: '127.0.0.1',
    DB_MODE: 'memory',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...extra,
  });
  const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  const close = async () => {
    ctx.rooms.close();
    ctx.football.stop();
    await ctx.app.close();
    await ctx.db.close();
  };
  return { ctx, base, close };
}

describe('launch setup: ads off (default)', () => {
  let s: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => (s = await boot({})));
  afterAll(() => s.close());

  it('has no ads configured, no ads.txt and a strict CSP', async () => {
    const site = await (await fetch(s.base + '/api/site')).json();
    expect(site.ads).toBeNull();
    expect((await fetch(s.base + '/ads.txt')).status).toBe(404);
    const res = await fetch(s.base + '/robots.txt');
    expect(await res.text()).toContain('Disallow: /api/');
  });
});

describe('launch setup: ads on', () => {
  let s: Awaited<ReturnType<typeof boot>>;
  beforeAll(
    async () =>
      (s = await boot({
        ADS_CLIENT: 'ca-pub-1234567890123456',
        ADS_BANNER_SLOT: '1234567890',
        PUBLIC_ORIGIN: 'https://example.test',
        LEGAL_NAME: 'Test Person',
        LEGAL_EMAIL: 'hi@example.test',
      })),
  );
  afterAll(() => s.close());

  it('publishes ad ids, ads.txt, sitemap and legal data', async () => {
    const site = await (await fetch(s.base + '/api/site')).json();
    expect(site.ads).toEqual({ client: 'ca-pub-1234567890123456', bannerSlot: '1234567890' });
    expect(site.legal.name).toBe('Test Person');
    expect(await (await fetch(s.base + '/ads.txt')).text()).toBe(
      'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n',
    );
    const map = await (await fetch(s.base + '/sitemap.xml')).text();
    expect(map).toContain('<loc>https://example.test/impressum</loc>');
  });

  it('only widens the CSP to Google ad domains when ads are configured', async () => {
    const { buildCsp } = await import('../server/http/app');
    expect(buildCsp(false)).not.toContain('googlesyndication');
    expect(buildCsp(false)).toContain("frame-src 'none'");
    expect(buildCsp(true)).toContain('pagead2.googlesyndication.com');
    expect(buildCsp(true)).toContain("frame-ancestors 'none'");
  });
});
