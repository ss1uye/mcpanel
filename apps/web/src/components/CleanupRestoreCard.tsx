import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { Button, ConfirmDialog, Field, Input, Notice, toast } from './ui';

export function CleanupRestoreCard({ instanceId, instanceName }: { instanceId: string; instanceName: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const leftovers = useQuery({
    queryKey: ['restore-leftovers', instanceId],
    queryFn: () => api.get<{ paths: string[] }>(`/instances/${instanceId}/restore-leftovers`),
  });

  const cleanup = useMutation({
    mutationFn: () => api.post(`/instances/${instanceId}/actions/cleanup-restore`, { confirmName }),
    onSuccess: async () => {
      setOpen(false);
      setConfirmName('');
      await queryClient.invalidateQueries({ queryKey: ['restore-leftovers', instanceId] });
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('恢复残留已清理', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '清理失败', 'error'),
  });

  const paths = leftovers.data?.paths ?? [];
  if (paths.length === 0) return null;

  return (
    <>
      <Notice tone="warning">
        <div className="flex flex-col gap-2">
          <span>检测到未完成的恢复现场（rollback 目录），请确认服务器文件后再清理：</span>
          <ul className="list-inside list-disc break-all text-xs">
            {paths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <Button variant="secondary" onClick={() => setOpen(true)}>
              清理残留
            </Button>
          </div>
        </div>
      </Notice>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmName('');
        }}
        title="清理恢复残留"
        description="会删除实例目录下的 .mcpanel-tmp；请先确认回滚目录中的文件已不再需要。"
        confirmLabel="确认清理"
        danger
        confirmDisabled={confirmName !== instanceName}
        loading={cleanup.isPending}
        onConfirm={() => cleanup.mutate()}
      >
        <Field label="确认实例名称">
          <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={instanceName} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
