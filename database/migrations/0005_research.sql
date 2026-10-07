-- 0005_research: Research Engine persistence (Phase 7). Additive only; earlier migrations are untouched.
-- Run events are NOT a separate table: lifecycle/diagnostic events go to the append-only `events` table (type prefix `research.`).
-- Retention: research_sources.text is bounded by the run's limits (default 20 000 chars per source, never the raw page) and is
-- deleted with its run; no credentials, headers, cookies or raw HTML are ever stored.

CREATE TABLE research_runs (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','planning','discovering','retrieving','evaluating','analyzing','synthesizing','validating','completed','insufficient','conflicted','failed','cancelled')),
  title           TEXT NOT NULL,
  objective_json  TEXT NOT NULL CHECK (json_valid(objective_json)),
  plan_json       TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
  limits_json     TEXT NOT NULL CHECK (json_valid(limits_json)),
  business_id     TEXT REFERENCES businesses(id),
  task_id         TEXT REFERENCES tasks(id),
  correlation_id  TEXT,
  priority        INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 10),
  stop_reason     TEXT,
  confidence      TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low','insufficient')),
  confidence_score REAL,
  result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provenance_json)),  -- provider attempts, fallbacks, failures, AI/cost summary
  counters_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counters_json)),    -- discovered, retrieved, failed, duplicates, aiCalls, queriesRun
  active_ms       INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),               -- accumulated working time (time budget survives restarts)
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  error_code      TEXT,
  error_message   TEXT,
  data_mode       TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT,
  completed_at    TEXT
) STRICT;
CREATE INDEX idx_research_runs_created ON research_runs (created_at DESC, id);
CREATE INDEX idx_research_runs_status ON research_runs (status, created_at DESC);
CREATE INDEX idx_research_runs_task ON research_runs (task_id);

CREATE TABLE research_subquestions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL CHECK (idx >= 0),
  text        TEXT NOT NULL,
  field       TEXT,                                   -- required-information field this subquestion targets (NULL = general)
  queries_json TEXT NOT NULL CHECK (json_valid(queries_json)),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','discovered','answered','unanswered')),
  UNIQUE (run_id, idx)
) STRICT;

CREATE TABLE research_sources (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  canonical_url   TEXT NOT NULL,
  final_url       TEXT,
  domain          TEXT NOT NULL,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','retrieved','failed','skipped','duplicate')),
  discovery_json  TEXT NOT NULL CHECK (json_valid(discovery_json)),     -- query, snippet, rank, provider, discovered_at
  retrieval_json  TEXT CHECK (retrieval_json IS NULL OR json_valid(retrieval_json)),  -- provider, http status, content type, length, limitations, failure
  content_hash    TEXT,
  text            TEXT,                                  -- bounded extracted text (see retention note)
  author          TEXT,                                  -- only when really present in the page; never inferred
  published_at    TEXT,
  language        TEXT,
  word_count      INTEGER,
  char_count      INTEGER,
  extraction_status TEXT,
  source_type     TEXT NOT NULL DEFAULT 'unknown' CHECK (source_type IN ('primary','official','marketplace','news','research','government','company','community','review','forum','social','unknown')),
  quality_score   REAL,
  quality_json    TEXT CHECK (quality_json IS NULL OR json_valid(quality_json)),
  duplicate_of    TEXT REFERENCES research_sources(id),
  duplicate_kind  TEXT,
  retrieved_at    TEXT,
  data_mode       TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (run_id, canonical_url)
) STRICT;
CREATE INDEX idx_research_sources_run ON research_sources (run_id, status, created_at, id);
CREATE INDEX idx_research_sources_hash ON research_sources (run_id, content_hash);

CREATE TABLE research_evidence (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_id       TEXT REFERENCES research_sources(id),     -- NULL only for derived/inferred items (their inputs are in derived_from_json)
  source_url      TEXT,
  claim           TEXT NOT NULL,
  excerpt         TEXT,                                    -- bounded supporting excerpt
  location        TEXT,                                    -- e.g. "sentence 4"
  evidence_type   TEXT NOT NULL CHECK (evidence_type IN ('directly_observed_fact','quoted_source_claim','derived_calculation','model_inference','hypothesis')),
  field           TEXT,
  value_json      TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  unit            TEXT,
  observed_at     TEXT NOT NULL,
  freshness       TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('fresh','acceptable','stale','unknown')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('high','medium','low','insufficient')),
  confidence_score REAL NOT NULL,
  method          TEXT NOT NULL,                           -- extraction method (deterministic rule id / ai provider+model)
  derived_from_json TEXT CHECK (derived_from_json IS NULL OR json_valid(derived_from_json)),   -- input evidence ids for calculations/inferences
  subquestion_id  TEXT REFERENCES research_subquestions(id),
  data_mode       TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live')),
  CHECK (source_id IS NOT NULL OR evidence_type IN ('derived_calculation','model_inference','hypothesis'))
) STRICT;
CREATE INDEX idx_research_evidence_run ON research_evidence (run_id, evidence_type, id);
CREATE INDEX idx_research_evidence_source ON research_evidence (source_id);

CREATE TABLE research_conflicts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  description TEXT NOT NULL,
  claims_json TEXT NOT NULL CHECK (json_valid(claims_json)),   -- [{evidenceId, sourceId, value, unit, quality, freshness, confidence}]
  status      TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','resolved')),
  data_mode   TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_research_conflicts_run ON research_conflicts (run_id);

CREATE TABLE research_findings (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('opportunity','trend','gap','risk','constraint','recommendation','unanswered_question')),
  statement     TEXT NOT NULL,
  basis         TEXT NOT NULL CHECK (basis IN ('sourced','derived','model_inference','none')),   -- how the statement is supported
  field         TEXT,
  evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
  confidence    TEXT NOT NULL CHECK (confidence IN ('high','medium','low','insufficient')),
  confidence_score REAL NOT NULL,
  rationale     TEXT NOT NULL,
  freshness     TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('fresh','acceptable','stale','unknown')),
  conflict_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_ids_json)),
  status        TEXT NOT NULL CHECK (status IN ('supported','tentative','conflicted','unsupported')),
  data_mode     TEXT NOT NULL DEFAULT 'live' CHECK (data_mode IN ('demo','test','live'))
) STRICT;
CREATE INDEX idx_research_findings_run ON research_findings (run_id, type, id);
