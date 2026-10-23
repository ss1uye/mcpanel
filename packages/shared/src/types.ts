import type { InstanceState, LogEncoding, RconStatus } from './constants';

export interface UserInfo {
  id: string;
  username: string;
  role: 'admin';
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user: UserInfo | null;
}

export interface InstanceStatusSnapshot {
  instanceId: string;
  state: InstanceState;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

export interface InstanceInfo {
  id: string;
  name: string;
  rootPath: string;
  startCommand: string;
  javaPath: string | null;
  stopTimeoutSec: number;
  logEncoding: LogEncoding;
  rconHost: string | null;
  backupKeep: number;
  backupIncludeMods: boolean;
  backupIncludeConfig: boolean;
  backupExtraPaths: string[];
  state: InstanceState;
  pid: number | null;
  startedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  rconStatus: RconStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProbeResult {
  rootPath: string;
  valid: boolean;
  detected: {
    startScripts: string[];
    serverJars: string[];
    levelName: string;
    serverPort: number;
    enableRcon: boolean;
    rconPort: number;
    onlineMode: boolean;
    hasMods: boolean;
    hasConfig: boolean;
    eula: boolean;
  };
  java: { path: string; major: number } | null;
  suggestedStartCommand: string | null;
  warnings: { code: string; message: string }[];
}

export interface ConsoleLine {
  seq: number;
  ts: string;
  stream: 'stdout' | 'stderr' | 'rcon';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface SystemMetricsSample {
  ts: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  uptimeSec: number;
  platform: string;
  arch: string;
  nodeVersion: string;
  panelVersion: string;
}

export interface ProcessMetricsSample {
  ts: string;
  cpu: number;
  memBytes: number;
  diskFreeBytes: number;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RootValidation {
  realPath: string;
  rootKey: string;
}

export interface StartSpec {
  instanceId: string;
  rootPath: string;
  startCommand: string;
  logEncoding: LogEncoding;
}

export interface ProcessSnapshot {
  instanceId: string;
  pid: number;
  startedAt: number;
}

export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

export interface RconProbe {
  status: RconStatus;
  error: string | null;
}

export interface PlayerListResult {
  online: string[];
  max: number;
  warning: string | null;
}

export type ServerWsMessage =
  | { type: 'hello'; channels: string[]; serverTime: string }
  | { type: 'console.snapshot'; channel: string; lines: ConsoleLine[]; lastSeq: number; gap: boolean }
  | { type: 'console.append'; channel: string; lines: ConsoleLine[] }
  | { type: 'console.gap'; channel: string; dropped: number }
  | { type: 'instance.state'; instanceId: string; state: InstanceState; pid: number | null; startedAt: string | null; error: string | null }
  | { type: 'metrics.sample'; target: 'system'; ts: string; sample: SystemMetricsSample }
  | { type: 'metrics.sample'; target: 'instance'; instanceId: string; ts: string; sample: ProcessMetricsSample }
  | { type: 'players.update'; instanceId: string; online: string[]; max: number; rconStatus: RconStatus }
  | { type: 'notification'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
