import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { CleanupRestoreCard } from '../src/components/CleanupRestoreCard';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

describe('CleanupRestoreCard', () => {
  it('shows leftover paths and requires the instance name before cleanup', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ paths: ['C:/srv/.mcpanel-tmp/rollback-1'] });
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CleanupRestoreCard instanceId="i1" instanceName="survival" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/rollback-1/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '清理残留' }));
    expect(screen.getByRole('button', { name: '确认清理' })).toBeDisabled();
    await user.type(screen.getByLabelText('确认实例名称'), 'survival');
    await user.click(screen.getByRole('button', { name: '确认清理' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/actions/cleanup-restore', { confirmName: 'survival' });
  });

  it('renders nothing when there are no leftovers', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ paths: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <CleanupRestoreCard instanceId="i1" instanceName="survival" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
