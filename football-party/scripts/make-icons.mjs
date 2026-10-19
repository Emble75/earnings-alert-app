// Renders PNG icons from public/icons/icon.svg using the Chromium that Playwright provides.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import { chromiumPath } from './browser.mjs';

const svg = fs.readFileSync('public/icons/icon.svg', 'utf8');
const maskable = svg
  .replace(
    '<rect width="512" height="512" rx="112" fill="#0a120e"/>',
    '<rect width="512" height="512" fill="#d4ff3f"/>',
  )
  .replace('<rect x="56" y="56" width="400" height="400" rx="72" fill="#d4ff3f"/>', '')
  .replace('<g ', '<g transform="translate(256 256) scale(.72) translate(-256 -256)" ')
  .replace(
    '<circle cx="352"',
    '<circle transform="translate(256 256) scale(.72) translate(-256 -256)" cx="352"',
  );

const browser = await chromium.launch({ executablePath: chromiumPath() });
async function render(markup, size, file, bg = 'transparent') {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0;background:${bg}">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`,
  );
  await page.screenshot({ path: file, omitBackground: bg === 'transparent' });
  await page.close();
}
await render(svg, 192, 'public/icons/icon-192.png');
await render(svg, 512, 'public/icons/icon-512.png');
await render(svg, 180, 'public/icons/apple-touch-icon.png', '#0a120e');
await render(maskable, 512, 'public/icons/maskable-512.png', '#d4ff3f');
await browser.close();
console.log('icons written');
