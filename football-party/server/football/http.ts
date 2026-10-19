import type { Logger } from '../log';

export interface HttpOptions {
  userAgent: string;
  /** Minimum gap between requests to the same client instance (client-side rate limit). */
  minIntervalMs?: number;
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log: Logger;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** GET client (JSON or text) with polite spacing, retry + exponential backoff + Retry-After support. */
export function createClient(opts: HttpOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  let last = 0;

  async function get<T>(url: string, parse: (res: Response) => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      const wait = (opts.minIntervalMs ?? 0) - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
        opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
        let res: Response;
        try {
          res = await doFetch(url, {
            headers: { 'User-Agent': opts.userAgent, Accept: '*/*' },
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) return await parse(res);
        if (!RETRYABLE.has(res.status) || attempt >= retries)
          throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}`);
        const ra = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : base * 2 ** attempt;
        opts.log.warn('http retry', { status: res.status, attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (opts.signal?.aborted) throw e;
        if (attempt >= retries) throw e;
        const delay = base * 2 ** attempt;
        opts.log.warn('http network error, retrying', { attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
      }
      attempt += 1;
    }
  }
  return {
    json: <T>(url: string) => get<T>(url, async (r) => (await r.json()) as T),
    text: (url: string) => get<string>(url, (r) => r.text()),
  };
}

export function createJsonClient(opts: HttpOptions) {
  return createClient(opts).json;
}
