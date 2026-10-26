import os from 'node:os';
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
const SYSTEM_OVERVIEW_CACHE_MS = 5000;
/** One Windows process enumeration costs a PowerShell run, so instances in the same tick share it. */
const PROCESS_LIST_TTL_MS = 1000;

interface TreeProcess {
  pid: number;
  parentPid: number;
}

let processList: { at: number; list: TreeProcess[] } | null = null;
let processListTask: Promise<TreeProcess[] | null> | null = null;

async function getProcessList(): Promise<TreeProcess[] | null> {
  if (processList && Date.now() - processList.at <= PROCESS_LIST_TTL_MS) return processList.list;
  if (!processListTask) {
    processListTask = si
      .processes()
      .then(({ list }) => {
        const mapped = list.map(({ pid, parentPid }) => ({ pid, parentPid }));
        processList = { at: Date.now(), list: mapped };
        return mapped;
      })
      .catch(() => null)
      .finally(() => {
        processListTask = null;
      });
  }
  return processListTask;
}

async function treePids(rootPid: number): Promise<number[]> {
  const list = await getProcessList();
  return list ? collectTreePids(list, rootPid) : [rootPid];
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

export interface CpuSnapshot {
  idle: number;
  total: number;
}

export function cpuSnapshot(cpus: os.CpuInfo[] = os.cpus()): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export function cpuUsagePercent(previous: CpuSnapshot, current: CpuSnapshot): number {
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return 0;
  const idleDelta = current.idle - previous.idle;
  const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number(Math.min(100, Math.max(0, percent)).toFixed(1));
}

let previousCpu = cpuSnapshot();

export const defaultCollector: MetricsCollector = {
  async system(dataDir) {
    const currentCpu = cpuSnapshot();
    const cpuPercent = cpuUsagePercent(previousCpu, currentCpu);
    previousCpu = currentCpu;
    const [disk, memTotal] = await Promise.all([diskUsage(dataDir), Promise.resolve(os.totalmem())]);
    return {
      ts: new Date().toISOString(),
      cpuPercent,
      memUsedBytes: Math.max(0, memTotal - os.freemem()),
      memTotalBytes: memTotal,
      diskFreeBytes: disk.free,
      diskTotalBytes: disk.total,
      uptimeSec: os.uptime(),
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
  private systemSampleAt = 0;
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
    const latest = this.getLatestSystem();
    if (latest && Date.now() - this.systemSampleAt < SYSTEM_OVERVIEW_CACHE_MS) return latest;
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
        try {
          this.pushSystem(await this.collector.system(this.deps.dataDir));
        } catch (error) {
          this.deps.logger?.warn({ err: error }, 'system metrics sampling failed');
        }
      }
      const results = await Promise.allSettled(
        [...this.instanceCounts.keys()].map((instanceId) => this.collectInstance(instanceId)),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          // A single failed sample (e.g. Windows EBUSY while the OS is busy) must
          // not become an unhandled rejection and take down the whole panel.
          this.deps.logger?.warn({ err: result.reason }, 'instance metrics sampling failed');
        }
      }
    } finally {
      this.sampling = false;
    }
  }

  private async collectInstance(instanceId: string): Promise<void> {
    const status = this.deps.supervisor.getStatus(instanceId);
    if (!status.pid || (status.state !== 'running' && status.state !== 'orphaned')) return;
    const row = this.deps.db.select().from(instances).where(eq(instances.id, instanceId)).get();
    if (!row) return;
    const sample = await this.collector.instance(status.pid, row.rootPath).catch(() => null);
    if (!sample) return;
    const history = this.instanceHistory.get(instanceId) ?? [];
    history.push(sample);
    this.instanceHistory.set(instanceId, history.slice(-HISTORY_SIZE));
    this.sink?.({ type: 'metrics.sample', target: 'instance', instanceId, ts: sample.ts, sample });
  }

  private pushSystem(sample: SystemMetricsSample): void {
    this.systemSampleAt = Date.now();
    this.systemHistory.push(sample);
    if (this.systemHistory.length > HISTORY_SIZE) this.systemHistory.shift();
    this.sink?.({ type: 'metrics.sample', target: 'system', ts: sample.ts, sample });
  }
}
