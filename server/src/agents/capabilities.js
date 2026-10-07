// Capability / permission model. Default deny. Capabilities with external effects exist in the catalog but
// are DISABLED in Phase 3: nothing can be granted publish/spend/communicate/configure until a later phase enables them.
import { ValidationError } from './validate.js';

export const CAPABILITIES = {
  research:    { enabled: true,  external: false, description: 'gather and score information (internal data only in Phase 3)' },
  source_discovery: { enabled: true, external: false, description: 'ask configured discovery providers for candidate sources (no page access)' },
  source_retrieval: { enabled: true, external: true,  description: 'fetch public web pages through the safe retriever (HTTPS, SSRF policy, bounded, robots-aware); no auth, no publishing' },
  evidence_analysis: { enabled: true, external: false, description: 'extract and analyze evidence from stored sources' },
  analyze:     { enabled: true,  external: false, description: 'analyze stored data' },
  generate:    { enabled: true,  external: false, description: 'create content/assets (deterministic stubs only in Phase 3)' },
  ai:          { enabled: true,  external: true,  description: 'call the configured AI providers through the AI service (never granted to demo agents; providers are disabled unless configured)' },
  publish:     { enabled: false, external: true,  description: 'publish to an external marketplace/site (not available until Phase 8+)' },
  spend:       { enabled: false, external: true,  description: 'spend money (not available until Phase 12)' },
  communicate: { enabled: false, external: true,  description: 'message customers/third parties (not available until Phase 11)' },
  configure:   { enabled: false, external: false, description: 'modify system configuration (not available until Phase 20)' },
};
export class PermissionError extends Error { constructor(message, capability) { super(message); this.name = 'PermissionError'; this.code = 'permission_denied'; this.capability = capability; } }

export function normalizePermissions(p = {}, primaryBusiness = null) {
  const capabilities = [...new Set(p.capabilities ?? [])], businesses = [...new Set(p.businesses ?? (primaryBusiness ? [primaryBusiness] : []))];
  for (const c of capabilities) {
    if (!CAPABILITIES[c]) throw new ValidationError(`Unknown capability "${c}"`, 'capabilities');
    if (!CAPABILITIES[c].enabled) throw new ValidationError(`Capability "${c}" is not available in this phase and cannot be granted`, 'capabilities');
  }
  return { capabilities, businesses };
}

/** Throws PermissionError unless the agent holds the (enabled) capability and may act on the business ('*' = any, shared agents only). */
export function assertCan(agent, capability, { businessId = null } = {}) {
  const meta = CAPABILITIES[capability];
  if (!meta) throw new PermissionError(`Unknown capability "${capability}"`, capability);
  if (!meta.enabled) throw new PermissionError(`Capability "${capability}" is disabled in this phase`, capability);
  const perms = agent.permissions ?? { capabilities: [], businesses: [] };
  if (!perms.capabilities.includes(capability)) throw new PermissionError(`Agent ${agent.id} lacks capability "${capability}"`, capability);
  if (businessId && !perms.businesses.includes('*') && !perms.businesses.includes(businessId)) throw new PermissionError(`Agent ${agent.id} may not act on business "${businessId}"`, capability);
  return true;
}
