import pidusage from 'pidusage';
import si from 'systeminformation';
import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { PANEL_VERSION, type ProcessMetricsSample, type ServerWsMessage, type SystemMetricsSample } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances } from '../db/schema';
import { diskUsage } from '../utils/disk';
import type { InstanceSupervisor } from './instance-supervisor';

const SAMPLE_INTERVAL_MS = 3000;
const HISTORY_SIZE = 60;
/** One Windows process enumeration costs a PowerShell run, so instances in the same tick share it. */
const PROCESS_LIST_TTL_MS = 1000;

interface TreeProcess {
  pid: number;
  parentPid: number;
}

let processList: { at: number; list: TreeProcess[] } | null = null;

async function treePids(rootPid: number): Promise<number[]> {
  const now = Date.now();
  if (!processList || now - processList.at > PROCESS_LIST_TTL_MS) {
    try {
      const { list } = await si.processes();
      processList = { at: now, list: list.map(({ pid, parentPid }) => ({ pid, parentPid })) };
    } catch {
      processList = null;
    }
  }
  return processList ? collectTreePids(processList.list, rootPid) : [rootPid];
}

export interface MetricsCollector {
  system(dataDir: string): Promise<SystemMetricsSample>;
  instance(pid: number, rootPath: string): Promise<ProcessMetricsSample>;
}

/**
 * The start command runs through a shell, so the tracked PID is only the wrapper:
 * the JVM lives in its subtree and must be included in the resource totals.
 */
export function collectTreePids(processes: TreeProcess[], rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = children.get(process.parentPid);
    if (siblings) siblings.push(process.pid);
    else children.set(process.parentPid, [process.pid]);
  }

  const pids: number[] = [];
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    pids.push(current);
    pending.push(...(children.get(current) ?? []));
  }
  return pids;
}

export const defaultCollector: MetricsCollector = {
  async system(dataDir) {
    const [load, mem, disk, time] = await Promise.all([si.currentLoad(), si.mem(), diskUsage(dataDir), si.time()]);
    return {
      ts: new Date().toISOString(),
      cpuPercent: Number(load.currentLoad.toFixed(1)),
      memUsedBytes: mem.used,
      memTotalBytes: mem.total,
      diskFreeBytes: disk.free,
      diskTotalBytes: disk.total,
      uptimeSec: time.uptime,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      panelVersion: PANEL_VERSION,
    };
  },
  async instance(pid, rootPath) {
    const pids = await treePids(pid);
    const [usage, disk] = await Promise.all([
      pidusage(pids).catch(() => null),
      diskUsage(rootPath),
    ]);
    const measured = Object.values(usage ?? {}).filter((stat) => Number.isFinite(stat.cpu) && Number.isFinite(stat.memory));
    if (measured.length === 0) throw new Error(`进程 ${pid} 无法采样`);
    const cpu = measured.reduce((total, stat) => total + stat.cpu, 0);
    const memBytes = measured.reduce((total, stat) => total + stat.memory, 0);
    return {
      ts: new Date().toISOString(),
      cpu: Number(cpu.toFixed(1)),
      memBytes,
      diskFreeBytes: disk.free,
    };
  },
};

export interface MetricsDeps {
  collector?: MetricsCollector;
  supervisor: InstanceSupervisor;
  db: DB;
  dataDir: string;
  logger?: Pick<Logger, 'warn'>;
}

export class MetricsService {
  private readonly collector: MetricsCollector;
  private readonly systemHistory: SystemMetricsSample[] = [];
  private readonly instanceHistory = new Map<string, ProcessMetricsSample[]>();
  private readonly instanceCounts = new Map<string, number>();
  private systemCount = 0;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private sink: ((message: ServerWsMessage) => void) | null = null;

  constructor(private readonly deps: MetricsDeps) {
    this.collector = deps.collector ?? defaultCollector;
  }

  setSink(sink: (message: ServerWsMessage) => void): void {
    this.sink = sink;
  }

  setSystemActive(active: boolean): void {
    this.systemCount = Math.max(0, this.systemCount + (active ? 1 : -1));
    this.syncTimer();
  }

  setInstanceActive(instanceId: string, active: boolean): void {
    const next = Math.max(0, (this.instanceCounts.get(instanceId) ?? 0) + (active ? 1 : -1));
    if (next === 0) this.instanceCounts.delete(instanceId);
    else this.instanceCounts.set(instanceId, next);
    this.syncTimer();
  }

  getLatestSystem(): SystemMetricsSample | null {
    return this.systemHistory.at(-1) ?? null;
  }

  getLatestInstance(instanceId: string): ProcessMetricsSample | null {
    return this.instanceHistory.get(instanceId)?.at(-1) ?? null;
  }

  async getSystemOverview(): Promise<SystemMetricsSample> {
    const sample = await this.collector.system(this.deps.dataDir);
    this.pushSystem(sample);
    return sample;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.systemCount = 0;
    this.instanceCounts.clear();
  }

  private syncTimer(): void {
    const active = this.systemCount > 0 || this.instanceCounts.size > 0;
    if (active && !this.timer) {
      this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
      this.timer.unref();
      void this.sample();
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      if (this.systemCount > 0) {
        this.pushSystem(await this.collector.system(this.deps.dataDir));
      }
      for (const instanceId of [...this.instanceCounts.keys()]) {
        const status = this.deps.supervisor.getStatus(instanceId);
        if (!status.pid || (status.state !== 'running' && status.state !== 'orphaned')) continue;
        const row = this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
        if (!row) continue;
        const sample = await this.collector.instance(status.pid, row.rootPath).catch(() => null);
        if (!sample) continue;
        const history = this.instanceHistory.get(instanceId) ?? [];
        history.push(sample);
        this.instanceHistory.set(instanceId, history.slice(-HISTORY_SIZE));
        this.sink?.({ type: 'metrics.sample', target: 'instance', instanceId, ts: sample.ts, sample });
      }
    } catch (error) {
      // A single failed sample (e.g. Windows EBUSY while the OS is busy) must
      // not become an unhandled rejection and take down the whole panel.
      this.deps.logger?.warn({ err: error }, 'metrics sampling failed');
    } finally {
      this.sampling = false;
    }
  }

  private pushSystem(sample: SystemMetricsSample): void {
    this.systemHistory.push(sample);
    if (this.systemHistory.length > HISTORY_SIZE) this.systemHistory.shift();
    this.sink?.({ type: 'metrics.sample', target: 'system', ts: sample.ts, sample });
  }
}
