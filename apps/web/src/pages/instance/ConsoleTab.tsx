import { useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError, downloadFile } from '../../api/client';
import { CommandInput } from '../../components/CommandInput';
import { ConsoleViewer } from '../../components/ConsoleViewer';
import { ErrorState, Notice, toast } from '../../components/ui';
import { useInstanceConsole } from '../../stores/realtime';

export function ConsoleTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const consoleState = useInstanceConsole(instance.id);

  const send = useMutation({
    mutationFn: (command: string) => api.post(`/instances/${instance.id}/console/command`, { command }),
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '命令发送失败', 'error'),
  });

  const running = status.state === 'running' || status.state === 'orphaned';

  return (
    <div className="flex flex-col gap-3">
      {status.state === 'stopped' || status.state === 'crashed' ? (
        <ErrorState message="服务器未运行。启动后可在此发送命令。" />
      ) : status.state === 'orphaned' ? (
        <Notice tone="warning">该进程由面板外部启动，控制台未接管，命令将通过 RCON 发送。</Notice>
      ) : null}
      <ConsoleViewer
        lines={consoleState.lines}
        gap={consoleState.gap}
        onDownload={async () => {
          try {
            await downloadFile(`/instances/${instance.id}/logs/download`, 'latest.log');
          } catch (cause) {
            toast(cause instanceof ApiError ? cause.message : '日志下载失败', 'error');
          }
        }}
      />
      <CommandInput
        key={instance.id}
        instanceId={instance.id}
        disabled={!running}
        onSend={(command) => send.mutateAsync(command).then(() => undefined)}
      />
    </div>
  );
}
