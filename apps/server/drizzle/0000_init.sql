CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_username_unique ON users(username);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'agent')),
  base_url TEXT,
  token_enc TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  name TEXT NOT NULL COLLATE NOCASE,
  root_path TEXT NOT NULL,
  root_path_key TEXT NOT NULL,
  start_command TEXT NOT NULL,
  java_path TEXT,
  stop_timeout_sec INTEGER NOT NULL DEFAULT 30 CHECK (stop_timeout_sec BETWEEN 10 AND 300),
  log_encoding TEXT NOT NULL DEFAULT 'utf-8' CHECK (log_encoding IN ('utf-8', 'gbk')),
  rcon_host TEXT,
  backup_keep INTEGER NOT NULL DEFAULT 10 CHECK (backup_keep BETWEEN 1 AND 100),
  backup_include_mods INTEGER NOT NULL DEFAULT 0 CHECK (backup_include_mods IN (0, 1)),
  backup_include_config INTEGER NOT NULL DEFAULT 1 CHECK (backup_include_config IN (0, 1)),
  backup_extra_paths TEXT NOT NULL DEFAULT '[]',
  last_state TEXT NOT NULL DEFAULT 'stopped' CHECK (last_state IN ('stopped', 'starting', 'running', 'stopping', 'crashed', 'orphaned', 'unknown')),
  last_pid INTEGER,
  last_started_at INTEGER,
  last_exit_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX instances_name_unique ON instances(name);
CREATE UNIQUE INDEX instances_root_unique ON instances(node_id, root_path_key);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('backup', 'start', 'stop', 'restart', 'command', 'broadcast')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX schedules_instance_idx ON schedules(instance_id);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, started_at);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled', 'pre_restore')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed', 'restoring')),
  size_bytes INTEGER,
  includes_mods INTEGER NOT NULL DEFAULT 0 CHECK (includes_mods IN (0, 1)),
  manifest_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (instance_id, filename)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_created_at_idx ON audit_logs(created_at);
CREATE INDEX audit_action_idx ON audit_logs(action);
CREATE INDEX audit_target_idx ON audit_logs(target_type, target_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
