import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InstanceInfo, LogEncoding, ProbeResult } from '@mcpanel/shared';
import { api, ApiError } from '../api/client';
import { Button, Dialog, ErrorState, Field, Input, Notice, Select, toast } from './ui';

function defaultName(rootPath: string): string {
  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? '新实例';
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0 text-[var(--muted)]">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

export function CreateInstanceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rootPath, setRootPath] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [name, setName] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [javaPath, setJavaPath] = useState('');
  const [stopTimeout, setStopTimeout] = useState(30);
  const [encoding, setEncoding] = useState<LogEncoding>('utf-8');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const reset = () => {
    setRootPath('');
    setProbe(null);
    setName('');
    setStartCommand('');
    setJavaPath('');
    setStopTimeout(30);
    setEncoding('utf-8');
    setError(null);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const probeMutation = useMutation({
    mutationFn: () => api.post<ProbeResult>('/instances/probe', { rootPath: rootPath.trim() }),
    onSuccess: (result) => {
      setProbe(result);
      setName((current) => current || defaultName(result.rootPath));
      setStartCommand(result.suggestedStartCommand ?? '');
      setError(null);
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '目录检测失败'),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.post<InstanceInfo>('/instances', {
        name: name.trim(),
        rootPath: rootPath.trim(),
        startCommand: startCommand.trim(),
        javaPath: javaPath.trim() || null,
        stopTimeoutSec: stopTimeout,
        logEncoding: encoding,
      }),
    onSuccess: async (instance) => {
      await queryClient.invalidateQueries({ queryKey: ['instances'] });
      toast('实例已纳管', 'success');
      reset();
      onOpenChange(false);
      navigate(`/instances/${instance.id}/overview`);
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : '创建失败'),
  });

  const submit = () => {
    setError(null);
    if (!probe || probe.rootPath !== rootPath.trim()) {
      setError('请先检测当前目录');
      return;
    }
    if (!name.trim()) {
      setError('请填写实例名称');
      return;
    }
    if (!startCommand.trim()) {
      setError('请填写启动命令');
      return;
    }
    if (!Number.isInteger(stopTimeout) || stopTimeout < 10 || stopTimeout > 300) {
      setError('停止超时需在 10 到 300 秒之间');
      return;
    }
    createMutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="纳管服务器"
      description="选择一个已经安装好的 Java 服务端目录，面板只读取现有文件，不会移动或覆盖任何内容。"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            取消
          </Button>
          <Button
            disabled={!probe || !rootPath.trim() || probe.rootPath !== rootPath.trim()}
            loading={createMutation.isPending}
            onClick={submit}
          >
            创建实例
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="服务器目录" hint="例如 D:\\servers\\survival">
              <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="输入绝对路径" />
            </Field>
          </div>
          <Button
            variant="secondary"
            loading={probeMutation.isPending}
            disabled={!rootPath.trim()}
            onClick={() => probeMutation.mutate()}
          >
            检测目录
          </Button>
        </div>

        {probe && probe.rootPath !== rootPath.trim() && (
          <Notice tone="warning">目录已修改，请重新检测后再创建实例。</Notice>
        )}

        {probe && (
          <>
            <div className="grid gap-2 rounded-lg bg-[var(--surface-2)] p-4 text-sm sm:grid-cols-2">
              <SummaryItem label="启动脚本" value={probe.detected.startScripts.join(', ') || '未找到'} />
              <SummaryItem label="服务端 JAR" value={probe.detected.serverJars.join(', ') || '未找到'} />
              <SummaryItem label="存档目录" value={probe.detected.levelName} />
              <SummaryItem label="端口" value={String(probe.detected.serverPort)} />
              <SummaryItem label="EULA" value={probe.detected.eula ? '已接受' : '未接受'} />
              <SummaryItem
                label="RCON"
                value={probe.detected.enableRcon ? `已启用（${probe.detected.rconPort}）` : '未启用'}
              />
              <SummaryItem label="Java" value={probe.java ? `Java ${probe.java.major}` : '未找到'} />
              <SummaryItem label="模组" value={probe.detected.hasMods ? '有 mods 目录' : '无'} />
              <SummaryItem label="正版验证" value={probe.detected.onlineMode ? '开启' : '关闭'} />
            </div>

            {probe.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
                {probe.warnings.map((warning) => (
                  <div key={warning.code}>{warning.message}</div>
                ))}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="实例名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
              </Field>
              <Field label="启动命令" hint="在服务端目录内执行">
                <Input value={startCommand} onChange={(event) => setStartCommand(event.target.value)} placeholder="run.bat" />
              </Field>
              <Field label="停止超时（秒）">
                <Input
                  type="number"
                  min={10}
                  max={300}
                  value={stopTimeout}
                  onChange={(event) => setStopTimeout(Math.trunc(Number(event.target.value)))}
                />
              </Field>
              <Field label="Java 路径" hint="留空使用 PATH 中的 java">
                <Input value={javaPath} onChange={(event) => setJavaPath(event.target.value)} placeholder="自动" />
              </Field>
              <Field label="日志编码" hint="中文服务端日志常见为 GBK">
                <Select value={encoding} onChange={(event) => setEncoding(event.target.value as LogEncoding)}>
                  <option value="utf-8">UTF-8</option>
                  <option value="gbk">GBK</option>
                </Select>
              </Field>
            </div>

            {!probe.detected.eula && (
              <p className="text-xs text-[var(--warn)]">eula.txt 尚未接受，启动会被 Mojang 拦截，请先在服务端目录中同意。</p>
            )}
          </>
        )}

        {error && <ErrorState message={error} />}
      </div>
    </Dialog>
  );
}
