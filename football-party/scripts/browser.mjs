import fs from 'node:fs';
import path from 'node:path';

/**
 * Locates a Chromium binary. Prefers CHROMIUM_PATH, then any pre-installed chromium-* under
 * PLAYWRIGHT_BROWSERS_PATH (useful when the installed Playwright build differs from the cached
 * browser revision), else returns undefined so Playwright uses its own download.
 */
export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  for (const dir of fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse()) {
    const p = path.join(root, dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
