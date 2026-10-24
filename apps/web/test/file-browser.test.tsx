import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { FileBrowser } from '../src/components/FileBrowser';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

afterEach(() => vi.clearAllMocks());

function renderBrowser(path = '/', onEdit = vi.fn()) {
  const entries =
    path === '/mods'
      ? [{ name: 'sodium.jar', type: 'file', size: 120, mtime: '2026-10-24T00:00:00.000Z', symlink: false, editable: false }]
      : [
          { name: 'mods', type: 'directory', size: 0, mtime: '2026-10-24T00:00:00.000Z', symlink: false, editable: false },
          { name: 'server.properties', type: 'file', size: 42, mtime: '2026-10-24T00:00:00.000Z', symlink: false, editable: true },
        ];
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ path, entries });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FileBrowser instanceId="i1" path={path} onPathChange={() => undefined} onEdit={onEdit} />
    </QueryClientProvider>,
  );
  return onEdit;
}

describe('FileBrowser', () => {
  it('lists entries and opens the editor for text files', async () => {
    const onEdit = renderBrowser();
    expect(await screen.findByText('mods')).toBeInTheDocument();
    expect(screen.getByText('server.properties')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '文件操作' })[1]!);
    await user.click(screen.getByRole('menuitem', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith('/server.properties');
  });

  it('opens directories through the breadcrumb path', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'mods' }));
    expect(screen.getByText('mods')).toBeInTheDocument();
  });

  it('offers mods toggling only inside /mods', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    renderBrowser('/mods');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: '文件操作' }))[0]!);
    await user.click(screen.getByRole('menuitem', { name: '禁用模组' }));
    expect(api.post).toHaveBeenCalledWith('/instances/i1/files/mods/toggle', { path: '/mods/sodium.jar' });
  });
});
