import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Db } from '../server/src/db/database.js';
import { loadMigrations, migrate, migrationStatus } from '../server/src/db/migrate.js';
import { createRepos } from '../server/src/db/repos.js';
import { seedFoundation, seedDemo } from '../server/src/db/seed.js';
import { createDatabaseService } from '../server/src/db/service.js';
import { createAgentOS } from '../server/src/agents/os.js';
import { AgentRegistry } from '../server/src/agents/registry.js';
import { TaskQueue, retryDelayMs } from '../server/src/agents/queue.js';
import { InvalidTransitionError, AGENT_TRANSITIONS, TASK_TRANSITIONS } from '../server/src/agents/states.js';
import { assertCan, CAPABILITIES, PermissionError } from '../server/src/agents/capabilities.js';
import { ValidationError } from '../server/src/agents/validate.js';
import { createApp } from '../server/src/api/app.js';
import { loadConfig, ROOT } from '../server/src/config/index.js';

class FakeClock { constructor() { this.t = Date.parse('2030-01-01T00:00:00.000Z'); } now() { return new Date(this.t); } advance(ms) { this.t += ms; } }
const tmp = () => mkdtempSync(join(tmpdir(), 'tycoon-ag-'));
function setup({ path, clock = new FakeClock(), dataMode = 'test' } = {}) {
  const dir = path ? null : tmp(), file = path ?? join(dir, 'a.sqlite'), db = Db.open(file), repos = createRepos(db);
  migrate(db); seedFoundation(repos);
  const os = createAgentOS({ db, repos, clock, config: { stopGraceMs: 200 } });
  const cleanup = () => { try { db.close(); } catch { /* closed */ } if (dir) rmSync(dir, { recursive: true, force: true }); };
  return { dir, file, db, repos, os, clock, cleanup, mk: (id, o = {}) => os.registerAgent({ id, name: `T ${id}`, role: 'Analytics', businessId: null, taskTypes: ['demo.noop', 'demo.success', 'demo.fail', 'demo.flaky', 'demo.slow', 'demo.publish_attempt'], permissions: { capabilities: ['analyze', 'research', 'generate'], businesses: ['*'] }, ...o }, { dataMode }) };
}

test('agent lifecycle: valid transitions persist, invalid ones are rejected', async () => {
  const s = setup();
  try {
    const a = s.mk('a1'); assert.equal(a.status, 'created');
    const reg = s.os.registry, rt = s.os.runtime('a1');
    assert.throws(() => reg.transition('a1', 'running'), InvalidTransitionError); // created cannot run
    await rt.start(); assert.equal(reg.get('a1').status, 'ready');
    rt.pause(); assert.equal(reg.get('a1').status, 'paused');
    assert.throws(() => reg.transition('a1', 'running'), InvalidTransitionError); // paused cannot jump to running
    rt.resume(); assert.equal(reg.get('a1').status, 'ready');
    await rt.stop(); assert.equal(reg.get('a1').status, 'stopped');
    assert.throws(() => reg.transition('a1', 'running'), InvalidTransitionError); // stopped must restart through ready
    await rt.start(); assert.equal(reg.get('a1').status, 'ready');
    rt.fail(new Error('boom')); assert.equal(reg.get('a1').status, 'failed'); assert.equal(reg.get('a1').last_error, 'boom'); assert.equal(reg.get('a1').health_status, 'failed');
    assert.throws(() => reg.transition('a1', 'ready'), InvalidTransitionError);
    reg.transition('a1', 'stopped'); reg.transition('a1', 'retired');
    assert.throws(() => reg.transition('a1', 'ready'), InvalidTransitionError); // retired is final
    for (const [from, tos] of Object.entries(AGENT_TRANSITIONS)) assert.ok(!tos.has(from), `no self transition for ${from}`);
    assert.ok(s.repos.events.list({ agent_id: 'a1' }).length >= 8, 'lifecycle events recorded');
    assert.equal(AGENT_TRANSITIONS.retired.size, 0);
  } finally { s.cleanup(); }
});

test('agent registration validates definitions and keeps secrets and external powers out', () => {
  const s = setup();
  try {
    const base = { name: 'X', role: 'Research', taskTypes: ['demo.noop'], permissions: { capabilities: ['research'] } };
    assert.throws(() => s.os.registry.register({ ...base, id: 'bad id!' }), ValidationError);
    assert.throws(() => s.os.registry.register({ ...base, role: 'Wizard' }), ValidationError);
    assert.throws(() => s.os.registry.register({ ...base, taskTypes: [] }), ValidationError);
    assert.throws(() => s.os.registry.register({ ...base, businessId: 'nope' }), ValidationError);
    assert.throws(() => s.os.registry.register({ ...base, settings: { apiKey: 'abc' } }), /credential/);
    assert.throws(() => s.os.registry.register({ ...base, settings: { nested: { password: 'x' } } }), /credential/);
    for (const cap of ['publish', 'spend', 'communicate', 'configure']) assert.throws(() => s.os.registry.register({ ...base, name: cap, permissions: { capabilities: [cap] } }), /not available in this phase/, cap);
    assert.throws(() => s.os.registry.register({ ...base, permissions: { capabilities: ['teleport'] } }), /Unknown capability/);
    assert.throws(() => s.os.registry.register({ ...base, limits: { maxConcurrentTasks: 5 } }), ValidationError);
    assert.throws(() => s.os.registry.register({ ...base, businessId: 'etsy', permissions: { capabilities: ['research'], businesses: ['*'] } }), /shared agents/);
    assert.ok(Object.entries(CAPABILITIES).filter(([k, c]) => c.external && k !== 'ai' && k !== 'source_retrieval').every(([, c]) => !c.enabled), 'every external capability except the AI service is disabled'); assert.equal(CAPABILITIES.ai.enabled, true); assert.equal(CAPABILITIES.source_retrieval.enabled, true);
    const ok = s.os.registry.register({ ...base, name: 'Good', businessId: 'etsy' }, { dataMode: 'test' });
    assert.deepEqual(ok.permissions, { capabilities: ['research'], businesses: ['etsy'] });
    assert.equal(ok.config.limits.timeoutMs, 30000);
    assert.throws(() => s.os.registry.register({ ...base, name: 'Good' }), /UNIQUE/);
  } finally { s.cleanup(); }
});

test('registry queries: by business, role, status, availability', async () => {
  const s = setup();
  try {
    s.mk('r1', { name: 'R1', role: 'Research', businessId: 'etsy', permissions: { capabilities: ['research'] } });
    s.mk('r2', { name: 'R2', role: 'QA', businessId: 'assets', permissions: { capabilities: ['analyze'] } });
    s.mk('r3', { name: 'R3', role: 'Research', businessId: null });
    await s.os.runtime('r1').start(); await s.os.runtime('r3').start();
    assert.deepEqual(s.os.registry.byBusiness('etsy').map((a) => a.id), ['r1']);
    assert.deepEqual(s.os.registry.byRole('Research').map((a) => a.id).sort(), ['r1', 'r3']);
    assert.deepEqual(s.os.registry.byStatus('created').map((a) => a.id), ['r2']);
    assert.deepEqual(s.os.registry.available().map((a) => a.id).sort(), ['r1', 'r3']);
    assert.throws(() => s.os.registry.list({ status: 'weird' }), ValidationError);
  } finally { s.cleanup(); }
});

test('task lifecycle: create, queue, assign, run, complete; invalid transitions rejected', async () => {
  const s = setup();
  try {
    const q = s.os.queue; s.mk('w1'); await s.os.runtime('w1').start();
    const t = q.create({ type: 'demo.success', payload: { numbers: [1, 2] }, dataMode: 'test', correlationId: 'corr-1' }); assert.equal(t.status, 'pending');
    assert.throws(() => q.transition(t.id, 'running'), InvalidTransitionError); // pending cannot run
    assert.equal(q.enqueue(t.id).status, 'queued');
    assert.throws(() => q.enqueue(t.id), InvalidTransitionError);
    const done = await s.os.runUntilIdle(); assert.equal(done.length, 1);
    const f = q.get(t.id); assert.equal(f.status, 'completed'); assert.deepEqual(f.result, { echo: { numbers: [1, 2] }, sum: 3 }); assert.equal(f.agent_id, 'w1'); assert.ok(f.started_at && f.completed_at);
    assert.throws(() => q.transition(t.id, 'running'), InvalidTransitionError); // terminal
    assert.throws(() => q.cancel(t.id), InvalidTransitionError);
    const types = s.repos.events.list({ task_id: t.id }, { orderBy: 'ts asc' }).map((e) => e.type);
    for (const need of ['task.pending', 'task.queued', 'task.assigned', 'task.running', 'task.completed']) assert.ok(types.includes(need), need);
    // cancel / block / unblock
    const c = q.submit({ type: 'demo.noop', dataMode: 'test' }); assert.equal(q.cancel(c.id).status, 'cancelled');
    const b = q.submit({ type: 'demo.noop', dataMode: 'test' }); q.block(b.id, 'waiting'); assert.equal(q.get(b.id).status, 'blocked');
    assert.equal((await s.os.runUntilIdle()).length, 0); // blocked tasks are not claimed
    q.unblock(b.id); assert.equal((await s.os.runUntilIdle()).length, 1);
    assert.equal(q.get(c.id).status, 'cancelled');
    for (const [from, tos] of Object.entries(TASK_TRANSITIONS)) assert.ok(!tos.has(from));
    assert.throws(() => q.create({ type: 'Bad Type' }), ValidationError);
    assert.throws(() => q.create({ type: 'demo.noop', priority: 11 }), ValidationError);
    assert.throws(() => q.create({ type: 'demo.noop', payload: { apiKey: 'x' } }), /credential/);
    assert.throws(() => q.get('x y'), ValidationError);
  } finally { s.cleanup(); }
});

test('queue: priority order, eligibility rules, and no double claim', async () => {
  const s = setup();
  try {
    const q = s.os.queue; const a1 = s.mk('c1'), a2 = s.mk('c2');
    const low = q.submit({ type: 'demo.noop', priority: 5, dataMode: 'test' }); s.clock.advance(5);
    const high = q.submit({ type: 'demo.noop', priority: 1, dataMode: 'test' }); s.clock.advance(5);
    const low2 = q.submit({ type: 'demo.noop', priority: 5, dataMode: 'test' });
    assert.equal(q.claim(a1).id, high.id); assert.equal(q.claim(a2).id, low.id); assert.equal(q.claim(a1).id, low2.id); assert.equal(q.claim(a2), null);
    assert.equal(q.get(high.id).status, 'assigned'); assert.equal(q.get(high.id).agent_id, 'c1');
    // a single task can only go to one claimant
    const only = q.submit({ type: 'demo.noop', dataMode: 'test' });
    assert.ok(q.claim(a1) && q.claim(a2) === null); assert.equal(q.get(only.id).agent_id, 'c1');
    assert.throws(() => q.transition(only.id, 'assigned', { expect: 'queued' }), InvalidTransitionError);
    // eligibility: task type, business scoping
    const etsyAgent = s.mk('c3', { name: 'C3', businessId: 'etsy', taskTypes: ['demo.noop'], permissions: { capabilities: ['analyze'] } });
    const assetsTask = q.submit({ type: 'demo.noop', businessId: 'assets', dataMode: 'test' });
    assert.equal(q.claim(etsyAgent), null, 'a business agent cannot take another business\'s task');
    const typeAgent = s.mk('c4', { name: 'C4', taskTypes: ['demo.slow'] });
    assert.equal(q.claim(typeAgent), null, 'agent only claims its declared task types');
    assert.equal(q.claim(a2).id, assetsTask.id, 'a shared agent can take any business');
  } finally { s.cleanup(); }
});

test('claims are exclusive across separate database connections', () => {
  const s = setup();
  const db2 = Db.open(s.file), repos2 = createRepos(db2), q2 = new TaskQueue(db2, repos2, { clock: s.clock });
  try {
    const a1 = s.mk('x1'), a2 = s.mk('x2'); const N = 30;
    for (let i = 0; i < N; i++) s.os.queue.submit({ type: 'demo.noop', priority: i % 3, dataMode: 'test' });
    const got1 = [], got2 = [];
    for (let i = 0; i < N + 5; i++) { const t1 = s.os.queue.claim(a1), t2 = q2.claim(new AgentRegistry(db2, repos2).get('x2')); if (t1) got1.push(t1.id); if (t2) got2.push(t2.id); }
    const all = [...got1, ...got2]; assert.equal(all.length, N); assert.equal(new Set(all).size, N, 'no task claimed twice');
    assert.ok(got1.length > 0 && got2.length > 0);
  } finally { db2.close(); s.cleanup(); }
});

test('claims are exclusive across separate processes', async () => {
  const s = setup();
  try {
    s.mk('p1'); s.mk('p2'); const N = 40;
    for (let i = 0; i < N; i++) s.os.queue.submit({ type: 'demo.noop', dataMode: 'test' });
    s.db.close();
    const run = (id) => new Promise((res, rej) => { const c = spawn(process.execPath, ['--no-warnings', 'tests/helpers/claim-worker.js', s.file, id], { cwd: ROOT }); let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(err)))); setTimeout(() => c.kill(), 30000).unref(); });
    const [a, b] = await Promise.all([run('p1'), run('p2')]);
    assert.equal(a.length + b.length, N); assert.equal(new Set([...a, ...b]).size, N, 'every task claimed exactly once');
  } finally { s.cleanup(); }
});

test('retries are bounded, deterministic, and only for retryable failures', async () => {
  const s = setup();
  try {
    const q = s.os.queue; s.mk('t1', { retry: { baseDelayMs: 1000, maxDelayMs: 60000 } }); await s.os.runtime('t1').start();
    assert.equal(retryDelayMs(0), 1000); assert.equal(retryDelayMs(1), 2000); assert.equal(retryDelayMs(10), 60000);
    const t = q.submit({ type: 'demo.flaky', payload: { failTimes: 2 }, maxRetries: 3, dataMode: 'test' });
    await s.os.step(); let r = q.get(t.id);
    assert.equal(r.status, 'retrying'); assert.equal(r.retry_count, 1); assert.equal(r.next_attempt_at, new Date(s.clock.t + 1000).toISOString()); assert.equal(r.error_code, 'demo_flaky');
    assert.equal((await s.os.step()).length, 0, 'not retried before the backoff elapses');
    s.clock.advance(1000); await s.os.step(); r = q.get(t.id); assert.equal(r.status, 'retrying'); assert.equal(r.retry_count, 2);
    assert.equal(r.next_attempt_at, new Date(s.clock.t + 2000).toISOString(), 'backoff doubles');
    s.clock.advance(2000); await s.os.step(); r = q.get(t.id); assert.equal(r.status, 'completed'); assert.equal(r.retry_count, 2); assert.deepEqual(r.result, { succeededAfterRetries: 2 });
    assert.equal(s.os.registry.metricsView(s.os.registry.get('t1')).retries, 2);
    // retry limit: 5 simulated failures but only 2 retries allowed -> terminal failure after 3 attempts
    const lim = q.submit({ type: 'demo.flaky', payload: { failTimes: 5 }, maxRetries: 2, dataMode: 'test' });
    for (let i = 0; i < 6; i++) { await s.os.step(); s.clock.advance(120000); }
    r = q.get(lim.id); assert.equal(r.status, 'failed'); assert.equal(r.retry_count, 2); assert.equal(r.error_code, 'demo_flaky');
    // non-retryable failure terminates immediately
    const nr = q.submit({ type: 'demo.fail', maxRetries: 5, dataMode: 'test' }); await s.os.step(); r = q.get(nr.id);
    assert.equal(r.status, 'failed'); assert.equal(r.retry_count, 0);
    // an unexpected thrown Error is treated as non-retryable (never retried blindly)
    s.os.handlers.register('test.boom', 'analyze', async () => { throw new Error('kaboom'); });
    s.os.repos.agents.update('t1', { config: { ...s.os.registry.get('t1').config, taskTypes: [...s.os.registry.get('t1').config.taskTypes, 'test.boom'] } });
    const boom = q.submit({ type: 'test.boom', maxRetries: 5, dataMode: 'test' }); await s.os.step(); r = q.get(boom.id);
    assert.equal(r.status, 'failed'); assert.equal(r.error_code, 'unhandled_error'); assert.equal(r.retry_count, 0);
  } finally { s.cleanup(); }
});

test('timeouts: enforced while running and detectable from the database', async () => {
  const s = setup();
  try {
    const q = s.os.queue; s.mk('to1', { limits: { timeoutMs: 40 } }); await s.os.runtime('to1').start();
    const t = q.submit({ type: 'demo.slow', payload: { sleepMs: 2000 }, maxRetries: 0, dataMode: 'test' });
    const t0 = Date.now(); await s.os.step();
    const r = q.get(t.id); assert.equal(r.status, 'failed'); assert.equal(r.error_code, 'timeout'); assert.ok(Date.now() - t0 < 1500, 'did not wait for the slow handler');
    assert.equal(s.os.registry.get('to1').status, 'ready'); assert.equal(s.os.registry.get('to1').current_task_id, null);
    const rt = q.submit({ type: 'demo.slow', payload: { sleepMs: 2000 }, maxRetries: 1, dataMode: 'test' }); await s.os.step();
    assert.equal(q.get(rt.id).status, 'retrying'); // timeouts are retryable
    // detection for a worker that died mid-task (no in-process timer): claim + start, advance the clock
    const orphan = q.submit({ type: 'demo.noop', timeoutMs: 100, dataMode: 'test' }); const claimed = q.claim(s.os.registry.get('to1')); assert.equal(claimed.id, orphan.id);
    q.start(orphan.id, s.os.registry.get('to1'), 100); assert.deepEqual(q.findTimedOut(), []);
    s.clock.advance(150); assert.deepEqual(q.findTimedOut().map((x) => x.id), [orphan.id]); assert.deepEqual(s.os.detect().timedOutTasks, [orphan.id]);
    await s.os.step(); assert.equal(q.get(orphan.id).error_code, 'timeout'); assert.ok(['retrying', 'failed'].includes(q.get(orphan.id).status));
  } finally { s.cleanup(); }
});

test('deadlines and claim leases', () => {
  const s = setup();
  try {
    const q = s.os.queue, a = s.mk('l1');
    const d = q.submit({ type: 'demo.noop', deadlineAt: new Date(s.clock.t + 1000).toISOString(), dataMode: 'test' });
    s.clock.advance(2000); assert.equal(q.expireDeadlines().length, 1); assert.equal(q.get(d.id).status, 'cancelled'); assert.equal(q.get(d.id).error_code, 'deadline_exceeded');
    const t = q.submit({ type: 'demo.noop', dataMode: 'test' }); q.claim(a); assert.equal(q.findExpiredLeases().length, 0);
    s.clock.advance(61000); assert.equal(q.findExpiredLeases().length, 1);
    assert.equal(q.releaseExpiredLeases()[0].status, 'queued'); assert.equal(q.get(t.id).agent_id, null); assert.equal(q.get(t.id).retry_count, 0);
  } finally { s.cleanup(); }
});

test('heartbeats persist and stale or degraded agents are detected', async () => {
  const s = setup();
  try {
    const reg = s.os.registry; s.mk('h1', { runtime: { staleAfterMs: 1000, heartbeatIntervalMs: 100 } }); const rt = s.os.runtime('h1');
    assert.equal(reg.assessHealth(reg.get('h1')), 'unknown');
    await rt.start(); assert.equal(reg.get('h1').last_heartbeat_at, s.clock.now().toISOString());
    s.clock.advance(500); rt.heartbeat(); assert.equal(reg.get('h1').last_heartbeat_at, s.clock.now().toISOString()); assert.equal(reg.get('h1').health_status, 'healthy');
    s.clock.advance(1500); assert.deepEqual(reg.findStale().map((a) => a.id), ['h1']); assert.equal(reg.assessHealth(reg.get('h1')), 'stalled'); assert.deepEqual(s.os.detect().staleAgents, ['h1']);
    rt.heartbeat(); assert.deepEqual(reg.findStale(), []); assert.equal(reg.get('h1').health_status, 'healthy');
    for (let i = 0; i < 3; i++) reg.recordOutcome('h1', { ok: false });
    rt.heartbeat(); assert.equal(reg.get('h1').health_status, 'degraded');
    assert.equal(reg.heartbeat('h1', { health: 20 }).health, 20);
    rt.fail(new Error('x')); assert.equal(reg.assessHealth(reg.get('h1')), 'failed');
    assert.throws(() => reg.heartbeat('h1'), InvalidTransitionError); // failed agents do not heartbeat
    assert.equal(reg.repos.agents.get('h1').last_heartbeat_at !== null, true);
  } finally { s.cleanup(); }
});

test('permissions: capability and business checks are enforced', async () => {
  const s = setup();
  try {
    const q = s.os.queue;
    const a = s.mk('perm', { name: 'Perm', businessId: 'etsy', permissions: { capabilities: ['research'] } });
    assert.equal(assertCan(a, 'research', { businessId: 'etsy' }), true);
    assert.throws(() => assertCan(a, 'research', { businessId: 'assets' }), PermissionError);
    assert.throws(() => assertCan(a, 'generate'), /lacks capability/);
    assert.throws(() => assertCan(a, 'publish'), /disabled in this phase/);
    assert.throws(() => assertCan(a, 'nonsense'), PermissionError);
    assert.throws(() => assertCan({ id: 'x' }, 'research'), PermissionError); // default deny
    // runtime enforcement: handler needs `analyze` but the agent only holds `research`
    s.os.registry.repos.agents.update('perm', { config: { ...a.config, taskTypes: ['demo.noop'] } });
    await s.os.runtime('perm').start(); const t = q.submit({ type: 'demo.noop', businessId: 'etsy', dataMode: 'test' }); await s.os.step();
    const r = q.get(t.id); assert.equal(r.status, 'failed'); assert.equal(r.error_code, 'permission_denied'); assert.equal(r.started_at, null, 'the handler never ran');
    // the demo Publishing agent can claim a publish attempt but is always denied
    seedDemo(s.db, s.repos);
    const pub = q.submit({ type: 'demo.publish_attempt', dataMode: 'demo' }); await s.os.startAll(); await s.os.runUntilIdle();
    assert.equal(q.get(pub.id).error_code, 'permission_denied');
    for (const ag of s.os.registry.list({ dataMode: 'demo' })) for (const c of ag.permissions.capabilities) assert.equal(CAPABILITIES[c].external, false, 'demo agents hold no external capability (including ai)');
  } finally { s.cleanup(); }
});

test('metrics, XP and reputation come only from verified outcomes and never invent revenue', async () => {
  const s = setup();
  try {
    const reg = s.os.registry, q = s.os.queue; s.mk('m1'); await s.os.runtime('m1').start();
    for (let i = 0; i < 10; i++) q.submit({ type: 'demo.noop', dataMode: 'test' });
    await s.os.runUntilIdle({ maxSteps: 20 });
    let a = reg.get('m1'); assert.equal(a.xp, 100); assert.equal(a.level, 2); assert.equal(a.reputation, 1);
    q.submit({ type: 'demo.fail', dataMode: 'test' }); await s.os.step(); a = reg.get('m1');
    assert.equal(a.xp, 100, 'failures grant no XP'); assert.equal(a.reputation, 0.8);
    const m = reg.metricsView(a); assert.equal(m.tasksCompleted, 10); assert.equal(m.tasksFailed, 1); assert.ok(Math.abs(m.successRate - 10 / 11) < 1e-9); assert.equal(m.revenueMinor, null); assert.equal(m.dataMode, 'test');
    assert.equal(s.repos.agentProgress.count({ agent_id: 'm1', kind: 'xp' }), 10); assert.ok(s.repos.agentProgress.list({ agent_id: 'm1' }).every((p) => p.data_mode === 'test'));
    assert.equal(s.repos.progression.get('agent', 'm1', 'test').xp, 100);
    assert.throws(() => s.db.run('UPDATE agent_progress_events SET delta = 99'), /append-only/);
    // no XP just because time passed
    s.clock.advance(3600e3); await s.os.step(); assert.equal(reg.get('m1').xp, 100);
  } finally { s.cleanup(); }
});

test('state survives a crash: tasks and agents persist, boot reconcile requeues interrupted work', async () => {
  const dir = tmp(), file = join(dir, 'p.sqlite');
  try {
    let s = setup({ path: file }); s.mk('z1'); await s.os.runtime('z1').start();
    const done = s.os.queue.submit({ type: 'demo.noop', dataMode: 'test' }); await s.os.step();
    const queued = s.os.queue.submit({ type: 'demo.success', payload: { numbers: [4] }, priority: 2, dataMode: 'test' });
    const inflight = s.os.queue.submit({ type: 'demo.noop', priority: 0, dataMode: 'test' });
    const claimed = s.os.queue.claim(s.os.registry.get('z1')); s.os.queue.start(claimed.id, s.os.registry.get('z1'), 5000); // pretend the process died mid-task
    s.os.registry.transition('z1', 'running', { extra: { current_task_id: claimed.id } });
    assert.equal(claimed.id, inflight.id);
    s.db.close(); // no graceful shutdown
    s = setup({ path: file });
    assert.equal(s.os.queue.get(done.id).status, 'completed'); assert.equal(s.os.queue.get(queued.id).status, 'queued'); assert.equal(s.os.queue.get(inflight.id).status, 'running');
    assert.equal(s.os.registry.get('z1').status, 'running', 'persisted state is still what the dead process left');
    const rec = s.os.reconcileAfterRestart(); assert.deepEqual(rec.releasedTasks, [inflight.id]); assert.deepEqual(rec.stoppedAgents, ['z1']);
    assert.equal(s.os.queue.get(inflight.id).status, 'queued'); assert.equal(s.os.queue.get(inflight.id).retry_count, 0); assert.equal(s.os.registry.get('z1').status, 'stopped'); assert.equal(s.os.registry.get('z1').current_task_id, null);
    assert.deepEqual(await s.os.startAll(), ['z1']);
    const finished = await s.os.runUntilIdle(); assert.deepEqual(finished.map((t) => t.id), [inflight.id, queued.id]); // priority order, nothing lost
    assert.ok(s.repos.events.list({ task_id: inflight.id }).some((e) => /process restart/.test(e.action)));
    assert.ok(s.db.integrityCheck().ok); assert.ok(s.db.foreignKeyCheck().ok); s.cleanup();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('graceful shutdown stops agents without losing or faking task completion', async () => {
  const s = setup();
  try {
    const q = s.os.queue; s.mk('g1'); s.mk('g2', { name: 'G2', taskTypes: ['demo.noop'] }); await s.os.startAll();
    const fin = q.submit({ type: 'demo.noop', dataMode: 'test' }); await s.os.step();
    const slow = q.submit({ type: 'demo.slow', payload: { sleepMs: 10000 }, timeoutMs: 60000, dataMode: 'test' });
    const stepping = s.os.step(); await new Promise((r) => setTimeout(r, 50)); assert.equal(q.get(slow.id).status, 'running'); assert.equal(s.os.registry.get('g1').status, 'running');
    const t0 = Date.now(); await s.os.shutdown(); assert.ok(Date.now() - t0 < 2000); await stepping;
    assert.equal(q.get(slow.id).status, 'queued', 'unfinished work is requeued, not marked complete'); assert.equal(q.get(slow.id).agent_id, null); assert.equal(q.get(slow.id).retry_count, 0);
    assert.equal(q.get(fin.id).status, 'completed');
    for (const id of ['g1', 'g2']) { const a = s.os.registry.get(id); assert.equal(a.status, 'stopped'); assert.equal(a.current_task_id, null); }
    assert.ok(s.db.integrityCheck().ok);
    assert.equal(s.repos.checkpoints.load('agent', 'g1').state.status, 'stopped');
  } finally { s.cleanup(); }
});

test('cancelling a running task aborts the handler and keeps it cancelled', async () => {
  const s = setup();
  try {
    const q = s.os.queue; s.mk('k1'); await s.os.startAll();
    const t = q.submit({ type: 'demo.slow', payload: { sleepMs: 10000 }, timeoutMs: 60000, dataMode: 'test' });
    const p = s.os.step(); await new Promise((r) => setTimeout(r, 50)); assert.equal(q.get(t.id).status, 'running');
    s.os.cancelTask(t.id); await p;
    assert.equal(q.get(t.id).status, 'cancelled'); assert.equal(s.os.registry.get('k1').status, 'ready'); assert.equal(s.os.registry.get('k1').xp, 0);
  } finally { s.cleanup(); }
});

test('checkpoints let recovery see what each agent and task was doing', async () => {
  const s = setup();
  try {
    s.mk('cp1'); await s.os.startAll(); const t = s.os.queue.submit({ type: 'demo.success', payload: { numbers: [1] }, dataMode: 'test' }); await s.os.step();
    const ac = s.repos.checkpoints.load('agent', 'cp1'), tc = s.repos.checkpoints.load('task', t.id);
    assert.equal(ac.state.status, 'ready'); assert.equal(ac.state.lastTaskId, t.id); assert.ok(ac.state.lastHeartbeatAt); assert.equal(ac.data_mode, 'test');
    assert.equal(tc.state.status, 'completed'); assert.equal(tc.state.agentId, 'cp1');
  } finally { s.cleanup(); }
});

test('migration 0003 upgrades a populated version-2 database and maps old states', () => {
  const dir = tmp(), file = join(dir, 'old.sqlite');
  try {
    const ms = loadMigrations(), db = Db.open(file);
    migrate(db, ms.slice(0, 2)); assert.equal(migrationStatus(db, ms).current, 2);
    db.run("INSERT INTO businesses (id, name, kind) VALUES ('etsy','Etsy','etsy_pod')");
    db.run("INSERT INTO agents (id, name, role, business_id, status, data_mode) VALUES ('oa','Old','QA','etsy','working','test'), ('ob','Idle','QA',NULL,'idle','test'), ('oc','Cand','QA',NULL,'candidate','test'), ('od','Susp','QA',NULL,'suspended','test')");
    db.run("INSERT INTO tasks (id, type, status, agent_id, business_id, data_mode) VALUES ('t1','x','succeeded','oa','etsy','test'), ('t2','x','waiting_approval','oa',NULL,'test'), ('t3','x','queued',NULL,NULL,'test')");
    db.run("INSERT INTO events (id, type, action, agent_id, task_id, data_mode) VALUES ('e1','t','a','oa','t1','test')");
    db.run("INSERT INTO approvals (id, request_type, action, task_id, data_mode) VALUES ('ap1','spend','x','t2','test')");
    const r = migrate(db, ms); assert.deepEqual(r.ran.slice(0, 1), [3], 'upgrade continues past 0003 to the latest version');
    assert.equal(db.pragma('foreign_keys'), 1, 'FK enforcement restored after the rebuild');
    const st = Object.fromEntries(db.all('SELECT id, status FROM agents').map((x) => [x.id, x.status])); assert.deepEqual(st, { oa: 'running', ob: 'ready', oc: 'created', od: 'paused' });
    const ts = Object.fromEntries(db.all('SELECT id, status FROM tasks').map((x) => [x.id, x.status])); assert.deepEqual(ts, { t1: 'completed', t2: 'blocked', t3: 'queued' });
    assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE id = 'e1'").n, 1); assert.equal(db.get("SELECT task_id FROM approvals WHERE id = 'ap1'").task_id, 't2');
    assert.ok(db.foreignKeyCheck().ok); assert.ok(db.integrityCheck().ok);
    assert.throws(() => db.run("INSERT INTO tasks (id, type, status) VALUES ('bad','x','succeeded')"), /CHECK/); // old states no longer valid
    assert.throws(() => db.run('DELETE FROM events'), /append-only/); // triggers survived
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Agent OS API: inspection, validation, demo task control', async () => {
  const dir = tmp(), cfg = { ...loadConfig({}), paths: { data: dir } };
  const svc = createDatabaseService(cfg).open(); seedDemo(svc.db, svc.repos);
  const os = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } }); await os.startAll();
  const serve = async (config, services) => { const srv = createApp(config, services); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`; return { base, close: () => srv.close() }; };
  const j = async (u, init) => { const r = await fetch(u, init); return { code: r.status, body: await r.json() }; };
  const post = (u, body, headers = { 'content-type': 'application/json' }) => j(u, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const app = await serve(cfg, { database: svc, agentOS: os });
  try {
    let r = await j(`${app.base}/api/agents`); assert.equal(r.code, 200); assert.equal(r.body.agents.length, 5);
    assert.ok(r.body.agents.every((a) => a.dataMode === 'demo' && a.status === 'ready' && !('config' in a)));
    r = await j(`${app.base}/api/agents?role=QA&status=ready`); assert.deepEqual(r.body.agents.map((a) => a.id), ['demo-qa']);
    r = await j(`${app.base}/api/agents/demo-qa`); assert.equal(r.body.agent.role, 'QA'); assert.deepEqual(r.body.agent.capabilities, ['analyze']);
    r = await j(`${app.base}/api/agents/demo-qa/status`); assert.equal(r.body.healthStatus, 'healthy');
    assert.equal((await j(`${app.base}/api/agents/nope`)).code, 404);
    assert.equal((await j(`${app.base}/api/agents/${encodeURIComponent("x'; DROP TABLE agents;--")}`)).code, 400);
    assert.equal((await j(`${app.base}/api/agents?business=${encodeURIComponent('a b')}`)).code, 400);
    assert.equal((await j(`${app.base}/api/tasks?limit=abc`)).code, 400);
    r = await post(`${app.base}/api/demo/tasks`, { type: 'demo.success', payload: { numbers: [5, 6] } }); assert.equal(r.code, 201); const id = r.body.task.id; assert.equal(r.body.task.status, 'queued'); assert.equal(r.body.task.dataMode, 'demo');
    await os.runUntilIdle();
    r = await j(`${app.base}/api/tasks/${id}`); assert.equal(r.body.task.status, 'completed'); assert.equal(r.body.task.result.sum, 11);
    r = await j(`${app.base}/api/tasks?status=completed`); assert.ok(r.body.tasks.some((t) => t.id === id));
    r = await post(`${app.base}/api/demo/tasks`, { type: 'demo.slow', payload: { sleepMs: 5000 } }); const slow = r.body.task.id;
    r = await post(`${app.base}/api/demo/tasks/${slow}/cancel`, {}); assert.equal(r.code, 200); assert.equal(r.body.task.status, 'cancelled');
    assert.equal((await post(`${app.base}/api/demo/tasks/${slow}/cancel`, {})).code, 409); // already cancelled
    for (const bad of [{ type: 'etsy.publish' }, { type: 'demo.unknown' }, {}, { type: 'demo.noop', priority: 99 }, { type: 'demo.noop', payload: { token: 'abc' } }]) assert.equal((await post(`${app.base}/api/demo/tasks`, bad)).code, 400, JSON.stringify(bad));
    assert.equal((await post(`${app.base}/api/demo/tasks`, '{not json')).code, 400);
    assert.equal((await post(`${app.base}/api/demo/tasks`, '{}', { 'content-type': 'text/plain' })).code, 400);
    assert.equal((await post(`${app.base}/api/demo/tasks`, JSON.stringify({ type: 'demo.noop', payload: { pad: 'x'.repeat(40000) } }))).code, 400);
    r = await j(`${app.base}/api/agent-os/status`); assert.equal(r.code, 200); assert.equal(r.body.agents.ready, 5);
    assert.ok(!JSON.stringify(r.body).includes(dir));
    // a non-demo task cannot be cancelled via the demo endpoint
    const live = os.queue.submit({ type: 'demo.noop' }); assert.equal((await post(`${app.base}/api/demo/tasks/${live.id}/cancel`, {})).code, 403);
    const h = await j(`${app.base}/api/health`); assert.equal(h.body.database.status, 'ok'); assert.equal(h.body.status, 'ok');
    // production disables demo task creation; missing Agent OS reports 503
    const prod = await serve({ ...cfg, env: 'production' }, { database: svc, agentOS: os });
    assert.equal((await post(`${prod.base}/api/demo/tasks`, { type: 'demo.noop' })).code, 403); assert.equal((await j(`${prod.base}/api/agents`)).code, 200); prod.close();
    const none = await serve(cfg, {}); assert.equal((await j(`${none.base}/api/agents`)).code, 503); none.close();
  } finally { app.close(); await os.shutdown(); svc.close(); rmSync(dir, { recursive: true, force: true }); }
});
