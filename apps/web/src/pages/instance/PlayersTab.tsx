import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PlayerActionInput, PlayerListsResponse, PlayersResponse } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { PlayerList } from '../../components/PlayerList';
import { RconEnableDialog } from '../../components/RconEnableDialog';
import { Button, Dialog, EmptyState, ErrorState, Field, Input, Notice, Spinner, toast } from '../../components/ui';
import { RCON_LABELS } from '../../utils/labels';

function NameList({ title, names }: { title: string; names: string[] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-sm font-medium">
        {title}（{names.length}）
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-[var(--muted)]">
        {names.length > 0
          ? names.map((name) => (
              <span key={name} className="rounded bg-[var(--surface-2)] px-2 py-0.5">
                {name}
              </span>
            ))
          : '暂无'}
      </div>
    </div>
  );
}

export function PlayersTab() {
  const { instance, status } = useOutletContext<InstanceOutletContext>();
  const [enableOpen, setEnableOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const queryClient = useQueryClient();

  const players = useQuery({
    queryKey: ['players', instance.id],
    queryFn: () => api.get<PlayersResponse>(`/instances/${instance.id}/players`),
    refetchInterval: 10_000,
  });
  const lists = useQuery({
    queryKey: ['player-lists', instance.id],
    queryFn: () => api.get<PlayerListsResponse>(`/instances/${instance.id}/players/lists`),
    refetchInterval: 30_000,
  });

  const action = useMutation({
    mutationFn: (input: PlayerActionInput) => api.post(`/instances/${instance.id}/players/actions`, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['players', instance.id] });
      toast('操作已发送', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  const rconStatus = players.data?.rconStatus ?? instance.rconStatus;
  const running = status.state === 'running' || status.state === 'orphaned';
  const online = players.data?.online ?? [];
  const canAct = running && rconStatus === 'connected';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">
          在线 {online.length} / {players.data?.max ?? 0} · RCON：{RCON_LABELS[rconStatus]}
        </div>
        <div className="flex gap-2">
          {rconStatus === 'disabled' && <Button onClick={() => setEnableOpen(true)}>启用 RCON</Button>}
        </div>
      </div>

      {!running && <Notice tone="warning">服务器未运行，玩家列表为空。启动后才能执行玩家操作。</Notice>}
      {running && rconStatus === 'disabled' && <Notice tone="warning">RCON 未启用，无法查询或管理玩家。</Notice>}
      {running && (rconStatus === 'auth_failed' || rconStatus === 'unreachable') && (
        <Notice tone="warning">RCON 连接失败（{RCON_LABELS[rconStatus]}），请检查密码、端口和防火墙。</Notice>
      )}
      {players.data?.warning && running && <Notice tone="info">{players.data.warning}</Notice>}
      {players.isError && <ErrorState message="玩家列表加载失败" />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">在线玩家</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!canAct} onClick={() => action.mutate({ action: 'whitelist_on' })}>
            开启白名单
          </Button>
          <Button variant="secondary" disabled={!canAct} onClick={() => action.mutate({ action: 'whitelist_off' })}>
            关闭白名单
          </Button>
          <Button variant="secondary" disabled={!canAct} onClick={() => setBroadcastOpen(true)}>
            广播
          </Button>
        </div>
      </div>

      {players.isLoading ? (
        <Spinner />
      ) : online.length === 0 ? (
        <EmptyState
          title="没有在线玩家"
          description={running ? '服务器正在运行，等待玩家加入。' : '启动服务器后这里会显示在线玩家。'}
        />
      ) : (
        <PlayerList players={online} onAction={(input) => action.mutate(input)} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <NameList title="白名单" names={lists.data?.whitelist ?? []} />
        <NameList title="OP" names={lists.data?.ops ?? []} />
        <NameList title="封禁玩家" names={lists.data?.banned ?? []} />
        <NameList title="封禁 IP" names={lists.data?.bannedIps ?? []} />
      </div>

      <Dialog
        open={broadcastOpen}
        onOpenChange={(open) => {
          setBroadcastOpen(open);
          if (!open) setBroadcastText('');
        }}
        title="广播消息"
        description="以服务器身份向所有在线玩家发送一条消息。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBroadcastOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!broadcastText.trim() || action.isPending}
              onClick={() => {
                void action
                  .mutateAsync({ action: 'broadcast', message: broadcastText.trim() })
                  .then(() => {
                    setBroadcastOpen(false);
                    setBroadcastText('');
                  })
                  .catch(() => undefined);
              }}
            >
              发送
            </Button>
          </>
        }
      >
        <Field label="消息">
          <Input value={broadcastText} maxLength={256} onChange={(event) => setBroadcastText(event.target.value)} />
        </Field>
      </Dialog>

      <RconEnableDialog
        instanceId={instance.id}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onEnabled={() => {
          void queryClient.invalidateQueries({ queryKey: ['instances'] });
          void queryClient.invalidateQueries({ queryKey: ['players', instance.id] });
        }}
      />
    </div>
  );
}
