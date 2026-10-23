import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError, clearCsrfToken, UNAUTHORIZED_EVENT } from './api/client';
import { AppRouter } from './router';
import { disconnectRealtime } from './stores/realtime';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && (error.status === 401 || error.status === 403)) && count < 1,
      refetchOnWindowFocus: false,
    },
  },
});

window.addEventListener(UNAUTHORIZED_EVENT, () => {
  clearCsrfToken();
  disconnectRealtime();
  queryClient.clear();
  if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/setup')) {
    location.assign(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
  }
});

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
