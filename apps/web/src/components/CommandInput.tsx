import { useState, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button, Input } from './ui';

const MAX_HISTORY = 100;

function historyKey(instanceId: string): string {
  return `mcpanel:command-history:${instanceId}`;
}

function loadHistory(instanceId: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(instanceId)) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function CommandInput({
  instanceId,
  disabled,
  onSend,
}: {
  instanceId: string;
  disabled: boolean;
  onSend: (command: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>(() => loadHistory(instanceId));
  const [index, setIndex] = useState(-1);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const command = value.trim();
    if (!command || disabled || sending) return;
    setSending(true);
    try {
      await onSend(command);
      const next = [command, ...history.filter((item) => item !== command)].slice(0, MAX_HISTORY);
      setHistory(next);
      localStorage.setItem(historyKey(instanceId), JSON.stringify(next));
      setValue('');
      setIndex(-1);
    } catch {
      // The caller surfaces the error; keeping the text lets the operator retry it.
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault();
      const next = Math.min(history.length - 1, index + 1);
      setIndex(next);
      setValue(history[next] ?? '');
      return;
    }
    if (event.key === 'ArrowDown' && index >= 0) {
      event.preventDefault();
      const next = index - 1;
      setIndex(next);
      setValue(next >= 0 ? (history[next] ?? '') : '');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <Input
          aria-label="服务器命令"
          className="console-font"
          placeholder={disabled ? '服务器未运行，无法发送命令' : '输入命令后回车，例如 say hello'}
          value={value}
          disabled={disabled || sending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <Button onClick={() => void send()} disabled={disabled || !value.trim()} loading={sending} aria-label="发送命令">
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
