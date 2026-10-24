import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { ScheduleForm } from '../src/components/ScheduleForm';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

beforeEach(() => {
  (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ nextRuns: [] });
});

function renderForm(onSubmit = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ScheduleForm
        open
        instanceId="instance-1"
        onOpenChange={() => undefined}
        timezone="Asia/Shanghai"
        onSubmit={onSubmit}
      />
    </QueryClientProvider>,
  );
  return onSubmit;
}

describe('ScheduleForm', () => {
  it('requires a command for command actions and submits with the default preset', async () => {
    const onSubmit = renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('名称'), '每日命令');
    await user.selectOptions(screen.getByLabelText('动作'), 'command');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.type(screen.getByLabelText('命令'), 'save-all');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '每日命令',
        actionType: 'command',
        command: 'save-all',
        cron: '0 4 * * *',
        timezone: 'Asia/Shanghai',
      }),
    );
  });

  it('uses a custom cron when selected', async () => {
    const onSubmit = renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('名称'), '自定义');
    await user.selectOptions(screen.getByLabelText('执行频率'), 'custom');
    await user.clear(screen.getByLabelText('cron 表达式'));
    await user.type(screen.getByLabelText('cron 表达式'), '*/15 * * * *');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cron: '*/15 * * * *' }));
  });

  it('previews the next three runs for the current cron', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      nextRuns: ['2026-10-25T20:00:00.000Z', '2026-10-26T20:00:00.000Z', '2026-10-27T20:00:00.000Z'],
    });
    renderForm();
    expect(await screen.findByText(/未来 3 次/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/schedules/preview?cron='));
  });

  it('requires a broadcast message for broadcast actions', async () => {
    const onSubmit = renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('名称'), '广播');
    await user.selectOptions(screen.getByLabelText('动作'), 'broadcast');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    await user.type(screen.getByLabelText('广播内容'), '维护提醒');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'broadcast', message: '维护提醒' }),
    );
  });
});
