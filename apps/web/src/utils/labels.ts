import type { RconStatus } from '@mcpanel/shared';

export const RCON_LABELS: Record<RconStatus, string> = {
  disabled: '未启用',
  auth_failed: '认证失败',
  unreachable: '无法连接',
  connected: '已连接',
  disconnected: '已断开',
};
