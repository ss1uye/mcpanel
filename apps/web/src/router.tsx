import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api } from './api/client';
import { Spinner } from './components/ui';
import { AppShell } from './layouts/AppShell';
import { InstanceLayout } from './layouts/InstanceLayout';

const SetupPage = lazy(() => import('./pages/SetupPage').then((module) => ({ default: module.SetupPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const InstancesPage = lazy(() =>
  import('./pages/InstancesPage').then((module) => ({ default: module.InstancesPage })),
);
const AuditPage = lazy(() => import('./pages/AuditPage').then((module) => ({ default: module.AuditPage })));
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const OverviewTab = lazy(() =>
  import('./pages/instance/OverviewTab').then((module) => ({ default: module.OverviewTab })),
);
const ConsoleTab = lazy(() =>
  import('./pages/instance/ConsoleTab').then((module) => ({ default: module.ConsoleTab })),
);
const PlayersTab = lazy(() =>
  import('./pages/instance/PlayersTab').then((module) => ({ default: module.PlayersTab })),
);
const FilesTab = lazy(() => import('./pages/instance/FilesTab').then((module) => ({ default: module.FilesTab })));
const ConfigTab = lazy(() => import('./pages/instance/ConfigTab').then((module) => ({ default: module.ConfigTab })));
const BackupsTab = lazy(() =>
  import('./pages/instance/BackupsTab').then((module) => ({ default: module.BackupsTab })),
);
const SchedulesTab = lazy(() =>
  import('./pages/instance/SchedulesTab').then((module) => ({ default: module.SchedulesTab })),
);
const InstanceSettingsTab = lazy(() =>
  import('./pages/instance/InstanceSettingsTab').then((module) => ({ default: module.InstanceSettingsTab })),
);

const pageFallback = (
  <div className="grid min-h-screen place-items-center">
    <Spinner />
  </div>
);

function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const status = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get<AuthStatus>('/auth/status'),
    retry: false,
  });
  if (status.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (status.data?.setupRequired) return <Navigate to="/setup" replace />;
  if (!status.data?.authenticated) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function AppRouter() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <Suspense fallback={pageFallback}>
            <SetupPage />
          </Suspense>
        }
      />
      <Route
        path="/login"
        element={
          <Suspense fallback={pageFallback}>
            <LoginPage />
          </Suspense>
        }
      />
      <Route
        path="/"
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="instances" element={<InstancesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="instances/:id" element={<InstanceLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="console" element={<ConsoleTab />} />
          <Route path="players" element={<PlayersTab />} />
          <Route path="files" element={<FilesTab />} />
          <Route path="config" element={<ConfigTab />} />
          <Route path="backups" element={<BackupsTab />} />
          <Route path="schedules" element={<SchedulesTab />} />
          <Route path="settings" element={<InstanceSettingsTab />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
