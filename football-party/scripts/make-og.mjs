// Renders the 1200x630 social preview (public/og.png) with Playwright's Chromium.
import { chromium } from '@playwright/test';
import { chromiumPath } from './browser.mjs';

const html = `<body style="margin:0;width:1200px;height:630px;background:#0a120e;color:#eef1e2;font-family:Impact,'Arial Narrow',sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;inset:0;background:radial-gradient(circle at 85% 20%,#1a3a26,transparent 55%)"></div>
  <div style="position:absolute;left:60px;top:48px;font:700 26px ui-monospace,monospace;letter-spacing:.2em;color:#d4ff3f">PITCHSIDE · FOOTBALL PARTY GAMES</div>
  <div style="position:absolute;left:60px;top:130px;font-size:112px;line-height:1;font-weight:900;text-transform:uppercase">Pick a game.<br><span style="background:#d4ff3f;color:#0a120e;padding:0 .12em">Beat your friends.</span></div>
  <div style="position:absolute;left:60px;bottom:52px;font:600 34px system-ui,sans-serif;color:#b3bda9">Impostor · Tic-Tac-Toe · Link-Up · Career Path</div>
</body>`;
const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.screenshot({ path: 'public/og.png' });
await browser.close();
console.log('wrote public/og.png');
