import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/src/db/database.js';
import { loadMigrations, migrate } from '../server/src/db/migrate.js';
import { createRepos } from '../server/src/db/repos.js';
import { seedFoundation, seedDemo } from '../server/src/db/seed.js';
import { createDatabaseService } from '../server/src/db/service.js';
import { createAgentOS } from '../server/src/agents/os.js';
import { Supervisor } from '../server/src/supervisor/supervisor.js';
import { createObservability } from '../server/src/observability/index.js';
import { EventQueries, serializeEvent } from '../server/src/observability/events.js';
import { parseEventQuery, parseMetricsQuery, parseHealthQuery } from '../server/src/observability/query.js';
import { SEVERITIES, toStored, toPublic, storedAtLeast } from '../server/src/observability/severity.js';
import { sanitizeValue, sanitizeText } from '../server/src/observability/sanitize.js';
import { createLogger } from '../server/src/observability/logger.js';
import { createApp } from '../server/src/api/app.js';
import { loadConfig, ROOT } from '../server/src/config/index.js';
import { healthBlock, healthPill, timelinePanel, agentsLive, supervisorLive } from '../client/public/js/ui.js';
import { DEMO } from '../client/public/js/data/mock.js';

class FakeClock { constructor() { this.t = Date.parse('2030-01-01T00:00:00.000Z'); } now() { return new Date(this.t); } advance(ms) { this.t += ms; } iso(off = 0) { return new Date(this.t + off).toISOString(); } }
const tmp = () => mkdtempSync(join(tmpdir(), 'tycoon-obs-'));
const AT = ['demo.noop', 'demo.success', 'demo.fail', 'demo.flaky', 'demo.slow', 'demo.publish_attempt'];
function fx({ autoMigrate = true, withSupervisor = false, supCfg = {} } = {}) {
  const dir = tmp(), clock = new FakeClock(), cfg = { ...loadConfig({}), paths: { data: dir }, database: { autoMigrate, busyTimeoutMs: 1000 }, observability: { healthCacheMs: 0 } };
  const svc = createDatabaseService(cfg).open(); const f = { dir, clock, cfg, svc, db: svc.db };
  if (svc.status === 'ok') {
    f.repos = svc.repos; f.os = createAgentOS({ db: svc.db, repos: svc.repos, clock, config: { stopGraceMs: 100 } });
    f.agent = async (id, o = {}) => { f.os.registerAgent({ id, name: `O ${id}`, role: 'Analytics', businessId: null, taskTypes: AT, permissions: { capabilities: ['analyze', 'research', 'generate'], businesses: ['*'] }, ...o }, { dataMode: 'test' }); await f.os.runtime(id).start(); };
    if (withSupervisor) f.sup = new Supervisor({ os: f.os, config: { checkpointIntervalMs: 0, ...supCfg }, processRunId: svc.runId });
    f.obs = () => createObservability({ database: svc, agentOS: f.os, supervisor: f.sup ?? null, config: cfg, clock });
    f.submit = (type, o = {}) => f.os.queue.submit({ type, dataMode: 'test', ...o });
    f.event = (o) => f.repos.events.insert({ ts: clock.iso(), type: 'task.failed', action: 'x', data_mode: 'test', ...o });
  }
  f.cleanup = async () => { try { await f.sup?.stop(); } catch { /* ok */ } try { await f.os?.shutdown(); } catch { /* ok */ } try { svc.close(); } catch { /* ok */ } rmSync(dir, { recursive: true, force: true }); };
  return f;
}
const get = async (base, path) => { const r = await fetch(base + path); return { code: r.status, body: await r.json() }; };
const serve = async (cfg, services) => { const s = createApp(cfg, services); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return { base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }; };

test('severity model: five public levels, stored `warn` maps to `warning`', () => {
  assert.deepEqual(SEVERITIES, ['debug', 'info', 'warning', 'error', 'critical']);
  assert.equal(toStored('warning'), 'warn'); assert.equal(toStored('warn'), 'warn'); assert.equal(toPublic('warn'), 'warning'); assert.equal(toStored('loud'), null);
  assert.deepEqual(storedAtLeast('warning'), ['warn', 'error', 'critical']); assert.deepEqual(storedAtLeast('info'), ['info', 'warn', 'error', 'critical']);
});

test('events accept the public name `warning`, reject unknown severities, and stay append-only', async () => {
  const f = fx();
  try {
    const e = f.event({ type: 'x.y', severity: 'warning' }); assert.equal(e.severity, 'warn');
    assert.throws(() => f.event({ severity: 'loud' }), /CHECK/);
    assert.throws(() => f.db.run('UPDATE events SET action = ?', ['z']), /append-only/);
    assert.equal(serializeEvent({ ...f.db.get('SELECT rowid AS rid, * FROM events WHERE id = ?', [e.id]) }).severity, 'warning');
  } finally { await f.cleanup(); }
});

test('event serialization: derived fields, honest nulls, redaction of secrets/paths/stacks', async () => {
  const f = fx(); await f.agent('a1');
  try {
    const t = f.submit('demo.noop', { correlationId: 'corr-1', businessId: 'etsy' });
    const e = f.event({ type: 'task.failed', severity: 'error', task_id: t.id, agent_id: 'a1', business_id: 'etsy', error: 'demo_failure: boom at /home/user/secret/file.js', metadata: { reason: 'it broke', runId: 'run-9', seq: 4, apiKey: 'sk-LEAK', nested: { password: 'pw', ok: 1 }, stack: 'Error\n at x', path: '/etc/passwd', note: 'see C:\\Users\\me\\x.txt', big: 'x'.repeat(900) } });
    const out = serializeEvent(f.db.get('SELECT e.rowid AS rid, e.*, t.correlation_id AS t_corr, t.parent_task_id AS t_parent, t.status AS t_status, t.type AS t_type, t.retry_count AS t_retry, t.max_retries AS t_max FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.id = ?', [e.id]));
    assert.equal(out.component, 'task'); assert.equal(out.message, 'it broke'); assert.equal(out.correlationId, 'corr-1'); assert.equal(out.supervisorRunId, 'run-9'); assert.equal(out.cycle, 4);
    assert.deepEqual(out.error, { code: 'demo_failure', message: 'boom at [path]' }); assert.deepEqual(out.retry, { count: 0, max: 3 }); assert.equal(out.cost, null, 'no cost is invented'); assert.equal(out.dataMode, 'test');
    const json = JSON.stringify(out); for (const bad of ['sk-LEAK', '"pw"', '/home/user', '/etc/passwd', 'C:\\\\Users', 'at x']) assert.ok(!json.includes(bad), bad);
    assert.equal(out.details.apiKey, '[redacted]'); assert.equal(out.details.nested.password, '[redacted]'); assert.equal(out.details.nested.ok, 1); assert.ok(out.details.big.length <= 300);
    assert.equal(sanitizeText('open /home/me/x now'), 'open [path] now'); assert.equal(sanitizeValue({ stack: 's', file: 'f', v: 1 }).v, 1);
    const withCost = f.event({ type: 'x.cost', cost_minor: 125 }); assert.deepEqual(f.obs().events.get(withCost.id).cost, { amountMinor: 125, currency: 'USD' });
  } finally { await f.cleanup(); }
});

test('event queries: filters, ordering, cursor pagination, bounds, indexed access', async () => {
  const f = fx(); await f.agent('a1');
  try {
    const q = new EventQueries(f.db), t1 = f.submit('demo.noop', { businessId: 'etsy', correlationId: 'c-1' }), t2 = f.submit('demo.noop', { businessId: 'assets', correlationId: 'c-1' });
    f.db.run('DELETE FROM sqlite_sequence WHERE 0'); // no-op: keeps the statement cache warm
    const base = f.clock.t + 60000; const kinds = [['task.failed', 'error', t1.id, 'a1', 'etsy'], ['task.retrying', 'warn', t1.id, 'a1', 'etsy'], ['agent.ready', 'info', null, 'a1', null], ['supervisor.decision', 'info', t2.id, 'a1', 'assets'], ['task.failed', 'critical', t2.id, null, 'assets'], ['task.debuggy', 'debug', null, null, null]];
    for (let i = 0; i < 24; i++) { const k = kinds[i % kinds.length]; f.repos.events.insert({ ts: new Date(base + i * 1000).toISOString(), type: k[0], severity: k[1], task_id: k[2], agent_id: k[3], business_id: k[4], action: k[0] === 'supervisor.decision' ? 'task.dispatched' : `act${i}`, data_mode: 'test' }); }
    const all = q.list({ limit: 200, since: new Date(base).toISOString() }).events; assert.equal(all.length, 24);
    assert.ok(all.every((e, i) => i === 0 || all[i - 1].ts >= e.ts), 'newest first');
    const idsOf = (o) => q.list({ limit: 200, since: new Date(base).toISOString(), ...o }).events;
    assert.ok(idsOf({ kind: 'task.failed' }).every((e) => e.kind === 'task.failed')); assert.equal(idsOf({ kind: 'task.dispatched' }).length, 4, 'decision names are filterable as kinds');
    assert.ok(idsOf({ component: 'task' }).every((e) => e.component === 'task')); assert.equal(idsOf({ component: 'task' }).length, 16);
    assert.equal(idsOf({ severity: 'warning' }).length, 4); assert.equal(idsOf({ minSeverity: 'error' }).length, 8); assert.equal(idsOf({ minSeverity: 'debug' }).length, 24);
    assert.equal(idsOf({ business: 'etsy' }).length, 8); assert.equal(idsOf({ agent: 'a1' }).length, 16); assert.equal(idsOf({ task: t1.id }).length, 8);
    assert.ok(idsOf({ correlation: 'c-1' }).length >= 16, 'correlation reaches every event of every task sharing it');
    assert.equal(idsOf({ since: new Date(base + 20000).toISOString() }).length, 4); assert.equal(idsOf({ until: new Date(base + 3000).toISOString() }).length, 3);
    // cursor pagination: no gaps, no repeats
    const seen = []; let before = null; for (let i = 0; i < 20; i++) { const r = q.list({ limit: 5, since: new Date(base).toISOString(), ...(before ? { before } : {}) }); seen.push(...r.events.map((e) => e.id)); if (!r.nextBefore) break; before = r.nextBefore; }
    assert.deepEqual(seen, all.map((e) => e.id)); assert.throws(() => q.list({ limit: 5, before: 'nope' }), /cursor/);
    // indexed access (no full scans of events for task / agent / severity / component filters)
    const plan = (sqlFilter) => { let captured; const orig = f.db.all.bind(f.db); f.db.all = (sql, p) => { captured = [sql, p]; return orig(sql, p); }; q.list({ limit: 5, ...sqlFilter }); f.db.all = orig; return orig(`EXPLAIN QUERY PLAN ${captured[0]}`, captured[1]).map((r) => r.detail).join(' | '); };
    assert.match(plan({ task: t1.id }), /idx_events_task/); assert.match(plan({ agent: 'a1' }), /idx_events_agent/); assert.match(plan({ minSeverity: 'error', since: new Date(base).toISOString() }), /idx_events_(severity|ts)/); assert.match(plan({ component: 'task', since: new Date(base).toISOString() }), /idx_events_(type|ts)/);
    assert.match(plan({ since: new Date(base).toISOString() }), /idx_events_ts/);
  } finally { await f.cleanup(); }
});

test('query validation: strict, bounded, no injection surface', () => {
  const NOW = Date.parse('2030-01-10T00:00:00.000Z'), P = (s) => parseEventQuery(new URLSearchParams(s), { now: NOW });
  assert.equal(P('').limit, 50); assert.equal(P('limit=200').limit, 200); assert.equal(P('').since, new Date(NOW - 86400e3).toISOString(), 'unfiltered listings default to the last 24 hours');
  assert.equal(P('task=abc').since, undefined, 'task lookups are not time-bounded'); assert.equal(P('severity=warn').severity, 'warning');
  for (const bad of ['limit=0', 'limit=201', 'limit=-1', 'limit=1e3', 'limit=abc', 'foo=bar', 'limit=5&limit=6', 'severity=loud', 'severity=info&minSeverity=error', 'kind=Bad Kind', "kind=x'; DROP TABLE events;--", 'component=A B', 'task=x y', "agent=' OR 1=1 --", 'business=../etc', 'correlation=%00', 'since=yesterday', 'since=2030-01-01T00:00:00Z&until=2029-01-01T00:00:00Z', 'since=2029-01-01T00:00:00Z&until=2030-01-09T00:00:00Z', 'window=1y', 'window=1h&since=2030-01-09T00:00:00Z', 'before=a%20b']) assert.throws(() => P(bad), (e) => e.code === 'validation', bad);
  assert.equal(P('window=1h').since, new Date(NOW - 3600e3).toISOString());
  const M = (s) => parseMetricsQuery(new URLSearchParams(s), { now: NOW, startupAt: '2030-01-09T12:00:00.000Z' });
  assert.equal(M('').label, '1h'); assert.equal(M('window=current').since, null); assert.equal(M('window=startup').since, '2030-01-09T12:00:00.000Z'); assert.equal(M('window=24h').label, '24h');
  for (const bad of ['window=forever', 'since=2029-01-01T00:00:00Z', 'until=2030-01-01T00:00:00Z', 'x=1', 'since=2030-01-09T00:00:00Z&until=2030-01-08T00:00:00Z']) assert.throws(() => M(bad), (e) => e.code === 'validation', bad);
  assert.deepEqual(parseHealthQuery(new URLSearchParams('deep=1')), { deep: true }); assert.throws(() => parseHealthQuery(new URLSearchParams('deep=maybe')));
});

test('correlation and trace: a failing task can be followed from task to agent to Supervisor decision to retries to result', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('tr1', { retry: { baseDelayMs: 1000, maxDelayMs: 4000 } });
  try {
    await f.sup.start({ loop: false });
    const parent = f.submit('demo.noop', { correlationId: 'job-77' }), child = f.submit('demo.flaky', { correlationId: 'job-77', parentTaskId: parent.id, payload: { failTimes: 1 }, maxRetries: 2 });
    await f.sup.cycle({ wait: true }); await f.sup.cycle({ wait: true }); f.clock.advance(1000); await f.sup.cycle({ wait: true }); await f.sup.cycle({ wait: true });
    assert.equal(f.os.queue.get(child.id).status, 'completed');
    const obs = f.obs(), byCorr = obs.events.list({ correlation: 'job-77', limit: 200 }).events;
    assert.ok(byCorr.some((e) => e.taskId === parent.id) && byCorr.some((e) => e.taskId === child.id)); assert.ok(byCorr.every((e) => e.correlationId === 'job-77'));
    const retryEv = obs.events.list({ task: child.id, kind: 'task.retrying' }).events[0]; assert.equal(retryEv.severity, 'warning'); assert.equal(retryEv.parentTaskId, parent.id); assert.equal(retryEv.retry.count, 1);
    const tr = obs.events.trace(retryEv.id); assert.equal(tr.task.status, 'completed'); assert.equal(tr.task.parentTaskId, parent.id);
    const names = tr.timeline.map((e) => (e.kind.startsWith('supervisor.') ? e.name : e.kind));
    for (const need of ['task.pending', 'task.queued', 'task.assigned', 'task.running', 'task.retrying', 'task.dispatched', 'task.completed']) assert.ok(names.includes(need), need);
    assert.ok(names.indexOf('task.dispatched') < names.indexOf('task.retrying') && names.indexOf('task.retrying') < names.lastIndexOf('task.completed'), 'timeline is chronological');
    assert.equal(tr.timeline.find((e) => e.name === 'task.dispatched').supervisorRunId, f.sup.runId, 'decisions carry the Supervisor run id');
    assert.equal(obs.events.trace('missing-id'), null);
  } finally { await f.cleanup(); }
});

test('error inspection: what failed, where, why, retryability, related decisions, sanitized', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('er1', { retry: { baseDelayMs: 1000, maxDelayMs: 4000 } });
  try {
    await f.sup.start({ loop: false });
    const bad = f.submit('demo.fail', { businessId: 'etsy' }), flaky = f.submit('demo.flaky', { payload: { failTimes: 5 }, maxRetries: 3 });
    await f.sup.cycle({ wait: true }); await f.sup.cycle({ wait: true });
    const { errors } = f.obs().events.errors({ limit: 50, since: f.clock.iso(-3600e3) });
    const fail = errors.find((e) => e.event.taskId === bad.id); assert.ok(fail); assert.equal(fail.event.severity, 'error'); assert.equal(fail.event.error.code, 'demo_failure'); assert.equal(fail.task.status, 'failed'); assert.equal(fail.retryable, false);
    assert.equal(fail.agent.id, 'er1'); assert.ok(fail.relatedDecisions.some((d) => d.kind === 'task.dispatched')); assert.match(fail.explanation, /not retried \(0\/3 retries used\)/); assert.equal(fail.event.businessId, 'etsy');
    assert.ok(!errors.some((e) => e.event.taskId === flaky.id), 'warnings are excluded by default');
    const withWarn = f.obs().events.errors({ limit: 50, since: f.clock.iso(-3600e3), includeWarnings: 'true' }).errors, retr = withWarn.find((e) => e.event.taskId === flaky.id && e.event.kind === 'task.retrying');
    assert.equal(retr.retryable, true); assert.match(retr.explanation, /will retry/); assert.ok(!JSON.stringify(withWarn).match(/\/home|\/tmp|stack/));
    assert.ok(errors.every((e) => ['error', 'critical'].includes(e.event.severity)));
  } finally { await f.cleanup(); }
});

test('health: deterministic rules for healthy, degraded, critical and unknown', async () => {
  const f = fx({ withSupervisor: true });
  try {
    const H = () => f.obs().health();
    assert.equal(H().status, 'unknown', 'fresh install: no agents, Supervisor not started'); assert.equal(H().components.agentOS.status, 'unknown'); assert.equal(H().components.database.status, 'healthy'); assert.match(H().summary, /no agents/);
    await f.agent('h1', { runtime: { staleAfterMs: 30000, heartbeatIntervalMs: 100 } }); await f.agent('h2', { runtime: { staleAfterMs: 30000, heartbeatIntervalMs: 100 } });
    await f.sup.start({ loop: false }); await f.sup.cycle();
    let h = H(); assert.equal(h.status, 'healthy', JSON.stringify(h.summary)); assert.equal(h.issues, 0); assert.equal(h.components.supervisor.details.state, 'running'); assert.equal(h.components.agentOS.details.available, 2); assert.deepEqual(JSON.parse(JSON.stringify(H())), JSON.parse(JSON.stringify(h)), 'same state => same answer');
    // Supervisor loop slow -> degraded, stalled -> critical
    f.clock.advance(20000); f.os.registry.heartbeat('h1'); f.os.registry.heartbeat('h2'); h = H(); assert.equal(h.status, 'degraded'); assert.match(h.components.supervisor.reasons[0], /slower/);
    f.clock.advance(60000); f.os.registry.heartbeat('h1'); f.os.registry.heartbeat('h2'); h = H(); assert.equal(h.status, 'critical'); assert.match(h.components.supervisor.reasons[0], /stalled/);
    await f.sup.cycle(); assert.equal(H().status, 'healthy', 'a successful cycle clears it');
    // stale agent -> degraded; failed agent -> degraded; all failed -> critical
    f.clock.advance(40000); await f.sup.cycle(); // supervisor itself restarts stale agents (Phase 4); detect before that by not cycling:
    f.clock.advance(40000); f.os.registry.heartbeat('h2'); h = H(); assert.equal(h.components.agentOS.status, 'degraded'); assert.equal(h.components.agentOS.details.stale, 1); assert.equal(h.status, 'degraded');
    await f.sup.cycle(); assert.equal(H().components.agentOS.status, 'healthy');
    f.os.runtime('h1').fail(new Error('x')); assert.equal(H().components.agentOS.status, 'degraded'); assert.ok(H().attention.some((a) => a.kind === 'failed_agents'));
    f.os.runtime('h2').fail(new Error('y')); assert.equal(H().components.agentOS.status, 'critical'); assert.equal(H().status, 'critical');
    // Supervisor lifecycle conditions
    f.os.registry.transition('h1', 'stopped'); f.os.registry.transition('h1', 'ready'); f.os.registry.transition('h2', 'stopped'); f.os.registry.transition('h2', 'ready');
    f.sup.pause(); assert.equal(H().components.supervisor.status, 'degraded'); assert.match(H().components.supervisor.reasons[0], /paused/); f.sup.resume(); assert.equal(H().components.supervisor.status, 'healthy');
    await f.sup.stop(); assert.equal(H().components.supervisor.status, 'degraded'); await f.sup.start({ loop: false }); await f.sup.cycle();
    f.sup.state = 'failed'; f.sup.stateSince = f.clock.iso(-5000); assert.equal(H().components.supervisor.status, 'degraded'); f.sup.stateSince = f.clock.iso(-31000); assert.equal(H().components.supervisor.status, 'critical'); assert.equal(H().status, 'critical'); f.sup.state = 'running';
  } finally { await f.cleanup(); }
});

test('health: task failure-rate thresholds need a real sample and are deterministic', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('t1'); await f.sup.start({ loop: false }); await f.sup.cycle();
  try {
    const H = () => f.obs().health().components.tasks, mk = (status, n) => { for (let i = 0; i < n; i++) f.repos.tasks.insert({ type: 'demo.noop', status, started_at: f.clock.iso(-2000), completed_at: f.clock.iso(-1000), data_mode: 'test' }); };
    mk('failed', 1); assert.equal(H().status, 'healthy', '1 of 1 failed is not a trend');
    mk('completed', 3); mk('failed', 1); assert.equal(H().status, 'healthy', '5 finished, 40% failed');
    mk('failed', 1); assert.equal(H().status, 'degraded', '6 finished, 50% failed'); assert.match(H().reasons[0], /50%/);
    mk('failed', 5); assert.equal(H().status, 'degraded', '11 finished, 73% failed is below the critical rate');
    mk('failed', 4); assert.equal(H().status, 'critical', '15 finished, 80% failed'); assert.equal(f.obs().health().status, 'critical');
    f.clock.advance(2 * 3600e3); assert.equal(H().status, 'healthy', 'old failures age out of the one-hour window');
  } finally { await f.cleanup(); }
});

test('health: expired leases, event pressure, attention items, closed or unmigrated database', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('e1');
  try {
    const H = () => f.obs().health();
    const t = f.submit('demo.noop'); f.os.queue.claim(f.os.registry.get('e1')); assert.equal(H().components.tasks.status, 'healthy'); f.clock.advance(61000);
    assert.equal(H().components.tasks.status, 'degraded'); assert.match(H().components.tasks.reasons[0], /expired/); f.os.queue.release(t.id, 'cleanup'); f.os.registry.heartbeat('e1');
    // oldest queued task waiting too long is flagged for attention, not as failure
    f.clock.advance(11 * 60000); f.os.registry.heartbeat('e1'); assert.ok(H().attention.some((a) => a.kind === 'queue_waiting')); assert.equal(H().components.tasks.status, 'healthy');
    const b = f.submit('demo.noop'); f.os.queue.block(b.id, 'waiting'); assert.ok(H().attention.some((a) => a.kind === 'blocked_tasks'));
    f.repos.events.insert({ ts: f.clock.iso(), type: 'supervisor.decision', severity: 'error', action: 'recovery.refused', data_mode: 'test' }); assert.ok(H().attention.some((a) => a.kind === 'recovery_escalated' && a.severity === 'error'));
    // event pressure: criticals and error volume in the last 15 minutes
    const crit = () => f.event({ type: 'supervisor.lifecycle', severity: 'critical', action: 'failed' });
    assert.equal(H().components.events.status, 'healthy'); crit(); assert.equal(H().components.events.status, 'degraded'); crit(); crit(); assert.equal(H().components.events.status, 'critical');
    f.clock.advance(20 * 60000); assert.equal(H().components.events.status, 'healthy', 'ages out of the 15 minute window');
    for (let i = 0; i < 20; i++) f.event({ severity: 'error' }); assert.equal(H().components.events.status, 'degraded'); for (let i = 0; i < 80; i++) f.event({ severity: 'error' }); assert.equal(H().components.events.status, 'critical');
    // deep health adds integrity results and is cached; normal health is cached for healthCacheMs
    const obs = f.obs(), d1 = obs.health({ deep: true }); assert.equal(d1.components.database.details.integrity, 'ok'); assert.equal(d1.components.database.details.foreignKeys, 'ok'); assert.equal(obs.health({ deep: true }), d1, 'deep result cached');
    const cached = createObservability({ database: f.svc, agentOS: f.os, supervisor: null, config: { ...f.cfg, observability: { healthCacheMs: 2000 } }, clock: f.clock }); const h1 = cached.health(); assert.equal(cached.health(), h1); f.clock.advance(2500); assert.notEqual(cached.health(), h1);
    // closed database: critical, never throws
    f.svc.db.close(); const down = f.obs().health(); assert.equal(down.status, 'critical'); assert.equal(down.components.database.status, 'critical'); assert.equal(down.components.tasks.status, 'unknown'); assert.equal(down.components.supervisor.status, 'unknown');
  } finally { await f.cleanup(); }
  const g = fx({ autoMigrate: false }); // schema never applied
  try { assert.equal(g.svc.status, 'migration_required'); const h = createObservability({ database: g.svc, agentOS: null, supervisor: null, config: g.cfg, clock: g.clock }).health(); assert.equal(h.status, 'critical'); assert.match(h.components.database.reasons[0], /migrations/); } finally { await g.cleanup(); }
});

test('metrics: counts, time windows, success and failure rates, execution time, empty data', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('m1'); await f.agent('m2', { name: 'M2', businessId: 'etsy', taskTypes: ['demo.noop'], permissions: { capabilities: ['analyze'] } });
  try {
    const obs = f.obs(), win = (label, sinceOff, untilOff = 0) => ({ label, since: sinceOff === null ? null : f.clock.iso(sinceOff), until: f.clock.iso(untilOff) });
    let m = obs.metrics(win('1h', -3600e3)); // empty: zeros and nulls, never invented numbers
    assert.equal(m.tasks.window.completed, 0); assert.equal(m.tasks.window.successRate, null); assert.equal(m.tasks.window.avgExecutionMs, null); assert.equal(m.agents.total, 2); assert.equal(m.supervisor.state, 'stopped'); assert.equal(m.supervisor.lifetime.cycles, 0); assert.equal(m.businesses.length, 4); assert.ok(m.businesses.every((b) => b.queueDepth === 0 && b.lastActivityAt === null || b.lastActivityAt));
    const done = (status, startedOff, completedOff, extra = {}) => f.repos.tasks.insert({ type: 'demo.noop', status, started_at: f.clock.iso(startedOff), completed_at: f.clock.iso(completedOff), agent_id: 'm1', data_mode: 'test', ...extra });
    done('completed', -1100, -1000, { business_id: 'etsy' }); done('completed', -2300, -2000, { business_id: 'etsy' }); done('failed', -3000, -2900, { business_id: 'assets', agent_id: 'm2' }); done('cancelled', -500, -400);
    done('completed', -7300e3 - 500, -7300e3, { business_id: 'etsy' }); // 2 hours ago: outside 1h, inside 24h
    f.submit('demo.noop', { businessId: 'etsy' }); f.submit('demo.noop', { businessId: 'etsy' });
    m = obs.metrics(win('1h', -3600e3)); assert.deepEqual([m.tasks.window.completed, m.tasks.window.failed, m.tasks.window.cancelled], [2, 1, 1]);
    assert.ok(Math.abs(m.tasks.window.successRate - 2 / 3) < 1e-9); assert.ok(Math.abs(m.tasks.window.failureRate - 1 / 3) < 1e-9); assert.equal(m.tasks.window.avgExecutionMs, 200, 'mean of 100 ms and 300 ms');
    assert.equal(m.tasks.current.queued, 2); assert.equal(m.tasks.current.completed, 3); assert.equal(m.tasks.current.failed, 1);
    assert.equal(obs.metrics(win('24h', -86400e3)).tasks.window.completed, 3); assert.equal(obs.metrics(win('5m', -300e3)).tasks.window.completed, 2); assert.equal(obs.metrics(win('5m', -1500)).tasks.window.completed, 1);
    assert.equal(obs.metrics(win('current', null)).tasks.window, null, '`current` reports live counts only');
    const etsy = m.businesses.find((b) => b.id === 'etsy'), assets = m.businesses.find((b) => b.id === 'assets');
    assert.deepEqual([etsy.queueDepth, etsy.window.completed, etsy.window.failed, etsy.agents], [2, 2, 0, 1]); assert.equal(etsy.window.successRate, 1); assert.deepEqual([assets.window.completed, assets.window.failed, assets.window.successRate], [0, 1, 0]);
    assert.deepEqual(etsy.notMeasured, ['revenue', 'profit', 'sales', 'roi']);
    const pa = m.agents.perAgent.find((a) => a.id === 'm1'); assert.deepEqual(pa.window, { completed: 2, failed: 0 }); assert.equal(m.agents.perAgent.find((a) => a.id === 'm2').window.failed, 1);
    // agent counters and stale detection
    f.clock.advance(120000); m = obs.metrics(win('1h', -3600e3)); assert.equal(m.agents.stale, 2); assert.equal(m.agents.available, 2); assert.ok(m.agents.maxHeartbeatAgeMs >= 120000);
    // Supervisor metrics from persisted decisions + counters
    await f.sup.start({ loop: false }); const o2 = f.obs(); f.submit('demo.noop'); f.submit('demo.publish_attempt'); await f.sup.cycle({ wait: true }); await f.sup.cycle({ wait: true });
    const sm = o2.metrics(win('1h', -3600e3)).supervisor;  assert.equal(sm.state, 'running'); assert.ok(sm.window.dispatches >= 1); assert.equal(sm.window.skippedTasks, 1); assert.ok(sm.lifetime.cycles >= 2); assert.equal(sm.lifetime.failedCycles, 0); assert.equal(sm.lifetime.successfulCycles, sm.lifetime.cycles); assert.ok(sm.window.recoveryActions >= 0);
    // NO FABRICATED BUSINESS DATA: any money-like key is null
    const walk = (o, path = '') => { if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`)); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (/revenue|profit|sales|roi|customer|margin/i.test(k)) assert.equal(v, null, `${path}.${k} must be null`); walk(v, `${path}.${k}`); } };
    walk(m); walk(sm); walk(obs.health());
  } finally { await f.cleanup(); }
});

test('Observability API: envelope, filters, validation, read-only, no leaks, degraded database', async () => {
  const f = fx({ withSupervisor: true }); await f.agent('api1'); await seedDemo(f.db, f.repos);
  const obs = f.obs(), app = await serve(f.cfg, { database: f.svc, agentOS: f.os, supervisor: f.sup, observability: obs });
  try {
    await f.sup.start({ loop: false }); f.submit('demo.fail', { businessId: 'etsy' }); f.submit('demo.noop'); await f.sup.cycle({ wait: true }); await f.sup.cycle({ wait: true });
    let r = await get(app.base, '/api/system/health'); assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.ok(r.body.timestamp); assert.equal(r.body.meta.phase, 7); assert.ok(['healthy', 'degraded', 'critical', 'unknown'].includes(r.body.data.status)); assert.ok(r.body.data.components.database);
    r = await get(app.base, '/api/system/health?deep=1'); assert.equal(r.body.data.components.database.details.integrity, 'ok');
    r = await get(app.base, '/api/health'); assert.equal(r.body.status, 'ok'); assert.ok('health' in r.body && 'supervisor' in r.body && 'agentOS' in r.body && r.body.database.schemaVersion >= 4 && r.body.phase === 7); assert.ok(JSON.stringify(r.body).length < 800, 'health stays small');
    r = await get(app.base, '/api/system/metrics?window=1h'); assert.equal(r.code, 200); assert.equal(r.body.meta.window, '1h'); assert.ok(r.body.data.tasks.window.failed >= 1); r = await get(app.base, '/api/system/metrics?window=current'); assert.equal(r.body.data.tasks.window, null);
    r = await get(app.base, '/api/events?limit=5'); assert.equal(r.code, 200); assert.ok(r.body.data.events.length <= 5 && r.body.meta.limit === 5); assert.ok(r.body.data.events.every((e) => SEVERITIES.includes(e.severity)));
    r = await get(app.base, '/api/events?minSeverity=error&component=task'); assert.ok(r.body.data.events.length >= 1 && r.body.data.events.every((e) => e.component === 'task' && ['error', 'critical'].includes(e.severity)));
    const id = r.body.data.events[0].id; r = await get(app.base, `/api/events/${id}`); assert.equal(r.code, 200); assert.ok(r.body.data.timeline.length >= 3); assert.equal(r.body.data.task.status, 'failed');
    assert.equal((await get(app.base, '/api/events/does-not-exist')).code, 404); assert.equal((await get(app.base, '/api/events/' + encodeURIComponent("x'; DROP TABLE events;--"))).code, 400); assert.equal((await get(app.base, `/api/events/${id}?x=1`)).code, 400);
    r = await get(app.base, '/api/errors'); assert.equal(r.code, 200); assert.ok(r.body.data.errors.length >= 1); assert.ok(r.body.data.errors[0].explanation && 'retryable' in r.body.data.errors[0]); assert.equal((await get(app.base, '/api/errors?includeWarnings=maybe')).code, 400);
    r = await get(app.base, '/api/activity?limit=3'); assert.equal(r.code, 200); assert.ok(r.body.meta.counts && r.body.data.events.every((e) => e.severity !== 'debug')); assert.ok(r.body.data.events.length <= 3);
    for (const bad of ['limit=201', 'limit=abc', 'foo=1', "kind=x'%20OR%201=1", 'since=never', 'severity=boom', 'window=9y', 'before=%00', 'task=a%20b', 'agent=%27%3B--']) { const x = await get(app.base, '/api/events?' + bad); assert.equal(x.code, 400, bad); assert.equal(x.body.ok, false); assert.equal(x.body.error, 'validation'); }
    assert.equal((await get(app.base, '/api/system/metrics?window=forever')).code, 400);
    const post = await fetch(`${app.base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(post.status, 405); assert.equal((await fetch(`${app.base}/api/errors`, { method: 'DELETE' })).status, 405);
    // nothing leaks: no filesystem paths, stacks or credential-like values in any response
    const dump = JSON.stringify([(await get(app.base, '/api/system/health?deep=1')).body, (await get(app.base, '/api/system/metrics?window=24h')).body, (await get(app.base, '/api/events?limit=200&window=24h')).body, (await get(app.base, '/api/errors?includeWarnings=true')).body]);
    assert.ok(!dump.includes(f.dir) && !/\/(home|tmp|root)\//.test(dump) && !/stack|apiKey|password|secret/i.test(dump), 'no paths, stacks or secrets');
    // events are never mutated by reads
    const n = f.repos.events.count(); await get(app.base, '/api/events'); await get(app.base, '/api/system/health'); assert.equal(f.repos.events.count(), n);
    // missing observability service and a closed database
    const none = await serve(f.cfg, {}); assert.equal((await get(none.base, '/api/events')).code, 503); const h0 = await get(none.base, '/api/health'); assert.equal(h0.body.status, 'ok'); assert.equal(h0.body.health, 'unknown'); none.close();
    f.svc.db.close(); r = await get(app.base, '/api/system/health'); assert.equal(r.code, 200); assert.equal(r.body.data.status, 'critical'); r = await get(app.base, '/api/events'); assert.equal(r.code, 503); assert.equal(r.body.error, 'database_unavailable'); r = await get(app.base, '/api/health'); assert.equal(r.body.health, 'critical'); assert.equal(r.body.database.status, 'unavailable');
  } finally { app.close(); await f.cleanup(); }
});

test('structured logger: levels, redaction, bounded output, no secrets or paths', () => {
  const lines = [], sink = { log: (l) => lines.push(['log', l]), warn: (l) => lines.push(['warn', l]), error: (l) => lines.push(['error', l]) }, now = () => new Date('2030-01-01T00:00:00.000Z');
  const log = createLogger('test', { sink, level: 'warning', now });
  log.debug('d'); log.info('i'); log.warn('careful', { taskId: 't1', agentId: 'a1' }); log.error('boom', { errorCode: 'db_down', error: new Error('failed at /home/user/app/x.js with password=1'), apiKey: 'sk-1', nested: { token: 't' } }); log.critical('dead');
  assert.deepEqual(lines.map((l) => l[0]), ['warn', 'error', 'error']);
  const e = JSON.parse(lines[1][1]); assert.deepEqual([e.ts, e.level, e.component, e.msg, e.errorCode], ['2030-01-01T00:00:00.000Z', 'error', 'test', 'boom', 'db_down']);
  const all = lines.map((l) => l[1]).join('\n'); assert.ok(!all.includes('sk-1') && !all.includes('/home/user') && !all.includes('"t"'), 'secrets and paths are scrubbed'); assert.equal(JSON.parse(lines[0][1]).taskId, 't1');
  assert.ok(JSON.stringify(JSON.parse(lines[2][1])).length < 300); log.error('x'.repeat(5000)); assert.ok(lines[3][1].length < 600, 'messages are bounded');
  assert.equal(createLogger('c', { sink, level: 'warn' }).child('sub').info('x'), undefined);
  for (const f of ['index.js', 'api/agentRoutes.js', 'agents/os.js']) assert.ok(!/console\.(log|error|warn)/.test(readFileSync(join(ROOT, 'server/src', f), 'utf8')), `${f} uses the structured logger`);
});

test('migration 0004 upgrades a populated Phase 4 database and the new indexes exist', async () => {
  const dir = tmp(), file = join(dir, 'old.sqlite');
  try {
    const ms = loadMigrations(), db = Db.open(file); migrate(db, ms.slice(0, 3)); const repos = createRepos(db); seedFoundation(repos); seedDemo(db, repos);
    repos.tasks.insert({ id: 'tk', type: 'demo.noop', status: 'completed', completed_at: '2030-01-01T00:00:00.000Z', started_at: '2029-12-31T23:59:59.000Z', data_mode: 'test' }); repos.events.insert({ type: 'task.completed', severity: 'warning', task_id: 'tk', action: 'a', data_mode: 'test' });
    const before = db.get('SELECT COUNT(*) AS n FROM events').n; assert.equal(db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_events_task'").n, 0);
    assert.deepEqual(migrate(db, ms).ran, [4, 5]); assert.equal(db.get('SELECT COUNT(*) AS n FROM events').n, before, 'no event was touched');
    for (const ix of ['idx_events_task', 'idx_events_agent', 'idx_events_severity', 'idx_tasks_completed']) assert.equal(db.get('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?', [ix]).n, 1, ix);
    assert.ok(db.integrityCheck().ok && db.foreignKeyCheck().ok); assert.equal(db.pragma('foreign_keys'), 1);
    assert.equal(new EventQueries(db).list({ limit: 5, since: '2000-01-01T00:00:00.000Z', task: 'tk', severity: 'warning' }).events.length, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dashboard rendering: health, timeline, agents and Supervisor blocks use real data and escape it', () => {
  const live = { health: { status: 'degraded', summary: 'agentOS: 1 agent(s) failed', issues: 1, checkedAt: new Date().toISOString(), attention: [{ severity: 'error', message: '1 agent(s) are in the failed state' }], components: { database: { status: 'healthy', reasons: [] }, agentOS: { status: 'degraded', reasons: ['1 agent(s) failed'] }, supervisor: { status: 'unknown', reasons: [] } } },
    status: { state: 'running', cycle: 9, inFlight: 1, counters: { dispatched: 4, recoveries: 1 }, lastCycle: { queue: { queued: 2, running: 1, retrying: 0, blocked: 0 } }, lastOkCycleAt: new Date().toISOString(), activeLimits: ['maxDispatchPerCycle'] }, decisions: [{ ts: '2030-01-01T00:00:01.000Z', kind: 'task.dispatched', result: 'ok', severity: 'info' }],
    events: { events: [{ ts: '2030-01-01T00:00:02.000Z', severity: 'error', kind: 'task.failed', name: 'task.failed', component: 'task', message: '<img src=x onerror=alert(1)>', agentId: 'a1', taskId: 'abcdefgh-1', error: { code: 'demo_failure' }, retry: { count: 1, max: 3 }, dataMode: 'demo' }, { ts: '2030-01-01T00:00:03.000Z', severity: 'info', kind: 'task.queued', name: 'task.queued', component: 'task', message: 'Task queued', dataMode: 'live' }] },
    agents: [{ name: 'DEMO A', role: 'QA', status: 'ready', level: 2, healthStatus: 'healthy', metrics: { successRate: null }, lastHeartbeatAt: null, currentTaskId: null, dataMode: 'demo' }] };
  const S = { live, logFilter: { sev: 'info', comp: '', steps: false } };
  const hb = healthBlock(live.health); assert.match(hb, /SYSTEM HEALTH · DEGRADED/); assert.match(hb, /agentOS/); assert.match(hb, /failed state/); assert.match(healthBlock(null), /no live connection/);
  assert.match(healthPill(live), /SYSTEM ● DEGRADED/); assert.match(healthPill(null), /NO LIVE DATA/);
  const tl = timelinePanel(DEMO, S); assert.match(tl, /EVENT TIMELINE · LIVE/); assert.match(tl, /sev-error/); assert.ok(!tl.includes('<img'), 'event text is escaped'); assert.match(tl, /&lt;img/); assert.match(tl, /demo_failure/); assert.match(tl, /retry 1\/3/); assert.ok(!tl.includes('Task queued'), 'routine steps hidden by default');
  assert.match(timelinePanel(DEMO, { ...S, logFilter: { ...S.logFilter, steps: true } }), /Task queued/); assert.match(timelinePanel(DEMO, { live: null }), /MOCK/);
  const ag = agentsLive(DEMO, S); assert.match(ag, /DEMO A/); assert.match(ag, /no results yet/); assert.match(ag, /DEMO/); assert.match(agentsLive(DEMO, { live: null }), /MOCK/);
  const sv = supervisorLive(live); assert.match(sv, /LIVE SUPERVISOR · RUNNING/); assert.match(sv, /maxDispatchPerCycle/); assert.match(sv, /task\.dispatched/); assert.match(supervisorLive(null), /no live connection/);
});

test('observability adds no timers, no network access, and is read-only by construction', async () => {
  const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, f = fx({ withSupervisor: true });
  try {
    await f.agent('nt'); const obs = f.obs(); obs.health(); obs.health({ deep: true }); obs.metrics({ label: '1h', since: f.clock.iso(-3600e3), until: f.clock.iso() }); obs.events.list({ limit: 5, since: f.clock.iso(-1000) });
    assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, before, 'no timers created');
    for (const file of readdirSync(join(ROOT, 'server/src/observability'))) { const src = readFileSync(join(ROOT, 'server/src/observability', file), 'utf8'); assert.ok(!/node:(http|https|net|dgram|child_process)|fetch\(|eval\(|setInterval|setTimeout|INSERT |UPDATE |DELETE FROM/i.test(src.replace(/\/\/.*$/gm, '')), `${file} is read-only and passive`); }
  } finally { await f.cleanup(); }
});
