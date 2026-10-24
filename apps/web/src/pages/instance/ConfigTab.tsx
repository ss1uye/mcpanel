import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { PropertiesPayload } from '@mcpanel/shared';
import type { InstanceOutletContext } from '../../layouts/InstanceLayout';
import { api, ApiError } from '../../api/client';
import { PropertiesForm } from '../../components/PropertiesForm';
import { RconEnableDialog } from '../../components/RconEnableDialog';
import { Button, ErrorState, Field, Notice, Spinner, toast } from '../../components/ui';
import { diffProperties } from '../../utils/properties';

export function ConfigTab() {
  const { instance } = useOutletContext<InstanceOutletContext>();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'form' | 'raw'>('form');
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enableOpen, setEnableOpen] = useState(false);

  const payload = useQuery({
    queryKey: ['properties', instance.id],
    queryFn: () => api.get<PropertiesPayload>(`/instances/${instance.id}/config/properties`),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['properties', instance.id] });
    setValues(null);
    setRawDraft(null);
  };

  const save = useMutation({
    mutationFn: (changes: Record<string, string>) =>
      api.put(`/instances/${instance.id}/config/properties`, {
        changes,
        expectedMtime: payload.data?.mtime ?? 0,
      }),
    onSuccess: async () => {
      setError(null);
      await refresh();
      toast('配置已保存，重启服务器后生效', 'success');
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '保存失败'),
  });

  const acceptEula = useMutation({
    mutationFn: () => api.post(`/instances/${instance.id}/config/eula`, { accept: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['properties', instance.id] });
      toast('已接受 EULA', 'success');
    },
    onError: (cause) => toast(cause instanceof ApiError ? cause.message : '操作失败', 'error'),
  });

  if (payload.isLoading) return <Spinner />;
  if (payload.isError || !payload.data) return <ErrorState message="配置加载失败" />;

  const data = payload.data;
  const original = Object.fromEntries(data.entries.map((entry) => [entry.key, entry.value]));
  const current = values ?? original;
  const raw = rawDraft ?? data.raw;

  const saveForm = () => {
    const changes: Record<string, string> = {};
    for (const [key, value] of Object.entries(current)) {
      if (original[key] !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      toast('没有需要保存的修改', 'info');
      return;
    }
    save.mutate(changes);
  };

  const saveRaw = () => {
    const changes = diffProperties(data.raw, raw);
    if (Object.keys(changes).length === 0) {
      toast('没有需要保存的修改', 'info');
      return;
    }
    save.mutate(changes);
  };

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {!data.eula && (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>尚未接受 Minecraft EULA，服务器启动会被拦截。</span>
            <Button variant="secondary" loading={acceptEula.isPending} onClick={() => acceptEula.mutate()}>
              接受 EULA
            </Button>
          </div>
        </Notice>
      )}
      {instance.rconStatus === 'disabled' && (
        <Notice tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>玩家管理需要 RCON。</span>
            <Button variant="secondary" onClick={() => setEnableOpen(true)}>
              启用 RCON
            </Button>
          </div>
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
          <Button variant={mode === 'form' ? 'secondary' : 'ghost'} onClick={() => setMode('form')}>
            表单
          </Button>
          <Button variant={mode === 'raw' ? 'secondary' : 'ghost'} onClick={() => setMode('raw')}>
            原始编辑
          </Button>
        </div>
        <Button loading={save.isPending} onClick={() => (mode === 'form' ? saveForm() : saveRaw())}>
          保存配置
        </Button>
      </div>

      {mode === 'form' ? (
        <PropertiesForm payload={data} values={current} onChange={setValues} />
      ) : (
        <Field label="server.properties" hint="只保存值发生变化的键；注释、顺序与换行风格保持不变（不支持删除键）">
          <textarea
            aria-label="server.properties 内容"
            className="console-font h-96 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--console-bg)] p-3 text-xs leading-5 text-[var(--console-fg)]"
            value={raw}
            spellCheck={false}
            onChange={(event) => setRawDraft(event.target.value)}
          />
        </Field>
      )}

      {error && <ErrorState message={error} />}

      <RconEnableDialog
        instanceId={instance.id}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onEnabled={() => {
          void queryClient.invalidateQueries({ queryKey: ['instances'] });
          void payload.refetch();
        }}
      />
    </div>
  );
}
