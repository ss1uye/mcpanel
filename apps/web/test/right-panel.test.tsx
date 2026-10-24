import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceInfo } from '@mcpanel/shared';
import { api } from '../src/api/client';
import { InstanceRightPanel } from '../src/components/InstanceRightPanel';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('InstanceRightPanel', () => {
  it('shows the live player list and the RCON status', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      online: ['Steve'],
      max: 20,
      warning: null,
      rconStatus: 'connected',
      state: 'running',
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <InstanceRightPanel
            instance={{ id: 'i1', rconStatus: 'connected' } as InstanceInfo}
            status={{ instanceId: 'i1', state: 'running', pid: 5, startedAt: null, exitCode: null, error: null }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Steve')).toBeInTheDocument();
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.getByText('1 / 20')).toBeInTheDocument();
  });
});
