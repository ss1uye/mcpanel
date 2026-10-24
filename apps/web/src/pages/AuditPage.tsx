import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry, Paginated } from '@mcpanel/shared';
import { api } from '../api/client';
import { Button, EmptyState, ErrorState, Input, Spinner } from '../components/ui';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 20;

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['audit', page, applied],
    queryFn: () =>
      api.get<Paginated<AuditEntry>>(
        `/audit?page=${page}&pageSize=${PAGE_SIZE}${applied ? `&action=${encodeURIComponent(applied)}` : ''}`,
      ),
  });

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">审计</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">所有写操作、登录与玩家动作都会记录在这里。</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setApplied(action.trim());
        }}
      >
        <div className="w-64">
          <Input
            aria-label="动作过滤"
            placeholder="按动作前缀过滤，例如 instance."
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary">
          过滤
        </Button>
        {applied && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAction('');
              setApplied('');
              setPage(1);
            }}
          >
            清除
          </Button>
        )}
      </form>

      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState message="审计记录加载失败" />
      ) : query.data && query.data.items.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="hidden grid-cols-[1fr_10rem_8rem_12rem] gap-3 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] md:grid">
            <span>动作</span>
            <span>对象</span>
            <span>来源 IP</span>
            <span>时间</span>
          </div>
          {query.data.items.map((entry) => (
            <div key={entry.id} className="border-b border-[var(--border)] last:border-0">
              <button
                type="button"
                className="grid w-full grid-cols-1 gap-1 px-4 py-2 text-left text-sm hover:bg-[var(--surface-2)] md:grid-cols-[1fr_10rem_8rem_12rem] md:gap-3"
                onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
              >
                <span className="font-medium">{entry.action}</span>
                <span className="truncate text-[var(--muted)]">{entry.targetId ?? entry.targetType}</span>
                <span className="text-[var(--muted)]">{entry.ip ?? '—'}</span>
                <span className="text-xs text-[var(--muted)]">{formatDateTime(entry.createdAt)}</span>
              </button>
              {expanded === entry.id && (
                <pre className="console-font overflow-auto border-t border-[var(--border)] bg-[var(--console-bg)] px-4 py-3 text-xs text-[var(--console-fg)]">
                  {JSON.stringify(entry.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title="暂无审计记录"
          description={applied ? '没有匹配该前缀的记录。' : '完成一次写操作后这里会出现记录。'}
        />
      )}

      <div className="flex items-center justify-between text-sm text-[var(--muted)]">
        <span>
          共 {total} 条，第 {page} / {pages} 页
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
