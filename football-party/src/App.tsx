import { Suspense, lazy } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { ToastProvider } from '@/ui/kit';
import { Landing } from '@/screens/Landing';
import { Play } from '@/screens/Play';
import { DataPolicy, Rules } from '@/screens/Info';
import { CenterMessage, Page } from '@/screens/Shell';

// Rare screens are split out so first load stays small.
const RoomPage = lazy(() => import('@/screens/RoomPage').then((m) => ({ default: m.RoomPage })));
const Practice = lazy(() => import('@/screens/Practice').then((m) => ({ default: m.Practice })));
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
            <Route path="/practice/:game" element={<Practice />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/data" element={<DataPolicy />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </ErrorBoundary>
  );
}
