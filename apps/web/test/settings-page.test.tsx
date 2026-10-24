import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, downloadFile } from '../src/api/client';
import { SettingsPage } from '../src/pages/SettingsPage';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  downloadFile: vi.fn().mockResolvedValue(undefined),
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

const settings = { panelName: 'MC Panel', defaultTimezone: 'Asia/Shanghai', auditRetentionDays: 90 };

afterEach(() => vi.clearAllMocks());

function renderPage() {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(settings);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  it('loads current settings and saves a change', async () => {
    (api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ ...settings, panelName: '生存服' });
    renderPage();
    const name = await screen.findByLabelText('面板名称');
    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, '生存服');
    await user.click(screen.getByRole('button', { name: '保存面板设置' }));
    expect(api.patch).toHaveBeenCalledWith('/settings', expect.objectContaining({ panelName: '生存服' }));
  });

  it('requires two matching passwords before changing it', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByLabelText('当前密码');
    await user.type(screen.getByLabelText('当前密码'), 'old-password-123');
    await user.type(screen.getByLabelText('新密码'), 'new-password-123');
    await user.type(screen.getByLabelText('确认新密码'), 'mismatch-123');
    await user.click(screen.getByRole('button', { name: '修改密码' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument();
  });

  it('downloads a panel database snapshot', async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '下载面板数据库快照' }));
    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith('/settings/panel-backup', expect.stringMatching(/^panel-.*\.db$/));
    });
  });
});
