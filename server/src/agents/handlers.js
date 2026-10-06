// Pluggable task handlers: type -> { capability, fn(ctx) }. Phase 3 ships deterministic DEMO handlers only.
// Handlers receive no network/filesystem helpers; real adapters arrive with later phases behind capability checks.
export class TaskError extends Error {
  constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'TaskError'; this.code = code; this.retryable = retryable; }
}
export class HandlerRegistry {
  #map = new Map();
  register(type, capability, fn) { if (this.#map.has(type)) throw new Error(`handler for ${type} already registered`); this.#map.set(type, { type, capability, fn }); return this; }
  get(type) { return this.#map.get(type); }
  types() { return [...this.#map.keys()]; }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

export function demoHandlers(registry = new HandlerRegistry()) {
  registry
    .register('demo.noop', 'analyze', async () => ({ ok: true }))
    .register('demo.success', 'research', async ({ task }) => ({ echo: task.payload, sum: (task.payload.numbers ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) }))
    .register('demo.fail', 'analyze', async () => { throw new TaskError('demo_failure', 'controlled non-retryable failure', { retryable: false }); })
    .register('demo.flaky', 'analyze', async ({ task }) => {
      const failTimes = Number.isInteger(task.payload.failTimes) ? task.payload.failTimes : 1;
      if (task.retry_count < failTimes) throw new TaskError('demo_flaky', `simulated transient failure ${task.retry_count + 1}/${failTimes}`, { retryable: true });
      return { succeededAfterRetries: task.retry_count };
    })
    .register('demo.slow', 'generate', async ({ task, signal }) => { await sleep(Number.isInteger(task.payload.sleepMs) ? task.payload.sleepMs : 10, signal); return { slept: true }; })
    .register('demo.publish_attempt', 'publish', async () => ({ published: false })); // requires a capability no agent can hold in Phase 3
  return registry;
}
