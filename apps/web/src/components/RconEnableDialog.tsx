import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { RconEnableResult } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Notice, toast } from './ui';

export function RconEnableDialog({
  instanceId,
  open,
  onOpenChange,
  onEnabled,
}: {
  instanceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}) {
  const [result, setResult] = useState<RconEnableResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enable = useMutation({
    mutationFn: () => api.post<RconEnableResult & { restartRequired: boolean }>(`/instances/${instanceId}/rcon/enable`),
    onSuccess: (data) => {
      setResult(data);
      onEnabled();
      toast('RCON 已写入配置，重启服务器后生效', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '启用失败'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setResult(null);
          setError(null);
        }
        onOpenChange(next);
      }}
      title="启用 RCON"
      description={
        result ? '密码已写入 server.properties，请妥善保存。' : '面板会生成随机密码并写入 server.properties，需要重启服务器后生效。'
      }
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button loading={enable.isPending} onClick={() => enable.mutate()}>
              生成并写入
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {result ? (
          <>
            <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-2)] p-3">
              <code className="console-font min-w-0 flex-1 truncate">{result.password}</code>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(result.password).then(() => toast('密码已复制', 'success'));
                }}
              >
                复制
              </Button>
            </div>
            <div>端口：{result.port}</div>
            <Notice tone="warning">重启服务器后玩家管理才会生效。</Notice>
          </>
        ) : (
          <p className="text-[var(--muted)]">
            将写入 <code className="console-font">enable-rcon=true</code>、<code className="console-font">rcon.port</code>{' '}
            与随机密码；如果 25575–25584 都被其他实例占用，会返回错误并提示先调整端口。
          </p>
        )}
        {error && <ErrorState message={error} />}
      </div>
    </Dialog>
  );
}
