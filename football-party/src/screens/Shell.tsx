import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Settings, Vibrate, Volume2, Waves } from 'lucide-react';
import { cue, setPref, usePrefs } from '@/lib/prefs';
import { Button, IconButton, Logo, Sheet } from '@/ui/kit';

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePrefs();
  const first = useRef<HTMLButtonElement>(null);
  const rows: {
    key: 'sound' | 'haptics' | 'calm';
    label: string;
    hint: string;
    icon: ReactNode;
  }[] = [
    {
      key: 'sound',
      label: 'Sound effects',
      hint: 'Short whistles and blips. Off by default.',
      icon: <Volume2 size={20} aria-hidden />,
    },
    {
      key: 'haptics',
      label: 'Haptics',
      hint: 'Subtle vibration on supported phones.',
      icon: <Vibrate size={20} aria-hidden />,
    },
    {
      key: 'calm',
      label: 'Calm motion',
      hint: 'Turns off animations. Also follows your system setting.',
      icon: <Waves size={20} aria-hidden />,
    },
  ];
  return (
    <Sheet open={open} onClose={onClose} title="Preferences" initialFocus={first}>
      <ul className="plain-list">
        {rows.map((r, i) => (
          <li key={r.key} className="pref-row">
            <span className="pref-icon">{r.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{r.label}</div>
              <div className="field-hint">{r.hint}</div>
            </div>
            <button
              ref={i === 0 ? first : undefined}
              type="button"
              role="switch"
              aria-checked={prefs[r.key]}
              aria-label={r.label}
              className="switch"
              onClick={() => {
                setPref(r.key, !prefs[r.key]);
                if (r.key === 'sound' && !prefs.sound) setTimeout(() => cue('success'), 50);
              }}
            >
              <span />
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function Header({ children }: { children?: ReactNode }) {
  // In-room headers carry extra controls; on phones the wordmark yields to them.
  const [prefsOpen, setPrefsOpen] = useState(false);
  return (
    <header className="site-header" data-compact={children ? '' : undefined}>
      <div className="container">
        <Link to="/" className="brand" aria-label="Pitchside home">
          <Logo size={30} />
          <span>Pitchside</span>
        </Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/play">Play</NavLink>
          <NavLink to="/party">One phone</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/data">Data</NavLink>
        </nav>
        <span className="spacer" />
        {children}
        <IconButton label="Preferences" onClick={() => setPrefsOpen(true)}>
          <Settings size={20} aria-hidden />
        </IconButton>
      </div>
      <SettingsSheet open={prefsOpen} onClose={() => setPrefsOpen(false)} />
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div
        className="container row wrap"
        style={{ justifyContent: 'space-between', gap: 'var(--s-4)' }}
      >
        <span>
          Pitchside is an independent project. Not affiliated with any club, league or federation.
        </span>
        <span className="row" style={{ gap: 'var(--s-4)' }}>
          <Link to="/rules">Rules</Link>
          <Link to="/data">Data &amp; rights</Link>
          <Link to="/profile">Profile</Link>
        </span>
      </div>
    </footer>
  );
}

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className={narrow ? 'container narrow' : 'container'}>
        {children}
      </main>
      <Footer />
    </>
  );
}

export function CenterMessage({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="center-msg">
      <div className="eyebrow lime">{eyebrow}</div>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export { Button };
