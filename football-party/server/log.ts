/** Minimal structured JSON logger. Secrets are redacted by key name; free text is never logged raw. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};
const SENSITIVE = /token|secret|password|authorization|api[-_]?key|cookie|database_url/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  level: Level | 'silent' = 'info',
  base: Record<string, unknown> = {},
): Logger {
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level: lvl,
      msg,
      ...(redact({ ...base, ...fields }) as object),
    });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }),
  };
}

export const silentLogger: Logger = createLogger('silent');

export function errInfo(e: unknown): Record<string, unknown> {
  return e instanceof Error ? { err: e.message, errName: e.name } : { err: String(e) };
}
