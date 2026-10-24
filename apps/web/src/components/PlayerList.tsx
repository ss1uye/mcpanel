import { useState } from 'react';
import type { PlayerActionInput } from '@mcpanel/shared';
import { PlayerAvatar } from './PlayerAvatar';
import { Button, Dialog, Field, Input, Menu, MenuItem, Select } from './ui';

type PlayerMode = 'survival' | 'creative' | 'adventure' | 'spectator';

type Pending = { kind: 'reason'; action: 'kick' | 'ban'; player: string } | { kind: 'gamemode'; player: string } | null;

const REASON_LABEL: Record<'kick' | 'ban', string> = { kick: '踢出', ban: '封禁' };

export function PlayerList({
  players,
  onAction,
}: {
  players: string[];
  onAction: (input: PlayerActionInput) => void | Promise<void>;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<PlayerMode>('survival');

  const quick = (action: PlayerActionInput) => {
    void onAction(action);
    setPending(null);
  };

  return (
    <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      {players.map((player) => (
        <div key={player} className="flex items-center gap-3 px-4 py-2.5">
          <PlayerAvatar name={player} />
          <span className="min-w-0 flex-1 truncate text-sm">{player}</span>
          <Menu label="玩家操作">
            <MenuItem onSelect={() => quick({ action: 'op', player })}>设为 OP</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'deop', player })}>取消 OP</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'whitelist_add', player })}>加入白名单</MenuItem>
            <MenuItem onSelect={() => quick({ action: 'whitelist_remove', player })}>移出白名单</MenuItem>
            <MenuItem
              onSelect={() => {
                setReason('');
                setPending({ kind: 'reason', action: 'kick', player });
              }}
            >
              踢出
            </MenuItem>
            <MenuItem
              danger
              onSelect={() => {
                setReason('');
                setPending({ kind: 'reason', action: 'ban', player });
              }}
            >
              封禁
            </MenuItem>
            <MenuItem onSelect={() => quick({ action: 'pardon', player })}>解除封禁</MenuItem>
            <MenuItem
              onSelect={() => {
                setMode('survival');
                setPending({ kind: 'gamemode', player });
              }}
            >
              切换游戏模式
            </MenuItem>
          </Menu>
        </div>
      ))}

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => (!open ? setPending(null) : undefined)}
        title={pending?.kind === 'reason' ? `确认${REASON_LABEL[pending.action]}` : `切换 ${pending?.player ?? ''} 的游戏模式`}
        description={
          pending?.kind === 'reason'
            ? `对 ${pending.player} 执行${REASON_LABEL[pending.action]}，原因会记录在服务器日志中。`
            : '切换后立即生效。'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant={pending?.kind === 'reason' && pending.action === 'ban' ? 'danger' : 'primary'}
              onClick={() => {
                if (!pending) return;
                if (pending.kind === 'reason') {
                  void onAction({ action: pending.action, player: pending.player, reason });
                } else {
                  void onAction({ action: 'gamemode', player: pending.player, mode });
                }
                setPending(null);
              }}
            >
              {pending?.kind === 'reason' ? `确认${REASON_LABEL[pending.action]}` : '确认切换'}
            </Button>
          </>
        }
      >
        {pending?.kind === 'reason' && (
          <Field label="原因">
            <Input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="可选" />
          </Field>
        )}
        {pending?.kind === 'gamemode' && (
          <Field label="游戏模式">
            <Select value={mode} onChange={(event) => setMode(event.target.value as PlayerMode)}>
              <option value="survival">生存</option>
              <option value="creative">创造</option>
              <option value="adventure">冒险</option>
              <option value="spectator">旁观</option>
            </Select>
          </Field>
        )}
      </Dialog>
    </div>
  );
}
