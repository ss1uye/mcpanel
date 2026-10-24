import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, LogOut, Menu, Moon, ScrollText, Server, Settings, Sun } from 'lucide-react';
import { Suspense, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { PANEL_VERSION, type PanelSettings } from '@mcpanel/shared';
import { api, clearCsrfToken } from '../api/client';
import { disconnectRealtime, useConnectionState, useRealtime } from '../stores/realtime';
import { useUi } from '../stores/ui';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Badge, Button, Spinner, Toaster } from '../components/ui';
import { cn } from '../utils/cn';

function ConnectionIndicator() {
  const connection = useConnectionState();
  const subscribed = useRealtime((state) => state.subscribed);
  // Nothing is subscribed on pages like the empty instance list, so "disconnected" would be a lie.
  if (!subscribed || connection === 'open') return null;
  return (
    <Badge tone={connection === 'connecting' ? 'warning' : 'danger'}>
      {connection === 'connecting' ? '实时连接中…' : '实时连接已断开，正在重试'}
    </Badge>
  );
}

const navigation = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/instances', label: '实例', icon: Server, end: false },
  { to: '/audit', label: '审计', icon: ScrollText, end: true },
  { to: '/settings', label: '设置', icon: Settings, end: true },
];

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.get<PanelSettings>('/settings') });
  const panelName = settingsQuery.data?.panelName ?? 'MC Panel';
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.post('/auth/logout');
    } catch {
      // the session may already be gone
    }
    clearCsrfToken();
    disconnectRealtime();
    queryClient.clear();
    navigate('/login', { replace: true });
    setLoggingOut(false);
  };

  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark');
  const themeLabel = theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统';

  const sidebar = (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-16 items-center gap-3 px-5">
        <div className="grid grid-cols-2 gap-0.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/50" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/30" />
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--primary)]/70" />
        </div>
        <span className="text-base font-semibold tracking-wide">{panelName}</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setDrawer(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
                isActive
                  ? 'bg-[var(--primary-soft)] text-[var(--primary)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]',
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex flex-col gap-2 border-t border-[var(--border)] p-3 text-xs text-[var(--muted)]">
        <ConnectionIndicator />
        <div className="flex items-center justify-between">
          <span>v{PANEL_VERSION}</span>
          <button
            type="button"
            onClick={cycleTheme}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-[var(--surface-2)]"
            aria-label="切换主题"
          >
            {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            {themeLabel}
          </button>
        </div>
        <Button variant="ghost" className="justify-start" loading={loggingOut} onClick={logout}>
          <LogOut className="h-4 w-4" /> 退出登录
        </Button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="hidden md:block">{sidebar}</div>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" className="absolute inset-0 bg-black/60" aria-label="关闭菜单" onClick={() => setDrawer(false)} />
          <div className="relative h-full">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-4 md:hidden">
          <Button variant="ghost" onClick={() => setDrawer(true)} aria-label="打开菜单">
            <Menu className="h-5 w-5" />
          </Button>
          <span className="font-semibold">{panelName}</span>
          <button type="button" onClick={cycleTheme} className="p-2 text-[var(--muted)]" aria-label="切换主题">
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">
          <Suspense
            fallback={
              <div className="p-8">
                <Spinner />
              </div>
            }
          >
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </Suspense>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
