-- migrate:foreign-keys=off
-- 0003_agent_os: Agent OS lifecycle states and runtime columns. SQLite cannot alter CHECK constraints, so agents and tasks
-- are rebuilt (the documented 12-step procedure; the migration runner disables FK enforcement around this file,
-- verifies PRAGMA foreign_key_check before commit, and re-enables enforcement).
-- State mapping for existing rows:
--   agents: candidate->created, idle->ready, working->running, suspended->paused, blocked->blocked, retired->retired
--   tasks:  queued->queued, running->running, waiting_approval->blocked, succeeded->completed, failed->failed, retrying->retrying, cancelled->cancelled

CREATE TABLE agents_new (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  role              TEXT NOT NULL CHECK (role IN ('Research','Opportunity','Strategy','Creation','QA','Publishing','Analytics','Optimization','Financial','Recovery','Safety','Supervisor')),
  business_id       TEXT REFERENCES businesses(id),            -- primary business; NULL = shared
  status            TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','ready','running','paused','blocked','stopping','stopped','failed','retired')),
  level             INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp                INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  reputation        REAL NOT NULL DEFAULT 0,
  health            INTEGER NOT NULL DEFAULT 100 CHECK (health BETWEEN 0 AND 100),
  health_status     TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy','degraded','stalled','failed','unknown')),
  metrics_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),
  config_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),         -- task types, limits, runtime, retry (NO secrets)
  permissions_json  TEXT NOT NULL DEFAULT '{"capabilities":[],"businesses":[]}' CHECK (json_valid(permissions_json)),
  current_task_id   TEXT REFERENCES tasks(id),
  last_heartbeat_at TEXT,
  last_activity_at  TEXT,
  last_started_at   TEXT,
  last_error        TEXT,
  data_mode         TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at        TEXT
) STRICT;

INSERT INTO agents_new (id, name, role, business_id, status, level, xp, reputation, health, metrics_json, config_json, data_mode, created_at, updated_at, retired_at)
SELECT id, name, role, business_id,
  CASE status WHEN 'candidate' THEN 'created' WHEN 'idle' THEN 'ready' WHEN 'working' THEN 'running' WHEN 'suspended' THEN 'paused' ELSE status END,
  level, xp, reputation, health, metrics_json, config_json, data_mode, created_at, updated_at, retired_at
FROM agents;

CREATE TABLE tasks_new (
  id               TEXT PRIMARY KEY,
  business_id      TEXT REFERENCES businesses(id),
  agent_id         TEXT REFERENCES agents(id),                  -- assigned/owning agent
  parent_task_id   TEXT REFERENCES tasks(id),
  correlation_id   TEXT,
  type             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('pending','queued','assigned','running','completed','failed','retrying','cancelled','blocked')),
  priority         INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 10),   -- 0 = most urgent
  payload_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  result_json      TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  metadata_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  retry_count      INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_retries      INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0),
  timeout_ms       INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  error_code       TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at       TEXT,
  completed_at     TEXT,
  next_attempt_at  TEXT,                                        -- not eligible before this time (retry backoff)
  deadline_at      TEXT,                                        -- absolute give-up time for tasks not yet running
  claimed_at       TEXT,
  lease_expires_at TEXT,                                        -- ownership lease while assigned/running
  data_mode        TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;

INSERT INTO tasks_new (id, business_id, agent_id, parent_task_id, correlation_id, type, status, priority, payload_json, result_json, retry_count, max_retries, error_code, error_message, created_at, updated_at, started_at, completed_at, next_attempt_at, data_mode)
SELECT id, business_id, agent_id, parent_task_id, correlation_id, type,
  CASE status WHEN 'waiting_approval' THEN 'blocked' WHEN 'succeeded' THEN 'completed' ELSE status END,
  priority, payload_json, result_json, retry_count, max_retries, error_code, error_message, created_at, updated_at, started_at, completed_at, next_attempt_at, data_mode
FROM tasks;

DROP TABLE tasks;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_agents_business ON agents (business_id);
CREATE INDEX idx_agents_status ON agents (status);
CREATE INDEX idx_agents_heartbeat ON agents (status, last_heartbeat_at);
CREATE INDEX idx_tasks_queue ON tasks (status, priority, next_attempt_at, created_at);
CREATE INDEX idx_tasks_business ON tasks (business_id, status);
CREATE INDEX idx_tasks_agent ON tasks (agent_id, status);
CREATE INDEX idx_tasks_correlation ON tasks (correlation_id);
CREATE INDEX idx_tasks_lease ON tasks (status, lease_expires_at);

-- XP and reputation changes, one row per awarded change with the reason (append-only). Balancing belongs to Phase 13.
CREATE TABLE agent_progress_events (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  kind       TEXT NOT NULL CHECK (kind IN ('xp','reputation')),
  delta      REAL NOT NULL,
  reason     TEXT NOT NULL,
  task_id    TEXT REFERENCES tasks(id),
  data_mode  TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_progress_agent ON agent_progress_events (agent_id, ts);
CREATE TRIGGER progress_no_update BEFORE UPDATE ON agent_progress_events BEGIN SELECT RAISE(ABORT, 'progress events are append-only'); END;
CREATE TRIGGER progress_no_delete BEFORE DELETE ON agent_progress_events BEGIN SELECT RAISE(ABORT, 'progress events are append-only'); END;
