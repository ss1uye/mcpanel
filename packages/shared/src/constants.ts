export const PANEL_VERSION = '0.1.0';
export const SESSION_COOKIE = 'mcpanel_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONSOLE_BUFFER_SIZE = 5000;
export const CONSOLE_HISTORY_BYTES = 64 * 1024;
export const WS_CHANNEL_PATTERN =
  /^(instance:[0-9a-f-]{36}:(console|status|metrics|players)|system:metrics|task:[0-9a-f-]{36})$/;

// Alias: the contract test imports `channelPattern` while the WS hub uses `WS_CHANNEL_PATTERN`.
export const channelPattern = WS_CHANNEL_PATTERN;

export const INSTANCE_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown'] as const;
export type InstanceState = (typeof INSTANCE_STATES)[number];

export const RCON_STATUSES = ['disabled', 'auth_failed', 'unreachable', 'connected', 'disconnected'] as const;
export type RconStatus = (typeof RCON_STATUSES)[number];

export const LOG_ENCODINGS = ['utf-8', 'gbk'] as const;
export type LogEncoding = (typeof LOG_ENCODINGS)[number];
