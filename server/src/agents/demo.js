// Deterministic DEMO agents: they exercise the Agent OS with demo handlers only. No business logic, no external access.
export const DEMO_AGENT_DEFS = [
  { id: 'demo-research', name: 'DEMO Research Agent', role: 'Research', businessId: 'etsy', taskTypes: ['demo.noop', 'demo.success', 'demo.flaky'], permissions: { capabilities: ['research', 'analyze'] } },
  { id: 'demo-analytics', name: 'DEMO Analytics Agent', role: 'Analytics', businessId: null, taskTypes: ['demo.noop', 'demo.success', 'demo.fail', 'demo.flaky'], permissions: { capabilities: ['research', 'analyze'], businesses: ['*'] } },
  { id: 'demo-creation', name: 'DEMO Creation Agent', role: 'Creation', businessId: 'assets', taskTypes: ['demo.noop', 'demo.slow'], permissions: { capabilities: ['generate', 'analyze'] } },
  { id: 'demo-qa', name: 'DEMO QA Agent', role: 'QA', businessId: 'etsy', taskTypes: ['demo.noop', 'demo.flaky'], permissions: { capabilities: ['analyze'] } },
  // Publishing role with NO publish capability (none can be granted in Phase 3): proves permission enforcement.
  { id: 'demo-publishing', name: 'DEMO Publishing Agent', role: 'Publishing', businessId: 'affiliate', taskTypes: ['demo.noop', 'demo.publish_attempt'], permissions: { capabilities: ['analyze'] } },
];
export function registerDemoAgents(registry) {
  return DEMO_AGENT_DEFS.map((d) => registry.get(d.id) ?? registry.register(d, { dataMode: 'demo' }));
}
