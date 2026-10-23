import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { InstanceInfo } from '@mcpanel/shared';
import { api } from '../api/client';
import { CreateInstanceDialog } from '../components/CreateInstanceDialog';
import { StatusBadge } from '../components/StatusBadge';
import { Button, EmptyState, ErrorState, Input, Spinner } from '../components/ui';
import { useInstanceStatus } from '../stores/realtime';

function InstanceCard({ instance }: { instance: InstanceInfo }) {
  const live = useInstanceStatus(instance.id);
  const state = live?.state ?? instance.state;
  return (
    <Link
      to={`/instances/${instance.id}/overview`}
      className="group rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--primary)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium group-hover:text-[var(--primary)]">{instance.name}</div>
          <div className="mt-1 truncate text-xs text-[var(--muted)]">{instance.rootPath}</div>
        </div>
        <StatusBadge state={state} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
        <span>{(live?.pid ?? instance.pid) ? `PID ${live?.pid ?? instance.pid}` : '无进程'}</span>
        <span className="console-font max-w-[60%] truncate" title={instance.startCommand}>
          {instance.startCommand}
        </span>
      </div>
      {(live?.error ?? instance.lastError) && (
        <div className="mt-2 truncate text-xs text-[var(--danger)]">{live?.error ?? instance.lastError}</div>
      )}
    </Link>
  );
}

export function InstancesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['instances'], queryFn: () => api.get<{ items: InstanceInfo[] }>('/instances') });
  const keyword = search.trim().toLowerCase();
  const items = (query.data?.items ?? []).filter(
    (instance) =>
      !keyword || instance.name.toLowerCase().includes(keyword) || instance.rootPath.toLowerCase().includes(keyword),
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">实例</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">纳管并管理本机的 Minecraft 服务器</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          纳管实例
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
        <Input
          className="pl-9"
          placeholder="搜索实例名称或目录"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="搜索实例"
        />
      </div>

      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState message="实例列表加载失败" />
      ) : items.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={keyword ? '没有匹配的实例' : '还没有纳管实例'}
          description={keyword ? '换一个关键字试试。' : '选择已有的服务器目录，填写启动命令即可开始管理。'}
          action={!keyword && <Button onClick={() => setCreateOpen(true)}>纳管第一个实例</Button>}
        />
      )}

      <CreateInstanceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
