import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthStatus } from '@mcpanel/shared';
import { api } from './api/client';
import { Spinner } from './components/ui';
import { AppShell } from './layouts/AppShell';
import { InstanceLayout } from './layouts/InstanceLayout';
import { DashboardPage } from './pages/DashboardPage';
import { InstancesPage } from './pages/InstancesPage';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { ConsoleTab } from './pages/instance/ConsoleTab';
import { InstanceSettingsTab } from './pages/instance/InstanceSettingsTab';
import { OverviewTab } from './pages/instance/OverviewTab';
import { PlayersTab } from './pages/instance/PlayersTab';

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
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
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
        <Route path="instances/:id" element={<InstanceLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="console" element={<ConsoleTab />} />
          <Route path="players" element={<PlayersTab />} />
          <Route path="settings" element={<InstanceSettingsTab />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
