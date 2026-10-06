-- 0001_core: system state, businesses, agents, tasks, events (audit), approvals, checkpoints, process runs.
-- Conventions: STRICT tables; TEXT ISO-8601 UTC timestamps; money as integer minor units (cents);
-- *_json columns hold validated JSON; data_mode separates DEMO / TEST / LIVE records.
-- No secrets or credentials belong in any table.

CREATE TABLE system_state (
  key         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'state' CHECK (kind IN ('state','setting')),
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE process_runs (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','clean','crashed')),
  pid         INTEGER,
  app_version TEXT
) STRICT;

CREATE TABLE businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL UNIQUE CHECK (kind IN ('etsy_pod','game_assets','affiliate','fiverr')),
  status      TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','active','paused','disabled')),
  level       INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  data_mode   TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE business_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  period      TEXT NOT NULL DEFAULT 'point',
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  data_mode   TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_business_metrics_lookup ON business_metrics (business_id, metric, recorded_at);

CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('Research','Opportunity','Strategy','Creation','QA','Publishing','Analytics','Optimization','Financial','Recovery','Safety','Supervisor')),
  business_id  TEXT REFERENCES businesses(id),           -- NULL = shared across businesses
  status       TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('candidate','idle','working','blocked','suspended','retired')),
  level        INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp           INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  reputation   REAL NOT NULL DEFAULT 0,
  health       INTEGER NOT NULL DEFAULT 100 CHECK (health BETWEEN 0 AND 100),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),
  config_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  data_mode    TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at   TEXT
) STRICT;
CREATE INDEX idx_agents_business ON agents (business_id);
CREATE INDEX idx_agents_status ON agents (status);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  business_id     TEXT REFERENCES businesses(id),
  agent_id        TEXT REFERENCES agents(id),
  parent_task_id  TEXT REFERENCES tasks(id),
  correlation_id  TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','retrying','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 10),   -- 0 = most urgent
  payload_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries     INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  error_code      TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT,
  completed_at    TEXT,
  next_attempt_at TEXT,
  data_mode       TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_tasks_queue ON tasks (status, priority, next_attempt_at);
CREATE INDEX idx_tasks_business ON tasks (business_id, status);
CREATE INDEX idx_tasks_agent ON tasks (agent_id, status);
CREATE INDEX idx_tasks_correlation ON tasks (correlation_id);

-- Append-only audit/event stream (enforced by triggers below).
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warn','error','critical')),
  business_id   TEXT REFERENCES businesses(id),
  agent_id      TEXT REFERENCES agents(id),
  task_id       TEXT REFERENCES tasks(id),
  action        TEXT NOT NULL,
  result        TEXT,
  cost_minor    INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  error         TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  data_mode     TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_events_ts ON events (ts);
CREATE INDEX idx_events_business_ts ON events (business_id, ts);
CREATE INDEX idx_events_type ON events (type, ts);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  request_type     TEXT NOT NULL,
  business_id      TEXT REFERENCES businesses(id),
  task_id          TEXT REFERENCES tasks(id),
  agent_id         TEXT REFERENCES agents(id),
  action           TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency         TEXT NOT NULL DEFAULT 'USD',
  reason           TEXT,
  expected_benefit TEXT,
  risk             TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high','critical')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  expires_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at      TEXT,
  resolution       TEXT,
  resolved_by      TEXT,
  data_mode        TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_approvals_status ON approvals (status, expires_at);

-- Recovery foundation: what was running/queued/done/failed per scope.
CREATE TABLE checkpoints (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  data_mode  TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  PRIMARY KEY (scope, key)
) STRICT;
