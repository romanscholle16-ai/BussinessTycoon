// Provider contract (documented; JS has no interfaces).
//
//   name, kind ('cloud' | 'local' | 'mock' | 'adapter')
//   describe()  -> { configured:boolean, problem:string|null, model, models:string[], capabilities:{text,json,temperature},
//                    endpointOrigin:string|null, integration:string }          (never contains credentials)
//   probe?(ctx) -> Promise<{ok:boolean, category?, message?}>                  (optional liveness check; bounded)
//   complete(req, ctx) -> Promise<{ output:string, finishReason?:string, requestId?:string|null,
//                                   usage?:{inputTokens,outputTokens}|null, model?:string, ignored?:string[] }>
//     req: { model, system, prompt, maxTokens, temperature, jsonSchema }   (already validated and bounded by the service)
//     ctx: { signal, timeoutMs, fetchImpl }
//   Failures are thrown as AiError (see ../errors.js). Raw provider responses never escape the adapter.
export const originOf = (endpoint) => { try { return endpoint ? new URL(endpoint).origin : null; } catch { return null; } };
export const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '');
export const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
