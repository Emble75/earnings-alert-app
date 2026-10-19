import fs from 'node:fs';

/** Tiny .env loader so scripts work without extra dependencies (real env vars win). */
export function loadDotEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2]!.replace(/^["']|["']$/g, '');
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
  }
}
