import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FileEntryInfo, FileListResult } from '@mcpanel/shared';
import { api, ApiError, downloadFile, uploadFile } from '../api/client';
import { Button, ConfirmDialog, Dialog, ErrorState, Field, Input, Menu, MenuItem, Spinner, toast } from './ui';
import { formatBytes, formatDateTime } from '../utils/format';

function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean);
  const items = [{ label: '根目录', path: '/' }];
  parts.forEach((part, index) => {
    items.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` });
  });
  return items;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/$/, '')}/${name}`;
}

type Pending =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntryInfo }
  | { kind: 'delete'; entry: FileEntryInfo }
  | { kind: 'unzip'; entry: FileEntryInfo }
  | null;

export function FileBrowser({
  instanceId,
  path,
  onPathChange,
  onEdit,
}: {
  instanceId: string;
  path: string;
  onPathChange: (path: string) => void;
  onEdit: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [value, setValue] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const list = useQuery({
    queryKey: ['files', instanceId, path],
    queryFn: () => api.get<FileListResult>(`/instances/${instanceId}/files?path=${encodeURIComponent(path)}`),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['files', instanceId] });

  const mutate = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await refresh();
      setPending(null);
      setValue('');
      setConfirmName('');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.set('path', path);
      form.set('file', file);
      return uploadFile<{ path: string }>(`/instances/${instanceId}/files/upload`, form);
    },
    onSuccess: async () => {
      await refresh();
      toast('上传完成', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '上传失败', 'error'),
  });

  const crumbs = breadcrumbs(path);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {index > 0 && <span className="text-[var(--muted)]">/</span>}
                <button
                  type="button"
                  className="rounded px-1 hover:bg-[var(--surface-2)]"
                  onClick={() => onPathChange(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = '';
          }}
        />
        <Button variant="secondary" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
          <Upload className="h-4 w-4" />
          上传
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setValue('');
            setPending({ kind: 'mkdir' });
          }}
        >
          新建目录
        </Button>
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorState message="目录加载失败" />
      ) : (
        <div
          className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) upload.mutate(file);
          }}
        >
          {(list.data?.entries.length ?? 0) === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">空目录（可以把文件拖到这里上传）</div>
          )}
          {list.data?.entries.map((entry) => {
            const entryPath = joinPath(path, entry.name);
            return (
              <div key={entry.name} className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 last:border-0">
                {entry.type === 'directory' ? (
                  <Folder className="h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden="true" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                )}
                <button
                  type="button"
                  aria-label={entry.name}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:text-[var(--primary)]"
                  onClick={() => (entry.type === 'directory' ? onPathChange(entryPath) : entry.editable && onEdit(entryPath))}
                >
                  {entry.name}
                </button>
                <span className="hidden w-20 shrink-0 text-right text-xs text-[var(--muted)] sm:block">
                  {entry.type === 'file' ? formatBytes(entry.size) : '—'}
                </span>
                <span className="hidden w-36 shrink-0 text-right text-xs text-[var(--muted)] md:block">
                  {formatDateTime(entry.mtime)}
                </span>
                <Menu label="文件操作">
                  {entry.type === 'file' && entry.editable && <MenuItem onSelect={() => onEdit(entryPath)}>编辑</MenuItem>}
                  {entry.type === 'file' && (
                    <MenuItem
                      onSelect={() => {
                        void downloadFile(
                          `/instances/${instanceId}/files/download?path=${encodeURIComponent(entryPath)}`,
                          entry.name,
                        ).catch((cause: unknown) => toast(cause instanceof ApiError ? cause.message : '下载失败', 'error'));
                      }}
                    >
                      下载
                    </MenuItem>
                  )}
                  {entry.type === 'file' && entry.name.endsWith('.zip') && (
                    <MenuItem
                      onSelect={() => {
                        setValue('');
                        setPending({ kind: 'unzip', entry });
                      }}
                    >
                      解压到当前目录
                    </MenuItem>
                  )}
                  {/\.jar(\.disabled)?$/.test(entry.name) && path.replace(/\/$/, '') === '/mods' && (
                    <MenuItem
                      onSelect={() =>
                        void api
                          .post(`/instances/${instanceId}/files/mods/toggle`, { path: entryPath })
                          .then(refresh)
                          .catch((cause: unknown) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'))
                      }
                    >
                      {entry.name.endsWith('.disabled') ? '启用模组' : '禁用模组'}
                    </MenuItem>
                  )}
                  <MenuItem
                    onSelect={() => {
                      setValue(entry.name);
                      setPending({ kind: 'rename', entry });
                    }}
                  >
                    重命名
                  </MenuItem>
                  <MenuItem
                    danger
                    onSelect={() => {
                      setConfirmName('');
                      setPending({ kind: 'delete', entry });
                    }}
                  >
                    删除
                  </MenuItem>
                </Menu>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={pending?.kind === 'mkdir' || pending?.kind === 'rename'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={pending?.kind === 'rename' ? '重命名' : '新建目录'}
        description={pending?.kind === 'rename' ? `重命名 ${pending.entry.name}` : `在 ${path} 下创建目录`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              loading={mutate.isPending}
              disabled={!value.trim()}
              onClick={() => {
                if (!pending) return;
                if (pending.kind === 'mkdir') {
                  mutate.mutate(() =>
                    api.post(`/instances/${instanceId}/files/mkdir`, { path: joinPath(path, value.trim()) }),
                  );
                } else if (pending.kind === 'rename') {
                  mutate.mutate(() =>
                    api.post(`/instances/${instanceId}/files/rename`, {
                      path: joinPath(path, pending.entry.name),
                      newName: value.trim(),
                    }),
                  );
                }
              }}
            >
              确认
            </Button>
          </>
        }
      >
        <Field label="名称">
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={pending?.kind === 'unzip'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title="解压压缩包"
        description="只支持 zip；解压前会校验路径、条目数与体积上限。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              loading={mutate.isPending}
              onClick={() => {
                if (pending?.kind !== 'unzip') return;
                mutate.mutate(() =>
                  api.post(`/instances/${instanceId}/files/unzip`, {
                    path: joinPath(path, pending.entry.name),
                    targetDir: path,
                  }),
                );
              }}
            >
              解压
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--muted)]">解压到 {path}</p>
      </Dialog>

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title="删除"
        description={
          pending?.kind === 'delete' && pending.entry.type === 'directory'
            ? `目录 ${pending.entry.name} 及其内容会被递归删除。输入名称以确认。`
            : `文件 ${pending?.kind === 'delete' ? pending.entry.name : ''} 会被删除，无法从面板恢复。`
        }
        confirmLabel="删除"
        danger
        confirmDisabled={
          pending?.kind === 'delete' && pending.entry.type === 'directory' && confirmName !== pending.entry.name
        }
        loading={mutate.isPending}
        onConfirm={() => {
          if (pending?.kind !== 'delete') return;
          mutate.mutate(() =>
            api.del(`/instances/${instanceId}/files`, {
              path: joinPath(path, pending.entry.name),
              recursive: pending.entry.type === 'directory',
            }),
          );
        }}
      >
        {pending?.kind === 'delete' && pending.entry.type === 'directory' && (
          <Field label="确认目录名">
            <Input value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={pending.entry.name} />
          </Field>
        )}
      </ConfirmDialog>
    </div>
  );
}
