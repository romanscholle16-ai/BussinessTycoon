// Agent OS integration: handlers that turn the AI service into task work. The Agent OS knows nothing about providers.
import { TaskError } from '../agents/handlers.js';

/** Task failure semantics: transient AI problems retry through the normal Agent OS/Supervisor retry rules (bounded by the task's maxRetries). */
const RETRY = new Set(['rate_limit', 'timeout', 'unavailable', 'provider_error', 'malformed_response']);

export function registerAiHandlers(handlerRegistry, ai) {
  // Capability `ai` is required to run this task type; no agent holds it by default (demo agents never do).
  handlerRegistry.register('ai.complete', 'ai', async ({ task, agent, signal }) => {
    const p = task.payload ?? {};
    const res = await ai.complete({ prompt: p.prompt, system: p.system, maxTokens: p.maxTokens, temperature: p.temperature, jsonSchema: p.jsonSchema, provider: p.provider, model: p.model, allowFallback: p.allowFallback, maxCostUsd: p.maxCostUsd, purpose: p.purpose ?? 'task.complete', signal,
      context: { taskId: task.id, agentId: agent.id, businessId: task.business_id, correlationId: task.correlation_id }, dataMode: task.data_mode });
    if (!res.ok) throw new TaskError(`ai_${res.error.category}`, res.error.message, { retryable: RETRY.has(res.error.category) });
    return { output: res.output, structured: res.structured, provider: res.provider, model: res.model, finishReason: res.finishReason, usage: res.usage, cost: res.cost, attempts: res.attempts.length, latencyMs: res.latencyMs };
  });
  return handlerRegistry;
}
