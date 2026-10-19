import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2, X } from 'lucide-react';

/* ---------- Button ---------- */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'paper';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
}
const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    block,
    loading,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cls(
        'btn',
        variant !== 'primary' && variant,
        size !== 'md' && size,
        block && 'block',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Loader2 className="spin" aria-hidden />}
      {children}
    </button>
  );
});

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  block,
  children,
  className,
}: {
  to: string;
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cls(
        'btn',
        variant !== 'primary' && variant,
        size !== 'md' && size,
        block && 'block',
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function IconButton({
  label,
  pressed,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------- Field ---------- */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p className="field-error" id={`${id}-err`} role="alert">
          <AlertTriangle size={16} aria-hidden style={{ flex: 'none', marginTop: 3 }} />
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- Segmented control (radio group semantics) ---------- */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);
  const move = (d: number) => {
    const next = (idx + d + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className="field">
      <span className="field-label" id={`seg-${label}`}>
        {label}
      </span>
      <div
        className="seg"
        role="radiogroup"
        aria-labelledby={`seg-${label}`}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {options.map((o, i) => (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={o.value === value ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Stepper ---------- */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span className="field-label" id={id}>
        {label}
      </span>
      <div className="stepper">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={disabled || value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          −
        </button>
        <output aria-live="polite">
          {value}
          {suffix}
        </output>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

/* ---------- Dialog / sheet (native <dialog>: focus trap + Esc for free) ---------- */
export function Sheet({
  open,
  onClose,
  title,
  children,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      initialFocus?.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, initialFocus]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // backdrop click
      }}
    >
      {open && (
        <>
          <div className="sheet-head">
            <h2>{title}</h2>
            <IconButton label="Close" onClick={onClose}>
              <X size={18} aria-hidden />
            </IconButton>
          </div>
          <div className="sheet-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

/* ---------- Toasts ---------- */
interface Toast {
  id: number;
  text: string;
  tone: 'error' | 'info';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((text: string, tone: Toast['tone'] = 'error') => {
    const id = ++idRef.current;
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cls('toast', t.tone === 'info' && 'info')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Identity visuals ---------- */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const AVATAR_COLORS = [
  '#d4ff3f',
  '#ffd426',
  '#7cf0c9',
  '#ff9d5c',
  '#a7c8ff',
  '#ff8fa3',
  '#c9f27a',
  '#f2e3a0',
];

export function Avatar({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  const c = AVATAR_COLORS[hash(id) % AVATAR_COLORS.length]!;
  return (
    <span
      className="avatar"
      aria-hidden
      style={{ ['--c' as string]: c, width: size, height: size, fontSize: size * 0.46 }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function readable(bg: string) {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#0e1510' : '#ffffff';
}

/** Text-based team identity: initials on the kit colour. No crests or logos are ever hotlinked. */
export function Monogram({
  short,
  color,
  size = 40,
  square,
}: {
  short: string;
  color?: string;
  size?: number;
  square?: boolean;
}) {
  const c = color ?? '#2b3a33';
  return (
    <span
      className={cls('mono-badge', square && 'sq')}
      aria-hidden
      style={{
        ['--c' as string]: c,
        ['--size' as string]: `${size}px`,
        ['--badge-fg' as string]: readable(c),
      }}
    >
      {short.slice(0, 3)}
    </span>
  );
}

/* ---------- Brand + decoration ---------- */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden>
      <rect x="2" y="2" width="44" height="44" rx="10" fill="#d4ff3f" />
      <g fill="none" stroke="#060b08" strokeWidth="2.4" strokeLinecap="round">
        <path d="M24 2v44" />
        <circle cx="24" cy="24" r="9" />
      </g>
      <circle cx="33" cy="15" r="4.6" fill="#060b08" />
    </svg>
  );
}

export function PitchLines({ variant = 'half' }: { variant?: 'half' | 'circle' | 'box' }) {
  return (
    <div className="pitch-lines" aria-hidden>
      {variant === 'half' && (
        <svg
          viewBox="0 0 800 520"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <rect x="20" y="20" width="760" height="480" />
          <path d="M20 260h760" />
          <circle cx="400" cy="260" r="90" />
          <circle cx="400" cy="260" r="5" fill="currentColor" />
          <rect x="200" y="20" width="400" height="130" />
          <rect x="300" y="20" width="200" height="48" />
          <path d="M340 150a60 60 0 0 0 120 0" />
          <rect x="200" y="370" width="400" height="130" />
          <rect x="300" y="452" width="200" height="48" />
          <path d="M340 370a60 60 0 0 1 120 0" />
        </svg>
      )}
      {variant === 'circle' && (
        <svg viewBox="0 0 400 400" fill="none" stroke="currentColor" strokeWidth="3">
          <circle cx="200" cy="200" r="150" />
          <circle cx="200" cy="200" r="6" fill="currentColor" />
          <path d="M0 200h400" />
        </svg>
      )}
      {variant === 'box' && (
        <svg
          viewBox="0 0 400 300"
          preserveAspectRatio="xMidYMax slice"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        >
          <rect x="40" y="0" width="320" height="200" />
          <rect x="130" y="0" width="140" height="70" />
          <path d="M150 200a50 50 0 0 0 100 0" />
          <circle cx="200" cy="140" r="4" fill="currentColor" />
        </svg>
      )}
    </div>
  );
}

/* ---------- Skeleton ---------- */
export function Skeleton({
  h = 16,
  w = '100%',
  r,
}: {
  h?: number;
  w?: number | string;
  r?: number;
}) {
  return <div className="skeleton" aria-hidden style={{ height: h, width: w, borderRadius: r }} />;
}

export function useMemoOnce<T>(f: () => T): T {
  return useMemo(f, []); // eslint-disable-line react-hooks/exhaustive-deps
}
