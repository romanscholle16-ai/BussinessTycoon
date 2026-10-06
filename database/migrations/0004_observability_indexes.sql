-- 0004_observability_indexes: indexes for the observability queries only (no table changes, no data changes).
--   events by task / agent / severity for the event, error and trace queries; tasks by completion time for windowed metrics.
CREATE INDEX idx_events_task ON events (task_id, ts) WHERE task_id IS NOT NULL;
CREATE INDEX idx_events_agent ON events (agent_id, ts) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_events_severity ON events (severity, ts);
CREATE INDEX idx_tasks_completed ON tasks (completed_at) WHERE completed_at IS NOT NULL;
