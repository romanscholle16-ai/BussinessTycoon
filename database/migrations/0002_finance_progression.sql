-- 0002_finance_progression: financial ledger (append-only), progression, achievements, quests, upgrades, leaderboard metrics.

-- Money is stored in integer minor units (cents). Amounts are always positive; direction comes from `type`.
-- Refunds are recorded as expenses with category 'refund'. Corrections are new reversing entries (never edits).
CREATE TABLE ledger_entries (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  type          TEXT NOT NULL CHECK (type IN ('revenue','expense')),
  category      TEXT NOT NULL CHECK (category IN ('revenue','ai_cost','api_cost','marketplace_fee','pod_cost','advertising','refund','other_expense')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  source        TEXT NOT NULL,                       -- e.g. 'manual', 'etsy', 'openai' (later phases)
  reference     TEXT,                                -- external id; (source, reference) is unique for idempotent imports
  task_id       TEXT REFERENCES tasks(id),
  agent_id      TEXT REFERENCES agents(id),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  data_mode     TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  CHECK ((type = 'revenue' AND category = 'revenue') OR (type = 'expense' AND category <> 'revenue'))
) STRICT;
CREATE UNIQUE INDEX idx_ledger_source_ref ON ledger_entries (source, reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_ledger_business_ts ON ledger_entries (business_id, ts);
CREATE INDEX idx_ledger_ts ON ledger_entries (ts);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END;

CREATE TABLE progression (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('empire','business','agent')),
  subject_id   TEXT NOT NULL,
  data_mode    TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  xp           INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level        INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  reputation   REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_type, subject_id, data_mode)
) STRICT;

CREATE TABLE achievements (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('empire','business','agent')),
  subject_id    TEXT NOT NULL,
  unlocked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),   -- what real result unlocked it
  data_mode     TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  UNIQUE (key, subject_type, subject_id, data_mode)
) STRICT;

CREATE TABLE quests (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  business_id       TEXT REFERENCES businesses(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('locked','active','completed','failed','expired')),
  progress          REAL NOT NULL DEFAULT 0 CHECK (progress >= 0),
  goal              REAL NOT NULL CHECK (goal > 0),
  reward_json       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reward_json)),
  verification_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(verification_json)),  -- how real progress is verified
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at      TEXT,
  data_mode         TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  UNIQUE (key, data_mode)
) STRICT;
CREATE INDEX idx_quests_status ON quests (status);

CREATE TABLE upgrades (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  business_id  TEXT REFERENCES businesses(id),
  cost_minor   INTEGER NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  effect_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(effect_json)),
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','pending_approval','installed','rejected','reverted')),
  approval_id  TEXT REFERENCES approvals(id),
  installed_at TEXT,
  data_mode    TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  UNIQUE (key, data_mode)
) STRICT;
CREATE INDEX idx_upgrades_status ON upgrades (status);

CREATE TABLE leaderboard_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('empire','business','agent')),
  subject_id   TEXT NOT NULL,
  metric       TEXT NOT NULL,
  value        REAL NOT NULL,
  period       TEXT NOT NULL DEFAULT 'all_time',
  recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  data_mode    TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_leaderboard_lookup ON leaderboard_metrics (metric, period, recorded_at);
