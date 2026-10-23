import pidusage from 'pidusage';
import si from 'systeminformation';
import { eq } from 'drizzle-orm';
import { PANEL_VERSION, type ProcessMetricsSample, type ServerWsMessage, type SystemMetricsSample } from '@mcpanel/shared';
import type { DB } from '../db/client';
import { instances } from '../db/schema';
import { diskUsage } from '../utils/disk';
import type { InstanceSupervisor } from './instance-supervisor';

const SAMPLE_INTERVAL_MS = 3000;
const HISTORY_SIZE = 60;

export interface MetricsCollector {
  system(dataDir: string): Promise<SystemMetricsSample>;
  instance(pid: number, rootPath: string): Promise<ProcessMetricsSample>;
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
    const [usage, disk] = await Promise.all([pidusage(pid), diskUsage(rootPath)]);
    return {
      ts: new Date().toISOString(),
      cpu: Number(usage.cpu.toFixed(1)),
      memBytes: usage.memory,
      diskFreeBytes: disk.free,
    };
  },
};

export interface MetricsDeps {
  collector?: MetricsCollector;
  supervisor: InstanceSupervisor;
  db: DB;
  dataDir: string;
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
