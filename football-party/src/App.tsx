import { Suspense, lazy } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { ToastProvider } from '@/ui/kit';
import { Landing } from '@/screens/Landing';
import { Play } from '@/screens/Play';
import { DataPolicy, Rules } from '@/screens/Info';
import { Impressum, Privacy } from '@/screens/Legal';
import { ConsentBanner } from '@/ui/Ads';
import { CenterMessage, Page } from '@/screens/Shell';

// Rare screens are split out so first load stays small.
const RoomPage = lazy(() => import('@/screens/RoomPage').then((m) => ({ default: m.RoomPage })));
const Party = lazy(() => import('@/screens/Party').then((m) => ({ default: m.Party })));
function LegacyPractice() {
  const { game } = useParams();
  return <Navigate to={`/party/${game ?? ''}`} replace />;
}
const Admin = lazy(() => import('@/screens/Admin').then((m) => ({ default: m.Admin })));
const Profile = lazy(() => import('@/screens/Profile').then((m) => ({ default: m.Profile })));

function NotFound() {
  return (
    <Page>
      <CenterMessage
        eyebrow="Offside"
        title="Page not found"
        actions={
          <Link className="btn" to="/">
            Back to kick-off
          </Link>
        }
      >
        That page isn’t on the pitch.
      </CenterMessage>
    </Page>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Suspense
          fallback={
            <div className="center-msg" role="status">
              Loading…
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/play" element={<Play />} />
            <Route path="/r/:code" element={<RoomPage />} />
            <Route path="/party" element={<Party />} />
            <Route path="/party/:game" element={<Party />} />
            <Route path="/practice/:game" element={<LegacyPractice />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/data" element={<DataPolicy />} />
            <Route path="/impressum" element={<Impressum />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        <ConsentBanner />
      </ToastProvider>
    </ErrorBoundary>
  );
}
