import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/src/db/database.js';
import { migrate, migrationStatus } from '../server/src/db/migrate.js';
import { createRepos } from '../server/src/db/repos.js';
import { seedFoundation, seedDemo } from '../server/src/db/seed.js';
import { createDatabaseService } from '../server/src/db/service.js';
import { createAgentOS } from '../server/src/agents/os.js';
import { demoHandlers, HandlerRegistry } from '../server/src/agents/handlers.js';
import { InvalidTransitionError } from '../server/src/agents/states.js';
import { Supervisor, SupervisorLockError } from '../server/src/supervisor/supervisor.js';
import { SUPERVISOR_TRANSITIONS } from '../server/src/supervisor/states.js';
import { planDispatch, rankKey } from '../server/src/supervisor/policy.js';
import { normalizeSupervisorConfig } from '../server/src/supervisor/config.js';
import { createApp } from '../server/src/api/app.js';
import { loadConfig, ROOT } from '../server/src/config/index.js';

class FakeClock { constructor() { this.t = Date.parse('2030-01-01T00:00:00.000Z'); } now() { return new Date(this.t); } advance(ms) { this.t += ms; } }
const tmp = () => mkdtempSync(join(tmpdir(), 'tycoon-sv-'));
const AT = ['demo.noop', 'demo.success', 'demo.fail', 'demo.flaky', 'demo.slow', 'demo.publish_attempt'];
function setup({ cfg = {}, clock = new FakeClock(), agentOs = {} } = {}) {
  const dir = tmp(), file = join(dir, 's.sqlite'), db = Db.open(file), repos = createRepos(db); migrate(db); seedFoundation(repos);
  const os = createAgentOS({ db, repos, clock, config: { stopGraceMs: 100, ...agentOs } });
  const mk = async (id, o = {}) => { os.registerAgent({ id, name: `S ${id}`, role: 'Analytics', businessId: null, taskTypes: AT, permissions: { capabilities: ['analyze', 'research', 'generate'], businesses: ['*'] }, ...o }, { dataMode: 'test' }); await os.runtime(id).start(); return os.registry.get(id); };
  const sup = (extra = {}) => new Supervisor({ os, config: { checkpointIntervalMs: 0, ...cfg, ...extra }, processRunId: repos.runs.start('test') });
  const submit = (type, o = {}) => os.queue.submit({ type, dataMode: 'test', ...o });
  const cleanup = async (...sups) => { for (const s of sups) { try { await s.stop(); } catch { /* ok */ } } try { await os.shutdown(); } catch { /* ok */ } try { db.close(); } catch { /* ok */ } rmSync(dir, { recursive: true, force: true }); };
  const decisions = (kind) => repos.events.list({}, { limit: 1000 }).filter((e) => e.action === kind);
  return { dir, file, db, repos, os, clock, mk, sup, submit, cleanup, decisions };
}
const snapAgent = (id, o = {}) => ({ id, status: 'ready', available: true, businessId: null, capabilities: ['analyze'], businesses: ['*'], taskTypes: ['demo.noop'], lastActivityAt: null, ...o });
const snapTask = (id, o = {}) => ({ id, type: 'demo.noop', status: 'queued', priority: 5, businessId: null, createdAt: '2030-01-01T00:00:00.000Z', nextAttemptAt: null, deadlineAt: null, retryCount: 0, agentId: null, estimatedCostMinor: null, ...o });
const NOW = Date.parse('2030-01-01T00:00:10.000Z'), H = demoHandlers(new HandlerRegistry()), CFG = normalizeSupervisorConfig({});
const plan = (agents, candidates, cfg = CFG, active = []) => planDispatch({ agents, candidates, activeTasks: active }, cfg, NOW, H);

test('supervisor lifecycle: explicit states, invalid transitions, duplicate-instance protection', async () => {
  const s = setup(); let a, b;
  try {
    a = s.sup(); assert.equal(a.state, 'stopped');
    assert.throws(() => a.pause(), InvalidTransitionError); // stopped cannot pause
    await a.start({ loop: false }); assert.equal(a.state, 'running');
    await assert.rejects(a.start({ loop: false }), InvalidTransitionError); // already running
    b = s.sup(); await assert.rejects(b.start({ loop: false }), (e) => e instanceof SupervisorLockError && e.code === 'supervisor_already_running');
    assert.equal(b.state, 'stopped', 'a refused instance stays stopped');
    a.pause(); assert.equal(a.state, 'paused'); assert.deepEqual(await a.cycle(), { skipped: 'paused' }); assert.throws(() => a.pause(), InvalidTransitionError);
    a.resume(); assert.equal(a.state, 'running');
    await a.stop(); assert.equal(a.state, 'stopped'); assert.throws(() => a.resume(), InvalidTransitionError);
    await b.start({ loop: false }); assert.equal(b.state, 'running'); // lock was released by the clean stop
    await b.stop();
    for (const [from, tos] of Object.entries(SUPERVISOR_TRANSITIONS)) assert.ok(!tos.has(from));
    assert.equal(s.repos.checkpoints.load('supervisor', 'state').state.cleanShutdown, true);
    const life = s.repos.events.list({ type: 'supervisor.lifecycle' }, { limit: 100 }).map((e) => e.action);
    for (const need of ['starting', 'running', 'paused', 'stopping', 'stopped']) assert.ok(life.includes(need), need);
  } finally { await s.cleanup(a, b); }
});

test('scheduling policy: priority, deadline, fairness, age, id tie-breaks (pure, deterministic)', () => {
  const A = [snapAgent('a1'), snapAgent('a2'), snapAgent('a3'), snapAgent('a4'), snapAgent('a5')];
  const order = (tasks, agents = A, cfg = CFG) => plan(agents, tasks, cfg).dispatch.map((d) => d.taskId);
  assert.deepEqual(order([snapTask('t5', { priority: 5 }), snapTask('t1', { priority: 1 }), snapTask('t3', { priority: 3 })]), ['t1', 't3', 't5']);
  // same priority: earlier deadline first, then no-deadline
  assert.deepEqual(order([snapTask('nd'), snapTask('d2', { deadlineAt: '2030-01-01T01:00:00.000Z' }), snapTask('d1', { deadlineAt: '2030-01-01T00:30:00.000Z' })]), ['d1', 'd2', 'nd']);
  // same priority + deadline: business with less active load first
  const one = snapAgent('solo'); const p = plan([one], [snapTask('x', { businessId: 'etsy' }), snapTask('y', { businessId: 'assets' })], CFG, [snapTask('r', { status: 'running', businessId: 'etsy' })]);
  assert.equal(p.dispatch[0].taskId, 'y', 'less-loaded business goes first');
  // then age, then id
  assert.deepEqual(order([snapTask('b', { createdAt: '2030-01-01T00:00:05.000Z' }), snapTask('a', { createdAt: '2030-01-01T00:00:05.000Z' }), snapTask('old', { createdAt: '2030-01-01T00:00:01.000Z' })]), ['old', 'a', 'b']);
  assert.deepEqual(order([snapTask('b'), snapTask('a')]), order([snapTask('a'), snapTask('b')]), 'input order does not matter');
  // retried task waits from its retry time, not its creation time
  assert.ok(rankKey(snapTask('r', { nextAttemptAt: '2030-01-01T00:00:09.000Z' }), NOW, CFG, new Map()).since > rankKey(snapTask('n'), NOW, CFG, new Map()).since);
  // starvation protection: after waiting 5 aging steps a priority-5 task beats a fresh priority-1 one; capped boost never reaches below 0
  const cfg = normalizeSupervisorConfig({ scheduling: { agingStepMs: 1000, maxAgingBoost: 10 } });
  const old = snapTask('old5', { priority: 5, createdAt: '2030-01-01T00:00:00.000Z' }), fresh = snapTask('new1', { priority: 1, createdAt: '2030-01-01T00:00:09.500Z' });
  assert.equal(plan([snapAgent('s')], [fresh, old], cfg).dispatch[0].taskId, 'old5');
  assert.equal(plan([snapAgent('s')], [fresh, old]).dispatch[0].taskId, 'new1', 'default 60s step: not yet boosted');
  assert.equal(rankKey(snapTask('z', { priority: 2, createdAt: '2020-01-01T00:00:00.000Z' }), NOW, CFG, new Map()).effPriority, 0);
  // one task per agent; extra tasks are deferred, not dropped
  const two = plan([snapAgent('only')], [snapTask('a'), snapTask('b')]); assert.equal(two.dispatch.length, 1); assert.deepEqual(two.skipped.map((s) => [s.taskId, s.reason]), [['b', 'deferred']]);
});

test('compatibility: type, business allow-list, capability, specialist preference', () => {
  const etsy = snapAgent('etsy-a', { businessId: 'etsy', businesses: ['etsy'] }), shared = snapAgent('shared-a');
  assert.equal(plan([etsy, shared], [snapTask('t', { businessId: 'etsy' })]).dispatch[0].agentId, 'etsy-a', 'specialist preferred');
  assert.equal(plan([etsy, shared], [snapTask('t', { businessId: 'etsy' })]).dispatch[0].agentChoice, 'specialist');
  const p = plan([etsy], [snapTask('t', { businessId: 'assets' })]); assert.equal(p.dispatch.length, 0); assert.deepEqual(p.skipped[0], { taskId: 't', reason: 'no_compatible_agent', detail: ['business_mismatch'] });
  assert.deepEqual(plan([snapAgent('x', { businesses: ['etsy'] })], [snapTask('t', { businessId: 'assets' })]).skipped[0].detail, ['business_not_permitted']);
  assert.deepEqual(plan([snapAgent('x', { taskTypes: ['demo.success'] })], [snapTask('t')]).skipped[0].detail, ['task_type_not_supported']);
  assert.deepEqual(plan([snapAgent('x', { taskTypes: ['demo.publish_attempt'] })], [snapTask('t', { type: 'demo.publish_attempt' })]).skipped[0].detail, ['capability_missing']);
  assert.deepEqual(plan([snapAgent('x')], [snapTask('t', { type: 'demo.unknown' })]).skipped[0].detail, ['no_handler']);
  assert.deepEqual(plan([snapAgent('x')], [snapTask('t', { agentId: 'someone-else' })]).skipped[0].detail, ['assigned_elsewhere']);
  // a busy compatible agent means "deferred", not "no compatible agent"
  assert.equal(plan([snapAgent('x', { available: false })], [snapTask('t')]).skipped[0].reason, 'deferred');
  // the plan is a pure function of its inputs
  const args = [[snapAgent('a'), snapAgent('b')], [snapTask('1'), snapTask('2', { priority: 1 })]]; assert.deepEqual(plan(...args), plan(...args));
});

test('limits: per-cycle count, concurrency, retry dispatch, estimated cost', () => {
  const agents = ['a', 'b', 'c', 'd', 'e'].map((i) => snapAgent(i)), tasks = ['1', '2', '3', '4', '5'].map((i) => snapTask(i));
  let p = plan(agents, tasks, normalizeSupervisorConfig({ limits: { maxDispatchPerCycle: 2 } })); assert.equal(p.dispatch.length, 2); assert.deepEqual(p.limits, ['maxDispatchPerCycle']);
  p = plan(agents, tasks, normalizeSupervisorConfig({ limits: { maxConcurrentTasks: 3 } }), [snapTask('r1', { status: 'running' }), snapTask('r2', { status: 'running' })]); assert.equal(p.dispatch.length, 1); assert.deepEqual(p.limits, ['maxConcurrentTasks']);
  p = plan(agents, tasks, normalizeSupervisorConfig({ limits: { maxConcurrentTasks: 1 } }), [snapTask('r1', { status: 'running' })]); assert.equal(p.dispatch.length, 0);
  const retried = ['r1', 'r2', 'r3'].map((i) => snapTask(i, { retryCount: 1, priority: 0 }));
  p = plan(agents, [...retried, snapTask('fresh', { priority: 9 })], normalizeSupervisorConfig({ limits: { maxRetryDispatchPerCycle: 1 } }));
  assert.deepEqual(p.dispatch.map((d) => d.taskId), ['r1', 'fresh'], 'retries are capped but ordinary work still flows'); assert.deepEqual(p.limits, ['maxRetryDispatchPerCycle']);
  const costly = ['c1', 'c2', 'c3'].map((i) => snapTask(i, { estimatedCostMinor: 600 }));
  p = plan(agents, [...costly, snapTask('free')], normalizeSupervisorConfig({ limits: { maxEstimatedCostPerCycleMinor: 1000 } }));
  assert.deepEqual(p.dispatch.map((d) => d.taskId).sort(), ['c1', 'free']); assert.deepEqual(p.limits, ['maxEstimatedCostPerCycleMinor']);
  assert.throws(() => normalizeSupervisorConfig({ limits: { maxTasksPerAgent: 2 } }), /maxTasksPerAgent/);
  assert.throws(() => normalizeSupervisorConfig({ pollMs: 1 }), /pollMs/);
});

test('dispatch through the Agent OS: priority order, completion, one task per agent', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('d1'); sup = s.sup(); await sup.start({ loop: false });
    const lo = s.submit('demo.noop', { priority: 5 }); s.clock.advance(5); const hi = s.submit('demo.success', { priority: 1, payload: { numbers: [1, 2] } }); s.clock.advance(5); const mid = s.submit('demo.noop', { priority: 3 });
    const done = [];
    for (let i = 0; i < 3; i++) { const r = await sup.cycle({ wait: true }); assert.equal(r.dispatched.length, 1, 'one agent => one task per cycle'); done.push(...r.dispatched); }
    assert.deepEqual(done, [hi.id, mid.id, lo.id]);
    for (const t of [hi, mid, lo]) assert.equal(s.os.queue.get(t.id).status, 'completed');
    assert.deepEqual(s.os.queue.get(hi.id).result.sum, 3);
    const disp = s.decisions('task.dispatched'); assert.equal(disp.length, 3); assert.equal(disp[0].metadata.rank.priority, 1); assert.equal(disp[0].agent_id, 'd1');
    assert.equal(s.os.registry.get('d1').xp, 30);
  } finally { await s.cleanup(sup); }
});

test('tasks nobody may run stay queued, untouched, with one recorded decision', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('c1', { taskTypes: ['demo.noop', 'demo.publish_attempt'] }); await s.mk('c2', { name: 'C2', businessId: 'etsy', permissions: { capabilities: ['analyze'] }, taskTypes: ['demo.noop'] });
    sup = s.sup(); await sup.start({ loop: false });
    const pub = s.submit('demo.publish_attempt'); const wrongBiz = s.submit('demo.fail', { businessId: 'assets' }); const ok = s.submit('demo.noop');
    await sup.cycle({ wait: true }); await sup.cycle({ wait: true }); await sup.cycle({ wait: true });
    assert.equal(s.os.queue.get(ok.id).status, 'completed');
    for (const t of [pub, wrongBiz]) { const r = s.os.queue.get(t.id); assert.equal(r.status, 'queued'); assert.equal(r.started_at, null); assert.equal(r.agent_id, null); }
    assert.equal(s.repos.events.list({ task_id: pub.id }).some((e) => e.type === 'task.running'), false, 'the publish attempt never ran');
    const skips = s.decisions('task.skipped'); assert.equal(skips.length, 2, 'recorded once per task, not once per cycle');
    assert.ok(skips.find((e) => e.task_id === pub.id).metadata.detail.includes('capability_missing'));
    assert.ok(skips.find((e) => e.task_id === wrongBiz.id).metadata.detail.includes('task_type_not_supported'));
  } finally { await s.cleanup(sup); }
});

test('no duplicate dispatch: overlapping cycles, repeated cycles, repeated claims', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('u1'); await s.mk('u2'); sup = s.sup(); await sup.start({ loop: false });
    const t = s.submit('demo.slow', { payload: { sleepMs: 5000 }, timeoutMs: 60000 });
    const [r1, r2] = await Promise.all([sup.cycle(), sup.cycle()]);
    assert.equal([r1, r2].filter((r) => r.skipped === 'busy').length, 1, 'overlapping cycle is refused');
    await sup.cycle(); await sup.cycle(); assert.equal(sup.counters.dispatched, 1, 'a running task is never dispatched again');
    assert.equal(s.os.dispatch(t.id, 'u2'), null, 'cannot claim a task that is already running');
    assert.equal(s.repos.events.list({ task_id: t.id }).filter((e) => e.type === 'task.assigned').length, 1);
    s.os.cancelTask(t.id); await sup.drain(); assert.equal(s.os.queue.get(t.id).status, 'cancelled');
  } finally { await s.cleanup(sup); }
});

test('limits in the live loop: stop at the limit, record it once, resume when clear', async () => {
  const s = setup(); let sup;
  try {
    for (const i of ['l1', 'l2', 'l3', 'l4']) await s.mk(i);
    sup = s.sup({ limits: { maxDispatchPerCycle: 2 } }); await sup.start({ loop: false });
    for (let i = 0; i < 5; i++) s.submit('demo.noop');
    let r = await sup.cycle({ wait: true }); assert.equal(r.dispatched.length, 2); assert.deepEqual(r.limits, ['maxDispatchPerCycle']);
    r = await sup.cycle({ wait: true }); assert.equal(r.dispatched.length, 2); r = await sup.cycle({ wait: true }); assert.equal(r.dispatched.length, 1); assert.deepEqual(r.limits, []);
    assert.equal(s.decisions('limit.reached').length, 1, 'edge-triggered, not per cycle'); assert.equal(s.os.queue.counts().completed, 5);
    // concurrency limit with long tasks
    const s2 = sup; await s2.stop(); sup = s.sup({ limits: { maxConcurrentTasks: 1 } }); await sup.start({ loop: false });
    const a = s.submit('demo.slow', { payload: { sleepMs: 5000 }, timeoutMs: 60000 }); s.clock.advance(5); const b = s.submit('demo.slow', { payload: { sleepMs: 5000 }, timeoutMs: 60000 });
    r = await sup.cycle(); assert.equal(r.dispatched.length, 1); r = await sup.cycle(); assert.equal(r.dispatched.length, 0); assert.deepEqual(r.limits, ['maxConcurrentTasks']);
    assert.equal(s.os.queue.get(b.id).status, 'queued'); s.os.cancelTask(a.id); await sup.drain();
    r = await sup.cycle(); assert.equal(r.dispatched.length, 1); s.os.cancelTask(b.id); await sup.drain();
  } finally { await s.cleanup(sup); }
});

test('retries: retryable failures are retried once per attempt, terminal failures never', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('r1', { retry: { baseDelayMs: 1000, maxDelayMs: 8000 } }); sup = s.sup(); await sup.start({ loop: false });
    const runs = (id) => s.repos.events.list({ task_id: id }).filter((e) => e.type === 'task.running').length;
    const t = s.submit('demo.flaky', { payload: { failTimes: 1 } });
    await sup.cycle({ wait: true }); assert.equal(s.os.queue.get(t.id).status, 'retrying'); assert.equal(runs(t.id), 1);
    await sup.cycle({ wait: true }); await sup.cycle({ wait: true }); assert.equal(runs(t.id), 1, 'nothing runs during the backoff');
    s.clock.advance(1000); await sup.cycle({ wait: true }); assert.equal(s.os.queue.get(t.id).status, 'completed'); assert.equal(runs(t.id), 2);
    const lim = s.submit('demo.flaky', { payload: { failTimes: 9 }, maxRetries: 1 });
    for (let i = 0; i < 6; i++) { await sup.cycle({ wait: true }); s.clock.advance(10000); }
    assert.equal(s.os.queue.get(lim.id).status, 'failed'); assert.equal(runs(lim.id), 2, 'one try + one retry, then terminal');
    const bad = s.submit('demo.fail', { maxRetries: 5 }); for (let i = 0; i < 3; i++) await sup.cycle({ wait: true }); assert.equal(runs(bad.id), 1); assert.equal(s.os.queue.get(bad.id).status, 'failed');
  } finally { await s.cleanup(sup); }
});

test('recovery: stale, failed and stopped agents; escalation instead of restart loops', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('g1', { runtime: { staleAfterMs: 1000, heartbeatIntervalMs: 100 } }); sup = s.sup({ recovery: { maxAgentRecoveries: 2, windowMs: 3600000 } }); await sup.start({ loop: false });
    // stale heartbeat -> restarted once, not repeatedly
    s.clock.advance(5000); assert.equal(s.os.registry.assessHealth(s.os.registry.get('g1')), 'stalled');
    await sup.cycle(); assert.equal(s.decisions('recovery.agent_restarted').length, 1); assert.equal(s.os.registry.get('g1').status, 'ready'); assert.equal(s.os.registry.assessHealth(s.os.registry.get('g1')), 'healthy');
    await sup.cycle(); await sup.cycle(); assert.equal(s.decisions('recovery.agent_restarted').length, 1, 'recovery is not repeated once it worked');
    // failed runtime -> restarted (attempt 2)
    s.os.runtime('g1').fail(new Error('boom')); await sup.cycle(); assert.equal(s.os.registry.get('g1').status, 'ready'); assert.equal(s.decisions('recovery.agent_restarted').length, 2);
    // attempts exhausted -> escalated and left failed, decision recorded once
    s.os.runtime('g1').fail(new Error('boom again')); await sup.cycle(); await sup.cycle(); await sup.cycle();
    assert.equal(s.os.registry.get('g1').status, 'failed'); const ref = s.decisions('recovery.refused'); assert.equal(ref.length, 1); assert.equal(ref[0].severity, 'error'); assert.equal(ref[0].metadata.escalate, true);
    // stopped agent: only restarted when compatible work exists
    await s.mk('g2'); await s.os.runtime('g2').stop(); await sup.cycle(); assert.equal(s.os.registry.get('g2').status, 'stopped', 'no work, no restart');
    const t = s.submit('demo.noop'); await sup.cycle({ wait: true }); assert.equal(s.os.registry.get('g2').status, 'ready'); assert.equal(s.os.queue.get(t.id).status, 'completed');
    assert.ok(s.decisions('recovery.agent_restarted').some((e) => e.metadata.reason === 'stopped_with_eligible_work'));
  } finally { await s.cleanup(sup); }
});

test('recovery: stale agent mid-task releases the task without consuming a retry', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('m1', { runtime: { staleAfterMs: 1000, heartbeatIntervalMs: 100 } }); sup = s.sup(); await sup.start({ loop: false });
    const t = s.submit('demo.slow', { payload: { sleepMs: 5000 }, timeoutMs: 600000 }); await sup.cycle(); assert.equal(s.os.queue.get(t.id).status, 'running');
    s.clock.advance(5000); await sup.cycle();
    const ev = s.repos.events.list({ task_id: t.id }).map((e) => e.type); assert.ok(ev.includes('task.queued'), 'released back to the queue');
    assert.equal(s.os.queue.get(t.id).retry_count, 0); assert.equal(s.decisions('recovery.agent_restarted').length, 1);
    assert.ok(['running', 'assigned', 'queued'].includes(s.os.queue.get(t.id).status));
    s.os.cancelTask(t.id); await sup.drain();
  } finally { await s.cleanup(sup); }
});

test('recovery: expired lease, orphaned running task, timeout; none consume a retry except timeout', async () => {
  const s = setup(); let sup;
  try {
    const a = await s.mk('o1'); sup = s.sup({ recovery: { orphanGraceMs: 0 } }); await sup.start({ loop: false });
    // expired lease: claimed by a worker that died before starting
    const lease = s.submit('demo.noop'); s.os.queue.claim(a); assert.equal(s.os.queue.get(lease.id).status, 'assigned');
    s.os.registry.transition('o1', 'paused'); // keep the agent busy so only recovery acts
    s.clock.advance(61000); await sup.cycle(); assert.equal(s.decisions('recovery.lease_released').length, 1); assert.equal(s.os.queue.get(lease.id).status, 'queued'); assert.equal(s.os.queue.get(lease.id).retry_count, 0);
    s.os.registry.transition('o1', 'ready'); await sup.cycle({ wait: true }); assert.equal(s.os.queue.get(lease.id).status, 'completed');
    // orphan: marked running by a dead process (no executor in this one)
    const orphan = s.submit('demo.noop', { timeoutMs: 600000 }); const c = s.os.queue.claim(s.os.registry.get('o1')); s.os.queue.start(c.id, s.os.registry.get('o1'), 600000);
    s.os.registry.transition('o1', 'running', { extra: { current_task_id: orphan.id } });
    await sup.cycle({ wait: true }); const d = s.decisions('recovery.task_interrupted'); assert.equal(d.length, 1); assert.equal(d[0].metadata.retryConsumed, false);
    assert.equal(s.os.queue.get(orphan.id).retry_count, 0);
  } finally { await s.cleanup(sup); }
});

test('recovery: orphaned running task is requeued and finished exactly once', async () => {
  const s = setup(); let sup;
  try {
    const a = await s.mk('q1'); sup = s.sup({ recovery: { orphanGraceMs: 0 } }); await sup.start({ loop: false });
    const t = s.submit('demo.noop'); const c = s.os.queue.claimTask(t.id, a); s.os.queue.start(c.id, a, 60000); // a "dead" executor left it running
    await sup.cycle({ wait: true }); await sup.cycle({ wait: true });
    const types = s.repos.events.list({ task_id: t.id }, { orderBy: 'ts asc' }).map((e) => e.type);
    assert.equal(s.os.queue.get(t.id).status, 'completed'); assert.equal(types.filter((x) => x === 'task.completed').length, 1);
    assert.equal(s.os.queue.get(t.id).retry_count, 0);
    // an overdue task that a live executor still holds is aborted by the Supervisor and fails with the retryable `timeout` error
    const t2 = s.submit('demo.slow', { payload: { sleepMs: 5000 }, timeoutMs: 300, maxRetries: 0 }); await sup.cycle(); assert.equal(s.os.queue.get(t2.id).status, 'running');
    s.clock.advance(1000); await sup.cycle(); await sup.drain();
    assert.equal(s.os.queue.get(t2.id).status, 'failed'); assert.equal(s.os.queue.get(t2.id).error_code, 'timeout'); assert.equal(s.decisions('recovery.task_timeout').length, 1);
  } finally { await s.cleanup(sup); }
});

test('a clean idle supervisor writes no decision spam', async () => {
  const s = setup(); let sup;
  try {
    await s.mk('i1'); sup = s.sup(); await sup.start({ loop: false }); const before = s.repos.events.count();
    for (let i = 0; i < 10; i++) await sup.cycle(); assert.equal(s.repos.events.count(), before); assert.equal(sup.counters.cycles, 10);
  } finally { await s.cleanup(sup); }
});

test('restart: interrupted run is detected, state resumes, no work is duplicated or lost', async () => {
  const dir = tmp(), cfg = { ...loadConfig({}), paths: { data: dir }, database: { autoMigrate: true, busyTimeoutMs: 1000 } };
  const build = () => { const svc = createDatabaseService(cfg).open(); const os = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } }); return { svc, os }; };
  try {
    let { svc, os } = build();
    os.registerAgent({ id: 'k1', name: 'K1', role: 'Analytics', taskTypes: AT, permissions: { capabilities: ['analyze', 'research', 'generate'], businesses: ['*'] } }, { dataMode: 'test' }); await os.startAll();
    let sup = new Supervisor({ os, config: { checkpointIntervalMs: 0 }, processRunId: svc.runId }); await sup.start({ loop: false });
    const done = os.queue.submit({ type: 'demo.noop', dataMode: 'test' }); await sup.cycle({ wait: true });
    const unpub = os.queue.submit({ type: 'demo.publish_attempt', dataMode: 'test' }); await sup.cycle({ wait: true }); // recorded as skipped once
    const mid = os.queue.submit({ type: 'demo.noop', dataMode: 'test' }); const agent = os.registry.get('k1'); const c = os.queue.claimTask(mid.id, agent); os.queue.start(c.id, agent, 60000); os.registry.transition('k1', 'running', { extra: { current_task_id: mid.id } }); // killed mid-task
    const firstRun = sup.runId, seqBefore = sup.seq; svc.db.close(); // crash: no stop(), no clean shutdown
    ({ svc, os } = build()); assert.equal(svc.previousCrashedRuns, 1);
    const cp = svc.repos.checkpoints.load('supervisor', 'state').state; assert.equal(cp.cleanShutdown, false); assert.equal(cp.runId, firstRun); assert.equal(os.queue.get(done.id).status, 'completed'); assert.equal(os.queue.get(mid.id).status, 'running');
    os.reconcileAfterRestart(); await os.startAll();
    sup = new Supervisor({ os, config: { checkpointIntervalMs: 0 }, processRunId: svc.runId }); await sup.start({ loop: false });
    assert.equal(sup.previousRun.interrupted, true); assert.equal(sup.previousRun.runId, firstRun); assert.equal(sup.seq, seqBefore, 'cycle sequence resumes');
    assert.equal(svc.repos.events.list({}, { limit: 1000 }).filter((e) => e.action === 'supervisor.resumed_after_interruption').length, 1);
    await sup.cycle({ wait: true }); await sup.cycle({ wait: true });
    const ev = (id) => svc.repos.events.list({ task_id: id }).map((e) => e.type);
    assert.equal(os.queue.get(mid.id).status, 'completed'); assert.equal(ev(mid.id).filter((t) => t === 'task.completed').length, 1); assert.equal(ev(done.id).filter((t) => t === 'task.running').length, 1, 'finished work is not re-run');
    assert.equal(svc.repos.events.list({}, { limit: 1000 }).filter((e) => e.action === 'task.skipped' && e.task_id === unpub.id).length, 1, 'skip decision not repeated after restart');
    await sup.stop(); assert.equal(svc.repos.checkpoints.load('supervisor', 'state').state.cleanShutdown, true);
    assert.ok(svc.db.integrityCheck().ok && svc.db.foreignKeyCheck().ok);
    // a clean restart is not reported as an interruption
    const sup2 = new Supervisor({ os, config: {}, processRunId: svc.runId }); await sup2.start({ loop: false }); assert.equal(sup2.previousRun.interrupted, false); await sup2.stop();
    await os.shutdown(); svc.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lock: a stuck instance can be taken over after its lease expires and then fails safely', async () => {
  const s = setup(); let a, b;
  try {
    await s.mk('lk'); a = s.sup({ lockTtlMs: 5000 }); await a.start({ loop: false });
    b = s.sup({ lockTtlMs: 5000 }); await assert.rejects(b.start({ loop: false }), SupervisorLockError);
    s.clock.advance(6000); await b.start({ loop: false }); assert.equal(b.state, 'running');
    const r = await a.cycle(); assert.equal(r.failed, 'lock_lost'); assert.equal(a.state, 'failed');
    await b.cycle(); assert.equal(b.state, 'running');
    await a.start({ loop: false }).then(() => assert.fail('should be locked'), (e) => assert.ok(e instanceof SupervisorLockError)); // failed -> starting is allowed, but b holds the lock
    assert.equal(a.state, 'failed', 'a refused restart leaves the failed state unchanged');
  } finally { await s.cleanup(a, b); }
});

test('cycle failures are contained; repeated failure ends in `failed` and can be restarted', async () => {
  const s = setup(); let sup;
  try {
    sup = s.sup({ maxConsecutiveCycleFailures: 2 }); await sup.start({ loop: false });
    const orig = s.os.queue.promoteDueRetries; s.os.queue.promoteDueRetries = () => { throw new Error('db hiccup'); };
    await sup.cycle(); assert.equal(sup.state, 'running'); assert.equal(s.decisions('cycle.failed').length, 1);
    await sup.cycle(); assert.equal(sup.state, 'failed'); assert.equal(s.repos.checkpoints.load('supervisor', 'state').state.state, 'failed');
    s.os.queue.promoteDueRetries = orig; await sup.start({ loop: false }); assert.equal(sup.state, 'running'); assert.equal((await sup.cycle()).seq > 0, true);
  } finally { await s.cleanup(sup); }
});

test('real loop: dispatches on a timer, stops cleanly, leaves no timers running', async () => {
  const s = setup({ clock: { now: () => new Date() } }); let sup;
  try {
    await s.mk('loop1'); await s.mk('loop2'); sup = s.sup({ pollMs: 20 }); await sup.start({ loop: true });
    const ids = ['demo.noop', 'demo.success', 'demo.noop'].map((t) => s.submit(t).id);
    const t0 = Date.now(); while (Date.now() - t0 < 4000 && !ids.every((id) => s.os.queue.get(id).status === 'completed')) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ids.every((id) => s.os.queue.get(id).status === 'completed'), 'tasks completed by the background loop');
    await sup.stop(); const seq = sup.seq; await new Promise((r) => setTimeout(r, 120)); assert.equal(sup.seq, seq, 'no cycles after stop'); assert.equal(sup.timer, null);
  } finally { await s.cleanup(sup); }
});

test('Supervisor API: status, decisions, demo controls, validation', async () => {
  const dir = tmp(), cfg = { ...loadConfig({}), paths: { data: dir } };
  const svc = createDatabaseService(cfg).open(); seedDemo(svc.db, svc.repos);
  const os = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } }); await os.startAll();
  const sup = new Supervisor({ os, config: { checkpointIntervalMs: 0 }, processRunId: svc.runId }); await sup.start({ loop: false });
  const serve = async (config, services) => { const srv = createApp(config, services); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }; };
  const j = async (u, init) => { const r = await fetch(u, init); return { code: r.status, body: await r.json() }; };
  const app = await serve(cfg, { database: svc, agentOS: os, supervisor: sup });
  try {
    os.queue.submit({ type: 'demo.success', payload: { numbers: [1] }, dataMode: 'demo' }); os.queue.submit({ type: 'demo.publish_attempt', dataMode: 'demo' }); await sup.cycle({ wait: true });
    let r = await j(`${app.base}/api/supervisor/status`); assert.equal(r.code, 200); assert.equal(r.body.supervisor.state, 'running'); assert.equal(r.body.supervisor.counters.dispatched, 1); assert.equal(r.body.supervisor.config.limits.maxTasksPerAgent, 1);
    assert.ok(!('instanceId' in r.body.supervisor)); assert.ok(!JSON.stringify(r.body).includes(dir));
    r = await j(`${app.base}/api/supervisor/decisions?limit=10`); assert.ok(r.body.decisions.some((d) => d.kind === 'task.dispatched')); assert.ok(r.body.decisions.length <= 10);
    r = await j(`${app.base}/api/supervisor/decisions?kind=task.skipped`); assert.deepEqual(r.body.decisions.map((d) => d.kind), ['task.skipped']);
    for (const bad of ['kind=Bad Kind', 'kind=x;DROP', 'since=notadate', 'limit=0', 'limit=abc']) assert.equal((await j(`${app.base}/api/supervisor/decisions?${bad}`)).code, 400, bad);
    assert.equal((await j(`${app.base}/api/supervisor/nope`)).code, 404);
    assert.equal((await j(`${app.base}/api/demo/supervisor/pause`, { method: 'POST' })).body.state, 'paused'); assert.equal((await j(`${app.base}/api/demo/supervisor/pause`, { method: 'POST' })).code, 409);
    assert.equal((await j(`${app.base}/api/demo/supervisor/resume`, { method: 'POST' })).body.state, 'running');
    const prod = await serve({ ...cfg, env: 'production' }, { database: svc, agentOS: os, supervisor: sup });
    assert.equal((await j(`${prod.base}/api/demo/supervisor/pause`, { method: 'POST' })).code, 403); assert.equal((await j(`${prod.base}/api/supervisor/status`)).code, 200); prod.close();
    const none = await serve(cfg, { database: svc, agentOS: os }); assert.equal((await j(`${none.base}/api/supervisor/status`)).code, 503); none.close();
  } finally { app.close(); await sup.stop(); await os.shutdown(); svc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('security and scope: no network/code-exec in the Supervisor, schema unchanged, permissions not bypassed', () => {
  for (const f of readdirSync(join(ROOT, 'server/src/supervisor'))) { const src = readFileSync(join(ROOT, 'server/src/supervisor', f), 'utf8'); assert.ok(!/node:(http|https|net|dgram|child_process)|fetch\(|eval\(|new Function/.test(src), f); }
  const s = setup(); try { assert.equal(migrationStatus(s.db).applied.find((m) => m.name === 'agent_os').version, 3); assert.ok(!migrationStatus(s.db).applied.some((m) => /supervisor/.test(m.name)), 'Phase 4 added no migration'); assert.deepEqual(new Set(s.db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)).has('supervisor_runs'), false); } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); }
  assert.ok(!JSON.stringify(normalizeSupervisorConfig({})).match(/key|token|secret|password/i));
});
