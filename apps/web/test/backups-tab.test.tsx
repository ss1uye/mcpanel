import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { BackupsTab } from '../src/pages/instance/BackupsTab';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

let instanceState = 'stopped';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useOutletContext: () => ({
      instance: { id: 'i1', name: 'survival', backupKeep: 10 },
      status: { state: instanceState },
    }),
  };
});

beforeEach(() => {
  instanceState = 'stopped';
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    items: [
      {
        id: 'b1',
        instanceId: 'i1',
        filename: '20261024-040000-manual-abcdef.zip',
        kind: 'manual',
        status: 'ready',
        sizeBytes: 1024,
        includesMods: false,
        error: null,
        createdAt: '2026-10-24T04:00:00.000Z',
        completedAt: '2026-10-24T04:00:10.000Z',
      },
    ],
  });
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BackupsTab />
    </QueryClientProvider>,
  );
}

describe('BackupsTab', () => {
  it('lists backups and restores with confirmation', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 't1' });
    renderTab();
    expect(await screen.findByText('手动')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await user.click(screen.getByRole('button', { name: '确认恢复' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/backups/b1/restore', { confirm: true });
  });

  it('disables restore while the instance is running', async () => {
    instanceState = 'running';
    renderTab();
    expect(await screen.findByRole('button', { name: '恢复' })).toBeDisabled();
    expect(screen.getByText(/恢复需要先停止服务器/)).toBeInTheDocument();
  });

  it('creates a backup and shows the task progress', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: 't1', backupId: 'b2' });
    renderTab();
    const user = userEvent.setup();
    await screen.findByText('手动');
    await user.click(screen.getByRole('button', { name: '立即备份' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/backups');
  });
});
