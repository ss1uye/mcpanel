import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { TextFileContent } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Spinner, toast } from './ui';

export function FileEditorDialog({
  instanceId,
  path,
  onOpenChange,
}: {
  instanceId: string;
  path: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<TextFileContent | null>(null);

  const file = useQuery({
    queryKey: ['file-content', instanceId, path],
    queryFn: () =>
      api.get<TextFileContent>(`/instances/${instanceId}/files/content?path=${encodeURIComponent(path ?? '')}`),
    enabled: Boolean(path),
  });

  useEffect(() => {
    if (!file.data) return;
    setContent(file.data.content);
    setMtime(file.data.mtime);
    setConflict(null);
    setError(null);
  }, [file.data]);

  const save = useMutation({
    mutationFn: (expectedMtime: number) => {
      if (!path) throw new Error('缺少文件路径');
      return api.put<{ mtime: number }>(`/instances/${instanceId}/files/content`, {
        path,
        content,
        expectedMtime,
      });
    },
    onSuccess: async (result) => {
      setMtime(result.mtime);
      setConflict(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['files', instanceId] }),
        queryClient.invalidateQueries({ queryKey: ['file-content', instanceId, path] }),
      ]);
      toast('已保存', 'success');
    },
    onError: async (cause) => {
      if (cause instanceof ApiError && cause.code === 'MTIME_CONFLICT' && path) {
        try {
          const latest = await api.get<TextFileContent>(
            `/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`,
          );
          setConflict(latest);
        } catch {
          setError('文件已被外部修改，且重新读取失败');
        }
        return;
      }
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    },
  });

  return (
    <Dialog
      open={Boolean(path)}
      onOpenChange={onOpenChange}
      title={path ?? ''}
      description="保存时会校验文件修改时间，外部改动会提示冲突。"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button loading={save.isPending} disabled={mtime === null} onClick={() => mtime !== null && save.mutate(mtime)}>
            保存
          </Button>
        </>
      }
    >
      {file.isLoading ? (
        <Spinner />
      ) : file.isError ? (
        <ErrorState message="文件读取失败或不是文本文件" />
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            className="console-font h-80 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--console-bg)] p-3 text-xs leading-5 text-[var(--console-fg)] focus:border-[var(--primary)] focus:outline-none"
            value={content}
            spellCheck={false}
            aria-label="文件内容"
            onChange={(event) => setContent(event.target.value)}
          />
          {conflict && (
            <div className="rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-soft)] p-3 text-sm text-[var(--warn)]">
              文件已被外部修改。重新加载会丢弃当前编辑；强制覆盖会以最新版本为基线保存。
              <div className="mt-2 flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setContent(conflict.content);
                    setMtime(conflict.mtime);
                    setConflict(null);
                  }}
                >
                  重新加载
                </Button>
                <Button variant="danger" onClick={() => save.mutate(conflict.mtime)}>
                  强制覆盖
                </Button>
              </div>
            </div>
          )}
          {error && <ErrorState message={error} />}
        </div>
      )}
    </Dialog>
  );
}
