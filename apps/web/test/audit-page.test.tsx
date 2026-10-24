import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AuditPage } from '../src/pages/AuditPage';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuditPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuditPage', () => {
  it('renders audit rows and expands the detail payload', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        {
          id: '1',
          userId: 'u1',
          action: 'instance.start',
          targetType: 'instance',
          targetId: 'abc',
          detail: { at: 'x' },
          ip: null,
          createdAt: '2026-10-24T00:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderPage();

    expect(await screen.findByText('instance.start')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText('instance.start'));
    expect(screen.getByText(/"at": "x"/)).toBeInTheDocument();
  });

  it('applies the action prefix filter', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderPage();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('动作过滤'), 'player.');
    await user.click(screen.getByRole('button', { name: '过滤' }));

    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('action=player.'));
    expect(await screen.findByText('暂无审计记录')).toBeInTheDocument();
  });
});
