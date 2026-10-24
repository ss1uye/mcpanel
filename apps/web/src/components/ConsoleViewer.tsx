import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleLine } from '@mcpanel/shared';
import { Button, Input, Select } from './ui';
import { cn } from '../utils/cn';

export type ConsoleLevelFilter = 'all' | 'info' | 'warn' | 'error';

export function filterConsoleLines(lines: ConsoleLine[], level: ConsoleLevelFilter, search: string): ConsoleLine[] {
  const needle = search.trim().toLowerCase();
  return lines.filter(
    (line) => (level === 'all' || line.level === level) && (needle === '' || line.text.toLowerCase().includes(needle)),
  );
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

const LINE_TONES: Record<ConsoleLine['level'], string> = {
  info: '',
  warn: 'text-[var(--warn)]',
  error: 'text-[var(--danger)]',
};

export function ConsoleViewer({
  lines,
  gap,
  onDownload,
}: {
  lines: ConsoleLine[];
  gap: boolean;
  onDownload: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<ConsoleLevelFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const filtered = useMemo(() => filterConsoleLines(lines, level, search), [lines, level, search]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  const scrollToLatest = () => {
    if (filtered.length > 0) virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
  };

  // Depend on the newest line's seq, not the array length: the store caps lines
  // at MAX_LINES, so once the cap is reached new lines no longer change the
  // length and a length-based effect would silently stop following.
  const lastSeq = filtered.at(-1)?.seq;
  useEffect(() => {
    if (follow) scrollToLatest();
  }, [follow, lastSeq]);

  const handleScroll = () => {
    const element = parentRef.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-36">
          <Select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value as ConsoleLevelFilter)}>
            <option value="all">全部级别</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </Select>
        </div>
        <div className="w-56">
          <Input aria-label="搜索日志" placeholder="搜索日志" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <span className="text-xs text-[var(--muted)]">{filtered.length} 行</span>
        <div className="ml-auto flex items-center gap-2">
          {!follow && (
            <Button
              variant="secondary"
              onClick={() => {
                scrollToLatest();
                setFollow(true);
              }}
            >
              回到最新
            </Button>
          )}
          <Button variant="secondary" onClick={onDownload}>
            下载日志
          </Button>
        </div>
      </div>

      {gap && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-[var(--warn)]">
          部分历史日志因输出过快被丢弃，当前显示的是缓冲区保留内容。
        </div>
      )}

      <div
        ref={parentRef}
        onScroll={handleScroll}
        role="log"
        className="console-font h-[calc(100vh-19rem)] min-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--console-bg)] p-3 text-xs leading-5 text-[var(--console-fg)]"
      >
        {filtered.length === 0 ? (
          <div className="text-[var(--muted)]">暂无日志</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = filtered[item.index];
              if (!line) return null;
              const time = timestamp(line.ts);
              return (
                <div
                  key={line.seq}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                  className={cn(
                    'flex gap-2',
                    'whitespace-pre-wrap break-all',
                    line.stream === 'rcon' && 'text-[var(--primary)]',
                    LINE_TONES[line.level],
                  )}
                >
                  {time && <span className="shrink-0 opacity-60">{time}</span>}
                  <span>{line.text}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
