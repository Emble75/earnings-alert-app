import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Search, SearchX } from 'lucide-react';
import type { PlayerCard } from '@shared/football/types';
import { useDebounced } from '@/lib/clock';
import { Button, Sheet, Skeleton } from '@/ui/kit';

type Status = 'idle' | 'loading' | 'done' | 'error';

/**
 * Searchable footballer selector (ARIA combobox/listbox). Debounced, abortable, cached per query,
 * accent-insensitive on the server. Footballers already used this round are shown but disabled.
 */
export function PlayerPicker({
  open,
  onClose,
  onPick,
  search,
  usedIds,
  cellLabel,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (p: PlayerCard) => void;
  search: (q: string, signal?: AbortSignal) => Promise<PlayerCard[]>;
  usedIds: ReadonlySet<string>;
  cellLabel: string;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 180);
  const [results, setResults] = useState<PlayerCard[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const cache = useRef(new Map<string, PlayerCard[]>());
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      setStatus('idle');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (dq.length < 2) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const hit = cache.current.get(dq.toLowerCase());
    if (hit) {
      setResults(hit);
      setStatus('done');
      setActive(0);
      return;
    }
    const ctrl = new AbortController();
    setStatus('loading');
    search(dq, ctrl.signal)
      .then((r) => {
        cache.current.set(dq.toLowerCase(), r);
        setResults(r);
        setStatus('done');
        setActive(0);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setStatus('error');
      });
    return () => ctrl.abort();
  }, [dq, open, search, retry]);

  const choose = (p: PlayerCard) => {
    if (usedIds.has(p.id)) return;
    onPick(p);
  };

  return (
    <Sheet open={open} onClose={onClose} title={cellLabel} initialFocus={input}>
      <div className="picker">
        <div className="picker-input">
          <Search size={20} aria-hidden />
          <input
            ref={input}
            className="input"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search footballers"
            placeholder="Search a footballer…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault();
                choose(results[active]!);
              }
            }}
          />
        </div>
        <div className="picker-body" aria-live="polite">
          {status === 'idle' && (
            <p className="picker-note">
              Type at least two letters. Accents don’t matter — “muller” finds Müller.
            </p>
          )}
          {status === 'loading' && (
            <div className="stack" style={{ ['--stack' as string]: '10px' }} aria-label="Searching">
              <Skeleton h={52} />
              <Skeleton h={52} />
              <Skeleton h={52} />
            </div>
          )}
          {status === 'error' && (
            <div className="picker-note">
              <AlertTriangle aria-hidden size={28} />
              <p>Couldn’t search right now. Check your connection.</p>
              <Button size="sm" variant="secondary" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </Button>
            </div>
          )}
          {status === 'done' && results.length === 0 && (
            <div className="picker-note">
              <SearchX aria-hidden size={28} />
              <p>
                No footballers match “{dq}”. Try a surname, or check the spelling — our data only
                covers players it can verify.
              </p>
            </div>
          )}
          {status === 'done' && results.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Footballers" className="picker-list">
              {results.map((p, i) => {
                const used = usedIds.has(p.id);
                return (
                  <li
                    key={p.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={used}
                    className={`${i === active ? 'active' : ''} ${used ? 'used' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(p)}
                  >
                    <span className="p-name">{p.name}</span>
                    <span className="p-hint mono">{used ? 'already used' : p.hint}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}
