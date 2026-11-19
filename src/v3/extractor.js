import { buildExtractorSystemPrompt, buildHighFloorExtractorSystemPrompt, ENTITY_TYPES, SPATIAL_FACT_LIMIT, MENTION_KEY, NULLABLE_MENTION_KEY,
  EVIDENCE_SEGMENT_LIMIT, EVIDENCE_OCCURRENCE_LIMIT, EVIDENCE_REF_LIMIT, EVIDENCE, evidenceArray, FLOOR_PROPERTIES } from './extractor-prompts.js';
export { QIANSHI_OUTPUT_CAPACITY_GUIDANCE, EXTRACTOR_RESPONSE_SCHEMA, EXTRACTOR_OUTPUT_CONTRACT, DEFAULT_EXTRACTOR_GUIDANCE, QIANSHI_LIFECYCLE_GUIDANCE, EXTRACTOR_FIXED_CONTRACT, buildExtractorSystemPrompt, buildHighFloorExtractorSystemPrompt, EXTRACTOR_SYSTEM_PROMPT } from './extractor-prompts.js';
import { isGenericPlaceAlias } from './spatial-domain.js';
import { TRADITIONAL_CLOCK_PATTERN, isStoryClockOnly } from '../story-time-clock.js';
import { isUuid, sha256 } from '../identity.js';
import { balancedObjects } from '../compact-api-client.js';
import { parseJsonWithSafeTrailingCommas, parseJsonWithSymbolRepair, repairJsonWithUniqueMissingObjectClose } from '../json-symbol-repair.js';
import { deterministicUuid } from './foundation-domain.js';
import { EXACT_ANCHOR_LIMIT, FLOOR_MEMORY_ITEM_LIMIT, collectFloorMemoryEntityIds, validateEntityRecord, validateFloorMemory } from './memory-schema.js';
import { expandPlacePaths, placeCurrentFactBindings, completePlaceCurrentPatch, isPlaceTagSource, placeParentSourceIntent } from './place-foundation.js';
import { locatePlaceQuote } from './place-evidence.js';
import { resolvePlaceParentBatch } from './place-parent.js';
import {QIANCHUANG_MAP_STYLES} from '../qianchuang-display-hints.js';
import { copyFloorVariableReference } from './floor-variable-reference.js';
import { sanitizeDiagnosticValue, sanitizeTaskMetadata } from './safe-metadata.js';
import { buildEntityIdentityDirectory, identityLabelKey, normalizeIdentityProjection, resolveIdentityEntityId } from './entity-identity.js';
import { compileQianshiDelta } from './qianshi-domain.js';
import { readMemoryTagBlocks, stripMemoryTagBlocks } from '../memory-content-sanitizer.js';
import { projectTime } from './time-engine.js';
import { normalizeLocationReference } from './location-reference.js';
import { compileIdentityFacts, identityFactBindings, identityFactsForPrompt, identityFactsText, sameIdentityFacts } from './identity-brief.js';

export const EXTRACTOR_SCHEMA_VERSION = 3;
export const EXTRACTOR_PROMPT_VERSION = 'qqj-v3-extractor-prompt-68';
export const EXTRACTOR_VERSION = `${EXTRACTOR_PROMPT_VERSION}/schema-${EXTRACTOR_SCHEMA_VERSION}/semantic-compiler-37`;
const EXTRACTOR_ERROR_COPY = Object.freeze({
  V3_EXTRACTOR_SUMMARY_INVALID: '模型没有返回可用摘要，请重新提取本楼。',
  V3_EXTRACTOR_MULTIPLE_RESULTS: '模型返回了多份不同摘要，无法确认；请重新提取本楼。',
  V3_EXTRACTOR_LOCAL_SCOPE_INVALID: '当前楼与提取目标不一致，请刷新后重新提取本楼。',
  V3_EXTRACTOR_LOCAL_CATALOG_INVALID: '人物资料与当前记忆不一致，请刷新后重新提取本楼。',
  V3_EXTRACTOR_ENTITY_KEY_INVALID: '返回的人物身份无法确认，请重新提取本楼。',
  V3_EXTRACTOR_ENTITY_TYPE_CONFLICT: '返回的人物类型与现有身份不一致，请重新提取本楼。',
  V3_EXTRACTOR_ENTITY_AMBIGUOUS: '人物称谓对应多人，无法确认；请重新提取本楼。',
  V3_EXTRACTOR_USER_ROLE_CONFLICT: '返回的人物身份与用户身份冲突，请检查称谓后重试。',
});
function extractorError(code, path = '', message = EXTRACTOR_ERROR_COPY[code] ?? code) {
  const error = new TypeError(message); error.code = code; error.validationPath = path; return error;
}
function assertObject(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path); return value; }
function boundedText(value, path, maximum = 4000, nullable = false) { if (nullable && value === null) return null; if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path); return value.trim(); }
function boundedLiteralText(value, path, maximum = 2000) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path); return value; }
function array(value, path, maximum = 80) { if (!Array.isArray(value) || value.length > maximum) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path); return value; }
function validateItemSchema(value, schema, path) {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (schema?.type && !types.includes(actualType) && !(actualType === 'integer' && types.includes('number'))) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  if (Object.hasOwn(schema ?? {}, 'const') && value !== schema.const) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  if (schema?.enum && !schema.enum.includes(value)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  if (actualType === 'string' && (!value.trim() || (schema.maxLength && value.length > schema.maxLength))) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  if (actualType === 'array') {
    if ((schema.minItems ?? 0) > value.length || (schema.maxItems ?? Infinity) < value.length) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
    value.forEach((item, index) => validateItemSchema(item, schema.items ?? {}, `${path}[${index}]`));
  }
  if (actualType === 'object') {
    const keys = Object.keys(value), allowed = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties === false && keys.some(key => !allowed.includes(key))) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
    for (const key of keys) if (schema.properties?.[key]) validateItemSchema(value[key], schema.properties[key], `${path}.${key}`);
  }
  return value;
}
function validateItemCore(value, schema, path) {
  assertObject(value, path);
  const properties = schema?.properties ?? {};
  for (const key of schema?.required ?? []) if (key !== 'evidence' && !Object.hasOwn(value, key)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', `${path}.${key}`);
  for (const [key, childSchema] of Object.entries(properties)) if (!['evidence', 'identityBrief', 'identityFacts', 'identityBriefEvidence'].includes(key) && Object.hasOwn(value, key)) validateItemSchema(value[key], childSchema, `${path}.${key}`);
  return value;
}
function occurrence(content, quote) { let count = 0, offset = -1; while ((offset = content.indexOf(quote, offset + 1)) !== -1) count += 1; return count; }
function exactSegment(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  return value.replace(/\r\n/g, '\n');
}
function normalizedCanonical(content) {
  const text = [];
  const offsets = [];
  for (let cursor = 0; cursor < content.length;) {
    if (content[cursor] === '\r' && content[cursor + 1] === '\n') {
      text.push('\n'); offsets.push({ start: cursor, end: cursor + 2 }); cursor += 2; continue;
    }
    const char = String.fromCodePoint(content.codePointAt(cursor));
    const end = cursor + char.length;
    text.push(char);
    for (let index = 0; index < char.length; index += 1) offsets.push({ start: cursor, end });
    cursor = end;
  }
  return { text: text.join(''), offsets };
}
function occurrenceAt(content, quote, targetOffset) {
  let count = 0, offset = -1;
  while ((offset = content.indexOf(quote, offset + 1)) !== -1) {
    count += 1;
    if (offset === targetOffset) return count;
    if (offset > targetOffset) break;
  }
  throw extractorError('V3_EXTRACTOR_EVIDENCE_SPAN_INVALID');
}
function segmentOccurrences(content, canonical, segment, path) {
  const found = [];
  let offset = -1;
  while ((offset = canonical.text.indexOf(segment, offset + 1)) !== -1) {
    if (found.length >= EVIDENCE_OCCURRENCE_LIMIT) throw extractorError('V3_EXTRACTOR_EVIDENCE_CHAIN_LIMIT', path);
    const first = canonical.offsets[offset];
    const last = canonical.offsets[offset + segment.length - 1];
    if (!first || !last) throw extractorError('V3_EXTRACTOR_EVIDENCE_SPAN_INVALID', path);
    const quotedText = content.slice(first.start, last.end);
    if (!quotedText || quotedText.length > 2000) throw extractorError('V3_EXTRACTOR_EVIDENCE_SPAN_INVALID', path);
    found.push({ start: first.start, end: last.end, quotedText, occurrence: occurrenceAt(content, quotedText, first.start) });
  }
  if (!found.length) throw extractorError('V3_EXTRACTOR_EVIDENCE_NOT_FOUND', path);
  return found;
}
function compileEvidenceSegments(content, value, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > EVIDENCE_SEGMENT_LIMIT) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', path);
  const canonical = normalizedCanonical(content);
  const occurrenceLists = value.map((segment, index) => segmentOccurrences(content, canonical, exactSegment(segment, `${path}[${index}]`), `${path}[${index}]`));
  const statesBySegment = [occurrenceLists[0].map(() => ({ count: 1, previous: -1 }))];
  for (let segmentIndex = 1; segmentIndex < occurrenceLists.length; segmentIndex += 1) {
    const previousOccurrences = occurrenceLists[segmentIndex - 1];
    const previousStates = statesBySegment[segmentIndex - 1];
    const states = occurrenceLists[segmentIndex].map(current => {
      let count = 0, previous = -1;
      for (let index = 0; index < previousOccurrences.length; index += 1) {
        if (previousOccurrences[index].end > current.start || previousStates[index].count === 0) continue;
        if (count === 0 && previousStates[index].count === 1) previous = index;
        else previous = -1;
        count = Math.min(2, count + previousStates[index].count);
      }
      return { count, previous: count === 1 ? previous : -1 };
    });
    statesBySegment.push(states);
  }
  const finalStates = statesBySegment.at(-1);
  const total = finalStates.reduce((sum, state) => Math.min(2, sum + state.count), 0);
  if (total === 0) throw extractorError('V3_EXTRACTOR_EVIDENCE_CHAIN_NOT_FOUND', path);
  if (total > 1) throw extractorError('V3_EXTRACTOR_EVIDENCE_CHAIN_AMBIGUOUS', path);
  const chain = Array(occurrenceLists.length);
  let occurrenceIndex = finalStates.findIndex(state => state.count === 1);
  for (let segmentIndex = occurrenceLists.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    chain[segmentIndex] = occurrenceLists[segmentIndex][occurrenceIndex];
    occurrenceIndex = statesBySegment[segmentIndex][occurrenceIndex].previous;
  }
  return chain;
}
function catalogEntries(directory) {
  return directory
    .filter(entry => entry.entityType === 'person' || entry.entityType === 'group' || entry.specialRole !== 'none')
    .map((entry, index) => {
      const identityBrief = entry.entityType === 'person' && typeof entry.identityBrief === 'string' && entry.identityBrief.trim()
        ? entry.identityBrief : null;
      return {
        entityKey: `catalog-${index + 1}`,
        entity: entry.entity,
        identityBriefSource: entry.identityBriefSource,
        labels: entry.labels,
        semantic: {
          entityKey: `catalog-${index + 1}`,
          displayName: entry.displayName,
          aliases: entry.aliases,
          ...(entry.originalDisplayName ? { previousName: entry.originalDisplayName } : {}),
          entityKind: entry.entityType === 'group' ? 'group' : 'individual',
          specialRole: entry.specialRole,
          ...(identityBrief && !entry.identityBriefSource?.facts?.length ? { identityBrief } : {}),
          ...(entry.identityBriefSource?.facts?.length ? { identityFacts: identityFactsForPrompt(entry.identityBriefSource, `catalog-${index + 1}`) } : {}),
        },
      };
    });
}
function placeIdentityLabels(directory) {
  const owners = new Map();
  for (const entry of directory) if (entry.entityType === 'place') for (const label of entry.labels) {
    const key = identityLabelKey(label);
    if (!key) continue;
    const ids = owners.get(key) ?? new Set(); ids.add(entry.entityId); owners.set(key, ids);
  }
  return Object.freeze([...owners].map(([label, ids]) => Object.freeze([label, Object.freeze([...ids])])));
}

function placeCatalogEntries(directory, sourceTexts = [], priorityPlaceEntityIds = [], parentEntityIdsByPlaceId = new Map(), placeFeatures = [], featurePlaceEntityIds = [], featureSourceTexts = [], sourceLocationReferencesByPlaceId = new Map(), manualPlaces = [], placeRelations = []) {
  const texts = sourceTexts.flatMap(value => {
    if (Array.isArray(value)) return value.filter(text => typeof text === 'string' && text);
    if (typeof value === 'string') return value ? [value] : [];
    if (!value || typeof value !== 'object') return [];
    return [value.summaryTail, ...(Array.isArray(value.locationReference) ? value.locationReference : []), ...(value.placeNames ?? []), ...(value.messages ?? []).map(message => message?.content)]
      .filter(text => typeof text === 'string' && text);
  });
  const places = directory.filter(entry => entry.entityType === 'place');
  const priorityIds = new Set(Array.isArray(priorityPlaceEntityIds) ? priorityPlaceEntityIds : []);
  const requiredPlaces = places.filter(entry => priorityIds.has(entry.entityId));
  const directlyReferenced = [];
  const otherKnownPlaces = [];
  for (const entry of places) {
    if (priorityIds.has(entry.entityId)) continue;
    const labels = [entry.displayName, ...entry.aliases.filter(label => !isGenericPlaceAlias(label))];
    (labels.some(label => label.length > 0 && texts.some(source => source.includes(label)))
      ? directlyReferenced : otherKnownPlaces).push(entry);
  }
  const selected = [...requiredPlaces, ...directlyReferenced, ...otherKnownPlaces].slice(0, SPATIAL_FACT_LIMIT);
  const ownersByLabel = new Map(placeIdentityLabels(directory));
  const keyByEntityId = new Map(selected.map((entry, index) => [entry.entityId, `place-${index + 1}`]));
  let featureCharacters = 0, featureCount = 0, sourceLocationCharacters = 0;
  return selected
    .map(entry => {
      const aliases = entry.aliases.filter(label => !isGenericPlaceAlias(label));
      const parents = parentEntityIdsByPlaceId.get(entry.entityId);
      const parentPlaceKeys = parents?.size === 1
        ? [...parents].map(parentId => keyByEntityId.get(parentId)).filter(Boolean)
        : [];
      const identityAmbiguous = [entry.displayName, ...aliases].some(label => (ownersByLabel.get(identityLabelKey(label))?.length ?? 0) > 1);
      const relevant = featurePlaceEntityIds.includes(entry.entityId) || [entry.displayName, ...aliases].filter(label => !isGenericPlaceAlias(label)).some(label => featureSourceTexts.some(text => typeof text === 'string' && text.includes(label)));
      const offeredFeatures = relevant ? placeFeatures.filter(feature => feature.placeEntityId === entry.entityId).filter(feature => {
        const text = String(feature.text ?? '');
        const sourceTime = String(feature.sourceTime ?? '').slice(0, 500);
        if ((!text||text.length>1000)&&!(feature.source&&Array.isArray(feature.replacesItemIds)) || featureCount >= 40 || featureCharacters + text.length + sourceTime.length > 8000) return false;
        featureCharacters += text.length + sourceTime.length;
        featureCount++;return true;
      }) : [];
      const isCurrent=feature=>feature.source&&Array.isArray(feature.replacesItemIds),currentDescriptions=offeredFeatures.filter(isCurrent),description=currentDescriptions.map(feature=>feature.text).join('\n');
      const featureBindings=offeredFeatures.filter(feature=>!isCurrent(feature)).map((feature,index)=>({key:`known-feature-${featureCount-offeredFeatures.length+index+1}`,itemId:feature.itemId,placeEntityId:entry.entityId,text:String(feature.text),...(feature.source?{source:{kind:feature.source.kind,locator:feature.source.locator}}:{sourceAssistantSeq:feature.assistantSeq,sourceTime:String(feature.sourceTime??'').slice(0,500)})}));
      const offeredRelations=placeRelations.filter(value=>value.placeEntityId===entry.entityId);
      const sourceLocationReference = [];
      for (const reference of (sourceLocationReferencesByPlaceId.get(entry.entityId) ?? []).slice(0, 8)) {
        if (typeof reference !== 'string' || !reference.trim() || reference.length > 500 || sourceLocationCharacters + reference.length > 4000 || sourceLocationReference.includes(reference)) continue;
        sourceLocationReference.push(reference); sourceLocationCharacters += reference.length;
      }
      const manual = manualPlaces.find(value => value.entityId === entry.entityId);
      const pathNames = [entry.displayName], seenParents = new Set([entry.entityId]);
      let ancestor = entry.entityId;
      while (parentEntityIdsByPlaceId.get(ancestor)?.size === 1) {
        ancestor = [...parentEntityIdsByPlaceId.get(ancestor)][0];
        if (seenParents.has(ancestor)) break; seenParents.add(ancestor);
        const parent = places.find(place => place.entityId === ancestor); if (!parent) break;
        pathNames.unshift(parent.displayName);
      }
      const semantic = { ...(manual ? { manualCurrentFacts: { ...(Object.hasOwn(manual, 'description') ? { description: manual.description } : {}), ...(Object.hasOwn(manual, 'relations') ? { relations: manual.relations } : {}), ...(Object.hasOwn(manual,'mapLevel')?{mapLevel:manual.mapLevel}:{}), ...(Object.hasOwn(manual,'mapRole')?{mapRole:manual.mapRole}:{}) } } : {}),
        relations: offeredRelations.map(value => ({ kind: value.kind, text: value.text })), ...(currentDescriptions.length?{description}:{}), entityKey: keyByEntityId.get(entry.entityId), displayName: entry.displayName, pathLabel: pathNames.join(' / '), aliases, entityType: 'place',
        ...(identityAmbiguous ? { identityAmbiguous: true } : {}),
        ownershipStatus: parents?.size === 1 ? 'known' : parents ? 'conflicting' : 'unknown',
        ...(parentPlaceKeys.length ? { parentPlaceKeys } : {}),
        ...(sourceLocationReference.length ? { sourceLocationReference } : {}),
        ...(featureBindings.length ? { features: featureBindings.map(({ itemId, placeEntityId, ...feature }) => feature) } : {}) };
      return {
        entityKey: keyByEntityId.get(entry.entityId),
        entity: entry.entity,
        labels: [entry.displayName, ...aliases],
        featureBindings, currentFactBindings:placeCurrentFactBindings([...offeredFeatures.map(item=>({...item,kind:'feature'})),...offeredRelations.map(item=>({...item,kind:'relation'}))]), semantic,
      };
    });
}
function publicPreviousFloorContext(value, placeCatalogSnapshot) {
  if (!value || typeof value !== 'object') return value ?? null;
  const locationReference = normalizeLocationReference(value.locationReference);
  const result = {
    time: value.time ?? null,
    summaryTail: value.summaryTail ?? null,
    ...(locationReference ? { locationReference } : {}),
    ...(Array.isArray(value.placeNames) && value.placeNames.length ? { placeNames: value.placeNames.slice(0, 8) } : {}),
  };
  const keyByEntityId = new Map(placeCatalogSnapshot.map(entry => [entry.entity.id, entry.entityKey]));
  const placeBindings = (Array.isArray(value.placeBindings) ? value.placeBindings : []).flatMap(binding => {
    const placeKey = keyByEntityId.get(binding?.placeEntityId);
    if (!placeKey) return [];
    return [{ placeKey, name: String(binding.name ?? '').slice(0, 200) }];
  }).slice(0, 8);
  if (placeBindings.length) result.placeBindings = placeBindings;
  return result;
}
function safeIdentity(value) {
  const displayName = typeof value?.displayName === 'string' ? value.displayName.trim().slice(0, 500) : '';
  const aliases = [...new Set([
    displayName,
    ...(Array.isArray(value?.aliases) ? value.aliases : []),
    '你',
    '{{user}}',
  ].filter(item => typeof item === 'string').map(item => item.trim().slice(0, 500)).filter(Boolean))].slice(0, 20);
  return Object.freeze({ displayName, aliases: Object.freeze(aliases) });
}

function safeUserInputSnapshot(value) {
  if (!value || !Array.isArray(value.messages) || !value.messages.length) return null;
  const messages = value.messages.slice(0, 40).map(message => Object.freeze({
    content: String(message?.content ?? ''),
    messageIndex: message?.messageIndex,
    swipeId: message?.swipeId ?? null,
    selectedSwipeIndex: message?.selectedSwipeIndex ?? null,
  }));
  return Object.freeze({ messages: Object.freeze(messages) });
}

function sourceDescriptor(value, path) {
  const sourceType = value?.sourceType;
  const hasIndex = Object.hasOwn(value ?? {}, 'sourceSnapshotIndex');
  if (sourceType === undefined && !hasIndex) return Object.freeze({ sourceType: 'assistant', sourceSnapshotIndex: null, stored: Object.freeze({}) });
  if (!['assistant', 'precedingUser'].includes(sourceType)) throw extractorError('V3_EXTRACTOR_EVIDENCE_SOURCE_INVALID', `${path}.sourceType`);
  if (sourceType === 'assistant') {
    if (hasIndex) throw extractorError('V3_EXTRACTOR_EVIDENCE_SOURCE_INVALID', `${path}.sourceSnapshotIndex`);
    return Object.freeze({ sourceType, sourceSnapshotIndex: null, stored: Object.freeze({ sourceType }) });
  }
  if (!hasIndex || !Number.isSafeInteger(value.sourceSnapshotIndex) || value.sourceSnapshotIndex < 0) throw extractorError('V3_EXTRACTOR_EVIDENCE_SOURCE_INVALID', `${path}.sourceSnapshotIndex`);
  return Object.freeze({ sourceType, sourceSnapshotIndex: value.sourceSnapshotIndex, stored: Object.freeze({ sourceType, sourceSnapshotIndex: value.sourceSnapshotIndex }) });
}

function sourceContentFor({ floor, envelope, value, path }) {
  const descriptor = sourceDescriptor(value, path);
  const bindings = envelope?.scope?.sourceFloorBindings ?? [];
  const requestedKey = typeof value?.sourceFloorKey === 'string' ? value.sourceFloorKey.trim() : '';
  const candidates = bindings.length ? bindings : [{ floorKey: 'floor-1', floorId: floor.id, canonicalContent: floor.content.canonicalContent, sourceUserInputSnapshot: envelope?.scope?.sourceUserInputSnapshot ?? null }];
  const sourceFor = binding => descriptor.sourceType === 'precedingUser'
    ? binding.sourceUserInputSnapshot?.messages?.[descriptor.sourceSnapshotIndex]?.content
    : binding.canonicalContent;
  let matching = requestedKey ? candidates.filter(binding => binding.floorKey === requestedKey) : candidates;
  if (!requestedKey && matching.length > 1) {
    const segments = Array.isArray(value?.quoteSegments) ? value.quoteSegments : [value?.exactText].filter(Boolean);
    matching = matching.filter(binding => {
      const content = sourceFor(binding);
      return typeof content === 'string' && content && segments.length > 0 && segments.every(segment => content.includes(segment));
    });
  }
  if (matching.length !== 1) throw extractorError('V3_EXTRACTOR_EVIDENCE_SOURCE_INVALID', `${path}.sourceFloorKey`);
  const content = sourceFor(matching[0]);
  if (typeof content !== 'string' || !content) throw extractorError('V3_EXTRACTOR_EVIDENCE_SOURCE_INVALID', path);
  return Object.freeze({ ...descriptor, content, floorId: matching[0].floorId, floorKey: matching[0].floorKey });
}

export async function createExtractorEnvelope({ batchId, chatId, narrativeGeneration, checkpointId, floor, sourceFloors = null, entities = [], floorOrder = null, identityProjection = null, userIdentity = null, identityHints = [], storyClock = null, previousStoryClock = null, previousFloorContext = null, sourceUserInputSnapshot = null, sourceVariableReference = null, qianshiCandidates = null, locationReference = undefined, placeWorldbookSources = [] }) {
  const normalizedIdentityProjection = normalizeIdentityProjection(identityProjection ?? {});
  const directory = buildEntityIdentityDirectory({ entities, floorOrder, identityProjection: normalizedIdentityProjection });
  const catalogSnapshot = catalogEntries(directory);
  const normalizedUserIdentity = safeIdentity(userIdentity);
  const normalizedUserInputSnapshot = safeUserInputSnapshot(sourceUserInputSnapshot);
  const placeCatalogSnapshot = placeCatalogEntries(directory, [
    floor.content.canonicalContent, locationReference, previousFloorContext, ...(normalizedUserInputSnapshot?.messages ?? []).map(message => message.content),
    ...(Array.isArray(sourceFloors) ? sourceFloors.flatMap(entry => [entry.floor?.content?.canonicalContent, entry.locationReference, entry.sourceUserInputSnapshot]) : []),
  ], previousFloorContext?.priorityPlaceEntityIds, previousFloorContext?.parentEntityIdsByPlaceId, previousFloorContext?.placeFeatures,
    previousFloorContext?.featurePlaceEntityIds, [floor.content.canonicalContent, ...(Array.isArray(locationReference) ? locationReference : []),
      ...(normalizedUserInputSnapshot?.messages ?? []).map(message => message.content),
      ...(Array.isArray(sourceFloors) ? sourceFloors.flatMap(entry => [entry.floor?.content?.canonicalContent, ...(entry.sourceUserInputSnapshot?.messages ?? []).map(message => message.content)]) : [])], previousFloorContext?.placeSourceLocationReferencesById, previousFloorContext?.manualPlaces, previousFloorContext?.placeRelations);
  const normalizedPreviousFloorContext = publicPreviousFloorContext(previousFloorContext, placeCatalogSnapshot);
  const normalizedVariableReference = copyFloorVariableReference(sourceVariableReference);
  const sourceFloorBindings = (Array.isArray(sourceFloors) && sourceFloors.length ? sourceFloors : [{ floor, sourceUserInputSnapshot, storyClock, ...(locationReference !== undefined ? { locationReference } : {}) }]).map((entry, index) => {
    const hasLocationReference = Object.hasOwn(entry, 'locationReference');
    const locationReference = hasLocationReference ? normalizeLocationReference(entry.locationReference) : undefined;
    return Object.freeze({
      floorKey: `floor-${index + 1}`,
      floorId: entry.floor.id,
      assistantSeq: entry.floor.assistantSeq,
      messageIndex: entry.floor.hostLocator?.messageIndex ?? null,
      canonicalContent: entry.floor.content.canonicalContent,
      rawFingerprint: entry.floor.content.rawFingerprint,
      sourceUserInputSnapshot: safeUserInputSnapshot(entry.sourceUserInputSnapshot),
      storyClock: entry.storyClock ?? null,
      storyClockSignature: String(entry.storyClockSignature ?? ''),
      ...(hasLocationReference ? { locationReference } : {}),
    });
  });
  const anchorBinding = sourceFloorBindings.find(binding => binding.floorId === floor.id);
  if (!anchorBinding) throw extractorError('V3_EXTRACTOR_LOCAL_SCOPE_INVALID', 'sourceFloors');
  const request = Object.freeze({
    task: 'extractFloorSemantics', locale: 'zh-CN',
    payload: {
      canonicalContent: floor.content.canonicalContent,
      precedingUserInput: normalizedUserInputSnapshot?.messages?.map((message, sourceSnapshotIndex) => ({ sourceSnapshotIndex, content: message.content })) ?? [],
      storyClock,
      previousStoryClock,
      previousFloorContext: normalizedPreviousFloorContext,
      ...(sourceFloorBindings.length === 1 && anchorBinding.locationReference ? { locationReference: anchorBinding.locationReference } : {}),
      ...(normalizedVariableReference ? { auxiliaryStateSnapshot: normalizedVariableReference } : {}),
      userIdentity: normalizedUserIdentity,
      knownPeople: catalogSnapshot.map(entry => entry.semantic),
      sourceFloorKey: anchorBinding.floorKey,
      knownPlaces: placeCatalogSnapshot.map(entry => entry.semantic),
      mapStyles: QIANCHUANG_MAP_STYLES,
      ...(placeWorldbookSources.length ? { placeWorldbookSources } : {}),
      identityHints: identityHints.filter(hint => typeof hint === 'string').slice(0, 20).map(hint => hint.slice(0, 500)),
      qianshiCandidates: Array.isArray(qianshiCandidates?.request) ? qianshiCandidates.request : [],
      ...(sourceFloorBindings.length > 1 ? { sourceFloors: sourceFloorBindings.map(binding => ({ floorKey: binding.floorKey, assistantSeq: binding.assistantSeq, messageIndex: binding.messageIndex, canonicalContent: binding.canonicalContent, precedingUserInput: binding.sourceUserInputSnapshot?.messages?.map((message, sourceSnapshotIndex) => ({ sourceSnapshotIndex, content: message.content })) ?? [], storyClock: binding.storyClock, ...(binding.locationReference ? { locationReference: binding.locationReference } : {}) })) } : {}),
    },
  });
  const scope = Object.freeze({
    batchId, chatId, narrativeGeneration, checkpointId: checkpointId ?? null, floorId: floor.id,
    canonicalContentFingerprint: await sha256(String(floor.content.canonicalContent ?? '')),
    rawContentFingerprint: floor.content.rawFingerprint ?? null,
    catalogBindings: Object.freeze(catalogSnapshot.map(entry => Object.freeze({ entityKey: entry.entityKey, entityId: entry.entity.id, entityType: entry.entity.entityType, specialRole: entry.entity.specialRole, labels: entry.labels }))),
    placeCatalogBindings: Object.freeze(placeCatalogSnapshot.map(entry => Object.freeze({ entityKey: entry.entityKey, entityId: entry.entity.id, entityType: entry.entity.entityType, specialRole: entry.entity.specialRole, labels: entry.labels }))),
    placeFeatureBindings: Object.freeze(placeCatalogSnapshot.flatMap(entry => entry.featureBindings ?? []).map(entry => Object.freeze(entry))),
    placeCurrentFactBindings: Object.freeze(placeCatalogSnapshot.flatMap(entry=>entry.currentFactBindings??[])),
    placeIdentityLabels: placeIdentityLabels(directory),
    placeWorldbookSources,
    parentEntityIdsByPlaceId: previousFloorContext?.parentEntityIdsByPlaceId ?? new Map(),
    placeParentFactBindings:previousFloorContext?.placeParentFactBindings??[],
    placeSourceLocationReferencesById: previousFloorContext?.placeSourceLocationReferencesById ?? new Map(),
    identityProjection: normalizedIdentityProjection,
    floorOrder,
    identityFactsByEntityId: Object.freeze(Object.fromEntries(catalogSnapshot.map(entry => [entry.entity.id,
      identityFactBindings(entry.identityBriefSource, entry.entityKey)]))),
    userIdentity: normalizedUserIdentity,
    sourceUserInputSnapshot: normalizedUserInputSnapshot,
    sourceFloorBindings: Object.freeze(sourceFloorBindings),
    sourceFloorRawFingerprints: Object.freeze(Object.fromEntries(sourceFloorBindings.map(binding => [binding.floorId, binding.rawFingerprint]))),
    sourceFloorStoryClockSignatures: Object.freeze(Object.fromEntries(sourceFloorBindings.map(binding => [binding.floorId, binding.storyClockSignature]))),
    sourceFloorLocationReferences: Object.freeze(Object.fromEntries(sourceFloorBindings.filter(binding => Object.hasOwn(binding, 'locationReference')).map(binding => [binding.floorId, binding.locationReference]))),
    sourceVariableReference: normalizedVariableReference,
    qianshiCandidateBindings: Object.freeze(Array.isArray(qianshiCandidates?.bindings) ? qianshiCandidates.bindings : []),
    qianshiCandidateStats: Object.freeze({ count: Number(qianshiCandidates?.stats?.count) || 0, characters: Number(qianshiCandidates?.stats?.characters) || 0 }),
  });
  return Object.freeze({ request, scope });
}

function normalizeMention(raw, catalog) {
  const mentionKey = boundedText(raw.mentionKey, 'entityMentions[].mentionKey', 160); const surface = boundedText(raw.surface, 'entityMentions[].surface', 500);
  if (!ENTITY_TYPES.includes(raw.entityType) || !['existing', 'new', 'uncertain'].includes(raw.identity)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', `entityMentions.${mentionKey}`);
  const aliases = array(raw.aliases, `entityMentions.${mentionKey}.aliases`, 20).map((alias, index) => boundedText(alias, `entityMentions.${mentionKey}.aliases[${index}]`, 500));
  const entityKey = raw.entityKey === null ? null : boundedText(raw.entityKey, `entityMentions.${mentionKey}.entityKey`, 160);
  if (raw.identity === 'existing' && (!entityKey || !catalog.has(entityKey))) throw extractorError('V3_EXTRACTOR_ENTITY_KEY_INVALID', `entityMentions.${mentionKey}.entityKey`);
  if (raw.identity !== 'existing' && entityKey !== null) throw extractorError('V3_EXTRACTOR_ENTITY_KEY_INVALID', `entityMentions.${mentionKey}.entityKey`);
  if (raw.identity === 'existing' && catalog.get(entityKey)?.entityType !== raw.entityType) throw extractorError('V3_EXTRACTOR_ENTITY_TYPE_CONFLICT', `entityMentions.${mentionKey}.entityType`);
  return { mentionKey, surface, aliases: [...new Set(aliases.filter(alias => alias !== surface || (raw.identity === 'existing' && raw.entityType === 'person')))], entityType: raw.entityType, identity: raw.identity, entityKey,
    identityInput: Object.fromEntries(['identityFacts', 'identityBrief', 'identityBriefEvidence', 'identityBriefConflict'].filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])),
    allowPlaceAliasLearning: raw.allowPlaceAliasLearning !== false,
    specialRole: raw.localSpecialRole === 'user' ? 'user' : 'none' };
}

async function normalizeLegacyExtractorResponse({ response, envelope, floor, existingEntities = [], now, supersedes = null, preservedSummary = null, expectedScope = null }) {
  const scope = envelope?.scope;
  const currentContentFingerprint = await sha256(String(floor?.content?.canonicalContent ?? ''));
  if (!scope || scope.floorId !== floor?.id || scope.chatId !== floor?.chatId || scope.narrativeGeneration !== floor?.narrativeGeneration || scope.canonicalContentFingerprint !== currentContentFingerprint) throw extractorError('V3_EXTRACTOR_LOCAL_SCOPE_INVALID', 'localScope');
  if (expectedScope && (scope.batchId !== expectedScope.batchId || scope.chatId !== expectedScope.chatId || scope.narrativeGeneration !== expectedScope.narrativeGeneration || scope.checkpointId !== expectedScope.checkpointId || scope.floorId !== expectedScope.floorId || (expectedScope.rawContentFingerprint !== undefined && scope.rawContentFingerprint !== expectedScope.rawContentFingerprint))) throw extractorError('V3_EXTRACTOR_LOCAL_SCOPE_INVALID', 'localScope');
  if (!Array.isArray(scope.catalogBindings)) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', 'localScope.catalogBindings');
  const sourceUserInputSnapshot = scope.sourceUserInputSnapshot ?? null;
  const sourceVariableReference = copyFloorVariableReference(scope.sourceVariableReference);
  const semanticCatalog = envelope?.request?.payload?.knownPeople;
  if (!Array.isArray(semanticCatalog) || semanticCatalog.length !== scope.catalogBindings.length) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', 'localScope.catalogBindings');
  const semanticPlaces = envelope?.request?.payload?.knownPlaces ?? [];
  const placeBindings = Array.isArray(scope.placeCatalogBindings) ? scope.placeCatalogBindings : [];
  if (!Array.isArray(semanticPlaces) || semanticPlaces.length !== placeBindings.length) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', 'localScope.placeCatalogBindings');
  const identityProjection = normalizeIdentityProjection(scope.identityProjection ?? {});
  const currentDirectory = buildEntityIdentityDirectory({ entities: existingEntities, floorOrder: scope.floorOrder, identityProjection });
  const currentEntityById = new Map(currentDirectory.map(entry => [entry.entityId, entry]));
  const catalog = new Map();
  for (const [index, binding] of scope.catalogBindings.entries()) {
    const current = currentEntityById.get(binding?.entityId);
    if (!binding || typeof binding.entityKey !== 'string' || !isUuid(binding.entityId) || catalog.has(binding.entityKey) || !current
      || binding.entityType !== current.entityType || binding.specialRole !== current.specialRole) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', `localScope.catalogBindings[${index}]`);
    catalog.set(binding.entityKey, current);
  }
  for (const [index, binding] of placeBindings.entries()) {
    const current = currentEntityById.get(binding?.entityId);
    if (!binding || typeof binding.entityKey !== 'string' || !binding.entityKey.startsWith('place-') || !isUuid(binding.entityId)
      || catalog.has(binding.entityKey) || !current || binding.entityType !== 'place' || current.entityType !== 'place'
      || binding.specialRole !== current.specialRole) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', `localScope.placeCatalogBindings[${index}]`);
    catalog.set(binding.entityKey, current);
  }
  const knownFeatureBindings = new Map();
  for (const binding of scope.placeFeatureBindings ?? []) {
    const place = placeBindings.find(entry => entry.entityId === binding.placeEntityId);
    const offered = semanticPlaces.find(entry => entry.entityKey === place?.entityKey)?.features?.find(entry => entry.key === binding.key);
    if (!offered || !isUuid(binding.itemId) || offered.text !== binding.text || offered.sourceAssistantSeq !== binding.sourceAssistantSeq || knownFeatureBindings.has(binding.key)) throw extractorError('V3_EXTRACTOR_LOCAL_CATALOG_INVALID', 'localScope.placeFeatureBindings');
    knownFeatureBindings.set(binding.key, binding);
  }
  const catalogKeyByEntityId = new Map([...catalog].map(([entityKey, entry]) => [entry.entityId, entityKey]));
  const existingEntityById = new Map(existingEntities.map(entity => [entity.id, entity]));
  const manualTargetsByLabel = new Map();
  for (const sourceId of Object.keys(identityProjection.identityRedirectsByEntityId)) {
    const source = existingEntityById.get(sourceId);
    const target = currentEntityById.get(resolveIdentityEntityId(sourceId, identityProjection));
    if (!source || !target || source.entityType !== target.entityType || source.recordStatus === 'superseded' || source.status === 'invalidated') continue;
    for (const label of [source.displayName, ...(source.aliases ?? []).map(alias => alias?.name)]) {
      const key = identityLabelKey(label);
      if (!key) continue;
      const targets = manualTargetsByLabel.get(key) ?? new Map();
      targets.set(target.entityId, target);
      manualTargetsByLabel.set(key, targets);
    }
  }
  const manualMappedTarget = mention => {
    const matches = new Map();
    for (const label of [mention.surface, ...mention.aliases]) {
      for (const target of manualTargetsByLabel.get(identityLabelKey(label))?.values() ?? []) {
        if (target.entityType === mention.entityType) matches.set(target.entityId, target);
      }
    }
    return matches.size === 1 ? [...matches.values()][0] : null;
  };
  assertObject(response, 'response');
  if (response.schemaVersion !== 3 || response.task !== 'extractFloorMemory' || response.promptVersion !== EXTRACTOR_PROMPT_VERSION) throw extractorError('V3_EXTRACTOR_RESPONSE_SCOPE_INVALID', 'response');
  if (!Array.isArray(response.floors) || response.floors.length !== 1) throw extractorError('V3_EXTRACTOR_FLOOR_MISMATCH', 'floors');
  const raw = assertObject(response.floors[0], 'floors[0]');
  const userDisplayName = typeof envelope?.request?.payload?.userIdentity?.displayName === 'string'
    ? envelope.request.payload.userIdentity.displayName.trim()
    : '';
  const generatedText = (value, path, maximum = 4000) => {
    const text = boundedText(value, path, maximum);
    return userDisplayName ? boundedText(text.replaceAll('{{user}}', userDisplayName), path, maximum) : text;
  };
  const summary = generatedText(raw.summary, 'floors[0].summary', 4000);
  const isolated = [];
  const isolate = (field, index, error, fallbackPath = field) => {
    if (isolated.length >= 80) return;
    isolated.push({ field, index, code: String(error?.code ?? 'V3_EXTRACTOR_ITEM_INVALID').slice(0, 120), path: String(error?.validationPath ?? fallbackPath).slice(0, 500) });
  };
  const sourceArray = (field, maximum = field === 'exactAnchors' ? EXACT_ANCHOR_LIMIT : FLOOR_MEMORY_ITEM_LIMIT) => {
    const value = raw[field];
    if (!Array.isArray(value)) {
      isolate(field, -1, extractorError('V3_EXTRACTOR_ARRAY_INVALID', field));
      return [];
    }
    if (value.length > maximum) isolate(field, maximum, extractorError('V3_EXTRACTOR_ARRAY_TRUNCATED', field));
    return value.slice(0, maximum);
  };
  if (!['ok', 'needsReview'].includes(raw.status)) isolate('status', -1, extractorError('V3_EXTRACTOR_ENUM_INVALID', 'floors[0].status'));
  const rawSpatialFacts = raw.spatialFacts && typeof raw.spatialFacts === 'object' && !Array.isArray(raw.spatialFacts) ? raw.spatialFacts : null;
  const spatialPlaceMentionKeys = new Set();
  for (const item of Array.isArray(rawSpatialFacts?.places) ? rawSpatialFacts.places : []) if (typeof item?.placeMentionKey === 'string') spatialPlaceMentionKeys.add(item.placeMentionKey);
  for (const item of Array.isArray(rawSpatialFacts?.containments) ? rawSpatialFacts.containments : []) {
    if (typeof item?.placeMentionKey === 'string') spatialPlaceMentionKeys.add(item.placeMentionKey);
    if (typeof item?.parentMentionKey === 'string') spatialPlaceMentionKeys.add(item.parentMentionKey);
  }
  for (const item of Array.isArray(rawSpatialFacts?.relations) ? rawSpatialFacts.relations : []) {
    if (typeof item?.placeMentionKey === 'string') spatialPlaceMentionKeys.add(item.placeMentionKey);
    for (const key of Array.isArray(item?.referenceMentionKeys) ? item.referenceMentionKeys : []) if (typeof key === 'string') spatialPlaceMentionKeys.add(key);
  }
  for (const item of Array.isArray(rawSpatialFacts?.positions) ? rawSpatialFacts.positions : []) if (typeof item?.placeMentionKey === 'string') spatialPlaceMentionKeys.add(item.placeMentionKey);
  for (const item of Array.isArray(rawSpatialFacts?.features) ? rawSpatialFacts.features : []) if (typeof item?.placeMentionKey === 'string') spatialPlaceMentionKeys.add(item.placeMentionKey);
  const invalidSpatialPlaceMentionKeys = new Set();
  const mentions = new Map();
  for (const [index, item] of sourceArray('entityMentions').entries()) {
    try {
      const path = `entityMentions[${index}]`;
      validateItemCore(item, FLOOR_PROPERTIES.entityMentions.items, path);
      const mentionEvidence = Array.isArray(item.evidence) ? item.evidence : [];
      if (!Array.isArray(item.evidence) && Object.hasOwn(item, 'evidence')) isolate('entityMentions', index, extractorError('V3_EXTRACTOR_EVIDENCE_INVALID', `${path}.evidence`));
      if (mentionEvidence.length > 40) isolate('entityMentions', index, extractorError('V3_EXTRACTOR_EVIDENCE_TRUNCATED', `${path}.evidence`));
      const evidenceSources = []; let hasLocatedEvidence = false;
      for (const [evidenceIndex, evidenceItem] of mentionEvidence.slice(0, 40).entries()) {
        try {
          assertObject(evidenceItem, `${path}.evidence[${evidenceIndex}]`);
          const source = sourceContentFor({ floor, envelope, value: evidenceItem, path: `${path}.evidence[${evidenceIndex}]` });
          compileEvidenceSegments(source.content, evidenceItem.quoteSegments, `${path}.evidence[${evidenceIndex}].quoteSegments`);
          boundedText(evidenceItem.supports, `${path}.evidence[${evidenceIndex}].supports`, 2000);
          if (!['explicit', 'witnessed', 'reported', 'privateCognition'].includes(evidenceItem.evidenceMode)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', `${path}.evidence[${evidenceIndex}].evidenceMode`);
          validateItemSchema(evidenceItem.sourceMentionKey, NULLABLE_MENTION_KEY, `${path}.evidence[${evidenceIndex}].sourceMentionKey`);
          if (evidenceItem.sourceMentionKey !== null) evidenceSources.push({ mentionKey: evidenceItem.sourceMentionKey, evidenceIndex });
          hasLocatedEvidence = true;
        } catch (error) { isolate('entityMentions', index, error, `${path}.evidence[${evidenceIndex}]`); }
      }
      if (item.entityType === 'place' && spatialPlaceMentionKeys.has(item.mentionKey) && !hasLocatedEvidence) {
        invalidSpatialPlaceMentionKeys.add(item.mentionKey);
        isolate('entityMentions', index, extractorError('V3_EXTRACTOR_SPATIAL_EVIDENCE_REQUIRED', `${path}.evidence`)); continue;
      }
      const mention = normalizeMention(item, catalog);
      if (mention.identity !== 'existing' && mention.entityType !== 'place') {
        const mapped = manualMappedTarget(mention);
        const entityKey = mapped ? catalogKeyByEntityId.get(mapped.entityId) : null;
        if (mapped && entityKey) {
          mention.identity = 'existing';
          mention.entityKey = entityKey;
          mention.specialRole = mapped.specialRole;
        }
      }
      mention.index = index;
      mention.evidenceSources = evidenceSources;
      if (mentions.has(mention.mentionKey)) throw extractorError('V3_EXTRACTOR_MENTION_DUPLICATE', `${path}.mentionKey`);
      mentions.set(mention.mentionKey, mention);
      if (mention.identity === 'uncertain') isolate('entityMentions', index, extractorError('V3_EXTRACTOR_ENTITY_UNRESOLVED', `${path}.identity`));
    } catch (error) { isolate('entityMentions', index, error, `entityMentions[${index}]`); }
  }
  for (const mention of mentions.values()) {
    for (const source of mention.evidenceSources) {
      const referenced = mentions.get(source.mentionKey);
      const sourcePath = `entityMentions[${mention.index}].evidence[${source.evidenceIndex}].sourceMentionKey`;
      if (!referenced) isolate('entityMentions', mention.index, extractorError('V3_EXTRACTOR_ENTITY_POINTER_INVALID', sourcePath));
      else if (referenced.identity === 'uncertain') isolate('entityMentions', mention.index, extractorError('V3_EXTRACTOR_ENTITY_UNRESOLVED', sourcePath));
    }
  }
  const newEntities = [];
  for (const mention of mentions.values()) {
    if (mention.identity !== 'new') continue;
    const entityId = mention.specialRole === 'user'
      ? await deterministicUuid(['v3-entity-special-user', floor.chatId, floor.narrativeGeneration, floor.id, expectedScope.batchId])
      : await deterministicUuid(['v3-entity', floor.chatId, floor.narrativeGeneration, floor.id, expectedScope.batchId, mention.entityType,
        mention.surface.normalize('NFKC').toLocaleLowerCase(), ...(mention.entityType === 'place' ? [mention.mentionKey] : [])]);
    const entity = validateEntityRecord({
      schemaVersion: 3, recordType: 'entity', id: entityId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration,
      entityType: mention.entityType, displayName: mention.surface, aliases: mention.aliases.map(name => ({ name, normalized: name.normalize('NFKC').toLocaleLowerCase(), kind: 'uncertain', evidenceRefs: [], baselineClaimIds: [] })), specialRole: mention.specialRole, firstSeenFloorId: floor.id, lastSeenFloorId: floor.id,
      status: 'provisional', mergedIntoEntityId: null, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null,
    }, { expectedChatId: floor.chatId });
    newEntities.push(entity); mention.resolvedEntityId = entityId;
  }
  for (const mention of mentions.values()) if (mention.identity === 'existing') mention.resolvedEntityId = catalog.get(mention.entityKey).entityId;
  const invalidIdentityTargets = new Set();
  for (const mention of mentions.values()) {
    if (mention.entityType !== 'person' || mention.specialRole === 'user' || mention.identity === 'uncertain') continue;
    try {
      if (mention.identityInput.identityBriefConflict) throw new TypeError('identityFacts.conflict');
      const facts = compileIdentityFacts({ raw: mention.identityInput,
        existingFacts: scope.identityFactsByEntityId?.[mention.resolvedEntityId] ?? {}, legacyEvidence: mention.identityInput.identityBriefEvidence,
        compileEvidence(raw) {
          if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new TypeError('identityFacts.evidence');
          return raw.flatMap((ref, index) => {
            const path = `entityMentions[${mention.index}].identityFacts.evidence[${index}]`;
            validateItemSchema(ref, EVIDENCE, path);
            const source = sourceContentFor({ floor, envelope, value: ref, path });
            const located = compileEvidenceSegments(source.content, ref.quoteSegments, `${path}.quoteSegments`);
            const sourceEntityId = ref.sourceMentionKey === null ? null : mentions.get(ref.sourceMentionKey)?.resolvedEntityId;
            if (sourceEntityId === undefined) throw new TypeError('identityFacts.sourceMentionKey');
            return located.map(segment => ({ source: source.sourceType === 'precedingUser' ? 'currentUserInput' : 'canonicalContent',
              kind: source.sourceType === 'precedingUser' ? 'userInput' : 'story', floorId: source.floorId, quotedText: segment.quotedText,
              occurrence: segment.occurrence, evidenceMode: ref.evidenceMode, supports: boundedText(ref.supports, `${path}.supports`, 2000), sourceEntityId, ...source.stored }));
          });
        } });
      if (!facts) continue;
      mention.identityBrief = identityFactsText(facts);
      mention.identityBriefSource = { sourceFloorId: floor.id, origin: 'extractor', facts };
      if (mention.identity === 'new') {
        const index = newEntities.findIndex(entity => entity.id === mention.resolvedEntityId);
        newEntities[index] = validateEntityRecord({ ...newEntities[index], identityBrief: mention.identityBrief, identityBriefSource: mention.identityBriefSource }, { expectedChatId: floor.chatId });
      }
    } catch (error) {
      if (mention.identity === 'existing') invalidIdentityTargets.add(mention.resolvedEntityId);
      isolate('identityBrief', mention.index, extractorError('V3_EXTRACTOR_IDENTITY_BRIEF_INVALID', error.validationPath ?? 'identityFacts'));
    }
  }
  const learnedLabels = new Map();
  for (const mention of mentions.values()) {
    if (mention.identity !== 'existing' || mention.entityType === 'place' && !mention.allowPlaceAliasLearning) continue;
    const target = catalog.get(mention.entityKey);
    const known = new Set([...(target?.labels ?? []), ...(learnedLabels.get(target.entityId) ?? [])].map(identityLabelKey));
    const additions = [];
    for (const label of mention.entityType === 'person' ? mention.aliases : [mention.surface, ...mention.aliases]) {
      const key = identityLabelKey(label);
      if (!key || known.has(key)) continue;
      known.add(key); additions.push(label);
    }
    if (!additions.length) continue;
    learnedLabels.set(target.entityId, [...(learnedLabels.get(target.entityId) ?? []), ...additions]);
  }
  const identityBriefCandidates = new Map();
  for (const mention of mentions.values()) {
    if (mention.identity !== 'existing' || mention.entityType !== 'person' || !mention.identityBrief || invalidIdentityTargets.has(mention.resolvedEntityId)) continue;
    const target = catalog.get(mention.entityKey);
    if (!target || sameIdentityFacts(target.identityBriefSource?.facts, mention.identityBriefSource.facts)) continue;
    const values = identityBriefCandidates.get(target.entityId) ?? new Map();
    values.set(JSON.stringify(mention.identityBriefSource.facts), mention); identityBriefCandidates.set(target.entityId, values);
  }
  const updateTargetIds = new Set([...learnedLabels.keys(), ...identityBriefCandidates.keys()]);
  for (const targetId of updateTargetIds) {
    const labels = learnedLabels.get(targetId) ?? [];
    const target = currentEntityById.get(targetId)?.entity;
    if (!target) continue;
    const briefValues = identityBriefCandidates.get(targetId);
    const briefCandidate = briefValues?.size === 1 ? [...briefValues.values()][0] : null;
    const identityBrief = briefCandidate?.identityBrief;
    if (!labels.length && !identityBrief) continue;
    const storedLabels = labels.slice(0, 81);
    const normalizedLabels = storedLabels.map(identityLabelKey).sort();
    const entityId = identityBrief
      ? await deterministicUuid(['v3-entity-identity-update', target.id, floor.id, expectedScope.batchId, normalizedLabels, briefCandidate.identityBriefSource])
      : await deterministicUuid(['v3-entity-merged-alias', target.id, floor.id, expectedScope.batchId, normalizedLabels]);
    newEntities.push(validateEntityRecord({
      schemaVersion: 3, recordType: 'entity', id: entityId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration,
      entityType: target.entityType, displayName: storedLabels[0] ?? target.displayName, aliases: storedLabels.slice(1).map(name => ({ name, normalized: identityLabelKey(name), kind: 'uncertain', evidenceRefs: [], baselineClaimIds: [] })), specialRole: target.specialRole, firstSeenFloorId: floor.id, lastSeenFloorId: floor.id,
      ...(identityBrief ? { identityBrief, identityBriefSource: briefCandidate.identityBriefSource } : {}),
      status: 'merged', mergedIntoEntityId: target.id, mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null,
    }, { expectedChatId: floor.chatId }));
  }
  const pointer = (value, path, { nullable = false } = {}) => {
    if (value === null && nullable) return null;
    const mentionKey = boundedText(value, path, 160);
    const mention = mentions.get(mentionKey);
    if (!mention) throw extractorError('V3_EXTRACTOR_ENTITY_POINTER_INVALID', path);
    if (!mention.resolvedEntityId) throw extractorError('V3_EXTRACTOR_ENTITY_UNRESOLVED', path);
    return mention.resolvedEntityId;
  };
  const locationEntityPointer = (value, path) => value !== null && invalidSpatialPlaceMentionKeys.has(value)
    ? null : pointer(value, path, { nullable: true });
  const evidence = (value, path, { required = true, issueField = path, ownerIndex = null } = {}) => {
    const result = [];
    if (!Array.isArray(value)) {
      const error = extractorError('V3_EXTRACTOR_EVIDENCE_INVALID', path); isolate(issueField, ownerIndex ?? -1, error);
      if (required) throw extractorError('V3_EXTRACTOR_EVIDENCE_REQUIRED', path);
      return result;
    }
    if (value.length > 40) isolate(issueField, ownerIndex ?? 40, extractorError('V3_EXTRACTOR_EVIDENCE_TRUNCATED', path));
    for (const [index, item] of value.slice(0, 40).entries()) {
      const itemPath = `${path}[${index}]`;
      try {
        assertObject(item, itemPath);
        const source = sourceContentFor({ floor, envelope, value: item, path: itemPath });
        const located = compileEvidenceSegments(source.content, item.quoteSegments, `${itemPath}.quoteSegments`);
        if (!['explicit', 'witnessed', 'reported', 'privateCognition'].includes(item.evidenceMode)) throw extractorError('V3_EXTRACTOR_SCHEMA_INVALID', `${itemPath}.evidenceMode`);
        const supports = generatedText(item.supports, `${itemPath}.supports`, 2000);
        const sourceEntityId = pointer(item.sourceMentionKey, `${itemPath}.sourceMentionKey`, { nullable: true });
        if (result.length + located.length > EVIDENCE_REF_LIMIT) throw extractorError('V3_EXTRACTOR_EVIDENCE_REFS_TRUNCATED', itemPath);
        result.push(...located.map(segment => ({ floorId: source.floorId, anchorId: null, quotedText: segment.quotedText, occurrence: segment.occurrence, evidenceMode: item.evidenceMode, supports, sourceEntityId, ...source.stored })));
      } catch (error) { isolate(issueField, ownerIndex ?? index, error, itemPath); }
    }
    if (required && !result.length) throw extractorError('V3_EXTRACTOR_EVIDENCE_REQUIRED', path);
    return result;
  };
  const summaryEvidenceRefs = evidence(raw.summaryEvidence, 'summaryEvidence', { required: false, issueField: 'summaryEvidence' });
  let sequence = 0;
  const itemId = async (field, item) => deterministicUuid(['v3-floor-memory-item', floor.id, field, sequence += 1, item]);
  const convert = async (field, mapper) => {
    const result = [];
    for (const [index, item] of sourceArray(field).entries()) {
      try { validateItemCore(item, FLOOR_PROPERTIES[field].items, `${field}[${index}]`); result.push(await mapper(item, index)); }
      catch (error) { isolate(field, index, error, `${field}[${index}]`); }
    }
    return result;
  };
  const optionalEvidence = (item, path) => evidence(item.evidence, path, { required: false });
  const chronology = await convert('chronology', async item => ({ itemId: await itemId('chronology', item), time: { ...item.time, relativeToFloorId: null }, description: generatedText(item.description, 'chronology.description', 2000), evidenceRefs: optionalEvidence(item, 'chronology.evidence') }));
  const locations = await convert('locations', async item => ({ itemId: await itemId('locations', item), entityId: locationEntityPointer(item.entityMentionKey, 'locations.entityMentionKey'), name: boundedText(item.name, 'locations.name', 500), change: item.change, participantEntityIds: array(item.participantMentionKeys, 'locations.participantMentionKeys', 40).map((key, i) => pointer(key, `locations.participantMentionKeys[${i}]`)), evidenceRefs: optionalEvidence(item, 'locations.evidence') }));
  let spatialFacts;
  if (raw.spatialFacts !== undefined) {
    try {
      assertObject(raw.spatialFacts, 'spatialFacts');
      const spatialInput = raw.spatialFacts;
      const readSpatialArray = field => {
        if (['features', 'relations'].includes(field) && spatialInput[field] === undefined) return [];
        if (!Array.isArray(spatialInput[field])) { isolate(`spatialFacts.${field}`, -1, extractorError('V3_EXTRACTOR_ARRAY_INVALID', `spatialFacts.${field}`)); return []; }
        if (spatialInput[field].length > SPATIAL_FACT_LIMIT) isolate(`spatialFacts.${field}`, SPATIAL_FACT_LIMIT, extractorError('V3_EXTRACTOR_ARRAY_TRUNCATED', `spatialFacts.${field}`));
        return spatialInput[field].slice(0, SPATIAL_FACT_LIMIT);
      };
      const facts = { schemaVersion: 1, containments: [], positions: [] };
      const placePointer = (key, path) => {
        const mention = mentions.get(boundedText(key, path, 160));
        if (!mention || mention.entityType !== 'place' || !mention.resolvedEntityId) throw extractorError('V3_EXTRACTOR_SPATIAL_PLACE_POINTER_INVALID', path);
        return mention.resolvedEntityId;
      };
      for (const [index, item] of readSpatialArray('containments').entries()) {
        try {
          validateItemSchema(item, { type: 'object', required: ['placeMentionKey', 'parentMentionKey', 'evidence'], properties: { placeMentionKey: MENTION_KEY, parentMentionKey: NULLABLE_MENTION_KEY, identityChange:{type:'string',enum:['ownershipChanged']}, evidence: evidenceArray }, additionalProperties: false }, `spatialFacts.containments[${index}]`);
          const placeEntityId = placePointer(item.placeMentionKey, `spatialFacts.containments[${index}].placeMentionKey`);
          const revision=item.identityChange==='ownershipChanged';
          const parentEntityId = item.parentMentionKey===null&&revision?null:placePointer(item.parentMentionKey, `spatialFacts.containments[${index}].parentMentionKey`);
          if(revision&&!(envelope.scope.placeCatalogBindings??[]).some(binding=>binding.entityId===placeEntityId))throw extractorError('V3_EXTRACTOR_SPATIAL_PLACE_POINTER_INVALID', `spatialFacts.containments[${index}]`);
          if (placeEntityId === parentEntityId) throw extractorError('V3_EXTRACTOR_SPATIAL_CYCLE', `spatialFacts.containments[${index}]`);
          const evidenceRefs = evidence(item.evidence, `spatialFacts.containments[${index}].evidence`, { required: true, issueField: 'spatialFacts.containments', ownerIndex: index });
          if (!evidenceRefs.length || evidenceRefs.some(ref => ref.evidenceMode === 'privateCognition')) throw extractorError('V3_EXTRACTOR_SPATIAL_EVIDENCE_INVALID', `spatialFacts.containments[${index}].evidence`);
          const id=await itemId('spatialFacts.containments',item);
          const prior=(envelope.scope.placeParentFactBindings??[]).filter(fact=>fact.placeEntityId===placeEntityId);
          facts.containments.push({itemId:id,placeEntityId,parentEntityId,evidenceRefs,...(revision?{identityChange:'ownershipChanged',replacesItemIds:[...new Set(prior.flatMap(fact=>[fact.itemId,...(fact.replacesItemIds??[])]))].filter(value=>value!==id)}:{})});
        } catch (error) { isolate('spatialFacts.containments', index, error, `spatialFacts.containments[${index}]`); }
      }
      const edgesByFloor = new Map();
      for (const item of facts.containments) for (const sourceFloorId of new Set(item.evidenceRefs.map(ref => ref.floorId))) {
        const edges = edgesByFloor.get(sourceFloorId) ?? []; edges.push(item); edgesByFloor.set(sourceFloorId, edges);
      }
      const invalidParentsByFloor = new Map(), selectedParentsByFloor = new Map();
      for (const [sourceFloorId, edges] of edgesByFloor) {
        const { rejected: invalid, updates } = resolvePlaceParentBatch(edges);
        selectedParentsByFloor.set(sourceFloorId, updates);
        if (invalid.size) { invalidParentsByFloor.set(sourceFloorId, invalid); isolate('spatialFacts.containments', -1, extractorError('V3_EXTRACTOR_SPATIAL_CONFLICT', 'spatialFacts.containments')); }
      }
      facts.containments = facts.containments.flatMap(item => { const evidenceRefs = item.evidenceRefs.filter(ref => !invalidParentsByFloor.get(ref.floorId)?.has(item.placeEntityId)
        && (item.parentEntityId === null ? selectedParentsByFloor.get(ref.floorId)?.get(item.placeEntityId)?.cleared : selectedParentsByFloor.get(ref.floorId)?.get(item.placeEntityId)?.parents.has(item.parentEntityId))); return evidenceRefs.length ? [{ ...item, evidenceRefs }] : []; });
      const relations = [];
      for (const [index, item] of readSpatialArray('relations').entries()) {
        try {
          const path = `spatialFacts.relations[${index}]`;
          validateItemSchema(item, { type: 'object', required: ['kind', 'placeMentionKey', 'referenceMentionKeys', 'text', 'evidence'], properties: { kind: { type: 'string', enum: ['locatedIn', 'onFloor', 'relative'] }, placeMentionKey: MENTION_KEY, referenceMentionKeys: { type: 'array', maxItems: 2, items: MENTION_KEY }, text: { type: 'string' }, evidence: evidenceArray }, additionalProperties: false }, path);
          const placeEntityId = placePointer(item.placeMentionKey, `${path}.placeMentionKey`);
          const referencePlaceEntityIds = item.referenceMentionKeys.map(key => placePointer(key, `${path}.referenceMentionKeys`));
          if (new Set(referencePlaceEntityIds).size !== referencePlaceEntityIds.length || referencePlaceEntityIds.includes(placeEntityId)
            || item.kind === 'locatedIn' && referencePlaceEntityIds.length !== 1 || item.kind === 'onFloor' && referencePlaceEntityIds.length > 1) throw extractorError('V3_EXTRACTOR_SPATIAL_RELATION_INVALID', path);
          const evidenceRefs = evidence(item.evidence, `${path}.evidence`, { required: true, issueField: 'spatialFacts.relations', ownerIndex: index });
          if (!evidenceRefs.length || evidenceRefs.some(ref => ['privateCognition', 'interpretation'].includes(ref.evidenceMode))) throw extractorError('V3_EXTRACTOR_SPATIAL_EVIDENCE_INVALID', path);
          relations.push({ itemId: await itemId('spatialFacts.relations', item), kind: item.kind, placeEntityId, referencePlaceEntityIds, text: generatedText(item.text, `${path}.text`, 1000), evidenceRefs });
        } catch (error) { isolate('spatialFacts.relations', index, error, `spatialFacts.relations[${index}]`); }
      }
      if (relations.length) facts.relations = relations;
      const positions = [];
      for (const [index, item] of readSpatialArray('positions').entries()) {
        try {
          validateItemSchema(item, { type: 'object', required: ['subjectMentionKey', 'placeMentionKey', 'status', 'evidence'], properties: { subjectMentionKey: MENTION_KEY, placeMentionKey: NULLABLE_MENTION_KEY, status: { type: 'string', enum: ['confirmed', 'lastSeen', 'leftUnknown'] }, evidence: evidenceArray }, additionalProperties: false }, `spatialFacts.positions[${index}]`);
          const subjectEntityId = pointer(item.subjectMentionKey, `spatialFacts.positions[${index}].subjectMentionKey`);
          if (!['person', 'group'].includes(mentions.get(item.subjectMentionKey)?.entityType)) throw extractorError('V3_EXTRACTOR_SPATIAL_SUBJECT_TYPE_INVALID', `spatialFacts.positions[${index}].subjectMentionKey`);
          const placeEntityId = item.placeMentionKey === null ? null : placePointer(item.placeMentionKey, `spatialFacts.positions[${index}].placeMentionKey`);
          if (item.status !== 'leftUnknown' && !placeEntityId) throw extractorError('V3_EXTRACTOR_SPATIAL_PLACE_POINTER_INVALID', `spatialFacts.positions[${index}].placeMentionKey`);
          const evidenceRefs = evidence(item.evidence, `spatialFacts.positions[${index}].evidence`, { required: true, issueField: 'spatialFacts.positions', ownerIndex: index });
          if (!evidenceRefs.length || evidenceRefs.some(ref => ref.evidenceMode === 'privateCognition')) throw extractorError('V3_EXTRACTOR_SPATIAL_EVIDENCE_INVALID', `spatialFacts.positions[${index}].evidence`);
          positions.push({ itemId: await itemId('spatialFacts.positions', item), subjectEntityId, placeEntityId, status: item.status, evidenceRefs });
        } catch (error) { isolate('spatialFacts.positions', index, error, `spatialFacts.positions[${index}]`); }
      }
      const positionsByFloorSubject = new Map();
      for (const item of positions) for (const sourceFloorId of new Set(item.evidenceRefs.map(ref => ref.floorId))) { const key = `${sourceFloorId}|${item.subjectEntityId}`, rows = positionsByFloorSubject.get(key) ?? []; rows.push(item); positionsByFloorSubject.set(key, rows); }
      const invalidPositions = new Set([...positionsByFloorSubject].filter(([, rows]) => new Set(rows.map(row => JSON.stringify([row.placeEntityId, row.status]))).size > 1).map(([key]) => key));
      if (invalidPositions.size) isolate('spatialFacts.positions', -1, extractorError('V3_EXTRACTOR_SPATIAL_POSITION_CONFLICT', 'spatialFacts.positions'));
      facts.positions = positions.flatMap(item => { const evidenceRefs = item.evidenceRefs.filter(ref => !invalidPositions.has(`${ref.floorId}|${item.subjectEntityId}`)); return evidenceRefs.length ? [{ ...item, evidenceRefs }] : []; });
      const featureRows = [], featureKeys = new Map();
      const featureInput = readSpatialArray('features');
      const duplicateFeatureKeys = new Set(featureInput.filter((item, index) => featureInput.findIndex(other => other?.key === item?.key) !== index).map(item => item?.key));
      for (const [index, item] of featureInput.entries()) {
        try {
          const path = `spatialFacts.features[${index}]`;
          validateItemSchema(item, { type: 'object', required: ['key', 'placeMentionKey', 'text', 'replacesKeys', 'evidence'], properties: { key: { type: 'string' }, placeMentionKey: MENTION_KEY, kind: { type: 'string', enum: ['stable', 'temporary'] }, text: { type: 'string' }, replacesKeys: { type: 'array', maxItems: 40, items: { type: 'string' } }, evidence: evidenceArray }, additionalProperties: false }, path);
          if (!/^feature-[1-9]\d*$/u.test(item.key) || duplicateFeatureKeys.has(item.key)) throw extractorError('V3_EXTRACTOR_SPATIAL_FEATURE_KEY_INVALID', path);
          const placeEntityId = placePointer(item.placeMentionKey, path);
          const evidenceRefs = evidence(item.evidence, `${path}.evidence`, { required: true, issueField: 'spatialFacts.features', ownerIndex: index });
          if (!evidenceRefs.length || evidenceRefs.some(ref => ['privateCognition', 'interpretation'].includes(ref.evidenceMode))) throw extractorError('V3_EXTRACTOR_SPATIAL_EVIDENCE_INVALID', path);
          const seqByFloor = new Map((scope.sourceFloorBindings ?? []).map(source => [source.floorId, source.assistantSeq]));
          seqByFloor.set(floor.id, floor.assistantSeq);
          const row = { item, index, itemId: await itemId('spatialFacts.features', item), placeEntityId, ...(Object.hasOwn(item, 'kind') ? { kind: item.kind } : {}), text: generatedText(item.text, `${path}.text`, 1000), evidenceRefs, seq: Math.max(...evidenceRefs.map(ref => seqByFloor.get(ref.floorId) ?? 0)) };
          featureRows.push(row); featureKeys.set(item.key, row);
        } catch (error) { isolate('spatialFacts.features', index, error, `spatialFacts.features[${index}]`); }
      }
      const validFeatures = new Map();
      for (const row of [...featureRows].sort((a, b) => a.seq - b.seq || a.index - b.index)) {
        try {
          if (row.kind === 'temporary' && row.item.replacesKeys.length) throw extractorError('V3_EXTRACTOR_SPATIAL_FEATURE_REPLACEMENT_INVALID', `spatialFacts.features[${row.index}].replacesKeys`);
          const replacesItemIds = [...new Set(row.item.replacesKeys)].map(key => {
            const known = knownFeatureBindings.get(key), local = featureKeys.get(key), target = known ?? local;
            const targetSeq = known?.sourceAssistantSeq ?? local?.seq;
            if (!target || target.placeEntityId !== row.placeEntityId || row.kind === 'stable' && local?.kind === 'temporary' || (known ? targetSeq >= row.seq : !(targetSeq < row.seq || targetSeq === row.seq && target.index < row.index)) || local && !validFeatures.has(local.item.key)) throw extractorError('V3_EXTRACTOR_SPATIAL_FEATURE_REPLACEMENT_INVALID', `spatialFacts.features[${row.index}].replacesKeys`);
            return target.itemId;
          });
          validFeatures.set(row.item.key, { itemId: row.itemId, placeEntityId: row.placeEntityId, ...(Object.hasOwn(row, 'kind') ? { kind: row.kind } : {}), text: row.text, replacesItemIds, evidenceRefs: row.evidenceRefs });
        } catch (error) { isolate('spatialFacts.features', row.index, error, `spatialFacts.features[${row.index}]`); }
      }
      if (validFeatures.size) facts.features = [...validFeatures.values()];
      if (facts.containments.length || facts.positions.length || facts.features?.length || facts.relations?.length) spatialFacts = facts;
    } catch (error) { isolate('spatialFacts', -1, error, 'spatialFacts'); }
  }
  const participants = await convert('participants', async item => ({ entityId: pointer(item.mentionKey, 'participants.mentionKey'), presence: item.presence, evidenceRefs: optionalEvidence(item, 'participants.evidence') }));
  const actions = await convert('actions', async item => ({ itemId: await itemId('actions', item), actorEntityId: pointer(item.actorMentionKey, 'actions.actorMentionKey'), targetEntityIds: array(item.targetMentionKeys, 'actions.targetMentionKeys', 40).map((key, i) => pointer(key, `actions.targetMentionKeys[${i}]`)), action: generatedText(item.action, 'actions.action', 2000), completion: item.completion, result: item.result === null ? null : generatedText(item.result, 'actions.result', 2000), evidenceRefs: optionalEvidence(item, 'actions.evidence') }));
  const observations = await convert('observations', async item => ({ itemId: await itemId('observations', item), subjectEntityId: pointer(item.subjectMentionKey, 'observations.subjectMentionKey', { nullable: true }), kind: item.kind, description: generatedText(item.description, 'observations.description', 2000), evidenceRefs: optionalEvidence(item, 'observations.evidence') }));
  const informationTransfers = await convert('informationTransfers', async item => ({ itemId: await itemId('informationTransfers', item), fromEntityId: pointer(item.fromMentionKey, 'informationTransfers.fromMentionKey', { nullable: true }), toEntityIds: array(item.toMentionKeys, 'informationTransfers.toMentionKeys', 40).map((key, i) => pointer(key, `informationTransfers.toMentionKeys[${i}]`)), claimText: generatedText(item.claimText, 'informationTransfers.claimText', 2000), channel: item.channel, evidenceRefs: optionalEvidence(item, 'informationTransfers.evidence') }));
  const privateCognition = await convert('privateCognition', async item => ({ itemId: await itemId('privateCognition', item), ownerEntityId: pointer(item.ownerMentionKey, 'privateCognition.ownerMentionKey'), kind: item.kind, content: generatedText(item.content, 'privateCognition.content', 2000), expressedPublicly: false, evidenceRefs: optionalEvidence(item, 'privateCognition.evidence') }));
  const anchorOccurrences = new Map();
  const exactAnchors = await convert('exactAnchors', async item => {
    const exactText = boundedLiteralText(item.exactText, 'exactAnchors.exactText', 2000);
    const source = sourceContentFor({ floor, envelope, value: item, path: 'exactAnchors' });
    const occurrenceKey = JSON.stringify([source.floorId, source.sourceType, source.sourceSnapshotIndex, exactText]);
    const nextOccurrence = (anchorOccurrences.get(occurrenceKey) ?? 0) + 1;
    anchorOccurrences.set(occurrenceKey, nextOccurrence);
    if (occurrence(source.content, exactText) < nextOccurrence) throw extractorError('V3_EXTRACTOR_ANCHOR_OCCURRENCE_INVALID', 'exactAnchors.exactText');
    return { anchorId: await deterministicUuid(['v3-anchor', source.floorId, source.sourceType, source.sourceSnapshotIndex, item.kind, exactText, nextOccurrence]), kind: item.kind, exactText, occurrence: nextOccurrence, speakerEntityId: pointer(item.speakerMentionKey, 'exactAnchors.speakerMentionKey', { nullable: true }), whyPreserve: generatedText(item.whyPreserve, 'exactAnchors.whyPreserve', 1000), ...(source.floorId !== floor.id ? { sourceFloorId: source.floorId } : {}), ...source.stored };
  });
  const anchorByText = new Map();
  const anchorSourceKey = (sourceFloorId, sourceType, sourceSnapshotIndex, exactText) => JSON.stringify([sourceFloorId ?? floor.id, sourceType ?? 'assistant', sourceSnapshotIndex ?? null, exactText]);
  for (const anchor of exactAnchors) {
    const key = anchorSourceKey(anchor.sourceFloorId, anchor.sourceType, anchor.sourceSnapshotIndex, anchor.exactText);
    anchorByText.set(key, [...(anchorByText.get(key) ?? []), anchor.anchorId]);
  }
  const commitmentAnchorOffsets = new Map();
  const commitments = await convert('commitments', async (item, index) => {
    const exactText = item.exactText === null ? null : boundedLiteralText(item.exactText, 'commitments.exactText', 2000);
    let exactAnchorId = null;
    if (exactText) {
      const evidenceSource = Array.isArray(item.evidence) && item.evidence.length ? sourceContentFor({ floor, envelope, value: item.evidence[0], path: `commitments[${index}].evidence[0]` }) : sourceContentFor({ floor, envelope, value: {}, path: `commitments[${index}]` });
      const key = anchorSourceKey(evidenceSource.floorId, evidenceSource.sourceType, evidenceSource.sourceSnapshotIndex, exactText);
      const anchorOffset = commitmentAnchorOffsets.get(key) ?? 0;
      commitmentAnchorOffsets.set(key, anchorOffset + 1);
      exactAnchorId = evidenceSource.content.includes(exactText) ? (anchorByText.get(key)?.[anchorOffset] ?? null) : null;
      if (!exactAnchorId) isolate('commitments', index, extractorError('V3_EXTRACTOR_ANCHOR_NOT_FOUND', `commitments[${index}].exactText`));
    }
    return { itemId: await itemId('commitments', item), speakerEntityId: pointer(item.speakerMentionKey, 'commitments.speakerMentionKey'), targetEntityIds: array(item.targetMentionKeys, 'commitments.targetMentionKeys', 40).map((key, i) => pointer(key, `commitments.targetMentionKeys[${i}]`)), kind: item.kind, content: generatedText(item.content, 'commitments.content', 2000), status: item.status, exactAnchorId, evidenceRefs: optionalEvidence(item, 'commitments.evidence') };
  });
  const eventFragments = await convert('eventFragments', async item => ({ itemId: await itemId('eventFragments', item), title: generatedText(item.title, 'eventFragments.title', 500), description: generatedText(item.description, 'eventFragments.description', 2000), candidateStatus: 'candidate', eventId: null, evidenceRefs: optionalEvidence(item, 'eventFragments.evidence') }));
  const openLoops = await convert('openLoops', async item => ({ itemId: await itemId('openLoops', item), description: generatedText(item.description, 'openLoops.description', 2000), ownerEntityIds: array(item.ownerMentionKeys, 'openLoops.ownerMentionKeys', 40).map((key, i) => pointer(key, `openLoops.ownerMentionKeys[${i}]`)), candidateThreadId: null, evidenceRefs: optionalEvidence(item, 'openLoops.evidence') }));
  const ambiguities = await convert('ambiguities', async item => ({ itemId: await itemId('ambiguities', item), question: generatedText(item.question, 'ambiguities.question', 2000), possibleReadings: array(item.possibleReadings, 'ambiguities.possibleReadings', 12).map((reading, i) => generatedText(reading, `ambiguities.possibleReadings[${i}]`, 1000)), evidenceRefs: evidence(item.evidence, 'ambiguities.evidence', { required: false }) }));
  const cseSignals = await convert('cseSignals', async item => ({ itemId: await itemId('cseSignals', item), subjectEntityId: pointer(item.subjectMentionKey, 'cseSignals.subjectMentionKey'), objectEntityId: pointer(item.objectMentionKey, 'cseSignals.objectMentionKey', { nullable: true }), signalType: item.signalType, description: generatedText(item.description, 'cseSignals.description', 2000), evidenceRefs: optionalEvidence(item, 'cseSignals.evidence') }));
  const memoryId = await deterministicUuid(['v3-floor-memory', floor.chatId, floor.narrativeGeneration, floor.id, expectedScope.batchId, EXTRACTOR_VERSION, response, supersedes]);
  const sourceRawFingerprint = /^sha256:[0-9a-f]{64}$/u.test(floor.content.rawFingerprint ?? '')
    ? floor.content.rawFingerprint
    : null;
  const batchSources = envelope?.scope?.sourceFloorBindings ?? [];
  const sourceFloorIds = batchSources.map(source => source.floorId);
  const sourceFloorSnapshots = batchSources.map(source => ({
    floorId: source.floorId,
    canonicalContent: source.canonicalContent,
    sourceUserInputSnapshot: source.sourceUserInputSnapshot,
    rawFingerprint: source.floorId === floor.id ? sourceRawFingerprint : envelope?.scope?.sourceFloorRawFingerprints?.[source.floorId],
    storyClockSignature: envelope?.scope?.sourceFloorStoryClockSignatures?.[source.floorId] ?? '',
    ...(Object.hasOwn(envelope?.scope?.sourceFloorLocationReferences ?? {}, source.floorId)
      ? { locationReference: envelope.scope.sourceFloorLocationReferences[source.floorId] } : {}),
  }));
  const aggregateFields = sourceFloorIds.length > 1 ? { sourceFloorIds, sourceFloorSnapshots } : {};
  const memory = validateFloorMemory({ schemaVersion: 3, recordType: 'floorMemory', id: memoryId, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, floorId: floor.id, extractorVersion: EXTRACTOR_VERSION, sourceCanonicalContent: floor.content.canonicalContent, sourceUserInputSnapshot,
    ...aggregateFields,
    ...(sourceVariableReference ? { sourceVariableReference } : {}),
    ...(sourceRawFingerprint ? { sourceRawFingerprint } : {}),
    ...(sourceFloorIds.length === 1 && Object.hasOwn(envelope?.scope?.sourceFloorLocationReferences ?? {}, floor.id)
      ? { sourceLocationReference: envelope.scope.sourceFloorLocationReferences[floor.id] } : {}),
    summary: { aiText: summary, userText: preservedSummary?.userText ?? null, effectiveSource: preservedSummary?.effectiveSource === 'user' && preservedSummary.userText ? 'user' : 'ai', revisionNote: preservedSummary?.effectiveSource === 'user' ? '重新提取后保留用户摘要' : null }, summaryEvidenceRefs,
    chronology, locations, participants, actions, observations, informationTransfers, privateCognition, commitments, eventFragments, exactAnchors, openLoops, ambiguities, cseSignals,
    ...(spatialFacts ? { spatialFacts } : {}),
    createdAt: now, updatedAt: now, recordStatus: 'active', supersedes,
  }, { expectedChatId: floor.chatId });
  // These are this response's actual bindings, not the whole offered catalog. Keep
  // them in the request result only, so commit can check concurrent identity edits.
  const identityBindings = Object.freeze([...mentions.values()].filter(mention => mention.resolvedEntityId).map(mention => Object.freeze({
    entityId: mention.resolvedEntityId, entityType: mention.entityType,
    labels: Object.freeze([mention.surface, ...mention.aliases]),
  })));
  return Object.freeze({ memory, newEntities: Object.freeze(newEntities), identityBindings, isolated: Object.freeze(isolated), needsReview: false });
}

const normalizedKey = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-:/|]+/g, '');
const field = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const wanted = new Set(names.map(normalizedKey));
  const found = Object.keys(value).find(key => wanted.has(normalizedKey(key)));
  return found === undefined ? undefined : value[found];
};
const list = value => value === undefined || value === null || value === '' ? [] : (Array.isArray(value) ? value : [value]);
const SUMMARY_KEYS = Object.freeze(['summary', 'synopsis', 'overview', 'recap', 'memorySummary', 'brief', '摘要', '总结', '概述', '剧情概述', '故事概述', '内容概述']);
const SUMMARY_KEY_SET = new Set(SUMMARY_KEYS.map(normalizedKey));
const SUMMARY_WRAPPER_KEYS = Object.freeze(['memory', 'semanticMemory', 'result', 'data', 'output', 'response', 'floor', 'floors']);
const SUMMARY_FALLBACK_CONTAINER_KEYS = new Set([
  'events', 'event', 'eventFragments', 'actions', 'action', 'observations', 'observation', 'knowledge', 'facts', 'information',
  'informationTransfers', 'privateThoughts', 'privateCognition', 'commitments', 'openLoops', 'cseSignals', 'chronology', 'timeline',
  '事件', '行动', '动作', '观察', '知识', '事实', '信息', '私下想法', '内心', '承诺', '约定', '未决事项', '悬念', '关系信号', '时间线',
].map(normalizedKey));
const SUMMARY_FALLBACK_TEXT_KEYS = new Set([
  'description', 'event', 'action', 'observation', 'content', 'text', 'detail', 'narrative', 'story', 'plot', 'fact', 'knowledge', 'claimText', 'thought', 'promise', 'result',
  '描述', '事件', '行动', '动作', '观察', '内容', '文本', '文本内容', '详情', '叙述', '叙事', '剧情', '故事', '情节', '事实', '知识', '主张', '想法', '承诺', '结果',
].map(normalizedKey));
const semanticText = (value, names = [], maximum = 2000) => {
  const candidate = typeof value === 'string' || typeof value === 'number'
    ? value
    : field(value, names);
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : '';
};
const literalText = (value, names = [], maximum = 2000) => {
  const candidate = typeof value === 'string' ? value : field(value, names);
  return typeof candidate === 'string' && candidate.trim() && candidate.length <= maximum ? candidate : '';
};

function hasUnbalancedStructure(value) {
  const stack = [];
  let quoted = false, escaped = false;
  for (const char of String(value ?? '')) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') { stack.push(char); continue; }
    if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) return true;
    }
  }
  return stack.length > 0;
}

function cleanSummaryText(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const technicalLabel = /^(?:hash|sha(?:-?\d+)?|(?:run|memory|floor|checkpoint|chat|entity|batch|record)[_\s-]*id)\s*[:=：]\s*[a-z0-9][a-z0-9._:/-]*$/iu;
  if (!text || isUuid(text) || /^[a-f0-9]{16,}$/iu.test(text) || technicalLabel.test(text) || !/[\p{L}\p{N}]/u.test(text)) return '';
  if (/^[\[{]/u.test(text)) {
    try { JSON.parse(text); return ''; } catch { /* natural-language text may contain brackets */ }
  }
  return text;
}

function explicitSummary(packet) {
  if (Array.isArray(packet)) return combineSummaryParts(packet.map(explicitSummary));
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return '';
  for (const [key, value] of Object.entries(packet)) {
    if (!SUMMARY_KEY_SET.has(normalizedKey(key))) continue;
    const summary = cleanSummaryText(value);
    if (summary) return summary.slice(0, 4000);
  }
  return '';
}

function combineSummaryParts(values) {
  const seen = new Set();
  const parts = [];
  for (const value of values) {
    const text = cleanSummaryText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join('；').slice(0, 4000);
}

function fallbackSummary(packet) {
  const parts = [];
  const seen = new Set();
  const add = value => {
    const text = cleanSummaryText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  const visit = (value, allowScalar = false) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, allowScalar);
      return;
    }
    if (typeof value === 'string') {
      if (allowScalar) add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizedKey(key);
      if (SUMMARY_KEY_SET.has(normalized)) continue;
      if (SUMMARY_FALLBACK_TEXT_KEYS.has(normalized) || SUMMARY_FALLBACK_CONTAINER_KEYS.has(normalized)) visit(child, true);
    }
  };
  visit(packet);
  return parts.join('；').slice(0, 4000);
}

function parseSemanticCandidate(value, { finishReason } = {}) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  const text = value.trim();
  if (!text) throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)];
  const fenced = fences[0]?.[1] ?? text;
  const jsonLike = /^[\[{]/u.test(fenced.trim()) || /```\s*json\b/iu.test(text);
  if (jsonLike) {
    const safeTrailing = fences.length <= 1 ? parseJsonWithSafeTrailingCommas(fenced)?.value : undefined;
    if (safeTrailing !== undefined) return parseSemanticCandidate(safeTrailing, { finishReason });
    const primaryRepair = fences.length <= 1 ? parseJsonWithSymbolRepair(fenced, { finishReason })?.value : undefined;
    if (primaryRepair !== undefined) return parseSemanticCandidate(primaryRepair, { finishReason });
    const singleMissingObjectClose = fences.length <= 1
      ? repairJsonWithUniqueMissingObjectClose(fenced, {
        finishReason,
        normalizeCandidate: candidate => candidate,
        stableKey: candidate => JSON.stringify(candidate),
      })
      : null;
    if (singleMissingObjectClose !== null) return parseSemanticCandidate(singleMissingObjectClose, { finishReason });
    if (hasUnbalancedStructure(text)) throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
    const candidates = [];
    const firstObject = fenced.indexOf('{'), lastObject = fenced.lastIndexOf('}');
    const firstArray = fenced.indexOf('['), lastArray = fenced.lastIndexOf(']');
    if (firstObject >= 0 && lastObject > firstObject) candidates.push(fenced.slice(firstObject, lastObject + 1));
    if (firstArray >= 0 && lastArray > firstArray) candidates.push(fenced.slice(firstArray, lastArray + 1));
    for (const candidate of candidates) {
      try { return parseSemanticCandidate(JSON.parse(candidate), { finishReason }); } catch { /* fail below */ }
    }
    throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  }
  const balanced = balancedObjects(text);
  const structureStart = text.search(/[\[{]/u);
  const prefix = structureStart < 0 ? '' : text.slice(0, structureStart).trim();
  const hasOutputIntroduction = /^(?:(?:说明|结果|处理结果|提取结果|解析结果|JSON(?:结果)?|输出|以下(?:是)?(?:JSON|结果|内容)?)(?:如下|是)?\s*[:：,，。.!！]?\s*)+$/iu.test(prefix);
  if (hasOutputIntroduction) {
    const suffixPattern = /^(?:(?:以上|完毕|结束|完成|供参考|仅供参考|结果)(?:[。.!！])?\s*)*$/iu;
    let candidate = null;
    if (!balanced.unclosed && balanced.candidates.length === 1 && text.indexOf(balanced.candidates[0]) === structureStart) {
      const balancedCandidate = balanced.candidates[0];
      const suffix = text.slice(structureStart + balancedCandidate.length).trim();
      if (suffixPattern.test(suffix)) candidate = balancedCandidate;
    } else if (balanced.unclosed && balanced.candidates.length === 0 && text[structureStart] === '{') {
      candidate = text.slice(structureStart);
    }
    if (candidate) {
      const parsed = parseJsonWithSafeTrailingCommas(candidate)?.value
        ?? parseJsonWithSymbolRepair(candidate, { finishReason })?.value
        ?? repairJsonWithUniqueMissingObjectClose(candidate, { finishReason });
      if (parsed !== undefined) {
        try {
          semanticPacketSingle(parsed, { finishReason });
          return parsed;
        } catch (error) {
          if (error?.code !== 'V3_EXTRACTOR_SUMMARY_INVALID') throw error;
        }
      }
    }
    throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  }
  const summary = text.replace(/^(?:summary|摘要|总结)\s*[:：]\s*/iu, '').trim();
  if (!summary) throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  return { summary: summary.slice(0, 4000) };
}

function semanticPacketSingle(value, { finishReason } = {}) {
  let packet = parseSemanticCandidate(value, { finishReason });
  const packets = [];
  for (let depth = 0; depth < 6; depth += 1) {
    if (packet?.task === 'extractFloorMemory' && Array.isArray(packet.floors)) return { legacy: packet };
    packets.push(packet);
    const wrapped = field(packet, SUMMARY_WRAPPER_KEYS);
    if (wrapped === undefined || wrapped === null || wrapped === '' || (Array.isArray(wrapped) && wrapped.length === 0) || wrapped === packet) break;
    packet = parseSemanticCandidate(wrapped, { finishReason });
  }
  if (packets.at(-1) !== packet) packets.push(packet);
  const summary = packets.map(explicitSummary).find(Boolean)
    || [...packets].reverse().map(fallbackSummary).find(Boolean)
    || '';
  if (!summary) throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
  if (Array.isArray(packet)) {
    const merged = {};
    for (const item of packet.flat(Infinity)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const [key, child] of Object.entries(item)) {
        if (!Object.hasOwn(merged, key)) merged[key] = child;
        else merged[key] = [...list(merged[key]), ...list(child)];
      }
    }
    packet = merged;
  }
  return { packet, summary };
}

function stableSemanticKey(value) {
  const sort = item => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(value));
}

function chooseSemanticCandidate(candidates) {
  if (!candidates.length) return null;
  const first = candidates[0];
  const firstKey = stableSemanticKey(first);
  if (candidates.slice(1).some(candidate => stableSemanticKey(candidate) !== firstKey)) {
    throw extractorError('V3_EXTRACTOR_MULTIPLE_RESULTS', 'summary', '模型返回了多份不同摘要，无法确认；请重新提取本楼。');
  }
  return first;
}

function looksLikeSemanticJson(value) {
  return /["']?(?:summary|synopsis|overview|recap|memorySummary|brief|摘要|总结|概述|剧情概述|故事概述|内容概述|people|actions|qianshi|entityMentions)["']?\s*[:：]/iu.test(value);
}

function isSchemaMetadataCandidate(text) {
  const keys = [];
  let depth = 0, previous = '', key = '', type = '';
  // Only root keys describe the envelope; properties.summary is schema metadata, not a broken answer.
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/gu)) {
    if (depth === 1 && token === ':' && previous.startsWith('"')) {
      try { key = JSON.parse(previous); keys.push(key); } catch { return false; }
    } else if (depth === 1 && previous === ':' && key === 'type' && token.startsWith('"')) {
      try { type = JSON.parse(token); } catch { return false; }
    }
    if (token === '{' || token === '[') depth += 1;
    else if (token === '}' || token === ']') depth -= 1;
    previous = token;
  }
  return ['object', 'array'].includes(type) && keys.some(value => ['properties', 'items'].includes(value))
    && keys.every(value => ['$schema', '$id', '$defs', 'definitions', 'type', 'title', 'description', 'properties', 'required', 'items', 'additionalProperties'].includes(value));
}

function collectSemanticCandidates(values, { finishReason } = {}) {
  const candidates = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const structured = /^[\[{]/u.test(text);
    const labeledSummary = /^(?:summary|摘要|总结)\s*[:：]/iu.test(text);
    if (!structured && !labeledSummary) continue;
    if (structured && isSchemaMetadataCandidate(text)) continue;
    try {
      candidates.push(semanticPacketSingle(text, { finishReason }));
    } catch (error) {
      if (error?.code !== 'V3_EXTRACTOR_SUMMARY_INVALID') throw error;
      if (structured && looksLikeSemanticJson(text)) throw error;
    }
  }
  return candidates;
}

function parseCompleteStructuredJson(value, { finishReason } = {}) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* try the existing narrow repair paths */ }
  try {
    const safeTrailing = parseJsonWithSafeTrailingCommas(value)?.value;
    if (safeTrailing && typeof safeTrailing === 'object') return safeTrailing;
  } catch { /* malformed candidate remains invalid */ }
  try {
    const symbolRepair = parseJsonWithSymbolRepair(value, { finishReason })?.value;
    if (symbolRepair && typeof symbolRepair === 'object') return symbolRepair;
  } catch { /* malformed candidate remains invalid */ }
  try {
    const missingClose = repairJsonWithUniqueMissingObjectClose(value, { finishReason });
    if (missingClose && typeof missingClose === 'object') return missingClose;
  } catch { /* malformed candidate remains invalid */ }
  return null;
}

function semanticPacket(value, { finishReason } = {}) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[\[{]/u.test(text)) {
      const raw = parseCompleteStructuredJson(text, { finishReason });
      if (raw) return semanticPacketSingle(raw, { finishReason });
    }
    const outerFence = /^```(?:json)?\s*/iu.exec(text);
    const outerClose = text.lastIndexOf('```');
    if (outerFence && outerClose >= outerFence[0].length && !text.slice(outerClose + 3).trim()) {
      const body = text.slice(outerFence[0].length, outerClose).trim();
      const outer = parseCompleteStructuredJson(body, { finishReason });
      if (outer) return semanticPacketSingle(outer, { finishReason });
    }
    const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)];
    if (fences.length > 1) {
      const selected = chooseSemanticCandidate(collectSemanticCandidates(fences.map(fence => fence[1]), { finishReason }));
      if (selected) return selected;
      throw extractorError('V3_EXTRACTOR_SUMMARY_INVALID', 'summary');
    }
  }
  try {
    return semanticPacketSingle(value, { finishReason });
  } catch (error) {
    if (error?.code !== 'V3_EXTRACTOR_SUMMARY_INVALID' || typeof value !== 'string') throw error;

    const text = value.trim();
    const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/giu)];
    if (hasUnbalancedStructure(text)) throw error;
    const fenced = fences[0]?.[1] ?? text;
    const balanced = balancedObjects(fenced);
    if (balanced.unclosed) throw error;
    if (balanced.candidates.length > 1) {
      const selected = chooseSemanticCandidate(collectSemanticCandidates(balanced.candidates, { finishReason }));
      if (selected) return selected;
    }
    throw error;
  }
}

function semanticSource(item, quote, floor, envelope, allowPlaceOmission = false, diagnostic = null) {
  const unresolved = reason => { if (diagnostic) diagnostic.reason = reason; return null; };
  const bindings = envelope?.scope?.sourceFloorBindings ?? [{ floorKey: 'floor-1', floorId: floor.id, canonicalContent: floor.content.canonicalContent, sourceUserInputSnapshot: envelope?.scope?.sourceUserInputSnapshot ?? null }];
  const sources = bindings.flatMap(binding => [
    { floorKey: binding.floorKey, floorId: binding.floorId, sourceType: 'assistant', sourceSnapshotIndex: null, content: binding.canonicalContent },
    ...(binding.sourceUserInputSnapshot?.messages ?? []).map((message, sourceSnapshotIndex) => ({ floorKey: binding.floorKey, floorId: binding.floorId, sourceType: 'precedingUser', sourceSnapshotIndex, content: message.content })),
  ]);
  const sourceHint = item && typeof item === 'object' && !Array.isArray(item) ? field(item, ['source', 'sourceType', 'evidenceSource', '来源']) : '';
  const hint = normalizedKey(semanticText(sourceHint, [], 80));
  if (hint === 'locationreference') return unresolved('placeTagIsNotBodyEvidence');
  const hintedType = ['canonicalcontent', 'assistant', 'ai', '正文', 'ai正文'].includes(hint) ? 'assistant'
    : ['precedinguserinput', 'precedinguser', 'userinput', 'currentuserinput', 'user', '前置用户输入', '用户输入'].includes(hint) ? 'precedingUser'
      : null;
  const floorKey = semanticText(field(item, ['sourceFloorKey', 'floorKey', '来源楼']), [], 80);
  const snapshotIndex=field(item,['sourceSnapshotIndex']);
  if (floorKey && !sources.some(source => source.floorKey === floorKey)) return unresolved('unknownSourceFloorKey');
  const candidates=sources.filter(source => (!floorKey || source.floorKey === floorKey) && (!hintedType || source.sourceType === hintedType) && (!Number.isSafeInteger(snapshotIndex)||source.sourceSnapshotIndex===snapshotIndex));
  const matches=candidates.filter(source=>source.content.includes(quote));
  if(matches.length)return matches.length===1?matches[0]:unresolved('ambiguousSourceQuote');
  if(!allowPlaceOmission||!floorKey||!hintedType)return unresolved('sourceQuoteUnlocated');
  const recovered=candidates.flatMap(source=>{const segments=locatePlaceQuote(source.content,quote,{allowOmission:true});return segments?[{...source,quoteSegments:segments.map(segment=>segment.quote)}]:[];});
  return recovered.length===1?recovered[0]:unresolved(recovered.length>1?'ambiguousSourceQuote':'sourceQuoteUnlocated');
}

function semanticEvidence(item, floor, envelope, allowPlaceOmission = false, diagnostic = null) {
  if (Array.isArray(item?._placePathEvidence)) return item._placePathEvidence.flatMap(ref => semanticEvidence(ref, floor, envelope, allowPlaceOmission, diagnostic));
  const quote = literalText(item, ['exactQuote', 'quote', 'sourceText', 'originalText', '原句', '引文'], 2000);
  if (!quote && diagnostic) diagnostic.reason = 'exactQuoteMissing';
  const source = quote ? semanticSource(item, quote, floor, envelope, allowPlaceOmission, diagnostic) : null;
  if (!source) return [];
  return [{ quoteSegments: source.quoteSegments ?? [quote], supports: '本地定位的语义条目', evidenceMode: 'explicit', sourceMentionKey: null, sourceFloorKey: source.floorKey, sourceType: source.sourceType, ...(source.sourceType === 'precedingUser' ? { sourceSnapshotIndex: source.sourceSnapshotIndex } : {}) }];
}

function enumOr(value, mappings, fallback) {
  const key = normalizedKey(value);
  return mappings[key] ?? fallback;
}

// The current library and the historical body snapshot share provenance, but
// only this request's body references date the newly available full text.
async function placeCurrentMemory(memory,patch,floor,envelope) {
 const spatial={schemaVersion:1,containments:[],positions:[],...(memory.spatialFacts??{})};
 let changed=false;
 for(const fact of patch.facts??[]){
  if(!['feature','relation'].includes(fact.kind)||!Array.isArray(fact.replacesItemIds)||typeof fact.text!=='string')continue;
  const evidenceRefs=[];
  for(const ref of fact.source?.references??(fact.source?[fact.source]:[])){
   if(ref.kind!=='body')continue;
   const binding=envelope.scope.sourceFloorBindings?.find(binding=>binding.floorId===ref.floorId);if(!binding)continue;
   try{
    const source=sourceContentFor({floor,envelope,value:{sourceFloorKey:binding.floorKey,sourceType:ref.sourceType??'assistant',...(ref.sourceSnapshotIndex!==undefined?{sourceSnapshotIndex:ref.sourceSnapshotIndex}:{})},path:'placePaths.currentSource'});
    const located=compileEvidenceSegments(source.content,[ref.quote],'placePaths.currentSource');
    evidenceRefs.push(...located.map(segment=>({floorId:source.floorId,anchorId:null,quotedText:segment.quotedText,occurrence:segment.occurrence,evidenceMode:'explicit',supports:'本次地点新增或变化；原有内容沿source关联旧来源',sourceEntityId:null,...source.stored})));
   }catch{/* An inherited source outside this request remains provenance only. */}
  }
  const refs=[...new Map(evidenceRefs.map(ref=>[JSON.stringify(ref),ref])).values()].slice(0,EVIDENCE_REF_LIMIT);if(!refs.length)continue;
  const field=fact.kind==='feature'?'features':'relations',prior=(spatial[field]??[]).filter(item=>item.placeEntityId===fact.placeEntityId&&(field!=='features'||item.kind==='stable'));
  const itemId=await deterministicUuid(['v3-place-current-snapshot',floor.id,fact.itemId]),replacesItemIds=[...new Set([...fact.replacesItemIds,...prior.flatMap(item=>[item.itemId,...(item.replacesItemIds??[])])])].filter(id=>id!==itemId);
  const available=(envelope.scope.sourceFloorBindings??[]).reduce((latest,binding)=>binding.assistantSeq>latest.assistantSeq?binding:latest,{floorId:floor.id,assistantSeq:floor.assistantSeq??0});
  (spatial[field]??=[]).push({itemId,placeEntityId:fact.placeEntityId,kind:field==='features'?'stable':'relative',...(field==='relations'?{referencePlaceEntityIds:[]}:{}),text:fact.text,replacesItemIds:replacesItemIds.slice(-40),evidenceRefs:refs,source:{...fact.source,replacesItemIds,knownFromFloorId:available.floorId}});changed=true;
 }
 return changed?validateFloorMemory({...memory,spatialFacts:spatial},{expectedChatId:memory.chatId}):memory;
}

function withoutPlaceFields(packet, legacy = false) {
  const result = { ...packet };
  for (const key of Object.keys(result)) if (['spatialfacts', 'placepaths', 'locations', 'location', 'places', 'place', '地点', '场景', '空间事实', 'mapstyle'].includes(normalizedKey(key))) delete result[key];
  if (legacy) {
    result.locations = [];
    result.entityMentions = (result.entityMentions ?? []).filter(mention => mention.entityType !== 'place');
  }
  return result;
}

async function compileSemanticPacketDomains({ response, finishReason, envelope, floor, existingEntities = [], now, supersedes, preservedSummary, expectedScope, skipPlaces = false }) {
  const parsed = semanticPacket(response, { finishReason });
  if (parsed.legacy) {
    const legacyResponse = skipPlaces ? { ...parsed.legacy, floors: parsed.legacy.floors.map(packet => withoutPlaceFields(packet, true)) } : parsed.legacy;
    const normalized = await normalizeLegacyExtractorResponse({ response: legacyResponse, envelope, floor, existingEntities, now, supersedes, preservedSummary, expectedScope });
    return Object.freeze({ ...normalized, qianshiPacket: parsed.legacy.floors?.[0] ?? null });
  }
  let { packet, summary } = parsed;
  if (skipPlaces) packet = withoutPlaceFields(packet);
  const pathResult = skipPlaces ? { packet, envelope, entities: existingEntities, freshEntities: [], foundationPatch: { schemaVersion: 1, entities: [], facts: [], replaceFields: [] }, isolated: [] } : await expandPlacePaths({ packet, envelope, existingEntities, now, deferParentResolution: true });
  const freshPlaceIds = new Set(pathResult.freshEntities.map(entity => entity.id));
  packet = pathResult.packet; envelope = pathResult.envelope; existingEntities = pathResult.entities;
  const isolated = [...pathResult.isolated];
  const issue = (fieldName, index, code, path = fieldName, reason = null) => {
    if (isolated.length < 80) isolated.push({ field: fieldName, index, code, path, ...(reason ? { reason } : {}) });
  };
  const identity = safeIdentity(envelope?.scope?.userIdentity);
  const userAliases = new Set(identity.aliases.map(identityLabelKey));
  const directory = buildEntityIdentityDirectory({ entities: existingEntities, floorOrder: envelope?.scope?.floorOrder, identityProjection: envelope?.scope?.identityProjection });
  const activeEntities = directory.map(entry => entry.entity);
  const bindings = envelope?.scope?.catalogBindings ?? [];
  const placeBindings = envelope?.scope?.placeCatalogBindings ?? [];
  const catalogKeyById = new Map(bindings.map(binding => [binding.entityId, binding.entityKey]));
  const directoryById = new Map(directory.map(entry => [entry.entityId, entry]));
  const catalogByKey = new Map(bindings.map(binding => [binding.entityKey, directoryById.get(binding.entityId)]));
  for (const binding of placeBindings) {
    const entry = directoryById.get(binding.entityId);
    if (entry?.entityType === 'place') { catalogKeyById.set(binding.entityId, binding.entityKey); catalogByKey.set(binding.entityKey, entry); }
  }
  const entityByLabel = new Map();
  for (const entry of directory) for (const label of entry.labels.map(identityLabelKey)) entityByLabel.set(label, [...(entityByLabel.get(label) ?? []), entry.entity]);
  const existingUser = activeEntities.find(entity => entity.specialRole === 'user') ?? null;
  const standardPeopleKey = Object.keys(packet).find(key => normalizedKey(key) === 'people');
  const standardPeople = standardPeopleKey === undefined ? undefined : packet[standardPeopleKey];
  const personFields = ['person', 'persons', 'characters', 'entities', 'participants', '人物', '角色'];
  const hasUsablePerson = value => list(value).some(item => Boolean(semanticText(item, ['name', 'displayName', 'person', 'character', 'surface', '姓名', '人物'], 500)));
  const fallbackPeople = personFields.map(name => field(packet, [name])).find(hasUsablePerson)
    ?? personFields.map(name => field(packet, [name])).find(value => value !== undefined);
  const rawPeople = hasUsablePerson(standardPeople) ? list(standardPeople)
    : hasUsablePerson(fallbackPeople) ? list(fallbackPeople)
      : standardPeopleKey !== undefined ? list(standardPeople) : list(fallbackPeople);
  const people = [];
  // 同楼同人的临时称呼只供本次引用绑定，不转成长期别名。
  const referenceLabels = new Map();
  const identityEvidence = refs => Array.isArray(refs) && refs.length <= 20
    ? refs.map(ref => ref && typeof ref === 'object' && !Array.isArray(ref) ? { ...ref, sourceMentionKey: ref.sourceMentionKey ?? null } : ref) : refs;
  for (const [index, item] of rawPeople.slice(0, FLOOR_MEMORY_ITEM_LIMIT).entries()) {
    const name = semanticText(item, ['name', 'displayName', 'person', 'character', 'surface', '姓名', '人物'], 500);
    if (!name) { issue('people', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `people[${index}].name`); continue; }
    const aliases = [...new Set(list(field(item, ['aliases', 'alias', 'otherNames', 'aka', '别名', '称谓'])).map(value => semanticText(value, [], 500)).filter(Boolean))];
    const role = semanticText(item, ['role', 'specialRole', 'type', '角色'], 80);
    const rawEntityKind = item && typeof item === 'object' && !Array.isArray(item)
      ? semanticText(item, ['entityKind', 'kind', 'identityKind', '实体类型', '身份类型'], 80)
      : '';
    const entityKind = normalizedKey(rawEntityKind) === 'group' || normalizedKey(rawEntityKind) === '群体' ? 'group' : 'individual';
    if (!rawEntityKind) issue('people', index, 'V3_EXTRACTOR_ENTITY_KIND_DEFAULTED', `people[${index}].entityKind`);
    else if (!['individual', 'group', '个体', '群体'].includes(normalizedKey(rawEntityKind))) { issue('people', index, 'V3_EXTRACTOR_ENTITY_KIND_INVALID', `people[${index}].entityKind`); continue; }
    const expectedEntityType = entityKind === 'group' ? 'group' : 'person';
    const identityInput = expectedEntityType === 'person' ? Object.fromEntries(['identityFacts', 'identityBrief', 'identityBriefEvidence'].filter(key => Object.hasOwn(item ?? {}, key)).map(key => [key, item[key]])) : {};
    if (Array.isArray(identityInput.identityFacts) && identityInput.identityFacts.length <= 20) identityInput.identityFacts = identityInput.identityFacts.map(fact =>
      fact && typeof fact === 'object' && !Array.isArray(fact) && Object.hasOwn(fact, 'evidence') ? { ...fact, evidence: identityEvidence(fact.evidence) } : fact);
    if (Object.hasOwn(identityInput, 'identityBriefEvidence')) identityInput.identityBriefEvidence = identityEvidence(identityInput.identityBriefEvidence);
    const referenceTokens = [name, ...aliases].flatMap(value => value.split(/[\/,|／、]/u)).map(identityLabelKey).filter(Boolean);
    const roleClaimsUser = ['user', 'player', 'protagonist', 'secondperson', '用户', '玩家', '主角', '第二人称'].includes(normalizedKey(role));
    const isUser = referenceTokens.some(token => userAliases.has(token));
    if (roleClaimsUser && !isUser) issue('people', index, 'V3_EXTRACTOR_USER_ROLE_CONFLICT', `people[${index}].role`);
    if (entityKind === 'group' && (roleClaimsUser || isUser)) { issue('people', index, 'V3_EXTRACTOR_USER_ROLE_CONFLICT', `people[${index}].entityKind`); continue; }
    const displayName = isUser && identity.displayName ? identity.displayName : name;
    let mergedAliases = [...new Set([...(isUser ? identity.aliases : []), ...aliases].filter(value => value !== displayName))];
    const labels = [displayName, ...mergedAliases].map(identityLabelKey).filter(Boolean);
    let matched = isUser ? existingUser : null;
    const sameAsRaw = field(item, ['sameAsEntityKey']);
    if (sameAsRaw !== undefined && sameAsRaw !== null && String(sameAsRaw).trim()) {
      const sameAsEntityKey = typeof sameAsRaw === 'string' ? sameAsRaw.trim() : '';
      const explicit = catalogByKey.get(sameAsEntityKey);
      if (isUser) {
        if (!explicit || explicit.entityId !== existingUser?.id) issue('people', index, 'V3_EXTRACTOR_USER_ROLE_CONFLICT', `people[${index}].sameAsEntityKey`);
      } else {
        if (!explicit) { issue('people', index, 'V3_EXTRACTOR_ENTITY_KEY_INVALID', `people[${index}].sameAsEntityKey`); continue; }
        if (explicit.entityType !== expectedEntityType) { issue('people', index, 'V3_EXTRACTOR_ENTITY_TYPE_CONFLICT', `people[${index}].entityKind`); continue; }
        if (explicit.specialRole === 'user') { issue('people', index, 'V3_EXTRACTOR_USER_ROLE_CONFLICT', `people[${index}].sameAsEntityKey`); continue; }
        matched = explicit.entity;
      }
    } else if (!matched && !isUser) {
      const matches = [...new Set(labels.flatMap(label => entityByLabel.get(label) ?? []).filter(entity => entity.entityType === expectedEntityType))];
      if (matches.length === 1) matched = matches[0];
      else if (matches.length > 1) { issue('people', index, 'V3_EXTRACTOR_ENTITY_AMBIGUOUS', `people[${index}].name`); continue; }
    }
    if (matched && matched.entityType !== expectedEntityType) { issue('people', index, 'V3_EXTRACTOR_ENTITY_TYPE_CONFLICT', `people[${index}].entityKind`); continue; }
    const identityMode = matched ? 'existing' : 'new';
    const entityKey = matched ? catalogKeyById.get(matched.id) ?? null : null;
    if (matched && !entityKey) { issue('people', index, 'V3_EXTRACTOR_LOCAL_CATALOG_INVALID', `people[${index}].name`); continue; }
    if (matched && expectedEntityType === 'person') mergedAliases = [...new Set([...mergedAliases, ...aliases])];
    const dedupeKey = isUser ? 'special:user' : (matched ? `existing:${matched.id}` : `new:${expectedEntityType}:${identityLabelKey(displayName)}`);
    const rawPresence = semanticText(item, ['presence', 'participation', 'presenceType', '出场状态', '在场状态'], 80);
    const explicitPresence = {
      present: 'present', onsite: 'present', '在场': 'present', '现场': 'present',
      remote: 'remote', '远程': 'remote', '远程参与': 'remote',
      mentioned: 'mentioned', mention: 'mentioned', '提及': 'mentioned', '仅提及': 'mentioned',
      privatecognitiononly: 'privateCognitionOnly', '仅私密认知': 'privateCognitionOnly', '仅内心': 'privateCognitionOnly',
    }[normalizedKey(rawPresence)] ?? null;
    const prior = people.find(person => person.dedupeKey === dedupeKey);
    const mentionKey = prior?.mentionKey ?? `person-${people.length + 1}`;
    const referenceNames = referenceLabels.get(mentionKey) ?? new Set();
    referenceNames.add(identityLabelKey(name));
    referenceLabels.set(mentionKey, referenceNames);
    if (prior) {
      prior.aliases = [...new Set([...prior.aliases, ...(expectedEntityType !== 'person' && displayName !== prior.surface ? [displayName] : []), ...mergedAliases])];
      if (explicitPresence) {
        const presenceRank = { mentioned: 0, privateCognitionOnly: 1, remote: 2, present: 3 };
        if (!prior.presenceExplicit || presenceRank[explicitPresence] > presenceRank[prior.presence]) prior.presence = explicitPresence;
        prior.presenceExplicit = true;
      }
      const hasPriorIdentity = ['identityFacts', 'identityBrief'].some(key => Object.hasOwn(prior, key));
      if (hasPriorIdentity && Object.keys(identityInput).length && JSON.stringify(Object.fromEntries(Object.keys(identityInput).map(key => [key, prior[key]]))) !== JSON.stringify(identityInput)) prior.identityBriefConflict = true;
      else Object.assign(prior, identityInput);
      continue;
    }
    people.push({ sourceIndex: index, dedupeKey, mentionKey, surface: displayName, aliases: mergedAliases, entityType: expectedEntityType, identity: identityMode, entityKey, localSpecialRole: isUser ? 'user' : 'none', presence: explicitPresence ?? 'mentioned', presenceExplicit: Boolean(explicitPresence), ...identityInput, evidence: semanticEvidence(item, floor, envelope) });
  }
  if (rawPeople.length > FLOOR_MEMORY_ITEM_LIMIT) issue('people', FLOOR_MEMORY_ITEM_LIMIT, 'V3_EXTRACTOR_ARRAY_TRUNCATED', 'people');
  const individualLabels = new Set(people.filter(person => person.entityType === 'person')
    .flatMap(person => [person.surface, ...person.aliases, ...(referenceLabels.get(person.mentionKey) ?? [])]).map(identityLabelKey).filter(Boolean));
  for (const person of people) {
    if (person.entityType !== 'group') continue;
    person.aliases = person.aliases.filter(alias => {
      if (!individualLabels.has(identityLabelKey(alias))) return true;
      issue('people', person.sourceIndex, 'V3_EXTRACTOR_GROUP_ALIAS_MEMBER_CONFLICT', `people[${person.sourceIndex}].aliases`);
      return false;
    });
  }
  const referenceName = value => semanticText(value, ['name', 'displayName', 'person', 'character', 'surface', 'owner', 'holder', 'speaker', 'issuer', 'subject', 'actor', 'sender', 'recipient', 'from', 'to', '姓名'], 500);
  const mentionFor = value => {
    const name = referenceName(value);
    const key = identityLabelKey(name);
    if (!key) return null;
    const exact = people.filter(person => identityLabelKey(person.surface) === key);
    if (exact.length === 1) return exact[0].mentionKey;
    if (exact.length > 1) return null;
    const aliases = people.filter(person => person.aliases.some(alias => identityLabelKey(alias) === key) || referenceLabels.get(person.mentionKey)?.has(key));
    return aliases.length === 1 ? aliases[0].mentionKey : null;
  };
  const evidence = item => semanticEvidence(item, floor, envelope);
  const legacy = {
    schemaVersion: 3, task: 'extractFloorMemory', promptVersion: EXTRACTOR_PROMPT_VERSION,
    floors: [{
      status: 'ok', summary, summaryEvidence: [], entityMentions: people.map(({ sourceIndex, dedupeKey, presence, presenceExplicit, ...person }) => ({ ...person, aliases: person.aliases.slice(0, 20) })),
      chronology: [], locations: [], participants: people.map(person => ({ mentionKey: person.mentionKey, presence: person.presence, evidence: person.evidence })),
      actions: [], observations: [], informationTransfers: [], privateCognition: [], commitments: [], eventFragments: [], exactAnchors: [], openLoops: [], ambiguities: [], cseSignals: [],
    }],
  };
  const target = legacy.floors[0];
  const boundedItems = (names, fieldName) => {
    const values = list(field(packet, names));
    if (values.length > FLOOR_MEMORY_ITEM_LIMIT) issue(fieldName, FLOOR_MEMORY_ITEM_LIMIT, 'V3_EXTRACTOR_ARRAY_TRUNCATED', fieldName);
    return values.slice(0, FLOOR_MEMORY_ITEM_LIMIT);
  };
  for (const [index, item] of boundedItems(['time', 'times', 'chronology', 'timeline', '时间'], 'time').entries()) {
    const sourceText = semanticText(item, ['sourceText', 'time', 'value', 'text', '时间', '原文'], 500);
    const description = semanticText(item, ['description', 'text', 'time', 'value', '描述', '时间']) || sourceText;
    if (!description) { issue('time', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `time[${index}]`); continue; }
    const kind = enumOr(semanticText(item, ['kind', 'type', '时间类型']), { explicit: 'explicit', relative: 'relative', sequenceonly: 'sequenceOnly', unknown: 'unknown', '明确': 'explicit', '相对': 'relative', '顺序': 'sequenceOnly', '未知': 'unknown' }, 'unknown');
    const precision = enumOr(semanticText(item, ['precision', '精度']), { exact: 'exact', approximate: 'approximate', unresolved: 'unresolved', '精确': 'exact', '大约': 'approximate', '未解析': 'unresolved' }, kind === 'explicit' ? 'exact' : 'unresolved');
    const normalized = semanticText(item, ['normalized', 'normalizedTime', '标准时间'], 500) || null;
    target.chronology.push({ time: { kind, sourceText: (sourceText || description).slice(0, 500), normalized, precision }, description, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['locations', 'location', 'places', 'place', '地点', '场景'], 'locations').entries()) {
    const name = semanticText(item, ['name', 'location', 'place', 'text', '名称', '地点'], 500);
    if (!name) { issue('locations', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `locations[${index}]`); continue; }
    const change = enumOr(semanticText(item, ['change', 'state', 'action']), { entered: 'entered', enter: 'entered', left: 'left', leave: 'left', movedthrough: 'movedThrough', mentioned: 'mentioned', '进入': 'entered', '离开': 'left', '路过': 'movedThrough', '提及': 'mentioned' }, 'present');
    target.locations.push({ entityMentionKey: null, name, change, participantMentionKeys: list(field(item, ['people', 'participants', 'persons'])).map(mentionFor).filter(Boolean), evidence: evidence(item) });
  }
  const spatialInputValue = field(packet, ['spatialFacts', '空间事实']);
  const spatialInput = spatialInputValue && typeof spatialInputValue === 'object' && !Array.isArray(spatialInputValue) ? spatialInputValue : null;
  const spatialPlaces = new Map();
  const knownPlaces = new Map((envelope?.request?.payload?.knownPlaces ?? []).map(value => [value.entityKey, value]));
  const allPlaceOwners = new Map(envelope?.scope?.placeIdentityLabels ?? placeIdentityLabels(directory));
  if (spatialInputValue !== undefined && !spatialInput) issue('spatialFacts', -1, 'V3_EXTRACTOR_OBJECT_INVALID', 'spatialFacts');
  const spatialArray = key => {
    const value = field(spatialInput, [key]);
    if (value === undefined && (!spatialInput || ['features', 'relations'].includes(key))) return [];
    if (!Array.isArray(value)) { issue(`spatialFacts.${key}`, -1, 'V3_EXTRACTOR_ARRAY_INVALID', `spatialFacts.${key}`); return []; }
    if (value.length > SPATIAL_FACT_LIMIT) issue(`spatialFacts.${key}`, SPATIAL_FACT_LIMIT, 'V3_EXTRACTOR_ARRAY_TRUNCATED', `spatialFacts.${key}`);
    return value.slice(0, SPATIAL_FACT_LIMIT);
  };
  const spatialEvidenceRecords = new Map();
  const spatialEvidence = item => {
    if (spatialEvidenceRecords.has(item)) return spatialEvidenceRecords.get(item).refs;
    const diagnostic = {};
    const refs = semanticEvidence(item, floor, envelope, true, diagnostic).filter(ref => {
      try {
        const source = sourceContentFor({ floor, envelope, value: ref, path: 'spatialFacts.evidence' });
        compileEvidenceSegments(source.content, ref.quoteSegments, 'spatialFacts.evidence.quoteSegments');
        return true;
      } catch (error) { diagnostic.reason = error?.code ?? 'invalidEvidence'; return false; }
    });
    spatialEvidenceRecords.set(item, { refs, reason: diagnostic.reason });
    return refs;
  };
  const spatialFailureReason = (item, placeKey, fallback) => !placeKey ? 'placeKeyMissing'
    : !spatialPlaces.has(placeKey) ? 'unknownPlaceKey' : spatialEvidenceRecords.get(item)?.reason ?? fallback;
  for (const [index, item] of spatialArray('places').entries()) {
    const key = semanticText(item, ['key', 'placeKey'], 80), name = semanticText(item, ['name', 'displayName', '地点'], 500);
    const aliases = [...new Set(list(field(item, ['aliases', '别名'])).map(value => semanticText(value, [], 500)).filter(Boolean))];
    const identityMode = semanticText(item, ['identity'], 40);
    const sameAsPlaceKey = semanticText(item, ['sameAsPlaceKey'], 80);
    const identityChange = field(item, ['identityChange']);
    const identityBasis = field(item, ['identityBasis']);
    if (!/^place-mention-[1-9]\d*$/u.test(key) || !name || spatialPlaces.has(key)) {
      issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_INVALID', `spatialFacts.places[${index}]`); continue;
    }
    if (!['existing', 'new', 'uncertain'].includes(identityMode) || identityMode === 'uncertain' || (identityMode === 'new' && sameAsPlaceKey)) {
      issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_IDENTITY_UNRESOLVED', `spatialFacts.places[${index}].identity`); continue;
    }
    if (identityChange !== undefined && (identityChange !== 'ownershipChanged' || identityMode !== 'existing' || !sameAsPlaceKey)) { issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_IDENTITY_UNRESOLVED', 'spatialFacts.places.identityChange'); continue; }
    if (identityBasis !== undefined && (identityBasis !== 'explicitSamePlace' || identityMode !== 'existing' || !sameAsPlaceKey)) { issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_IDENTITY_UNRESOLVED', 'spatialFacts.places.identityBasis'); continue; }
    const evidenceRefs = spatialEvidence(item);
    if (!evidenceRefs.length) { issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_EVIDENCE_INVALID', `spatialFacts.places[${index}]`, spatialEvidenceRecords.get(item)?.reason); continue; }
    let identity = identityMode, entityKey = null;
    if (identity === 'existing') {
      if (sameAsPlaceKey) {
        if (!knownPlaces.has(sameAsPlaceKey)) { issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_KEY_INVALID', `spatialFacts.places[${index}].sameAsPlaceKey`); continue; }
        entityKey = sameAsPlaceKey;
      } else {
        const labels = new Set([name, ...aliases].filter(label => !isGenericPlaceAlias(label)).map(identityLabelKey).filter(Boolean));
        const matches = new Set([...labels].flatMap(label => allPlaceOwners.get(label) ?? []));
        if (matches.size !== 1) {
          issue('spatialFacts.places', index, matches.size ? 'V3_EXTRACTOR_SPATIAL_PLACE_AMBIGUOUS' : 'V3_EXTRACTOR_SPATIAL_PLACE_UNRESOLVED', `spatialFacts.places[${index}].name`); continue;
        }
        const binding = placeBindings.find(binding => binding.entityId === matches.values().next().value);
        if (!binding || !knownPlaces.has(binding.entityKey)) {
          issue('spatialFacts.places', index, 'V3_EXTRACTOR_SPATIAL_PLACE_UNRESOLVED', `spatialFacts.places[${index}].name`); continue;
        }
        entityKey = binding.entityKey;
      }
    }
    const mention = { mentionKey: key, surface: name, aliases, entityType: 'place', identity, entityKey, identityChange, identityBasis, specialRole: 'none', evidence: evidenceRefs };
    spatialPlaces.set(key, mention);

  }
  // Both endpoints have passed the normal identity parser. Only evidence that
  // compiles through the normal source contract can prove a finer parent chain.
  const containmentItems = spatialArray('containments'), relationItems = spatialArray('relations');
  const validParent = (item, parentKey) => {
    const child = spatialPlaces.get(item?.placeKey);
    if (!child || !(spatialPlaces.has(parentKey) || parentKey === null && child.identityChange === 'ownershipChanged') || item.placeKey === parentKey) return false;
    return spatialEvidence(item).length > 0;
  };
  const bindingByKey = new Map(placeBindings.map(binding => [binding.entityKey, binding]));
  const placeToken = key => key === null ? null : bindingByKey.get(spatialPlaces.get(key)?.entityKey)?.entityId ?? key;
  const bodyParents = containmentItems.filter(item => validParent(item, item?.parentPlaceKey)).map(item => ({
    placeEntityId: placeToken(item.placeKey), parentEntityId: placeToken(item.parentPlaceKey),
    identityChange: spatialPlaces.get(item.placeKey).identityChange, authority: item._placePathIndex === undefined ? 0 : 1, item,
  }));
  const foundationParents = (pathResult.foundationPatch.facts ?? []).filter(fact => fact.kind === 'containment').map(fact => placeParentSourceIntent(fact));
  const previousParents = new Map([...(envelope.scope.parentEntityIdsByPlaceId ?? [])].map(([id, parents]) => [id, { parents: new Map([...parents].map(parent => [parent, {}])) }]));
  const manualParents = new Map(Object.entries(envelope.scope.identityProjection?.placeWorkspace?.placesByEntityId ?? {}).filter(([, row]) => Object.hasOwn(row, 'parentEntityId'))
    .map(([id, row]) => [id, new Map(row.parentEntityId ? [[row.parentEntityId, { manual: true }]] : [])]));
  const parentDecision = skipPlaces ? { updates: new Map(), rejected: new Set(), compatible: new Set() } : resolvePlaceParentBatch([...bodyParents, ...foundationParents], { previous: previousParents, manual: manualParents, preservePreviousRefinements: false });
  const rejectedPaths = new Set([...bodyParents.filter(intent => parentDecision.rejected.has(intent.placeEntityId)).map(intent => intent.item._placePathIndex),
    ...foundationParents.filter(intent => parentDecision.rejected.has(intent.placeEntityId) || isPlaceTagSource(intent.source) && !parentDecision.compatible.has(intent)).map(intent => pathResult.pathOrigins?.parentPathIndex.get(intent.itemId))].filter(index => index !== undefined));
  for (const index of rejectedPaths) issue('placePaths', index, 'QQJ_PLACE_PATH_SCOPE_CONFLICT', `placePaths[${index}]`);
  pathResult.foundationPatch.facts = pathResult.foundationPatch.facts.filter(fact => !parentDecision.rejected.has(fact.placeEntityId)
    && ![...(pathResult.pathOrigins?.factPathIndexes.get(fact.itemId) ?? [])].every(index => rejectedPaths.has(index)));
  const foundationEntityIds = new Set(pathResult.foundationPatch.facts.flatMap(fact => [fact.placeEntityId, fact.parentEntityId, ...(fact.referencePlaceEntityIds ?? [])]).filter(Boolean));
  pathResult.foundationPatch.entities = pathResult.foundationPatch.entities.filter(entity => foundationEntityIds.has(entity.id));
  pathResult.foundationPatch.replaceFields = pathResult.foundationPatch.replaceFields.filter(row => pathResult.foundationPatch.facts.some(fact => fact.placeEntityId === row.entityId && fact.kind === row.kind));
  const acceptedBodyParents = new Set(bodyParents.filter(intent => parentDecision.compatible.has(intent) && !rejectedPaths.has(intent.item._placePathIndex)).map(intent => intent.item));
  const qualifiedBodyParents = new Set(bodyParents.map(intent => intent.item));
  const useContainment = item => !qualifiedBodyParents.has(item) || acceptedBodyParents.has(item);
  const localIntents = bodyParents.filter(intent => acceptedBodyParents.has(intent.item)).map(intent => ({
    placeEntityId: intent.item.placeKey, parentEntityId: intent.item.parentPlaceKey, identityChange: intent.identityChange, authority: intent.authority,
  }));
  const locatedParents = relationItems.filter(item => item?.kind === 'locatedIn' && item.referencePlaceKeys?.length === 1 && semanticText(item, ['text'], 1000)
    && validParent(item, item.referencePlaceKeys[0])).map(item => ({ placeEntityId: item.placeKey, parentEntityId: item.referencePlaceKeys[0], item }));
  const ownershipDecision = skipPlaces ? { updates: new Map(), rejected: new Set(), compatible: new Set() } : resolvePlaceParentBatch([...localIntents, ...locatedParents], { preservePreviousRefinements: false });
  const localParents = new Map([...ownershipDecision.updates].map(([id, value]) => [id, new Set(value.cleared ? [null] : value.parents.keys())]));
  const oldParents = envelope.scope.parentEntityIdsByPlaceId ?? new Map();
  const lineage = id => {
    const result = new Set(); let next = id;
    while (next && !result.has(next)) { result.add(next); const parents = oldParents.get(next); next = parents?.size === 1 ? [...parents][0] : null; }
    return result;
  };
  const invalidPlaces = new Set([...spatialPlaces.keys()].filter(key => parentDecision.rejected.has(placeToken(key)) || ownershipDecision.rejected.has(key))), checking = new Set(), checked = new Set();
  const knownParentThroughNewPlaces = key => {
    let current = key;
    while (current && checked.has(current) && !invalidPlaces.has(current)) {
      const binding = bindingByKey.get(spatialPlaces.get(current).entityKey);
      if (binding && !freshPlaceIds.has(binding.entityId)) return binding;
      const parents = localParents.get(current);
      current = parents?.size === 1 ? [...parents][0] : null;
    }
    return null;
  };
  const check = key => {
    if (checked.has(key)) return !invalidPlaces.has(key);
    if (checking.has(key)) { invalidPlaces.add(key); return false; }
    checking.add(key);
    const mention = spatialPlaces.get(key), parents = localParents.get(key), binding = bindingByKey.get(mention.entityKey);
    if (parents?.size > 1) invalidPlaces.add(key);
    const parentKey = parents?.size === 1 ? [...parents][0] : null;
    if (parentKey && !check(parentKey)) invalidPlaces.add(key);
    const parent = parentKey && spatialPlaces.get(parentKey);
    if (mention.identityChange && (!binding || !parent&&!(parents?.size===1&&parents.has(null)))) invalidPlaces.add(key);
    if (binding && parent && mention.identityChange !== 'ownershipChanged') {
      const known = oldParents.get(binding.entityId);
      const parentBinding = bindingByKey.get(parent.entityKey);
      if (known?.size !== undefined && known.size !== 1) invalidPlaces.add(key);
      else if (known?.size === 1) {
        const expectedParent = [...known][0];
        if (parentBinding && !freshPlaceIds.has(parentBinding.entityId)) {
          if (!lineage(expectedParent).has(parentBinding.entityId) && !lineage(parentBinding.entityId).has(expectedParent)) invalidPlaces.add(key);
        } else {
          // A new subdivision must lead back inside the old parent, not just to a shared ancestor.
          const anchor = knownParentThroughNewPlaces(parentKey);
          if (!anchor || !lineage(anchor.entityId).has(expectedParent)) invalidPlaces.add(key);
        }
      }
    }
    mention.allowPlaceAliasLearning = !invalidPlaces.has(key);
    checking.delete(key); checked.add(key);
    return !invalidPlaces.has(key);
  };
  for (const key of spatialPlaces.keys()) check(key);
  for (const [key, mention] of spatialPlaces) {
    if (invalidPlaces.has(key)) { issue('spatialFacts.places', key, 'V3_EXTRACTOR_SPATIAL_PLACE_SCOPE_CONFLICT', 'spatialFacts.places'); spatialPlaces.delete(key); }
    else target.entityMentions.push(mention);
  }
  for (const location of target.locations) {
    const label = identityLabelKey(location.name);
    const matches = [...spatialPlaces.values()].filter(mention => [mention.surface, ...mention.aliases, ...(bindingByKey.get(mention.entityKey)?.labels ?? [])].some(value => identityLabelKey(value) === label));
    if (matches.length === 1) location.entityMentionKey = matches[0].mentionKey;
  }
  const normalizedSpatialFacts = { schemaVersion: 1, places: [...spatialPlaces.keys()].map(placeMentionKey => ({ placeMentionKey })), containments: [], positions: [] };
  for (const [index, item] of containmentItems.entries()) {
    if (!useContainment(item)) continue;
    const placeMentionKey = semanticText(item, ['placeKey'], 80), parentMentionKey = item?.parentPlaceKey===null?null:semanticText(item, ['parentPlaceKey'], 80);
    const evidenceRefs = spatialEvidence(item),revision=spatialPlaces.get(placeMentionKey)?.identityChange==='ownershipChanged';
    if (!spatialPlaces.has(placeMentionKey) || !(spatialPlaces.has(parentMentionKey)||parentMentionKey===null&&revision) || placeMentionKey === parentMentionKey || !evidenceRefs.length) {
      issue('spatialFacts.containments', index, 'V3_EXTRACTOR_SPATIAL_FACT_INVALID', `spatialFacts.containments[${index}]`, !parentMentionKey ? 'parentPlaceKeyMissing' : !spatialPlaces.has(parentMentionKey) ? 'unknownParentPlaceKey' : placeMentionKey === parentMentionKey ? 'selfParent' : spatialFailureReason(item, placeMentionKey, 'invalidContainmentFields')); continue;
    }
    normalizedSpatialFacts.containments.push({placeMentionKey,parentMentionKey,evidence:evidenceRefs,...(revision?{identityChange:'ownershipChanged'}:{})});
  }
  for (const [index, item] of spatialArray('positions').entries()) {
    const subjectMentionKey = mentionFor(field(item, ['subject', 'person', 'name', '人物']));
    const subject = people.find(person => person.mentionKey === subjectMentionKey);
    const placeMentionKey = semanticText(item, ['placeKey'], 80) || null;
    const evidenceRefs = spatialEvidence(item), status = semanticText(item, ['status'], 40);
    if (!subject || !['person', 'group'].includes(subject.entityType) || (placeMentionKey && !spatialPlaces.has(placeMentionKey))
      || !['confirmed', 'lastSeen', 'leftUnknown'].includes(status) || (status !== 'leftUnknown' && !placeMentionKey) || !evidenceRefs.length) {
      issue('spatialFacts.positions', index, 'V3_EXTRACTOR_SPATIAL_POSITION_INVALID', `spatialFacts.positions[${index}]`, !subject ? 'subjectUnmatched' : spatialFailureReason(item, placeMentionKey, 'invalidPositionFields')); continue;
    }
    normalizedSpatialFacts.positions.push({ subjectMentionKey, placeMentionKey, status, evidence: evidenceRefs });
  }
  const relations = [];
  for (const [index, item] of relationItems.entries()) {
    const parentIntent = locatedParents.find(intent => intent.item === item);
    if (parentIntent && !ownershipDecision.compatible.has(parentIntent)) continue;
    const placeMentionKey = semanticText(item, ['placeKey'], 80), kind = field(item, ['kind']);
    const referenceMentionKeys = field(item, ['referencePlaceKeys']), text = semanticText(item, ['text'], 1000), evidenceRefs = spatialEvidence(item);
    if (!spatialPlaces.has(placeMentionKey) || !['locatedIn', 'onFloor', 'relative'].includes(kind) || !Array.isArray(referenceMentionKeys)
      || referenceMentionKeys.length > 2 || new Set(referenceMentionKeys).size !== referenceMentionKeys.length || referenceMentionKeys.some(key => !spatialPlaces.has(key) || key === placeMentionKey)
      || kind === 'locatedIn' && referenceMentionKeys.length !== 1 || kind === 'onFloor' && referenceMentionKeys.length > 1 || !text || !evidenceRefs.length) {
      issue('spatialFacts.relations', index, 'V3_EXTRACTOR_SPATIAL_RELATION_INVALID', `spatialFacts.relations[${index}]`, spatialFailureReason(item, placeMentionKey, 'invalidRelationFields')); continue;
    }
    relations.push({ kind, placeMentionKey, referenceMentionKeys, text, evidence: evidenceRefs });
  }
  if (relations.length) normalizedSpatialFacts.relations = relations;
  const features = [];
  for (const [index, item] of spatialArray('features').entries()) {
    const placeMentionKey = semanticText(item, ['placeKey'], 80), key = semanticText(item, ['key'], 80);
    const text = semanticText(item, ['text'], 1000), evidenceRefs = spatialEvidence(item);
    const replacesKeys = field(item, ['replacesKeys']);
    if (!spatialPlaces.has(placeMentionKey) || !/^feature-[1-9]\d*$/u.test(key) || !text || !evidenceRefs.length || !Array.isArray(replacesKeys) || replacesKeys.length > 40 || replacesKeys.some(key => typeof key !== 'string')) {
      issue('spatialFacts.features', index, 'V3_EXTRACTOR_SPATIAL_FEATURE_INVALID', `spatialFacts.features[${index}]`, spatialFailureReason(item, placeMentionKey, 'invalidFeatureFields')); continue;
    }
    const rawKind = field(item, ['kind']);
    if (rawKind !== undefined && !['stable', 'temporary'].includes(rawKind)) {
      issue('spatialFacts.features', index, 'V3_EXTRACTOR_SPATIAL_FEATURE_KIND_INVALID', `spatialFacts.features[${index}].kind`); continue;
    }
    features.push({ key, placeMentionKey, ...(rawKind !== undefined ? { kind: rawKind } : {}), text, replacesKeys, evidence: evidenceRefs });
  }
  if (features.length) normalizedSpatialFacts.features = features;
  if (normalizedSpatialFacts.containments.length || normalizedSpatialFacts.positions.length || features.length || relations.length) target.spatialFacts = normalizedSpatialFacts;
  for (const [index, item] of boundedItems(['events', 'event', 'eventFragments', '事件'], 'events').entries()) {
    const description = semanticText(item, ['description', 'summary', 'event', 'action', 'text', '描述', '事件']);
    if (!description) { issue('events', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `events[${index}]`); continue; }
    const title = semanticText(item, ['title', 'name', '标题'], 500) || description.slice(0, 80);
    target.eventFragments.push({ title, description, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['actions', 'action', '行动', '动作'], 'actions').entries()) {
    const action = semanticText(item, ['action', 'description', 'summary', 'event', 'content', 'text', '行为', '行动', '动作', '事件']);
    if (!action) { issue('actions', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `actions[${index}].action`); continue; }
    const actorValue = field(item, ['actor', 'subject', 'person', 'who', '行为主体', '执行者']);
    if (actorValue === undefined || actorValue === null) {
      const title = semanticText(item, ['title', 'name', '标题'], 500) || action.slice(0, 80);
      target.eventFragments.push({ title, description: action, evidence: evidence(item) });
      continue;
    }
    const actorMentionKey = mentionFor(actorValue);
    if (!actorMentionKey) { issue('actions', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `actions[${index}].actor`); continue; }
    const completion = enumOr(semanticText(item, ['completion', 'status', 'state', '完成状态']), {
      intended: 'intended', intent: 'intended', planned: 'intended', '意图': 'intended', '计划': 'intended',
      attempted: 'attempted', attempt: 'attempted', '尝试': 'attempted',
      completed: 'completed', complete: 'completed', done: 'completed', '完成': 'completed', '已完成': 'completed',
      interrupted: 'interrupted', interruptedbeforecompletion: 'interrupted', '中断': 'interrupted', '被打断': 'interrupted',
      uncertain: 'uncertain', unknown: 'uncertain', '不确定': 'uncertain',
    }, 'uncertain');
    const targetMentionKeys = list(field(item, ['targets', 'target', 'to', 'recipients', 'beneficiaries', 'objects', '受事者', '对象', '受益者'])).map(mentionFor).filter(Boolean);
    const result = semanticText(item, ['result', 'outcome', '结果'], 2000) || null;
    target.actions.push({ actorMentionKey, targetMentionKeys, action, completion, result, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['knowledge', 'facts', 'observations', 'information', '知识', '事实', '观察'], 'knowledge').entries()) {
    const description = semanticText(item, ['description', 'content', 'fact', 'text', 'knowledge', '内容', '描述']);
    if (!description) { issue('knowledge', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `knowledge[${index}]`); continue; }
    const kind = enumOr(semanticText(item, ['kind', 'type']), { physical: 'physical', injury: 'injury', object: 'object', environment: 'environment', situational: 'situational', other: 'other', '身体': 'physical', '受伤': 'injury', '环境': 'environment', '情境': 'situational' }, 'other');
    target.observations.push({ subjectMentionKey: mentionFor(field(item, ['subject', 'person', 'owner'])), kind, description, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['informationTransfers', 'transfers', 'communications', '信息转交', '消息转交', '通信'], 'informationTransfers').entries()) {
    const claimText = semanticText(item, ['claimText', 'claim', 'content', 'message', 'information', 'text', '内容', '消息'], 2000);
    if (!claimText) { issue('informationTransfers', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `informationTransfers[${index}].claimText`); continue; }
    const fromValue = field(item, ['from', 'sender', 'speaker', 'issuer', '消息来源', '发送人']);
    const fromMentionKey = fromValue === undefined || fromValue === null ? null : mentionFor(fromValue);
    if (fromValue !== undefined && fromValue !== null && !fromMentionKey) { issue('informationTransfers', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `informationTransfers[${index}].from`); continue; }
    const toValue = field(item, ['to', 'recipients', 'recipient', 'targets', 'audience', '接收者', '收信人']);
    const rawRecipients = list(toValue);
    const toMentionKeys = rawRecipients.map(mentionFor).filter(Boolean);
    if (rawRecipients.length && !toMentionKeys.length) { issue('informationTransfers', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `informationTransfers[${index}].to`); continue; }
    const channelKey = normalizedKey(semanticText(item, ['channel', 'method', 'mode', '渠道', '方式'], 80));
    const channel = {
      told: 'told', tell: 'told', said: 'told', '告知': 'told', '口头告知': 'told',
      shown: 'shown', show: 'shown', '展示': 'shown', '出示': 'shown',
      written: 'written', write: 'written', '书面': 'written', '写下': 'written',
      overheard: 'overheard', overhear: 'overheard', '无意听见': 'overheard', '偷听': 'overheard',
      discovered: 'discovered', discover: 'discovered', '发现': 'discovered',
    }[channelKey] ?? null;
    if (!channel) { issue('informationTransfers', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `informationTransfers[${index}].channel`); continue; }
    target.informationTransfers.push({ fromMentionKey, toMentionKeys, claimText, channel, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['privateThoughts', 'privateCognition', 'thoughts', '私下想法', '内心'], 'privateThoughts').entries()) {
    const content = semanticText(item, ['content', 'thought', 'description', 'text', '内容', '想法']);
    const ownerMentionKey = mentionFor(field(item, ['owner', 'holder', 'person', 'subject']));
    if (!content) { issue('privateThoughts', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `privateThoughts[${index}].content`); continue; }
    if (!ownerMentionKey) { issue('privateThoughts', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `privateThoughts[${index}].owner`); continue; }
    const kind = enumOr(semanticText(item, ['kind', 'type']), { thought: 'thought', emotion: 'emotion', intention: 'intention', dream: 'dream', privatedecision: 'privateDecision', suspicion: 'suspicion', '情绪': 'emotion', '意图': 'intention', '决定': 'privateDecision', '怀疑': 'suspicion' }, 'thought');
    target.privateCognition.push({ ownerMentionKey, kind, content, expressedPublicly: false, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['commitments', 'promises', 'agreements', '承诺', '约定'], 'commitments').entries()) {
    const content = semanticText(item, ['content', 'description', 'promise', 'text', '内容', '承诺']);
    const speakerMentionKey = mentionFor(field(item, ['speaker', 'issuer', 'from', 'person']));
    if (!content) { issue('commitments', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `commitments[${index}].content`); continue; }
    if (!speakerMentionKey) { issue('commitments', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `commitments[${index}].speaker`); continue; }
    const kind = enumOr(semanticText(item, ['kind', 'type']), { promise: 'promise', agreement: 'agreement', command: 'command', codephrase: 'codePhrase', plan: 'plan', boundary: 'boundary', '约定': 'agreement', '命令': 'command', '暗号': 'codePhrase', '计划': 'plan', '边界': 'boundary' }, 'promise');
    const status = enumOr(semanticText(item, ['status', 'state']), { made: 'made', accepted: 'accepted', refused: 'refused', uncertain: 'uncertain', '接受': 'accepted', '拒绝': 'refused', '不确定': 'uncertain' }, 'made');
    const exactText = literalText(item, ['exactQuote', 'exactText', 'quote', '原话'], 2000) || null;
    target.commitments.push({ speakerMentionKey, targetMentionKeys: list(field(item, ['targets', 'target', 'to', 'recipient', 'recipients', 'people'])).map(mentionFor).filter(Boolean), kind, content, status, exactText, evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['exactQuotes', 'quotes', 'exactAnchors', '原句', '引文'], 'exactQuotes').entries()) {
    const exactText = literalText(item, ['text', 'exactText', 'quote', 'content', '原句', '引文']);
    if (!exactText) { issue('exactQuotes', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `exactQuotes[${index}]`); continue; }
    const source = semanticSource(item, exactText, floor, envelope);
    if (!source) {
      issue('exactQuotes', index, 'V3_EXTRACTOR_ANCHOR_NOT_FOUND', `exactQuotes[${index}]`);
      continue;
    }
    const kind = enumOr(semanticText(item, ['kind', 'type']), { promise: 'promise', codephrase: 'codePhrase', wording: 'wording', number: 'number', date: 'date', riddle: 'riddle', title: 'title', other: 'other', '承诺': 'promise', '暗号': 'codePhrase', '数字': 'number', '日期': 'date', '谜语': 'riddle', '标题': 'title' }, 'wording');
    target.exactAnchors.push({ kind, exactText, speakerMentionKey: mentionFor(field(item, ['speaker', 'person'])), whyPreserve: semanticText(item, ['why', 'reason', 'whyPreserve', '原因'], 1000) || '关键原句', sourceFloorKey: source.floorKey, sourceType: source.sourceType, ...(source.sourceType === 'precedingUser' ? { sourceSnapshotIndex: source.sourceSnapshotIndex } : {}) });
  }
  for (const [index, item] of boundedItems(['openLoops', 'unresolved', 'unfinished', 'looseEnds', '未决事项', '悬念'], 'openLoops').entries()) {
    const description = semanticText(item, ['description', 'content', 'text', '内容', '描述']);
    if (!description) { issue('openLoops', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `openLoops[${index}]`); continue; }
    target.openLoops.push({ description, ownerMentionKeys: list(field(item, ['owners', 'people', 'persons'])).map(mentionFor).filter(Boolean), evidence: evidence(item) });
  }
  for (const [index, item] of boundedItems(['cseSignals', 'signals', 'relationshipSignals', '关系信号'], 'cseSignals').entries()) {
    const description = semanticText(item, ['description', 'content', 'text', '内容', '描述']);
    const subjectMentionKey = mentionFor(field(item, ['subject', 'person', 'from']));
    if (!description || !subjectMentionKey) { issue('cseSignals', index, 'V3_EXTRACTOR_OPTIONAL_ITEM_INVALID', `cseSignals[${index}]`); continue; }
    const signalType = enumOr(semanticText(item, ['signalType', 'type', 'kind']), { emotion: 'emotion', boundary: 'boundary', conflict: 'conflict', reconciliation: 'reconciliation', vulnerability: 'vulnerability', trust: 'trust', betrayal: 'betrayal', repeatedpattern: 'repeatedPattern', relationdefinition: 'relationDefinition', persistentcondition: 'persistentCondition', other: 'other', '情绪': 'emotion', '边界': 'boundary', '冲突': 'conflict', '和解': 'reconciliation', '信任': 'trust', '背叛': 'betrayal' }, 'other');
    target.cseSignals.push({ subjectMentionKey, objectMentionKey: mentionFor(field(item, ['object', 'target', 'to'])), signalType, description, evidence: evidence(item) });
  }
  let normalized = await normalizeLegacyExtractorResponse({ response: legacy, envelope, floor, existingEntities, now, supersedes, preservedSummary, expectedScope });
  if (!skipPlaces) normalized={...normalized,memory:await placeCurrentMemory(normalized.memory,pathResult.foundationPatch,floor,envelope)};
  const referenced = collectFloorMemoryEntityIds(normalized.memory);
  return Object.freeze({ ...normalized, newEntities: Object.freeze([...normalized.newEntities, ...pathResult.freshEntities.filter(entity => referenced.has(entity.id))]),
    foundationPatch: skipPlaces ? pathResult.foundationPatch : completePlaceCurrentPatch(pathResult.foundationPatch,normalized.memory), isolated: Object.freeze([...isolated, ...normalized.isolated].slice(0, 80)), needsReview: false, qianshiPacket: packet });
}

async function compileSemanticPacket(options) {
  const unavailable = options.envelope?.scope?.identityProjection?.unavailableSources?.includes('places');
  if (!unavailable) {
    try { return await compileSemanticPacketDomains(options); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Validate the same acquired response without the optional domain. Required
      // summary, body identity and scope checks still run and must all succeed.
      try {
        const result = await compileSemanticPacketDomains({ ...options, skipPlaces: true });
        return Object.freeze({ ...result, placeUnavailable: true, isolated: Object.freeze([...result.isolated,
          { field: 'places', index: -1, code: 'V3_EXTRACTOR_PLACE_COMPILE_FAILED', path: 'places' }]) });
      } catch { throw error; }
    }
  }
  const result = await compileSemanticPacketDomains({ ...options, skipPlaces: true });
  return Object.freeze({ ...result, placeUnavailable: true, isolated: Object.freeze([...result.isolated,
    { field: 'places', index: -1, code: 'V3_EXTRACTOR_PLACE_SOURCE_UNAVAILABLE', path: 'places' }]) });
}

export async function normalizeExtractorResponse(options) {
  const compiled = await compileSemanticPacket(options);
  const { qianshiPacket, ...normalized } = compiled;
  let qianshiDelta;
  try {
    qianshiDelta = await compileQianshiDelta({ packet: qianshiPacket, floor: options.floor,
      sourceFloorBindings: options.envelope?.scope?.sourceFloorBindings,
      candidateBindings: [...(options.envelope?.scope?.qianshiCandidateBindings ?? []), ...(options.qianshiCandidateBindings ?? [])],
      candidateStats: options.envelope?.scope?.qianshiCandidateStats,
      entities: options.existingEntities ?? [], identityProjection: options.envelope?.scope?.identityProjection,
      compiledBindings: options.qianshiCompiledBindings, now: options.now });
  } catch {
    // 千事异常只让本次千事增量无效，不重试摘要；旧档读取仍兼容缺少该字段。
    qianshiDelta = await compileQianshiDelta({ packet: null, floor: options.floor, sourceFloorBindings: options.envelope?.scope?.sourceFloorBindings, candidateStats: options.envelope?.scope?.qianshiCandidateStats, now: options.now });
  }
  const memoryWithQianshi = validateFloorMemory({ ...normalized.memory, qianshiDelta }, { expectedChatId: options.floor.chatId });
  const withQianshi = Object.freeze({ ...normalized, memory: memoryWithQianshi });
  const clock = options.envelope?.request?.payload?.storyClock;
  // 日期与钟点独立决定精度；未知或冲突的星期不遮蔽它们。
  const complete = clock?.complete && clock.start?.date && clock.start?.time && clock.end?.date && clock.end?.time;
  const pairs = (Array.isArray(clock?.pairs) && clock.pairs.length ? clock.pairs : complete ? [{ start: clock.start, end: clock.end }] : [])
    .filter(pair => [pair.start, pair.end].some(value => value?.date || value?.time));
  const singleEnd = clock?.singleEnd === true && clock.end?.date && clock.end?.time;
  const canonicalTime = inferCanonicalCurrentTime(options.floor?.content?.canonicalContent);
  const referenceText = typeof clock?.referenceText === 'string' ? clock.referenceText.trim().slice(0, 500) : '';
  if (!pairs.length && !singleEnd && !canonicalTime && withQianshi.memory.chronology.length
    && (!referenceText || clock?.namespace?.startsWith('tag:'))) {
    return withQianshi;
  }
  if (!pairs.length && !singleEnd && !referenceText && !canonicalTime && clock?.start && !clock?.end) {
    return withQianshi;
  }
  const clockPart = value => [value?.date ?? (value?.time ? '日期未知' : null), value?.weekday, value?.time].filter(Boolean).join(' ');
  const end = clockPart(clock?.end);
  const sourceText = pairs.length ? `${clockPart(pairs[0].start)} → ${clockPart(pairs[0].end)}`.slice(0, 500)
    : singleEnd ? end.slice(0, 500) : '';
  const fallbackText = sourceText || referenceText || canonicalTime?.text || '时间未明确';
  const chronology = pairs.length ? await Promise.all(pairs.map(async (pair, index) => {
    const pairText = `${clockPart(pair.start)} → ${clockPart(pair.end)}`.slice(0, 500);
    const itemIdInput = ['v3-floor-memory-story-clock', options.expectedScope.batchId, options.floor.id, clock?.namespace ?? 'unknown', pair.start?.raw ?? null, pair.end?.raw ?? null];
    if (pairs.length > 1) itemIdInput.push(index);
    return {
      itemId: await deterministicUuid(itemIdInput),
      time: { kind: 'explicit', sourceText: pairText, normalized: null, precision: pair.start?.date && pair.start?.time && pair.end?.date && pair.end?.time ? 'exact' : 'unresolved', relativeToFloorId: null },
      description: pairText,
      evidenceRefs: [],
    };
  })) : [{
    itemId: await deterministicUuid(['v3-floor-memory-story-clock', options.expectedScope.batchId, options.floor.id, clock?.namespace ?? 'unknown', clock?.start?.raw ?? null, clock?.end?.raw ?? null, ...(referenceText ? [referenceText] : [])]),
    time: { kind: sourceText ? 'explicit' : referenceText ? 'unknown' : canonicalTime?.kind ?? 'unknown', sourceText: fallbackText, normalized: null, precision: complete || singleEnd ? 'exact' : referenceText ? 'unresolved' : canonicalTime ? 'approximate' : 'unresolved', relativeToFloorId: null },
    description: fallbackText,
    evidenceRefs: [],
  }];
  const memory = validateFloorMemory({ ...withQianshi.memory, chronology }, { expectedChatId: options.floor.chatId });
  return Object.freeze({ ...withQianshi, memory, storyClockSource: clock?.namespace ?? null });
}

export function inferCanonicalCurrentTime(canonicalContent, { allowOpeningFallback = true } = {}) {
  const source = String(canonicalContent ?? '');
  const safeSource = source.replace(/<!--[\s\S]*?-->/gu, ' ');
  const numericDatePattern = '(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|(?:(?<![\\p{L}\\p{N}])|(?<=[至到]))(?:\\d{2,4}年\\s*)?\\d{1,2}月\\s*\\d{1,2}日|(?:(?<![\\p{L}\\p{N}])|(?<=[至到]))(?:[\\p{L}]{1,12})?\\d{1,4}年\\s*(?:(?![0-9零〇一二两兩三四五六七八九壹贰貳叁參叄肆伍陆陸柒捌玖十拾百佰千仟廿卄卅卌初月日号號])\\p{L}){1,12}?\\s*(?:初)?[0-9零〇一二两兩三四五六七八九十拾廿卄卅卌]+日)';
  const chineseNumber = '[0-9零〇一二两兩三四五六七八九十拾百佰千仟廿卄卅卌]+';
  const datePattern = `(?:(?:[\\p{L}]{0,12}?${chineseNumber}年\\s*)?(?:闰|閏)?(?:${chineseNumber}|正|冬|腊|臘|[\\p{L}]{1,12}?)月\\s*(?:初)?${chineseNumber}(?:日|号|號)?|${numericDatePattern})`;
  const numericClockPattern = '(?:(?:上午|下午|中午|正午|晚上|凌晨|清晨|早晨|早上|夜里|夜间|夜間|午夜|AM|PM)?\\s*\\d{1,2}[：:]\\d{2}\\s*(?:AM|PM)?)';
  const traditionalClockPattern = `(?:[（(]\\s*)?(?:(?:大约|大約|大概|约莫|约|約)\\s*)?${TRADITIONAL_CLOCK_PATTERN}(?:\\s*(?:左右|前后|前後|上下|[（(]\\s*(?:左右|前后|前後|上下|约|約)\\s*[）)]))?(?:[）)])?`;
  const clockPattern = `(?:${numericClockPattern}|${traditionalClockPattern}|(?<![\\p{L}\\p{N}])[子丑寅卯辰巳午未申酉戌亥](?![\\p{L}\\p{N}]))`;
  const rangeSeparator = '(?:→|->|⟶|至|到|[~～—–－]|\\s-\\s|(?<=\\d)-(?=\\d))';
  const explicitDate = `(?:${datePattern})(?:\\s*(?:周|星期)[一二三四五六日天])?`;
  const explicitPattern = `(?:${explicitDate})(?:\\s*${clockPattern})?(?:\\s*${rangeSeparator}\\s*(?:${explicitDate}|${clockPattern}))?|${clockPattern}(?:\\s*${rangeSeparator}\\s*${clockPattern})?`;
  const relativePattern = '(?:次日|翌日|第二天|当天|当晚|翌晨|随后|片刻后|不久后|[一二三四五六七八九十百两\\d]+(?:分钟|小时|天|周|个月|年)(?:前|后))';
  const timeValue = new RegExp(explicitPattern, 'u');
  const dateValue = new RegExp(datePattern, 'iu');
  const hasDate = value => {
    const date = dateValue.exec(String(value ?? ''))?.[0];
    return Boolean(date && projectTime(date).date);
  };
  const isClock = isStoryClockOnly;
  const parts = value => {
    const dates = [...String(value).matchAll(new RegExp(datePattern, 'giu'))].map(match => match[0].trim());
    const rawClocks = [...String(value).matchAll(new RegExp(clockPattern, 'giu'))].map(match => match[0].trim());
    const clocks = rawClocks.filter(isClock);
    const weekdays = [...String(value).matchAll(/(?:周|星期)[一二三四五六日天]/gu)].map(match => match[0]);
    if (dates.length === 1 && !hasDate(dates[0])) return null;
    if (dates.length > 1 || clocks.length > 1 || weekdays.length > 1) return { ambiguous: true, signature: JSON.stringify([dates, clocks, weekdays]) };
    if (!dates.length && !clocks.length) return null;
    return { text: [dates[0], weekdays[0], clocks[0]].filter(Boolean).join(' '), kind: 'explicit' };
  };
  const candidates = [];
  const add = (candidate, priority, depth = 0) => { if (candidate) candidates.push({ ...candidate, priority, depth }); };
  const isStatusName = name => /(?:^|[_-])status(?:$|[_-])/iu.test(name) || /^(?:statusbar|story_status)$/iu.test(name);
  const excluded = /^(?:chat_history|status_history|history|events?|timeline|records?|details|think|thinking|snow|reasoning|archive|log|due|deadline)$/iu;
  const excludedTags = ['chat_history', 'status_history', 'history', 'events', 'event', 'timeline', 'records', 'details', 'think', 'thinking', 'snow', 'reasoning', 'archive', 'log', 'due', 'deadline'];
  const blocks = readMemoryTagBlocks(safeSource).filter(block => block.closed
    && !excluded.test(block.name) && !block.ancestors.some(name => excluded.test(name)));
  for (const block of blocks) {
    const plain = stripMemoryTagBlocks(block.rawContent, excludedTags).replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
    const direct = block.directText.replace(/\s+/gu, ' ').trim();
    for (const match of direct.matchAll(/(?:故事时间|当前时间|现在时间|本楼时间)\s*[：:=]\s*([^\r\n]+)/giu)) {
      const candidate = parts(match[1]);
      if (candidate && (candidate.ambiguous ? hasDate(match[1]) : hasDate(candidate.text))) add(candidate, 5, block.depth);
    }
    const statusContainer = isStatusName(block.name) || block.ancestors.some(isStatusName);
    for (const match of direct.matchAll(/\bTime\s*[:：]\s*([^\]\r\n]*)/giu)) {
      const candidate = parts(match[1]);
      if (candidate && (candidate.ambiguous ? hasDate(match[1]) : hasDate(candidate.text))) add(candidate, statusContainer ? 4 : 3, block.depth);
    }
    const childFields = readMemoryTagBlocks(block.rawContent).filter(field => field.name === 'date' || field.name === 'time')
      .filter(field => field.closed && !field.ancestors.some(name => excluded.test(name)));
    const fieldGroups = new Map();
    for (const field of childFields) {
      const parentKey = field.parentRange ? field.parentRange.join(':') : 'root';
      const group = fieldGroups.get(parentKey) ?? { date: [], time: [] };
      group[field.name].push(field);
      fieldGroups.set(parentKey, group);
    }
    for (const group of fieldGroups.values()) {
      if (group.date.length > 1 || group.time.length > 1) add({ ambiguous: true, signature: JSON.stringify([group.date.length, group.time.length]) }, 4, block.depth);
      else if (group.date.length === 1 && group.time.length === 1) {
        const dateText = group.date[0].rawContent.replace(/<[^>]*>/gu, ' ').trim();
        const clockText = group.time[0].rawContent.replace(/<[^>]*>/gu, ' ').trim();
        add(parts(`${dateText} ${clockText}`), 4, block.depth);
      }
    }
    const currentHeadings = [...plain.matchAll(/当前状态|本楼状态|此刻状态/gu)];
    for (const heading of currentHeadings) {
      const current = plain.slice(heading.index + heading[0].length, heading.index + heading[0].length + 240);
      const structured = parts(current), explicit = current.match(timeValue)?.[0];
      const candidate = structured ?? (explicit ? { text: explicit.trim(), kind: 'explicit' } : null);
      if (candidate && (candidate.ambiguous ? hasDate(current) : hasDate(candidate.text))) add(candidate, 4, block.depth);
    }
    const semanticContainer = /^(?:time|clock|date|status|statusbar|status_bar|story_status|时间|状态|状态栏|时间栏)$/iu.test(block.name) || statusContainer;
    const values = [...plain.matchAll(new RegExp(explicitPattern, 'gu'))].map(match => match[0]);
    const containsHistory = /历史|回忆|过去|此前|之前|旧记录|截止|到期|deadline|due|event|事件|Date\s*\/\s*Event/iu.test(plain);
    const uniqueValue = values.length === 1 ? parts(values[0]) : null;
    const uniqueValueHasDate = uniqueValue?.ambiguous ? hasDate(values[0]) : hasDate(uniqueValue?.text);
    if (semanticContainer && !containsHistory && uniqueValue && uniqueValueHasDate) add(uniqueValue, 2, block.depth);
    const sceneCluster = /(?:当前场景|本楼场景|场景|地点|在场人物)/u.test(plain);
    if (!semanticContainer && sceneCluster && !containsHistory && uniqueValue && uniqueValueHasDate) add(uniqueValue, 2, block.depth);
  }
  const opening = safeSource.split(/\r?\n/u, 1)[0].slice(0, 400);
  const openingCandidate = parts(opening);
  const openingDateIndex = opening.search(dateValue);
  const openingPrefix = openingDateIndex < 0 ? '' : opening.slice(0, openingDateIndex).trim();
  const openingPrefixValid = !openingPrefix || /^[\p{P}\p{S}\s]*$/u.test(openingPrefix)
    || /^(?:(?:当前|本楼)?(?:场景|地点|日期|时间)|Time)\s*[:：=]?\s*$/iu.test(openingPrefix);
  if (openingCandidate && openingDateIndex >= 0 && openingPrefixValid) add(openingCandidate, 1, 0);
  if (candidates.length) {
    const priority = Math.max(...candidates.map(candidate => candidate.priority));
    const priorityWinners = candidates.filter(candidate => candidate.priority === priority);
    const depth = Math.max(...priorityWinners.map(candidate => candidate.depth));
    const winners = priorityWinners.filter(candidate => candidate.depth === depth);
    const texts = [...new Set(winners.filter(candidate => candidate.text).map(candidate => candidate.text.replace(/\s+/gu, ' ').trim()))];
    if (winners.some(candidate => candidate.ambiguous) || texts.length > 1) return Object.freeze({ kind: 'ambiguous', signature: JSON.stringify(winners.map(candidate => candidate.signature ?? candidate.text ?? '').sort()) });
    if (texts.length === 1) return Object.freeze({ text: texts[0], kind: 'explicit' });
  }
  if (!allowOpeningFallback) return null;
  const openingFallback = safeSource.slice(0, 400);
  const explicit = new RegExp(`^\\s*(?:【[^】]{0,40}】\\s*)?(?:日期\\s*[：:]\\s*)?(${explicitPattern})`, 'iu').exec(openingFallback)?.[1] ?? '';
  if (explicit && hasDate(explicit)) return Object.freeze({ text: explicit, kind: 'explicit' });
  const relative = new RegExp(`^\\s*(?:【[^】]{0,40}】\\s*)?(${relativePattern})`, 'u').exec(openingFallback)?.[1] ?? '';
  return relative ? Object.freeze({ text: relative, kind: 'relative' }) : null;
}

export function buildExtractorTaskOptions({ envelope, promptGuidance = '', processingPrompt = '', aggregate = false }) {
  return {
    promptTask: aggregate ? 'summaryBatch' : 'summary',
    promptOwnerId: envelope.scope?.chatId,
    systemPrompt: aggregate ? buildHighFloorExtractorSystemPrompt(promptGuidance, processingPrompt) : buildExtractorSystemPrompt(promptGuidance, processingPrompt),
    taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }],
    maxTokens: 30000, temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic',
  };
}

export async function runExtractorRequest({ generateUtilityTask, envelope, floor, existingEntities = [], now, supersedes = null, preservedSummary = null, expectedScope, promptGuidance = '', processingPrompt = '', aggregate = false, signal, transportBudget = { remaining: 3, used: 0 } }) {
  if (typeof generateUtilityTask !== 'function') throw new TypeError('V3 Extractor utility route unavailable');
  if (!expectedScope) throw extractorError('V3_EXTRACTOR_LOCAL_SCOPE_INVALID', 'expectedScope');
  const validationErrors = [];
  const taskOptions = buildExtractorTaskOptions({ envelope, promptGuidance, processingPrompt, aggregate });
  for (let attempts = 1; attempts <= (transportBudget.totalAttempts ?? 3); attempts += 1) {
    let candidate = null, metadata = sanitizeTaskMetadata(null), responseFingerprint = null, receivedResult = false;
    try {
      const result = await generateUtilityTask({ ...taskOptions, signal, transportBudget });
      receivedResult = true;
      if (transportBudget.diagnostic) Object.assign(transportBudget.diagnostic, { phase: 'normalize', phaseStartedAt: Date.now(), attemptEndedAt: Date.now(), outcome: 'running', endedAt: null });
      candidate = result?.jsonData ?? result?.textData ?? result;
      metadata = sanitizeTaskMetadata(result?.taskMetadata);
      responseFingerprint = `sha256:${await sha256(JSON.stringify(candidate))}`;
      const normalized = await normalizeExtractorResponse({ response: candidate, finishReason: result?.taskMetadata?.finishReason, envelope, floor, existingEntities, now, supersedes, preservedSummary, expectedScope });
      const successfulIssues = normalized.isolated.map(item => ({ code: item.code, path: item.path, field: item.field, index: item.index }));
      return Object.freeze({ ...normalized, attempts, transportAttempts: transportBudget.used || metadata.transportAttempts, metadata, responseFingerprint, validationErrors: Object.freeze([...validationErrors, ...successfulIssues].slice(-20)) });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      if (error?.name === 'AbortError') throw error;
      if (transportBudget.diagnostic) {
        const code = /^(?:QQJ|V3)_[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : null;
        const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'TimeoutError'].includes(error?.name) ? error.name : null;
        const status = error?.httpStatus ?? error?.status;
        if (receivedResult || transportBudget.diagnostic.lastAttemptError?.attempt !== transportBudget.used || transportBudget.diagnostic.lastAttemptError?.code !== code) {
          transportBudget.diagnostic.lastAttemptError = { code, name, httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, at: Date.now(), attempt: transportBudget.used, phase: transportBudget.diagnostic.phase };
        }
        const failure = transportBudget.diagnostic.lastAttemptError;
        Object.assign(transportBudget.diagnostic, { outcome: 'failed', error: { code: failure.code, name: failure.name, httpStatus: failure.httpStatus, at: failure.at }, endedAt: Date.now() });
      }
      const formatStage = error?.formatStage ?? null;
      validationErrors.push({ code: String(error?.code ?? 'V3_EXTRACTOR_REQUEST_FAILED').slice(0, 120), path: String(error?.validationPath ?? '').slice(0, 500), formatStage: formatStage ? String(formatStage).slice(0, 120) : null });
      const retryable = receivedResult || error?.retryableRecognitionFormat === true || ['QQJ_TIMEOUT', 'QQJ_EMPTY'].includes(error?.code);
      if (retryable && attempts < (transportBudget.totalAttempts ?? 3) && transportBudget.remaining > 0) continue;
      let sessionCandidate = null;
      if (candidate !== null) {
        try { sessionCandidate = JSON.stringify(candidate).slice(0, 24000); } catch { sessionCandidate = '[候选无法序列化]'; }
      }
      error.extractorDiagnostics = { attempts, transportAttempts: transportBudget.used || error?.transportAttempts || error?.taskMetadata?.transportAttempts || null, metadata: sanitizeTaskMetadata(error?.taskMetadata ?? metadata), httpStatus: Number.isSafeInteger(error?.httpStatus ?? error?.status) ? (error.httpStatus ?? error.status) : null, providerError: sanitizeDiagnosticValue(error?.providerError ?? null), responseFingerprint, validationErrors: validationErrors.slice(-20), formatStage, sessionCandidate };
      throw error;
    }
  }
}
