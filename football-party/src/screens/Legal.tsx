import { Navigate } from 'react-router-dom';
import { useSite } from '@/lib/site';
import { setConsent, useConsent } from '@/lib/consent';
import { Button } from '@/ui/kit';
import { Page } from './Shell';

/**
 * Impressum and Datenschutz are TEMPLATES for a small hobby site in Germany. They are not legal
 * advice: have them reviewed before going live (e.g. with a generator such as eRecht24 or a lawyer).
 */
export function Impressum() {
  const { legal } = useSite();
  // Not shown while the site is a private, non-commercial project (no LEGAL_NAME set).
  if (!legal.name) return <Navigate to="/" replace />;
  const missing = !legal.address || !legal.email;
  return (
    <Page narrow>
      <div className="legal">
        <div className="eyebrow">Rechtliches</div>
        <h1 className="page-title">Impressum</h1>
        {missing && (
          <p className="banner red" role="alert">
            Angaben fehlen: Setze LEGAL_NAME, LEGAL_ADDRESS und LEGAL_EMAIL auf dem Server.
          </p>
        )}
        <h2>Angaben gemäß § 5 DDG</h2>
        <p>
          {legal.name ?? '[Name]'}
          <br />
          {(legal.address ?? '[Straße und Hausnummer, PLZ Ort]').split('\n').map((l, i) => (
            <span key={i}>
              {l}
              <br />
            </span>
          ))}
        </p>
        <h2>Kontakt</h2>
        <p>E-Mail: {legal.email ?? '[E-Mail-Adresse]'}</p>
        <h2>Haftung für Inhalte</h2>
        <p>
          Die Spiele nutzen Fußballdaten aus öffentlichen Quellen. Trotz sorgfältiger Prüfung
          übernehmen wir keine Gewähr für Vollständigkeit und Richtigkeit einzelner Angaben.
        </p>
        <h2>Markenhinweis</h2>
        <p>
          Pitchside ist ein unabhängiges Projekt und steht in keiner Verbindung zu Vereinen, Ligen,
          Verbänden oder Spielern. Alle genannten Namen dienen nur der Beschreibung.
        </p>
      </div>
    </Page>
  );
}

export function Privacy() {
  const { legal, ads } = useSite();
  const consent = useConsent();
  return (
    <Page narrow>
      <div className="legal">
        <div className="eyebrow">Rechtliches</div>
        <h1 className="page-title">Datenschutzerklärung</h1>
        <h2>Verantwortlicher</h2>
        <p>
          {legal.name
            ? `${legal.name}${legal.address ? `, ${legal.address.replace(/\n/g, ', ')}` : ''}${legal.email ? `, ${legal.email}` : ''}`
            : 'Der Betreiber dieser privaten, nicht-kommerziellen Seite.'}
        </p>
        <h2>Was beim Besuch passiert</h2>
        <ul>
          <li>
            <strong>Server-Logs:</strong> Beim Aufruf verarbeitet unser Hoster technisch notwendige
            Daten (IP-Adresse, Zeitpunkt, aufgerufene Seite). Rechtsgrundlage: Art. 6 Abs. 1 lit. f
            DSGVO (sicherer, stabiler Betrieb).
          </li>
          <li>
            <strong>Spielräume:</strong> Dein gewählter Spitzname und deine Spielzüge werden für die
            Dauer des Raums auf dem Server gehalten und danach gelöscht. Es gibt keine Konten.
          </li>
          <li>
            <strong>Lokaler Speicher:</strong> In deinem Browser speichern wir Spitzname,
            Einstellungen, deine Werbe-Auswahl und die Zuordnung zu deinem Sitzplatz im Raum. Das
            ist technisch notwendig bzw. von dir gewählt und wird nicht an Dritte gesendet.
          </li>
        </ul>
        <h2>Werbung</h2>
        {ads ? (
          <>
            <p>
              Wir finanzieren Pitchside mit Werbung von Google AdSense (Google Ireland Limited).
              Werbung wird nur geladen, wenn du einwilligst (Art. 6 Abs. 1 lit. a DSGVO, § 25
              TDDDG). Google kann dabei Cookies setzen und Daten wie IP-Adresse und
              Geräteinformationen verarbeiten, auch in Drittländern. Du kannst die Einwilligung
              jederzeit widerrufen:
            </p>
            <div className="row wrap" style={{ marginTop: 'var(--s-3)' }}>
              <Button
                size="sm"
                onClick={() => setConsent('granted')}
                disabled={consent === 'granted'}
              >
                Werbung erlauben
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setConsent('denied')}
                disabled={consent === 'denied'}
              >
                Werbung ablehnen
              </Button>
            </div>
          </>
        ) : (
          <p>Derzeit wird keine Werbung eingesetzt.</p>
        )}
        <h2>Deine Rechte</h2>
        <p>
          Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung,
          Datenübertragbarkeit und Widerspruch sowie auf Beschwerde bei einer
          Datenschutzaufsichtsbehörde.
        </p>
        <p className="field-hint">
          Hinweis: Diese Erklärung ist eine Vorlage. Lass sie vor dem Start rechtlich prüfen.
        </p>
      </div>
    </Page>
  );
}
