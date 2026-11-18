import { normalizeExtractorResponse } from './extractor.js';
import { inlineCandidateRef } from '../inline-memory-format.js';
import { sha256 } from '../identity.js';
import { sanitizeTaskMetadata } from './safe-metadata.js';

export async function compileInlineMemory({ packet, ...options }) {
  const candidate = structuredClone(packet);
  const scope = options.envelope.scope;
  const remap = (value, prefix, bindings) => {
    if (typeof value !== 'string') return value;
    // Reply references are stable across generation and subsequent extraction.
    const found = bindings.find(item => `${prefix}:${item.entityId}` === value);
    return found?.entityKey ?? 'unresolved-inline-reference';
  };
  for (const person of candidate.people) if (person?.sameAsEntityKey) person.sameAsEntityKey = remap(person.sameAsEntityKey, 'person', scope.catalogBindings);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'sourceFloorKey')) value.sourceFloorKey = value.sourceFloorKey === 'current' ? options.envelope.request.payload.sourceFloorKey : 'invalid-inline-floor';
    if (Object.hasOwn(value, 'sameAsPlaceKey')) value.sameAsPlaceKey = remap(value.sameAsPlaceKey, 'place', scope.placeCatalogBindings);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
  };
  walk(candidate);
  const candidateKey = value => scope.qianshiCandidateBindings.find(item => inlineCandidateRef(item) === value)?.key ?? 'unresolved-inline-reference';
  for (const event of candidate.qianshi.events) for (const link of event?.links ?? []) if (link && typeof link === 'object') link.candidateKey = candidateKey(link.candidateKey);
  for (const order of candidate.qianshi.order) for (const key of ['before', 'after']) if (typeof order?.[key] === 'string' && !/^event-\d+$/u.test(order[key])) order[key] = candidateKey(order[key]);
  const normalized = await normalizeExtractorResponse({ ...options, response: candidate, finishReason: 'stop' });
  return Object.freeze({ ...normalized, attempts: 0, transportAttempts: 0,
    metadata: sanitizeTaskMetadata({ source: 'main-reply', sourceLabel: '主回复记忆区块', model: '主模型（随正文）', sourceStage: 'inline-memory', transportAttempts: 0 }),
    responseFingerprint: `sha256:${await sha256(JSON.stringify(packet))}`,
    validationErrors: normalized.isolated.map(item => ({ code: item.code, path: item.path, field: item.field, index: item.index })).slice(-20) });
}
