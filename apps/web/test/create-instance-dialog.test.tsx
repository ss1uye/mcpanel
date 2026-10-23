import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { CreateInstanceDialog } from '../src/components/CreateInstanceDialog';

vi.mock('../src/api/client', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
  clearCsrfToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'mcpanel:unauthorized',
}));

function probeResult(valid: boolean) {
  return {
    rootPath: 'D:\\servers\\survival',
    valid,
    detected: {
      startScripts: ['run.bat'],
      serverJars: ['fabric-server-launch.jar'],
      levelName: 'world',
      serverPort: 25565,
      enableRcon: true,
      rconPort: 25575,
      onlineMode: true,
      hasMods: true,
      hasConfig: true,
      eula: true,
    },
    java: { path: 'java', major: 21 },
    suggestedStartCommand: 'run.bat',
    warnings: valid ? [] : [{ code: 'EULA_NOT_ACCEPTED', message: 'eula.txt 未接受' }],
  };
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CreateInstanceDialog open onOpenChange={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('CreateInstanceDialog', () => {
  it('probes a directory and fills the suggested start command', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce(probeResult(true));

    renderDialog();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('服务器目录'), 'D:\\servers\\survival');
    await user.click(screen.getByRole('button', { name: '检测目录' }));

    expect(await screen.findByDisplayValue('run.bat')).toBeInTheDocument();
    expect(screen.getByText('Java 21')).toBeInTheDocument();
    expect(screen.getByText('fabric-server-launch.jar')).toBeInTheDocument();
  });

  it('shows probe warnings returned by the server', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce(probeResult(false));

    renderDialog();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('服务器目录'), 'D:\\servers\\survival');
    await user.click(screen.getByRole('button', { name: '检测目录' }));

    expect(await screen.findByText('eula.txt 未接受')).toBeInTheDocument();
  });

  it('requires a probe before creating the instance', async () => {
    renderDialog();
    expect(screen.getByRole('button', { name: '创建实例' })).toBeDisabled();
  });
});
