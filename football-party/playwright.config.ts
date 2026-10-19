import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Use a pre-installed Chromium when the cached revision differs from this Playwright build. */
function chromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  for (const d of fs
    .readdirSync(root)
    .filter((x) => /^chromium-\d+$/.test(x))
    .sort()
    .reverse()) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    launchOptions: { executablePath: chromium() },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node dist-server/main.js',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '8799',
      HOST: '127.0.0.1',
      DB_MODE: 'memory',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
