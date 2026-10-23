import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin'] }).notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [uniqueIndex('sessions_token_hash_unique').on(table.tokenHash), index('sessions_expires_at_idx').on(table.expiresAt)],
);

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['local', 'agent'] }).notNull(),
  baseUrl: text('base_url'),
  tokenEnc: text('token_enc'),
  createdAt: integer('created_at').notNull(),
});

export const instances = sqliteTable(
  'instances',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    rootPathKey: text('root_path_key').notNull(),
    startCommand: text('start_command').notNull(),
    javaPath: text('java_path'),
    stopTimeoutSec: integer('stop_timeout_sec').notNull().default(30),
    logEncoding: text('log_encoding', { enum: ['utf-8', 'gbk'] }).notNull().default('utf-8'),
    rconHost: text('rcon_host'),
    backupKeep: integer('backup_keep').notNull().default(10),
    backupIncludeMods: integer('backup_include_mods', { mode: 'boolean' }).notNull().default(false),
    backupIncludeConfig: integer('backup_include_config', { mode: 'boolean' }).notNull().default(true),
    backupExtraPaths: text('backup_extra_paths').notNull().default('[]'),
    lastState: text('last_state', {
      enum: ['stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown'],
    })
      .notNull()
      .default('stopped'),
    lastPid: integer('last_pid'),
    lastStartedAt: integer('last_started_at'),
    lastExitCode: integer('last_exit_code'),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('instances_name_unique').on(table.name),
    uniqueIndex('instances_root_unique').on(table.nodeId, table.rootPathKey),
  ],
);

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull(),
    actionType: text('action_type', { enum: ['backup', 'start', 'stop', 'restart', 'command', 'broadcast'] }).notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: integer('last_run_at'),
    nextRunAt: integer('next_run_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('schedules_instance_idx').on(table.instanceId)],
);

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: text('id').primaryKey(),
    scheduleId: text('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: ['scheduled', 'manual'] }).notNull(),
    status: text('status', { enum: ['running', 'success', 'failed', 'skipped'] }).notNull(),
    message: text('message'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [index('schedule_runs_schedule_idx').on(table.scheduleId, table.startedAt)],
);

export const backups = sqliteTable(
  'backups',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    kind: text('kind', { enum: ['manual', 'scheduled', 'pre_restore'] }).notNull(),
    status: text('status', { enum: ['creating', 'ready', 'failed', 'restoring'] }).notNull(),
    sizeBytes: integer('size_bytes'),
    includesMods: integer('includes_mods', { mode: 'boolean' }).notNull().default(false),
    manifestJson: text('manifest_json'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [uniqueIndex('backups_instance_filename_unique').on(table.instanceId, table.filename)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    detailJson: text('detail_json').notNull().default('{}'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('audit_created_at_idx').on(table.createdAt),
    index('audit_action_idx').on(table.action),
    index('audit_target_idx').on(table.targetType, table.targetId),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type InstanceRow = typeof instances.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
