import { buildCseSystemPrompt } from './analysis-prompts.js';
export { DEFAULT_CSE_GUIDANCE, CSE_FIXED_CONTRACT, CSE_SYSTEM_PROMPT, buildCseSystemPrompt } from './analysis-prompts.js';
import { auxiliaryStateSnapshotForPrompt } from './floor-variable-reference.js';
import { sha256 } from '../identity.js';
import { parseJsonWithSymbolRepair, repairJsonWithUniqueMissingObjectClose } from '../json-symbol-repair.js';
import { scanWorldInfo } from '../world-info-scanner.js';
import { sanitizeMemoryContent } from '../memory-content-sanitizer.js';
import { deterministicUuid } from './foundation-domain.js';
import { validateEntityRecord } from './memory-schema.js';
import { sanitizeDiagnosticValue, sanitizeTaskMetadata } from './safe-metadata.js';
import { sanitizeCompletionDiagnostic } from '../completion-diagnostic.js';
import { projectCseSubjectDiagnostic } from './cse-failure-diagnostic.js';
import { CSE_ISOLATION_CODES, CSE_VISIBILITIES, LATEST_CSE_CALIBRATION_VERSION, isSupportedCseCalibrationVersion, stateFingerprint, validateBaselineRecord, validateCurrentStateRecord, validateStateDeltaRecord } from './cse-schema.js';
import { buildEntityIdentityDirectory, identityLabelKey } from './entity-identity.js';
import { compileIdentityFacts, identityFactBindings, identityFactsForPrompt, identityFactsText, sameIdentityFacts } from './identity-brief.js';
import { normalizeCseQuantification, advanceAdaptiveStrength, cseQuantificationFields, isCseQuantificationOnlyChange } from './cse-quantification.js';

export const CSE_PROMPT_VERSION = 'qqj-v3-cse-prompt-55';
export const CSE_COMPILER_VERSION = 'qqj-v3-cse-prompt-2/calibration-compiler-24';
export const CSE_CALIBRATION_VERSION = LATEST_CSE_CALIBRATION_VERSION;

const normalized = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const errorWith = (code, message) => { const error = new TypeError(message ?? code); error.code = code; return error; };
const text = (value, maximum = 4000) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const list = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const field = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  for (const name of names) {
    const found = entries.find(([key]) => normalized(key) === normalized(name));
    if (found) return found[1];
  }
  return undefined;
};
const char = (ctx) => Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
const personaDescription = ctx => text(ctx?.powerUserSettings?.persona_description ?? ctx?.personaDescription ?? ctx?.persona?.description ?? '', 40000);
const cardText = (character, names) => text(names.map(name => character?.data?.[name] ?? character?.[name]).find(value => typeof value === 'string') ?? '', 40000);
const aliasRecord = name => ({ name, normalized: normalized(name), kind: 'canonical', evidenceRefs: [], baselineClaimIds: [] });

export async function verifyCseBaselineFingerprint(baseline) {
  const payload = { userPersona: baseline.userPersona, characterCard: baseline.characterCard, worldInfoSources: baseline.worldInfoSources };
  return baseline.fingerprint === `sha256:${await sha256(JSON.stringify(payload))}`;
}

function entityLabels(entity) {
  return [entity.displayName, ...(entity.aliases ?? []).map(alias => alias.name)].map(normalized).filter(Boolean);
}

async function roleEntity({ chatId, narrativeGeneration, role, name, aliases = [], now }) {
  const id = await deterministicUuid(['v3-cse-role-entity', chatId, narrativeGeneration, role]);
  const displayName = text(name, 500) || (role === 'user' ? '用户' : '角色');
  const names = [...new Set([displayName, ...aliases.map(value => text(value, 500)).filter(Boolean)])];
  return validateEntityRecord({
    schemaVersion: 3, recordType: 'entity', id, chatId, narrativeGeneration,
    entityType: 'person', displayName,
    aliases: names.map(aliasRecord), specialRole: role,
    firstSeenFloorId: null, lastSeenFloorId: null, status: 'established', mergedIntoEntityId: null,
    mergeEvidenceRefs: [], baselineClaimIds: [], createdAt: now, updatedAt: now,
    recordStatus: 'active', supersedes: null,
  }, { expectedChatId: chatId });
}

export async function captureCseBaseline({ hostAdapter, chatId, narrativeGeneration, entities = [], sanitizerOptions = {}, now }) {
  const snapshot = hostAdapter.snapshot();
  const ctx = snapshot.context;
  const userIdentity = snapshot.userIdentity;
  const character = char(ctx) ?? {};
  const user = entities.find(entity => entity.specialRole === 'user' && entity.recordStatus === 'active')
    ?? await roleEntity({ chatId, narrativeGeneration, role: 'user', name: userIdentity.displayName, aliases: userIdentity.aliases, now });
  const characterName = text(ctx?.name2 ?? character?.name ?? character?.data?.name ?? '角色', 500);
  const matchingCharacter = entities.filter(entity => entity.recordStatus === 'active' && entityLabels(entity).includes(normalized(characterName)));
  const characterEntity = entities.find(entity => entity.specialRole === 'char' && entity.recordStatus === 'active')
    ?? (matchingCharacter.length === 1 ? matchingCharacter[0] : null)
    ?? await roleEntity({ chatId, narrativeGeneration, role: 'char', name: characterName, aliases: [characterName, '{{char}}'], now });
  let catalog = { entries: [], warnings: [] };
  try { catalog = await scanWorldInfo(ctx, { bindings: hostAdapter.getWorldInfoBindings?.() ?? {} }); } catch { /* Luker/旧宿主缺少世界书接口时安全降级为空 */ }
  const worldInfoSources = [];
  for (const entry of catalog.entries ?? []) {
    if (entry.hostEnabled === false || entry.disabled === true) continue;
    const content = sanitizeMemoryContent(entry.content, sanitizerOptions);
    if (!content) continue;
    worldInfoSources.push({
      sourceKind: 'worldbook', sourceName: text(entry.source, 512), scope: text(entry.scope, 80) || 'unknown',
      locator: `${text(entry.source, 240)}:${text(entry.uid, 120)}`, enabled: true,
      activated: entry.activated === true, content, fingerprint: `sha256:${await sha256(content)}`, visibility: 'authorial',
    });
  }
  const payload = {
    userPersona: { entityId: user.id, name: user.displayName, description: personaDescription(ctx), aliases: [...new Set(userIdentity.aliases ?? [])] },
    characterCard: { entityId: characterEntity.id, name: characterEntity.displayName, description: cardText(character, ['description']), personality: cardText(character, ['personality']), scenario: cardText(character, ['scenario']) },
    worldInfoSources,
  };
  const fingerprint = `sha256:${await sha256(JSON.stringify(payload))}`;
  const id = await deterministicUuid(['v3-cse-baseline', chatId, narrativeGeneration]);
  const baseline = validateBaselineRecord({ schemaVersion: 3, recordType: 'baseline', id, chatId, narrativeGeneration, ...payload, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: chatId });
  return Object.freeze({ baseline, roleEntities: Object.freeze([user, characterEntity]), warnings: Object.freeze(catalog.warnings ?? []) });
}

export async function createBaselineRoleEntities(baseline) {
  const user = await roleEntity({ chatId: baseline.chatId, narrativeGeneration: baseline.narrativeGeneration, role: 'user', name: baseline.userPersona.name, aliases: baseline.userPersona.aliases, now: baseline.createdAt });
  const character = await roleEntity({ chatId: baseline.chatId, narrativeGeneration: baseline.narrativeGeneration, role: 'char', name: baseline.characterCard.name, aliases: [baseline.characterCard.name, '{{char}}'], now: baseline.createdAt });
  return Object.freeze([
    user.id === baseline.userPersona.entityId ? user : Object.freeze({ ...user, id: baseline.userPersona.entityId }),
    character.id === baseline.characterCard.entityId ? character : Object.freeze({ ...character, id: baseline.characterCard.entityId }),
  ]);
}

export function cseReferencedEntityIds(memory) {
  const result = new Set();
  const add = value => { if (typeof value === 'string') result.add(value); };
  memory.participants?.forEach(item => { if (item.presence === 'present' || item.presence === 'remote') add(item.entityId); });
  memory.actions?.forEach(item => { add(item.actorEntityId); item.targetEntityIds?.forEach(add); });
  memory.informationTransfers?.forEach(item => { add(item.fromEntityId); item.toEntityIds?.forEach(add); });
  memory.privateCognition?.forEach(item => add(item.ownerEntityId));
  memory.commitments?.forEach(item => { add(item.speakerEntityId); item.targetEntityIds?.forEach(add); });
  memory.cseSignals?.forEach(item => { add(item.subjectEntityId); add(item.objectEntityId); });
  return result;
}

export function selectTrackedSubjects({ entities = [], floorMemory }) {
  const referenced = cseReferencedEntityIds(floorMemory);
  for (const item of floorMemory.participants ?? []) referenced.add(item.entityId);
  for (const item of floorMemory.observations ?? []) referenced.add(item.subjectEntityId);
  for (const item of floorMemory.locations ?? []) for (const id of item.participantEntityIds ?? []) referenced.add(id);
  for (const item of floorMemory.openLoops ?? []) for (const id of item.ownerEntityIds ?? []) referenced.add(id);
  for (const item of floorMemory.exactAnchors ?? []) referenced.add(item.speakerEntityId);
  for (const item of floorMemory.qianshiDelta?.events ?? []) for (const person of item.people ?? []) referenced.add(person.entityId);
  const active = new Map(entities.filter(entity => entity.recordStatus === 'active' && entity.status !== 'merged'
    && entity.status !== 'invalidated' && entity.entityType === 'person').map(entity => [entity.id, entity]));
  return [...referenced].flatMap(id => active.has(id) ? [active.get(id)] : []);
}

function semanticMemory(memory, entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity.displayName]));
  const mapIds = value => Array.isArray(value) ? value.map(id => byId.get(id)).filter(Boolean) : byId.get(value) ?? null;
  return {
    summary: memory.summary?.effectiveSource === 'user' ? memory.summary.userText : memory.summary?.aiText,
    chronology: memory.chronology,
    locations: memory.locations?.map(item => ({ name: item.name, change: item.change, participants: mapIds(item.participantEntityIds) })),
    participants: memory.participants?.map(item => ({ person: mapIds(item.entityId), presence: item.presence })),
    actions: memory.actions?.map(item => ({ actor: mapIds(item.actorEntityId), targets: mapIds(item.targetEntityIds), action: item.action, completion: item.completion, result: item.result })),
    observations: memory.observations?.map(item => ({ subject: mapIds(item.subjectEntityId), kind: item.kind, description: item.description })),
    informationTransfers: memory.informationTransfers?.map(item => ({ from: mapIds(item.fromEntityId), to: mapIds(item.toEntityIds), claim: item.claimText, channel: item.channel })),
    privateCognition: memory.privateCognition?.map(item => ({ owner: mapIds(item.ownerEntityId), kind: item.kind, content: item.content, visibility: 'private' })),
    commitments: memory.commitments?.map(item => ({ speaker: mapIds(item.speakerEntityId), targets: mapIds(item.targetEntityIds), kind: item.kind, content: item.content, status: item.status })),
    cseSignals: memory.cseSignals?.map(item => ({ subject: mapIds(item.subjectEntityId), object: mapIds(item.objectEntityId), type: item.signalType, description: item.description })),
  };
}

function subjectRelevantEvidence(memory, tracked, entities) {
  const semantic = semanticMemory(memory, entities);
  // 同一条楼层事实按主体保留各自关系，这里只省去重复内容，不改原 FloorMemory。
  const related = (items, relationFor) => (items ?? []).flatMap((_item, index) => {
    const relationToSubject = relationFor(index);
    return relationToSubject.length ? [{ index, relationToSubject }] : [];
  });
  return tracked.map(entity => {
    const sections = {
      participants: related(semantic.participants, index => memory.participants?.[index]?.entityId === entity.id ? ['participant'] : []),
      actions: related(semantic.actions, index => {
        const item = memory.actions?.[index];
        return [item?.actorEntityId === entity.id ? 'actor' : null, item?.targetEntityIds?.includes(entity.id) ? 'target' : null].filter(Boolean);
      }),
      observations: related(semantic.observations, index => memory.observations?.[index]?.subjectEntityId === entity.id ? ['subject'] : []),
      informationTransfers: related(semantic.informationTransfers, index => {
        const item = memory.informationTransfers?.[index];
        return [item?.fromEntityId === entity.id ? 'sender' : null, item?.toEntityIds?.includes(entity.id) ? 'recipient' : null].filter(Boolean);
      }),
      privateCognition: related(semantic.privateCognition, index => memory.privateCognition?.[index]?.ownerEntityId === entity.id ? ['owner'] : []),
      commitments: related(semantic.commitments, index => {
        const item = memory.commitments?.[index];
        return [item?.speakerEntityId === entity.id ? 'speaker' : null, item?.targetEntityIds?.includes(entity.id) ? 'target' : null].filter(Boolean);
      }),
      cseSignals: related(semantic.cseSignals, index => {
        const item = memory.cseSignals?.[index];
        return [item?.subjectEntityId === entity.id ? 'subject' : null, item?.objectEntityId === entity.id ? 'object' : null].filter(Boolean);
      }),
    };
    return { subject: entity.displayName, ...Object.fromEntries(Object.entries(sections).filter(([, items]) => items.length)) };
  });
}

function semanticItems(items, entities, { includeReason = true, category } = {}) {
  const byId = new Map(entities.map(entity => [entity.id, entity.displayName]));
  return items.map(item => ({ text: item.text, visibility: item.visibility, ...(includeReason ? { reason: item.reason } : {}), origin: item.origin, ...(item.towardEntityId ? { toward: byId.get(item.towardEntityId) ?? null } : {}), ...cseQuantificationFields(item, category) }));
}

function previousSubjectsForPrompt(currentState, tracked) {
  const trackedIds = new Set(tracked.map(entity => entity.id));
  return (currentState?.subjects ?? []).filter(subject => trackedIds.has(subject.subjectEntityId));
}

function previousForPrompt(subjects, entities, coreUserEditedSubjectEntityIds) {
  return subjects.map(subject => {
    const owner = entities.find(entity => entity.id === subject.subjectEntityId);
    // Core/Adaptive 旧 reason 是前次解释，请求只传状态语义；Situational 复核沿用原观察依据。
    return { subject: owner?.displayName ?? '未知人物', coreUserEdited: coreUserEditedSubjectEntityIds.has(subject.subjectEntityId), ownState: {
      core: semanticItems(subject.core, entities, { includeReason: false, category: 'core' }), adaptive: semanticItems(subject.adaptive, entities, { includeReason: false, category: 'adaptive' }), situational: semanticItems(subject.situational, entities, { category: 'situational' }),
    } };
  });
}

function cseEvidenceSources({ floor, baseline, currentUserInput, requestSources }) {
  const userPersona = requestSources.userPersona ?? baseline.userPersona;
  const characterCard = requestSources.characterCard ?? baseline.characterCard;
  const worldInfoSources = requestSources.worldInfoSources ?? baseline.worldInfoSources;
  const sources = [
    { source: 'canonicalContent', kind: 'story', subjectEntityId: null, contents: [floor.content.canonicalContent] },
    { source: 'userPersona', kind: 'authorialSetting', subjectEntityId: baseline.userPersona.entityId, contents: [userPersona.description] },
    // 角色卡可包含多人设定，具体人物归属由正文语义判断，不固定归给卡名对应实体。
    { source: 'characterCard', kind: 'authorialSetting', subjectEntityId: null, contents: [characterCard.description, characterCard.personality, characterCard.scenario] },
    ...worldInfoSources.map((entry, index) => ({ source: `worldbook:${index + 1}`, kind: 'authorialSetting', subjectEntityId: null, contents: [entry.content],
      ...(entry.locator ? { locator: entry.locator } : {}), ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}) })),
  ];
  if (requestSources.authorNote?.content) sources.push({ source: 'authorNote', kind: 'authorialReference', subjectEntityId: null, contents: [requestSources.authorNote.content] });
  const userInputContents = Array.isArray(currentUserInput?.messages)
    ? currentUserInput.messages.map(message => message?.content).filter(content => typeof content === 'string' && content)
    : (currentUserInput?.content ? [currentUserInput.content] : []);
  if (userInputContents.length) sources.push({ source: 'currentUserInput', kind: 'userInput', subjectEntityId: null, contents: userInputContents });
  return sources;
}

function currentUserInputPayload(value) {
  if (Array.isArray(value?.messages) && value.messages.length) {
    return { source: 'currentUserInput', messages: value.messages.map((message, sourceSnapshotIndex) => ({ sourceSnapshotIndex: Number.isSafeInteger(message?.sourceSnapshotIndex) ? message.sourceSnapshotIndex : sourceSnapshotIndex, messageIndex: message?.messageIndex, content: message?.content })) };
  }
  return value?.content ? { source: 'currentUserInput', messageIndex: value.messageIndex, content: value.content } : null;
}

function authorialOtherStateContext(currentState, entities, previousSubjectIds) {
  const visible = items => items.filter(item => item.visibility !== 'private' && item.visibility !== 'authorial');
  return (currentState?.subjects ?? []).filter(subject => !previousSubjectIds.has(subject.subjectEntityId)).map(subject => ({
    subject: entities.find(entity => entity.id === subject.subjectEntityId)?.displayName ?? '未知人物',
    core: semanticItems(visible(subject.core), entities, { includeReason: false, category: 'core' }),
    adaptive: semanticItems(visible(subject.adaptive), entities, { includeReason: false, category: 'adaptive' }),
    situational: semanticItems(visible(subject.situational), entities, { category: 'situational' }),
  }));
}


export function createCseEnvelope({ floor, floorMemory, baseline, currentState, trackedSubjects, entities, floorOrder = null, identityDirectory = null, identityBriefTargets = [], requestSources = null, worldInfoSources = null, currentUserInput = null, coreUserEditedSubjectEntityIds = [], identityMemberEntityIdsBySubject = {}, relevantPriorContext = '', userCoreExtraction = null, userAdaptiveHistory = [], relationHistory = [], reviewUserAdaptive = true }) {
  const directory = identityDirectory ?? buildEntityIdentityDirectory({ entities, floorOrder });
  const directoryById = new Map(directory.map(entry => [entry.entityId, entry]));
  const labelsFor = entity => directoryById.get(entity.id)?.labels ?? entityLabels(entity);
  const activeKnownEntities = directory.filter(entry => entry.entityType === 'person' || entry.specialRole !== 'none');
  const trackedIds = new Set(trackedSubjects.map(entity => entity.id));
  const reviewCandidates = (currentState?.subjects ?? []).filter(subject => !trackedIds.has(subject.subjectEntityId)
    && subject.situational.some(item => item.origin !== 'manual'))
    .map(subject => directoryById.get(subject.subjectEntityId)?.entity)
    .filter(entity => entity?.entityType === 'person');
  const candidateBindings = [...trackedSubjects, ...reviewCandidates].map(entity => ({ entityId: entity.id, labels: labelsFor(entity), specialRole: entity.specialRole }));
  // 旧情境的新增复核资格保持当前主体的唯一绑定。
  const reviewSubjects = reviewCandidates.filter(entity => labelsFor(entity).every(label => matchingBindings(label, candidateBindings).length === 1))
    .slice(0, Math.max(0, 80 - trackedSubjects.length));
  const reviewOnlyIds = new Set(reviewSubjects.map(entity => entity.id));
  const outputSubjects = [...trackedSubjects, ...reviewSubjects];
  const requestWorldInfoSources = Array.isArray(worldInfoSources) ? worldInfoSources : baseline.worldInfoSources;
  const effectiveSources = requestSources && typeof requestSources === 'object' ? requestSources : {
    userPersona: baseline.userPersona,
    characterCard: baseline.characterCard,
    worldInfoSources: requestWorldInfoSources,
    authorNote: Object.freeze({ content: '' }),
    fingerprint: null,
  };
  const effectiveUserPersona = effectiveSources.userPersona ?? baseline.userPersona;
  const effectiveCharacterCard = effectiveSources.characterCard ?? baseline.characterCard;
  const effectiveWorldInfoSources = Array.isArray(effectiveSources.worldInfoSources) ? effectiveSources.worldInfoSources : requestWorldInfoSources;
  const sourceLocationReference = Array.isArray(floorMemory.sourceFloorSnapshots)
    ? floorMemory.sourceFloorSnapshots.find(snapshot => snapshot.floorId === floor.id)?.locationReference
    : floorMemory.sourceLocationReference;
  const evidenceSources = cseEvidenceSources({ floor, baseline, currentUserInput, requestSources: { ...effectiveSources, worldInfoSources: effectiveWorldInfoSources } });
  const coreUserEdited = new Set(coreUserEditedSubjectEntityIds);
  const previousSubjects = previousSubjectsForPrompt(currentState, outputSubjects);
  const previousSubjectIds = new Set(previousSubjects.map(subject => subject.subjectEntityId));
  const nameForSubjectId = entityId => directoryById.get(entityId)?.displayName
    ?? (entityId === baseline.userPersona.entityId ? baseline.userPersona.name : entityId === baseline.characterCard.entityId ? baseline.characterCard.name : null);
  const userEntityId = baseline.userPersona.entityId;
  const userBindings = trackedSubjects.filter(entity => entity.id === userEntityId || identityMemberEntityIdsBySubject?.[entity.id]?.includes(userEntityId));
  const userBinding = userBindings.length === 1 ? userBindings[0] : null;
  const previousUser = userBinding && previousSubjects.find(subject => subject.subjectEntityId === userBinding.id);
  const userAdaptiveReview = reviewUserAdaptive && userBinding && !(previousUser?.adaptive?.length)
    ? {
      subject: nameForSubjectId(userBinding.id) ?? effectiveUserPersona.name,
      task: '独立检查用户自己的长期 Adaptive；自身与明确对象分开判断，不镜像。只用请求材料，符合既有证据合同才更新，否则留空。历史最多含3个完整楼、合计6000字符；从历史归纳新增时，须判断至少两个彼此独立的事件，并在同一新增项引用 canonicalContent 或 currentUserInput 中能确认该模式当前仍适用的原句。不同楼号或多个 quote 不代表独立事件，同一连续事件链只算一个；不得补猜未提供的历史。明确作者设定或纠正仍按原合同处理。历史只供该用户 Adaptive，不用于 Core、Situational、他人状态或角色知识；不复制 Core，不强迫填满。此独立任务只检查该用户 Adaptive；本楼对所有 trackedSubjects 的常规分析照常进行。',
    }
    : null;
  const userAdaptiveSources = userAdaptiveReview ? userAdaptiveHistory.map(entry => ({
    source: `userAdaptiveHistory:${entry.floorId}`, kind: 'userAdaptiveHistory',
    subjectEntityId: baseline.userPersona.entityId, contents: [entry.content, ...(entry.precedingUserInput?.messages ?? []).map(message => message.content)],
  })) : [];
  evidenceSources.push(...userAdaptiveSources);
  const relationHistorySources = relationHistory.map(entry => ({ source: entry.source, kind: 'relationHistory',
    pairEntityIds: entry.pairEntityIds, contents: [JSON.stringify(entry.record), ...(entry.quotes ?? [])] }));
  evidenceSources.push(...relationHistorySources);
  const baselineEntityIds = new Set([baseline.userPersona?.entityId, baseline.characterCard?.entityId].filter(Boolean));
  const briefTargets = identityBriefTargets.flatMap((target, index) => {
    const entry = directoryById.get(target?.entityId);
    if (!entry || entry.entityType !== 'person' || entry.specialRole !== 'none' || baselineEntityIds.has(entry.entityId)) return [];
    return [{ key: `npc-${index + 1}`, entityId: entry.entityId, name: target.name ?? entry.displayName,
      aliases: target.labels ?? entry.labels,
      identityBriefSource: entry.identityBriefSource,
      ...((target.identityBrief ?? entry.identityBrief) ? { identityBrief: target.identityBrief ?? entry.identityBrief } : {}) }];
  }).slice(0, 80);
  return Object.freeze({
    request: Object.freeze({ task: 'understandCharacterStateAfterFloor', locale: 'zh-CN', payload: {
      ...(userCoreExtraction?.hasDescription ? { userCoreExtraction: {
        subject: nameForSubjectId(userCoreExtraction.userEntityId) ?? effectiveUserPersona.name,
        task: '独立核验 relevantBaseline.userPersona.description 中用户本人的稳定长期核心特质，不把短期情绪、一次行为、角色扮演表现或推测当作事实。此任务不依赖本楼是否有变化，也不依赖 previousState 是否已有 Core；不得以“本楼无变化”或“旧 Core 为空”为由跳过。有明确长期特质且可由 Persona 原句支持时，在 subjects 中仅将内容放入该用户的 additions.core，并同时返回 userCoreExtraction:{status:"traits"}；依据不足时不要新增 Core，并返回 userCoreExtraction:{status:"insufficient"}。新增项 evidence 必须使用 userPersona 和逐字原句。不得仅凭 Persona 改动其他人物或其他分类；本楼对其他 trackedSubjects 的常规状态分析仍照常进行。',
      } } : {}),
      ...(userAdaptiveReview ? { userAdaptiveReview } : {}),
      canonicalContent: floor.content.canonicalContent,
      floorMemory: semanticMemory(floorMemory, entities),
      ...(Array.isArray(sourceLocationReference) && sourceLocationReference.length ? { sourceLocationReference: {
        label: '对应来源楼原消息地点标注（仅补充参照；正文和人工修订优先，不代表当前位置或人物在场）',
        values: sourceLocationReference,
      } } : {}),
      ...(floorMemory.sourceVariableReference ? { auxiliaryStateSnapshot: auxiliaryStateSnapshotForPrompt(floorMemory.sourceVariableReference) } : {}),
      previousState: previousSubjects.map(previous => {
        const subject = previousForPrompt([previous], entities, coreUserEdited)[0];
        return reviewOnlyIds.has(previous.subjectEntityId)
          ? { subject: subject.subject, reviewOnly: true, ownState: { situational: subject.ownState.situational.filter(item => item.origin !== 'manual') } }
          : subject;
      }),
      relevantBaseline: {
        userPersona: { name: effectiveUserPersona.name, description: effectiveUserPersona.description, visibility: 'authorial' },
        characterCard: { name: effectiveCharacterCard.name, description: effectiveCharacterCard.description, personality: effectiveCharacterCard.personality, scenario: effectiveCharacterCard.scenario, visibility: 'authorial' },
        worldInfo: effectiveWorldInfoSources.map((source, index) => ({ source: source.sourceName, evidenceSource: `worldbook:${index + 1}`, content: source.content, visibility: 'authorial', activated: source.activated })),
        authorNote: effectiveSources.authorNote?.content ? { evidenceSource: 'authorNote', content: effectiveSources.authorNote.content, visibility: 'authorialReference' } : null,
      },
      currentUserInput: currentUserInputPayload(currentUserInput),
      ...(userAdaptiveReview ? { userAdaptiveHistory: userAdaptiveHistory.map(entry => ({
        source: `userAdaptiveHistory:${entry.floorId}`, floorId: entry.floorId,
        assistantSeq: entry.assistantSeq, content: entry.content,
        ...(entry.precedingUserInput ? { precedingUserInput: entry.precedingUserInput } : {}),
      })) } : {}),
      ...(relationHistory.length ? { relationHistory: relationHistory.map(({ pairEntityIds, ...entry }) => entry) } : {}),
      ...(briefTargets.length ? { identityBriefTargets: briefTargets.map(({ key, name, aliases, identityBrief, identityBriefSource }) => ({ key, name, aliases,
        ...(identityBrief && !identityBriefSource?.facts?.length ? { identityBrief } : {}), ...(identityBriefSource?.facts?.length ? { identityFacts: identityFactsForPrompt(identityBriefSource, key) } : {}) })) } : {}),
      evidenceSourceCatalog: evidenceSources.map(source => ({ source: source.source, kind: source.kind,
        ...(source.subjectEntityId ? { subject: nameForSubjectId(source.subjectEntityId) }
          : source.kind === 'authorialSetting' ? { subjectScope: '按来源原文明确描述的人物' } : {}) })),
      subjectRelevantEvidence: subjectRelevantEvidence(floorMemory, trackedSubjects, entities),
      authorialOtherStateContext: authorialOtherStateContext(currentState, entities, previousSubjectIds),
      ...(relevantPriorContext ? { relevantPriorContext } : {}),
      trackedSubjects: outputSubjects.map(entity => ({ name: entity.displayName, aliases: labelsFor(entity), ...(reviewOnlyIds.has(entity.id) ? { reviewOnly: true } : { coreUserEdited: coreUserEdited.has(entity.id) }) })),
      knownPeople: activeKnownEntities.map(entry => ({ name: entry.displayName, aliases: entry.labels })),
    } }),
    scope: Object.freeze({
      floorId: floor.id, floorMemoryId: floorMemory.id, chatId: floor.chatId, narrativeGeneration: floor.narrativeGeneration, baselineId: baseline.id,
      trackedBindings: outputSubjects.map(entity => ({ entityId: entity.id, labels: labelsFor(entity), specialRole: entity.specialRole, ...(reviewOnlyIds.has(entity.id) ? { reviewOnly: true } : {}) })),
      knownBindings: activeKnownEntities.map(entry => ({ entityId: entry.entityId, labels: entry.labels, specialRole: entry.specialRole })),
      identityBriefBindings: briefTargets.map(({ key, entityId, identityBrief, identityBriefSource }) => ({ key, entityId, identityBrief: identityBrief ?? null,
        identityFacts: identityBriefSource?.facts ?? [], existingFacts: identityFactBindings(identityBriefSource, key) })),
      evidenceSources,
      sourceSnapshotFingerprint: typeof effectiveSources.fingerprint === 'string' ? effectiveSources.fingerprint : null,
      coreUserEditedSubjectEntityIds: [...coreUserEdited],
      userAdaptiveReview: Boolean(userAdaptiveReview),
      ...(userCoreExtraction ? { userCoreExtraction } : {}),
      identityMemberEntityIdsBySubject: Object.freeze(Object.fromEntries(outputSubjects.map(entity => [entity.id, Object.freeze([...new Set([entity.id, ...(identityMemberEntityIdsBySubject?.[entity.id] ?? [])].filter(id => typeof id === 'string' && id))])]))),
    }),
  });
}

const SITUATIONAL_FIELDS = Object.freeze(['situational', 'situation', '短期状态', '情境']);

function normalizeCsePacket(value, { rejectSituationalConflict = false } = {}) {
  const packet = Array.isArray(value) ? { subjects: value } : value;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return packet;
  let updates = null;
  for (const candidate of subjectResultCandidates(packet)) {
    const source = candidate.value;
    const entries = Array.isArray(source) ? source : [source];
    let changed = false;
    let conflict = false;
    const normalizedEntries = entries.map(subject => {
      if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return subject;
      const review = field(subject, ['review']);
      if (!review || typeof review !== 'object' || Array.isArray(review)) return subject;
      const reviewSituationalKey = Object.keys(review).find(key => normalized(key) === 'situational');
      if (!reviewSituationalKey) return subject;
      const reviewSituational = review[reviewSituationalKey];
      const topSituational = field(subject, SITUATIONAL_FIELDS);
      if (topSituational !== undefined) {
        if (rejectSituationalConflict && stableCandidate(topSituational) !== stableCandidate(reviewSituational)) conflict = true;
        return subject;
      }
      const nextReview = Object.fromEntries(Object.entries(review).filter(([key]) => key !== reviewSituationalKey));
      changed = true;
      return { ...subject, review: nextReview, situational: reviewSituational };
    });
    if (conflict) return null;
    if (changed) {
      updates ??= { ...packet };
      updates[candidate.key] = Array.isArray(source) ? normalizedEntries : normalizedEntries[0];
    }
  }
  return updates ?? packet;
}

function collectFencedBlocks(raw) {
  const blocks = [];
  let quoted = false, escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (!raw.startsWith('```', index)) continue;
    const headerEnd = raw.indexOf('\n', index + 3);
    if (headerEnd < 0) break;
    const start = headerEnd + 1;
    let innerQuoted = false, innerEscaped = false, close = -1;
    for (let cursor = start; cursor < raw.length; cursor += 1) {
      const inner = raw[cursor];
      if (innerQuoted) {
        if (innerEscaped) innerEscaped = false;
        else if (inner === '\\') innerEscaped = true;
        else if (inner === '"') innerQuoted = false;
        continue;
      }
      if (inner === '"') { innerQuoted = true; continue; }
      if (raw.startsWith('```', cursor)) { close = cursor; break; }
    }
    if (close < 0) break;
    blocks.push(raw.slice(start, close).trim());
    index = close + 2;
    quoted = false; escaped = false;
  }
  return blocks;
}

function parsePacketContent(raw, { finishReason } = {}) {
  raw = String(raw ?? '').trim();
  try { return normalizeCsePacket(JSON.parse(raw)); } catch { /* limited wrapper recovery */ }
  const symbolRepaired = parseJsonWithSymbolRepair(raw, { finishReason })?.value;
  if (symbolRepaired) return normalizeCsePacket(symbolRepaired);
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const bounded = raw.slice(start, end + 1);
    try { return normalizeCsePacket(JSON.parse(bounded)); } catch { /* fail below */ }
  }
  const repairedSuffix = repairJsonWithUniqueMissingObjectClose(raw, { finishReason, allowArray: true });
  if (repairedSuffix) return normalizeCsePacket(repairedSuffix);
  const repairedMiddle = repairJsonWithUniqueMissingObjectClose(raw, {
    finishReason,
    allowArray: true,
    scanMiddle: true,
    normalizeCandidate: parsed => normalizeCsePacket(parsed, { rejectSituationalConflict: true }),
    stableKey: stableCandidate,
    rejectOnNullNormalization: true,
  });
  if (repairedMiddle) return repairedMiddle;
  const error = new TypeError('CSE 返回不是可识别的 JSON。'); error.code = 'V3_CSE_FORMAT_INVALID'; throw error;
}

function formalPacketSignature(packet, { compareUserCoreExtraction = false } = {}) {
  const userCoreExtraction = field(packet, ['userCoreExtraction', '用户核心特质提取']);
  const extractionStatus = userCoreExtraction && typeof userCoreExtraction === 'object' && !Array.isArray(userCoreExtraction)
    ? normalized(field(userCoreExtraction, ['status', '状态'])) || null
    : null;
  return stableCandidate({ noMaterialChange: field(packet, ['noMaterialChange']) === true, subjects: selectSubjectResults(packet) ?? null,
    identityBriefUpdates: field(packet, ['identityBriefUpdates', '身份简介更新']) ?? null,
    ...(compareUserCoreExtraction ? { userCoreExtractionStatus: extractionStatus } : {}) });
}

function parsePacket(value, { finishReason, compareUserCoreExtraction = false } = {}) {
  if (Array.isArray(value)) return normalizeCsePacket(value);
  if (value && typeof value === 'object') return normalizeCsePacket(value);
  const raw = String(value ?? '').trim();
  try { return normalizeCsePacket(JSON.parse(raw)); } catch { /* wrapped JSON follows */ }

  const blocks = collectFencedBlocks(raw);
  if (blocks.length) {
    const candidates = [];
    for (const block of blocks) {
      try {
        const packet = parsePacketContent(block, { finishReason });
        if (hasRecognizableCseResult(packet)) candidates.push(packet);
      } catch (error) {
        if (error?.code === 'V3_CSE_SUBJECT_RESULT_AMBIGUOUS') throw error;
      }
    }
    if (candidates.length) {
      const signature = formalPacketSignature(candidates[0], { compareUserCoreExtraction });
      if (candidates.some(candidate => formalPacketSignature(candidate, { compareUserCoreExtraction }) !== signature)) {
        throw errorWith('V3_CSE_SUBJECT_RESULT_AMBIGUOUS', '模型返回了多份不同的人物状态，无法确认；请重新分析本楼。');
      }
      return reconcileQuantification(candidates);
    }
  }
  return parsePacketContent(raw, { finishReason });
}

const CSE_SUBJECT_RESULT_FIELDS = Object.freeze(['subjects', 'people', 'characters', 'states', '人物', '角色', '状态']);

function subjectResultCandidates(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return [];
  const entries = Object.entries(packet);
  const candidates = [];
  for (const name of CSE_SUBJECT_RESULT_FIELDS) {
    const found = entries.find(([key]) => normalized(key) === normalized(name));
    if (!found) continue;
    const value = found[1];
    if (Array.isArray(value) || (value && typeof value === 'object')) candidates.push({ name, key: found[0], value });
  }
  return candidates;
}

function stableCandidate(value) {
  if (Array.isArray(value)) return `[${value.map(stableCandidate).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => key !== 'quantification').sort().map(key => `${JSON.stringify(key)}:${stableCandidate(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Equivalent text packets share the result; only an agreed optional number survives.
function reconcileQuantification(values) {
  const first = values[0];
  if (Array.isArray(first)) return first.map((_, index) => reconcileQuantification(values.map(value => value?.[index])));
  if (!first || typeof first !== 'object') return first;
  return Object.fromEntries(Object.entries(first).flatMap(([key, value]) => {
    if (key === 'quantification') return values.every(item => stableCandidate(item?.[key]) === stableCandidate(value)) ? [[key, value]] : [];
    return [[key, reconcileQuantification(values.map(item => item?.[key]))]];
  }));
}

function selectSubjectResults(packet) {
  const candidates = subjectResultCandidates(packet);
  const nonempty = candidates.filter(({ value }) => Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
  if (nonempty.length > 1 && nonempty.some(candidate => stableCandidate(candidate.value) !== stableCandidate(nonempty[0].value))) {
    throw errorWith('V3_CSE_SUBJECT_RESULT_AMBIGUOUS', 'CSE 返回了互相冲突的人物状态字段。');
  }
  if (nonempty.length > 1) return reconcileQuantification(nonempty.map(candidate => candidate.value));
  const standard = candidates.find(candidate => candidate.name === 'subjects' && (Array.isArray(candidate.value) || candidate.value));
  if (standard && (Array.isArray(standard.value) ? standard.value.length > 0 : Object.keys(standard.value).length > 0)) return standard.value;
  if (nonempty.length) return nonempty[0].value;
  return standard?.value ?? candidates[0]?.value ?? undefined;
}

function hasRecognizableCseResult(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  if (field(packet, ['noMaterialChange']) === true) return true;
  const subjects = selectSubjectResults(packet);
  return Array.isArray(subjects) || Boolean(subjects && typeof subjects === 'object');
}

function matchingBindings(value, bindings) {
  const label = identityLabelKey(typeof value === 'string' ? value : field(value, ['subject', 'name', 'person', 'character', '主体', '人物', '姓名']));
  if (!label) return [];
  const userAlias = ['你', '主角', '用户', '{{user}}', 'user', 'player'].includes(label);
  return bindings.filter(binding => (userAlias && binding.specialRole === 'user') || binding.labels.some(candidate => identityLabelKey(candidate) === label));
}

function bindingFor(value, bindings) {
  const matches = matchingBindings(value, bindings);
  return matches.length === 1 ? matches[0] : null;
}

const visibility = value => ({ private: 'private', 私密: 'private', 内心: 'private', expressed: 'expressed', 表达: 'expressed', 已表达: 'expressed', observable: 'observable', 可观察: 'observable', shared: 'shared', 共享: 'shared', authorial: 'authorial', 作者设定: 'authorial' }[normalized(value)] ?? 'private');
const origin = value => ({ baseline: 'baseline', 初始设定: 'baseline', floor: 'floor', 本楼: 'floor', reasonableprogression: 'reasonableProgression', naturalprogression: 'reasonableProgression', 合理进展: 'reasonableProgression', 自然进展: 'reasonableProgression' }[normalized(value)] ?? 'floor');
const itemSemantic = item => typeof item === 'string' ? item.trim() : text(field(item, ['text', 'state', 'description', 'content', '状态', '描述', '内容']), 4000);
const stateMeaning = item => [item.text, item.visibility, item.reason, item.origin, item.towardEntityId ?? ''];
const storedProjection = subject => Object.fromEntries(['core', 'adaptive', 'situational'].map(category => [category,
  subject[category].map(item => [...stateMeaning(item), normalizeCseQuantification(item.quantification, category)])]));

async function compileItems({ raw, category, binding, knownBindings, deltaId, floorId, isolated, acceptedIntents }) {
  const output = [];
  for (const [index, item] of list(raw).slice(0, 120).entries()) {
    if (usesRelationHistory(item)) { isolated.push({ field: category, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); acceptedIntents.count += 1; continue; }
    const value = itemSemantic(item);
    if (!value) { isolated.push({ field: category, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); continue; }
    let towardEntityId = null;
    const towardRaw = category !== 'core' && typeof item === 'object' ? field(item, ['toward', 'target', 'object', '对谁', '对象']) : null;
    if (towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
      const matches = matchingBindings(towardRaw, knownBindings);
      const toward = matches.length === 1 ? matches[0] : null;
      if (!toward) { isolated.push({ field: category, index, code: 'V3_CSE_TOWARD_UNBOUND', label: towardRaw, matchCount: matches.length }); continue; }
      towardEntityId = toward.entityId;
    }
    const reason = typeof item === 'object' ? text(field(item, ['reason', 'because', '依据', '原因']), 4000) : '';
    output.push({ id: await deterministicUuid(['v3-cse-state-item', deltaId, binding.entityId, category, index, value, towardEntityId]), text: value, visibility: visibility(typeof item === 'object' ? field(item, ['visibility', '可见性']) : null), reason: reason || '未提供依据', origin: origin(typeof item === 'object' ? field(item, ['origin', '来源']) : null), towardEntityId, sourceFloorId: floorId, sourceDeltaId: deltaId, ...cseQuantificationFields(item, category === 'adaptive' ? null : category) });
    acceptedIntents.count += 1;
  }
  return output;
}

async function compileAfterStateCategory(options) {
  const output = await compileItems(options);
  if (options.category === 'adaptive' && options.previous.some(item => normalizeCseQuantification(item.quantification, 'adaptive'))) for (const item of output) {
    const matches = options.previous.filter(value => sameItemMeaning(value, item));
    const quantification = matches.length === 1 ? normalizeCseQuantification(matches[0].quantification, 'adaptive') : null;
    if (quantification) item.quantification = quantification;
  }
  if (Array.isArray(options.raw) && options.raw.length === 0) { options.acceptedIntents.count += 1; return output; }
  return output.length ? output : options.previous;
}

async function compileSituationalList(options) {
  const { raw } = options;
  if (Array.isArray(raw) || raw === null || raw === undefined || typeof raw !== 'object'
    || (!Object.hasOwn(raw, 'self') && !Object.hasOwn(raw, 'relations'))) return compileAfterStateCategory(options);
  if (!Array.isArray(raw.self) || !Array.isArray(raw.relations)) {
    options.isolated.push({ field: 'situational', index: 0, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' });
    return options.previous;
  }
  if (raw.self.length === 0 && raw.relations.length === 0) {
    options.acceptedIntents.count += 1;
    return [];
  }
  const self = raw.self.slice(0, 120).map(item => {
    const toward = field(item, ['toward', 'target', 'object', '对谁', '对象']);
    return toward !== undefined && toward !== null && String(toward).trim() ? null : item;
  });
  const relations = raw.relations.slice(0, Math.max(0, 120 - self.length)).map(item => {
    const toward = field(item, ['toward', 'target', 'object', '对谁', '对象']);
    return toward !== undefined && toward !== null && String(toward).trim() ? item : null;
  });
  return compileAfterStateCategory({ ...options, raw: [...self, ...relations] });
}

const categoryNames = category => category === 'core' ? ['core', '核心', '核心人格'] : ['adaptive', '适应', '长期适应'];
async function compileSituationalCategory(options) {
  const proposed = await compileSituationalList(options);
  const used = new Set();
  return proposed.map(item => {
    const index = options.previous.findIndex((previous, position) => !used.has(position) && sameItemMeaning(previous, item));
    if (index < 0) return item;
    used.add(index);
    const previous = options.previous[index];
    return previous.origin === 'manual' ? previous : { ...previous, ...cseQuantificationFields(item, 'situational') };
  });
}

const sameItemMeaning = (left, right) => normalized(left?.text) === normalized(right?.text)
  && (left?.towardEntityId ?? null) === (right?.towardEntityId ?? null)
  && left?.visibility === right?.visibility;

const EVIDENCE_QUOTE_STYLE = Object.freeze({
  '"': '"', '“': '"', '”': '"', '„': '"', '‟': '"', '＂': '"', '「': '"', '」': '"',
  "'": "'", '‘': "'", '’': "'", '‚': "'", '‛': "'", '＇': "'", '『': "'", '』': "'",
});

function normalizedEvidenceQuoteStyle(value) {
  return [...value].map(character => EVIDENCE_QUOTE_STYLE[character] ?? character).join('');
}

function locateEvidenceQuote(contents, quote) {
  for (const content of contents) if (typeof content === 'string' && content.includes(quote)) return quote;
  const normalizedQuote = normalizedEvidenceQuoteStyle(quote);
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    const index = normalizedEvidenceQuoteStyle(content).indexOf(normalizedQuote);
    if (index >= 0) return content.slice(index, index + quote.length);
  }
  return null;
}

const relationHistoryNamespace = value => typeof value === 'string' && /^\s*relation[\s_-]*history/iu.test(value.normalize('NFKC'));
const formalEntries = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).filter(([key]) => names.some(name => normalized(key) === normalized(name))) : [];
function usesRelationHistory(raw, names = ['evidence', '证据']) {
  return formalEntries(raw, names).some(([, refs]) => (Array.isArray(refs) ? refs : refs ? [refs] : [])
    .some(ref => formalEntries(ref, ['source', '来源']).some(([, source]) => relationHistoryNamespace(source))));
}

// Only the new namespace has this all-reference, whole-mutation gate. Old protocols retain their contract.
function relationHistoryEvidence(raw, { envelope, binding, category, original = null, index, isolated }) {
  if (!usesRelationHistory(raw)) return undefined;
  const reject = () => { isolated.push({ field: category, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); return null; };
  const groups = formalEntries(raw, ['evidence', '证据']);
  if (groups.length !== 1) return reject();
  const refs = groups[0][1];
  if (category !== 'adaptive' || !Array.isArray(refs) || !refs.length || refs.length > 20) return reject();
  const towardRaw = field(raw, ['toward', 'target', 'object', '对谁', '对象']);
  const towardMatches = towardRaw === undefined || towardRaw === null || !String(towardRaw).trim() ? [] : matchingBindings(towardRaw, envelope.scope.knownBindings);
  const towardEntityId = towardRaw === undefined || towardRaw === null || !String(towardRaw).trim() ? original?.towardEntityId : towardMatches.length === 1 ? towardMatches[0].entityId : null;
  if (!towardEntityId || towardEntityId === binding.entityId) return reject();
  const evidence = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return reject();
    if (formalEntries(ref, ['source', '来源']).length !== 1 || formalEntries(ref, ['quote', '引用']).length !== 1) return reject();
    const sourceName = field(ref, ['source', '来源']), quote = field(ref, ['quote', '引用']);
    if (typeof sourceName !== 'string' || sourceName.length > 160 || typeof quote !== 'string' || !quote.trim() || quote.length > 2000) return reject();
    const source = envelope.scope.evidenceSources.find(candidate => candidate.source === sourceName);
    const located = source && locateEvidenceQuote(source.contents, quote);
    if (!source || !located || source.subjectEntityId && source.subjectEntityId !== binding.entityId) return reject();
    if (source.kind === 'relationHistory' && !source.pairEntityIds?.some(pair => pair.length === 2 && pair.includes(binding.entityId) && pair.includes(towardEntityId))) return reject();
    evidence.push({ source: source.source, kind: source.kind, quote: located });
  }
  if (!evidence.some(ref => ref.kind === 'relationHistory') || !evidence.some(ref => ref.source === 'canonicalContent' || ref.source === 'currentUserInput')) return reject();
  return Object.freeze(evidence);
}

function calibratedEvidence(raw, { envelope, binding, category, index, isolated }) {
  const evidence = [];
  const allSubmitted = list(field(raw, ['evidence', '证据']));
  const submitted = allSubmitted.slice(0, 20);
  for (const [evidenceIndex, item] of submitted.entries()) {
    const sourceName = text(field(item, ['source', '来源']), 160);
    const quote = text(field(item, ['quote', '引用']), 2000);
    const source = envelope.scope.evidenceSources.find(candidate => candidate.source === sourceName);
    const path = `${category}.${index}.evidence.${evidenceIndex}`;
    const locatedQuote = source && quote ? locateEvidenceQuote(source.contents, quote) : null;
    if (!source || !quote || !locatedQuote) {
      isolated.push({ field: path, code: 'V3_CSE_EVIDENCE_UNLOCATED' });
      continue;
    }
    if (source.subjectEntityId && source.subjectEntityId !== binding.entityId) {
      isolated.push({ field: path, code: 'V3_CSE_EVIDENCE_SUBJECT_MISMATCH' });
      continue;
    }
    evidence.push({ source: source.source, kind: source.kind, quote: locatedQuote,
      ...(category === 'identityBriefUpdates' ? { floorId: envelope.scope.floorId,
        ...(source.locator ? { locator: source.locator } : {}), ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}) } : {}) });
  }
  return Object.freeze(evidence);
}

function calibratedMutationAllowed({ category, evidence, manualCore }) {
  if (!evidence.length) return false;
  if (category !== 'core') return true;
  // Once Core is user-authored, only evidence from the current user input can revise it.
  if (manualCore) return evidence.some(item => item.source === 'currentUserInput');
  return evidence.some(item => item.kind === 'authorialSetting' || item.source === 'currentUserInput');
}

function compileIdentityBriefUpdates(packet, envelope, isolated, deltaId) {
  const bindings = envelope.scope.identityBriefBindings ?? [];
  if (!bindings.length) return [];
  const bindingByKey = new Map(bindings.map(binding => [binding.key, binding]));
  const submitted = list(field(packet, ['identityBriefUpdates', '身份简介更新'])).slice(0, 80);
  const grouped = new Map();
  for (const [index, raw] of submitted.entries()) {
    const key = text(field(raw, ['targetKey', 'key', '目标']), 80);
    if (!key || !bindingByKey.has(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      isolated.push({ field: 'identityBriefUpdates', index, code: 'V3_CSE_IDENTITY_BRIEF_TARGET_UNBOUND' });
      continue;
    }
    const items = grouped.get(key) ?? [];
    items.push({ raw, index }); grouped.set(key, items);
  }
  const updates = [];
  for (const [key, items] of grouped) {
    const binding = bindingByKey.get(key), validBriefs = new Map();
    let invalid = false;
    for (const { raw, index } of items) {
      try {
        if (usesRelationHistory(raw, ['evidence', '依据', '证据']) || Array.isArray(raw.identityFacts) && raw.identityFacts.some(fact => usesRelationHistory(fact))) throw new TypeError('identityFacts.evidence');
        const brief = field(raw, ['identityBrief', 'brief', '简介']);
        if (!Object.hasOwn(raw, 'identityFacts') && (typeof brief !== 'string' || !brief.trim() || brief.length > 400)) throw new TypeError('identityBrief');
        const facts = compileIdentityFacts({ raw: { ...raw, identityBrief: brief }, existingFacts: binding.existingFacts,
          legacyEvidence: field(raw, ['evidence', '依据']), compileEvidence(refs) {
            if (usesRelationHistory({ evidence: refs })) throw new TypeError('identityFacts.evidence');
            if (!Array.isArray(refs) || !refs.length || refs.length > 20) throw new TypeError('identityFacts.evidence');
            if (refs.some(ref => typeof field(ref, ['quote', '引用']) !== 'string' || field(ref, ['quote', '引用']).length > 2000)) throw new TypeError('identityFacts.quote');
            const evidence = calibratedEvidence({ evidence: refs }, { envelope, binding, category: 'identityBriefUpdates', index, isolated });
            if (evidence.length !== refs.length || evidence.some(item => item.source === 'userPersona' || item.kind === 'userAdaptiveHistory')) throw new TypeError('identityFacts.evidence');
            return evidence.map(({ quote, ...ref }) => ({ ...ref, quotedText: quote }));
          } });
        if (!facts) continue;
        const meaning = JSON.stringify(facts);
        const matching = validBriefs.get(meaning) ?? { facts, indexes: [] };
        matching.indexes.push(index); validBriefs.set(meaning, matching);
      } catch {
        invalid = true;
        isolated.push({ field: 'identityBriefUpdates', index, code: 'V3_CSE_IDENTITY_BRIEF_INVALID' });
      }
    }
    if (validBriefs.size > 1) {
      for (const { indexes } of validBriefs.values()) for (const index of indexes) isolated.push({ field: 'identityBriefUpdates', index, code: 'V3_CSE_IDENTITY_BRIEF_TARGET_AMBIGUOUS' });
      continue;
    }
    const [candidate] = validBriefs.values();
    if (!invalid && candidate && !sameIdentityFacts(candidate.facts, binding.identityFacts)) updates.push({ entityId: binding.entityId, identityBrief: identityFactsText(candidate.facts),
      identityBriefSource: { sourceFloorId: envelope.scope.floorId, origin: 'cse', sourceDeltaId: deltaId, facts: candidate.facts } });
  }
  return updates;
}

function reasonWithEvidence(raw, evidence) {
  const reason = text(field(raw, ['reason', 'because', '依据', '原因']), 2600);
  const audit = evidence.map(item => `${item.source}「${item.quote}」`).join('；');
  return `${reason || '基于本次可定位证据'}（证据：${audit}）`.slice(0, 4000);
}

async function calibratedStateItem({ raw, category, binding, knownBindings, deltaId, floorId, index, isolated, evidence, original = null }) {
  const value = itemSemantic(raw);
  if (!value) { isolated.push({ field: category, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); return null; }
  let towardEntityId = category === 'adaptive' ? original?.towardEntityId ?? null : null;
  const towardRaw = typeof raw === 'object' ? field(raw, ['toward', 'target', 'object', '对谁', '对象']) : null;
  if (category === 'adaptive' && towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
    const matches = matchingBindings(towardRaw, knownBindings);
    const toward = matches.length === 1 ? matches[0] : null;
    if (!toward) { isolated.push({ field: category, index, code: 'V3_CSE_TOWARD_UNBOUND', label: towardRaw, matchCount: matches.length }); return null; }
    towardEntityId = toward.entityId;
  }
  const visibilityRaw = typeof raw === 'object' ? field(raw, ['visibility', '可见性']) : null;
  const sourceOrigin = evidence.every(item => item.kind === 'authorialSetting') ? 'baseline' : 'floor';
  const quantification = normalizeCseQuantification(raw?.quantification, category);
  if (category === 'adaptive' && quantification) quantification.strength = advanceAdaptiveStrength(original?.quantification?.strength, quantification.strength);
  return {
    id: await deterministicUuid(['v3-cse-calibrated-state-item', deltaId, binding.entityId, category, index, value, towardEntityId]),
    text: value,
    visibility: visibilityRaw === undefined || visibilityRaw === null ? original?.visibility ?? 'private' : visibility(visibilityRaw),
    reason: reasonWithEvidence(raw, evidence),
    origin: sourceOrigin,
    towardEntityId,
    sourceFloorId: floorId,
    sourceDeltaId: deltaId,
    ...(quantification ? { quantification } : {}),
  };
}

function calibrationAuditEntry({ binding, category, action, original = null, item = null, raw, evidence }) {
  return {
    subjectEntityId: binding.entityId,
    category,
    action,
    previousText: original?.text ?? null,
    previousTowardEntityId: original?.towardEntityId ?? null,
    text: item?.text ?? null,
    towardEntityId: item?.towardEntityId ?? null,
    reason: text(field(raw, ['reason', 'because', '依据', '原因']), 4000) || '基于本次可定位证据',
    evidence: evidence.map(({ source, quote }) => ({ source, quote })),
  };
}

async function compileCalibratedCategory({ rawSubject, category, binding, previous, envelope, deltaId, isolated, calibrationAudit, acceptedIntents }) {
  const reviewContainer = field(rawSubject, ['review', '复核']);
  const additionsContainer = field(rawSubject, ['additions', '新增']);
  const reviewRaw = field(reviewContainer, categoryNames(category));
  const additionsRaw = field(additionsContainer, categoryNames(category));
  const directRaw = field(rawSubject, categoryNames(category));
  const usesCalibration = reviewRaw !== undefined || additionsRaw !== undefined;
  if (!usesCalibration) return null;
  if (directRaw !== undefined) isolated.push({ field: category, code: 'V3_CSE_CATEGORY_PROTOCOL_MIXED' });

  const original = previous[category] ?? [];
  const output = [...original];
  const reviewedIds = new Set();
  const manualCore = category === 'core' && (envelope.scope.coreUserEditedSubjectEntityIds.includes(binding.entityId) || original.some(item => item.origin === 'manual'));
  for (const [index, review] of list(reviewRaw).slice(0, 120).entries()) {
    if (!review || typeof review !== 'object' || Array.isArray(review)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_INVALID' }); continue; }
    const previousText = text(field(review, ['previousText', 'previous', '旧内容']), 4000);
    const action = normalized(field(review, ['action', '操作']));
    if (!previousText || !['keep', 'refine', 'remove'].includes(action)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_INVALID' }); continue; }
    let towardEntityId;
    const towardRaw = field(review, ['toward', 'target', 'object', '对谁', '对象']);
    if (category === 'adaptive' && towardRaw !== undefined && towardRaw !== null && String(towardRaw).trim()) {
      const matches = matchingBindings(towardRaw, envelope.scope.knownBindings);
      const toward = matches.length === 1 ? matches[0] : null;
      if (!toward) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_TOWARD_UNBOUND', label: towardRaw, matchCount: matches.length }); continue; }
      towardEntityId = toward.entityId;
    }
    const matches = original.filter(item => normalized(item.text) === normalized(previousText)
      && (towardEntityId === undefined || item.towardEntityId === towardEntityId));
    if (matches.length !== 1 || reviewedIds.has(matches[0]?.id)) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_TARGET_AMBIGUOUS' }); continue; }
    const matched = matches[0];
    reviewedIds.add(matched.id);
    const historyEvidence = relationHistoryEvidence(review, { envelope, binding, category, original: matched, index, isolated });
    if (historyEvidence === null) { acceptedIntents.count += 1; continue; }
    if (action === 'keep') {
      if (category === 'adaptive' && matched.origin !== 'manual' && !normalizeCseQuantification(matched.quantification, category)) {
        const quantification = normalizeCseQuantification(review.quantification, category);
        if (quantification) output.splice(output.findIndex(item => item.id === matched.id), 1, { ...matched, quantification });
      }
      acceptedIntents.count += 1; continue;
    }
    const evidence = historyEvidence ?? calibratedEvidence(review, { envelope, binding, category, index, isolated });
    if (!calibratedMutationAllowed({ category, evidence, manualCore })) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); continue; }
    const currentIndex = output.findIndex(item => item.id === matched.id);
    if (currentIndex < 0) { isolated.push({ field: `${category}.review`, index, code: 'V3_CSE_REVIEW_TARGET_AMBIGUOUS' }); continue; }
    if (action === 'remove') {
      output.splice(currentIndex, 1);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action, original: matched, raw: review, evidence }));
      acceptedIntents.count += 1;
      continue;
    }
    const replacement = await calibratedStateItem({ raw: review, category, binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, index, isolated, evidence, original: matched });
    if (replacement && !sameItemMeaning(matched, replacement)) {
      output.splice(currentIndex, 1, replacement);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action, original: matched, item: replacement, raw: review, evidence }));
    } else if (replacement?.quantification && matched.origin !== 'manual') {
      output.splice(currentIndex, 1, { ...matched, ...cseQuantificationFields(replacement, category) });
    }
    if (replacement) acceptedIntents.count += 1;
  }

  for (const [index, addition] of list(additionsRaw).slice(0, 120).entries()) {
    if (!addition || typeof addition !== 'object' || Array.isArray(addition)) { isolated.push({ field: `${category}.additions`, index, code: 'V3_CSE_OPTIONAL_ITEM_INVALID' }); continue; }
    const historyEvidence = relationHistoryEvidence(addition, { envelope, binding, category, index, isolated });
    if (historyEvidence === null) { acceptedIntents.count += 1; continue; }
    const evidence = historyEvidence ?? calibratedEvidence(addition, { envelope, binding, category, index, isolated });
    if (category === 'adaptive' && envelope.scope.userAdaptiveReview
      && evidence.some(item => item.kind === 'userAdaptiveHistory')
      && !evidence.some(item => ['story', 'userInput'].includes(item.kind))) {
      isolated.push({ field: `${category}.additions`, index, code: 'V3_CSE_USER_HISTORY_CURRENT_CONFIRMATION_MISSING' });
      continue;
    }
    if (!calibratedMutationAllowed({ category, evidence, manualCore })) { isolated.push({ field: `${category}.additions`, index, code: 'V3_CSE_CALIBRATION_EVIDENCE_INSUFFICIENT' }); continue; }
    const item = await calibratedStateItem({ raw: addition, category, binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, index: original.length + index, isolated, evidence });
    if (item) acceptedIntents.count += 1;
    if (item && !output.some(existing => normalized(existing.text) === normalized(item.text) && existing.towardEntityId === item.towardEntityId)) {
      output.push(item);
      calibrationAudit.push(calibrationAuditEntry({ binding, category, action: 'add', item, raw: addition, evidence }));
    }
  }
  return output;
}

export async function compileCseResponse({ response, finishReason, envelope, previousCurrentState, now, deltaId, userCoreExtraction = null }) {
  const packet = parsePacket(response, { finishReason, compareUserCoreExtraction: Boolean(userCoreExtraction) });
  if (!hasRecognizableCseResult(packet)) throw errorWith('V3_CSE_FORMAT_INVALID', 'CSE 返回不含可识别的人物状态结果。');
  const isolated = [];
  const identityBriefUpdates = compileIdentityBriefUpdates(packet, envelope, isolated, deltaId);
  const previousById = new Map((previousCurrentState?.subjects ?? []).map(subject => [subject.subjectEntityId, subject]));
  const compiled = new Map();
  const calibrationAudit = [];
  const rawSubjects = list(selectSubjectResults(packet));
  const acceptedIntents = { count: 0 };
  for (const [subjectIndex, raw] of rawSubjects.slice(0, 80).entries()) {
    const matches = matchingBindings(raw, envelope.scope.trackedBindings);
    const binding = matches.length === 1 ? matches[0] : null;
    const subjectLabel = typeof raw === 'string' ? raw : field(raw, ['subject', 'name', 'person', 'character', '主体', '人物', '姓名']);
    if (!binding) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_UNBOUND', label: subjectLabel, matchCount: matches.length }); continue; }
    if (compiled.has(binding.entityId)) { isolated.push({ field: 'subjects', index: subjectIndex, code: 'V3_CSE_SUBJECT_DUPLICATE', label: subjectLabel, matchCount: matches.length }); continue; }
    const isolationStart = isolated.length;
    const acceptedBeforeSubject = acceptedIntents.count;
    const previous = previousById.get(binding.entityId) ?? { core: [], adaptive: [], situational: [] };
    if (binding.reviewOnly) {
      const rawSituational = field(raw, ['situational', 'situation', '短期状态', '情境']);
      const proposed = rawSituational === undefined ? previous.situational
        : await compileSituationalCategory({ raw: rawSituational, category: 'situational', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous: previous.situational, isolated, acceptedIntents });
      const retainedIds = new Set(proposed.map(item => item.id));
      const situational = previous.situational.filter(item => item.origin === 'manual' || retainedIds.has(item.id));
      compiled.set(binding.entityId, { ...previous, subjectEntityId: binding.entityId, situational, changeSummary: [], coreChallenges: [] });
      acceptedIntents.count += 1;
      continue;
    }
    const hasCore = field(raw, categoryNames('core')) !== undefined;
    const hasAdaptive = field(raw, categoryNames('adaptive')) !== undefined;
    const hasSituational = field(raw, ['situational', 'situation', '短期状态', '情境']) !== undefined;
    let calibratedCore = await compileCalibratedCategory({ rawSubject: raw, category: 'core', binding, previous, envelope, deltaId, isolated, calibrationAudit, acceptedIntents });
    const calibratedAdaptive = await compileCalibratedCategory({ rawSubject: raw, category: 'adaptive', binding, previous, envelope, deltaId, isolated, calibrationAudit, acceptedIntents });
    const hasAuthorNote = envelope.scope.evidenceSources.some(source => source.source === 'authorNote');
    if (calibratedCore === null && hasCore && previous.core.length === 0 && hasAuthorNote) {
      calibratedCore = await compileCalibratedCategory({
        rawSubject: { additions: { core: field(raw, categoryNames('core')) } },
        category: 'core', binding, previous, envelope, deltaId, isolated, calibrationAudit, acceptedIntents,
      });
    }
    const proposedCore = calibratedCore ?? (hasCore ? await compileAfterStateCategory({ raw: field(raw, categoryNames('core')), category: 'core', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous: previous.core, isolated, acceptedIntents }) : previous.core);
    const adaptive = calibratedAdaptive ?? (hasAdaptive ? await compileAfterStateCategory({ raw: field(raw, categoryNames('adaptive')), category: 'adaptive', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous: previous.adaptive, isolated, acceptedIntents }) : previous.adaptive);
    const situational = hasSituational ? await compileSituationalCategory({ raw: field(raw, ['situational', 'situation', '短期状态', '情境']), category: 'situational', binding, knownBindings: envelope.scope.knownBindings, deltaId, floorId: envelope.scope.floorId, previous: previous.situational, isolated, acceptedIntents }) : previous.situational;
    const explicitChallenges = list(field(raw, ['coreChallenges', 'coreChallenge', '核心挑战'])).map(itemSemantic).filter(Boolean);
    let core = proposedCore;
    const challenges = [...explicitChallenges];
    const manualCoreProtected = envelope.scope.coreUserEditedSubjectEntityIds.includes(binding.entityId) || previous.core.some(item => item.origin === 'manual');
    if ((previous.core.length || manualCoreProtected) && calibratedCore === null) {
      core = previous.core;
      if (hasCore && JSON.stringify(proposedCore.map(item => item.text)) !== JSON.stringify(previous.core.map(item => item.text))) challenges.push(...proposedCore.map(item => `AI 建议改写 Core：${item.text}`));
    }
    compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core, adaptive, situational, changeSummary: [], coreChallenges: [...new Set(challenges)].slice(0, 40) });
    if (acceptedIntents.count === acceptedBeforeSubject && !hasCore && !hasAdaptive && !hasSituational
      && calibratedCore === null && calibratedAdaptive === null) acceptedIntents.count += 1;
    for (let index = isolationStart; index < isolated.length; index += 1) isolated[index].subjectIndex = subjectIndex;
  }
  if (rawSubjects.length > 0 && acceptedIntents.count === 0 && isolated.length > 0) {
    const error = errorWith('V3_CSE_ALL_CANDIDATES_ISOLATED', '本楼人物状态未保存：返回结果无法确认人物归属或未通过校验。请到设置 → 记忆管理 → 详细诊断，复制状态诊断反馈。');
    error.cseDiagnostics = { subjectResolution: projectCseSubjectDiagnostic({
      trackedSubjects: envelope.request.payload.trackedSubjects, knownPeople: envelope.request.payload.knownPeople, isolated,
    }) };
    throw error;
  }
  let userCoreExtractionResult = null;
  if (userCoreExtraction) {
    const rawReview = field(packet, ['userCoreExtraction', '用户核心特质提取']);
    const rawSubmittedStatus = field(rawReview, ['status', '状态']);
    const submittedStatus = rawReview && typeof rawReview === 'object' && !Array.isArray(rawReview)
      && rawSubmittedStatus !== undefined ? normalized(rawSubmittedStatus) : '';
    const userAdditions = calibrationAudit.filter(entry => entry.subjectEntityId === userCoreExtraction.userEntityId
      && entry.category === 'core' && entry.action === 'add'
      && entry.evidence.length > 0 && entry.evidence.every(evidence => evidence.source === 'userPersona'));
    let status = !userCoreExtraction.hasDescription ? 'sourceEmpty'
      : submittedStatus === 'insufficient' && userAdditions.length === 0 ? 'insufficient'
        : submittedStatus === 'traits' && userAdditions.length > 0 ? 'traits' : 'failed';
    const user = compiled.get(userCoreExtraction.userEntityId);
    const previous = previousById.get(userCoreExtraction.userEntityId);
    const acceptedTexts = new Set(userAdditions.map(entry => normalized(entry.text)));
    const acceptedCore = status === 'traits'
      ? (user?.core ?? []).filter(item => item.sourceDeltaId === deltaId && acceptedTexts.has(normalized(item.text)))
      : [];
    if (user) {
      user.core = [...(previous?.core ?? []), ...acceptedCore];
    }
    const acceptedAuditTexts = new Set(acceptedCore.map(item => normalized(item.text)));
    const retainedAudit = calibrationAudit.filter(entry => entry.subjectEntityId !== userCoreExtraction.userEntityId || entry.category !== 'core')
      .concat(userAdditions.filter(entry => acceptedAuditTexts.has(normalized(entry.text))));
    calibrationAudit.splice(0, calibrationAudit.length, ...retainedAudit);
    userCoreExtractionResult = {
      status,
      userEntityId: userCoreExtraction.userEntityId,
      personaLocator: userCoreExtraction.personaLocator,
      descriptionFingerprint: userCoreExtraction.descriptionFingerprint,
    };
  }
  for (const binding of envelope.scope.trackedBindings) if (!compiled.has(binding.entityId) && !previousById.has(binding.entityId)) compiled.set(binding.entityId, { subjectEntityId: binding.entityId, core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] });
  const logicalSubjectSnapshots = [...compiled.values()].map(subject => {
    const previous = previousById.get(subject.subjectEntityId) ?? { core: [], adaptive: [], situational: [] };
    const audits = calibrationAudit.filter(entry => entry.subjectEntityId === subject.subjectEntityId);
    return {
      ...subject,
      changeSummary: actualSubjectChanges({ before: previous, after: subject, audits })
        .filter(change => !isCseQuantificationOnlyChange(change))
        .map(change => summarizeActualChange(change, envelope.scope.knownBindings))
        .slice(0, 40),
    };
  });
  const fixedChanges = logicalSubjectSnapshots.map(subject => {
    const previous = previousById.get(subject.subjectEntityId) ?? EMPTY_CSE_SUBJECT;
    const audits = calibrationAudit.filter(entry => entry.subjectEntityId === subject.subjectEntityId);
    return { subjectEntityId: subject.subjectEntityId, items: actualSubjectChanges({ before: previous, after: subject, audits }) };
  }).filter(subject => subject.items.length);
  const material = logicalSubjectSnapshots.some(subject => JSON.stringify(storedProjection(previousById.get(subject.subjectEntityId) ?? { core: [], adaptive: [], situational: [] })) !== JSON.stringify(storedProjection(subject)));
  const noMaterialChange = !material;
  const subjectSnapshots = logicalSubjectSnapshots.flatMap(subject => {
    const members = envelope.scope.identityMemberEntityIdsBySubject?.[subject.subjectEntityId] ?? [subject.subjectEntityId];
    const clearedMembers = members.filter(entityId => entityId !== subject.subjectEntityId).map(subjectEntityId => ({ subjectEntityId, core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] }));
    return [...clearedMembers, subject];
  });
  const fingerprint = `sha256:${await sha256(JSON.stringify([envelope.scope.floorId, envelope.scope.floorMemoryId, subjectSnapshots, noMaterialChange, { fixedChanges }]))}`;
  const stateIsolated = isolated.filter(item => item.field !== 'identityBriefUpdates' && !item.field.startsWith('identityBriefUpdates.'));
  const isolationCodes = [...new Set(stateIsolated.map(item => item.code).filter(code => CSE_ISOLATION_CODES.includes(code)))];
  const delta = validateStateDeltaRecord({ schemaVersion: 3, recordType: 'stateDelta', id: deltaId, chatId: envelope.scope.chatId, narrativeGeneration: envelope.scope.narrativeGeneration, floorId: envelope.scope.floorId, floorMemoryId: envelope.scope.floorMemoryId, baselineId: envelope.scope.baselineId, previousCurrentStateId: previousCurrentState?.id ?? null, subjectSnapshots, fixedChanges, noMaterialChange, fingerprint, source: { promptVersion: CSE_PROMPT_VERSION, compilerVersion: CSE_COMPILER_VERSION, calibrationVersion: CSE_CALIBRATION_VERSION, ...(userCoreExtractionResult ? { userCoreExtraction: userCoreExtractionResult } : {}), ...(calibrationAudit.length ? { calibrationAudit } : {}), ...(stateIsolated.length ? { isolationSummary: { count: stateIsolated.length, codes: isolationCodes } } : {}) }, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: null }, { expectedChatId: envelope.scope.chatId });
  // Successful runs keep their existing isolation record contract; labels belong only to failure hints.
  for (const item of isolated) { delete item.label; delete item.matchCount; delete item.subjectIndex; }
  return Object.freeze({ delta, identityBriefUpdates: Object.freeze(identityBriefUpdates.map(update => Object.freeze(update))), isolated: Object.freeze(isolated) });
}

const categoryAllowsToward = category => category === 'adaptive' || category === 'situational';
const manualItemMeaning = (item, category) => [item.text, item.visibility, categoryAllowsToward(category) ? item.towardEntityId ?? null : null];
const manualCategoryLabel = category => ({ core: '核心特质', adaptive: '长期倾向', situational: '当前情境' })[category] ?? '人物状态';

async function manualStateItems({ edits, originals, category, subjectEntityId, floorId, oldDeltaId, deltaId, allowedTowardEntityIds }) {
  const label = manualCategoryLabel(category);
  if (!Array.isArray(edits)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}编辑内容无效，请调整后重试。`);
  if (edits.length > 120) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}最多120项，请删减后保存。`);
  const originalById = new Map(originals.map(item => [item.id, item]));
  const usedIds = new Set();
  const output = [];
  for (const [index, raw] of edits.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}第${index + 1}项格式无效，请重新编辑。`);
    const itemId = typeof raw.itemId === 'string' && raw.itemId ? raw.itemId : null;
    const original = itemId ? originalById.get(itemId) : null;
    if (itemId && (!original || usedIds.has(itemId))) throw errorWith('V3_CSE_MANUAL_INPUT_STALE', `${label}第${index + 1}项已变化，请重新打开编辑。`);
    if (itemId) usedIds.add(itemId);
    const itemText = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!itemText) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}第${index + 1}项内容为空，请填写或删除该项。`);
    if (itemText.length > 4000) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}第${index + 1}项内容超过4000字，请缩短后保存。`);
    if (!CSE_VISIBILITIES.includes(raw.visibility)) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', `${label}第${index + 1}项信息范围无效，请重新选择。`);
    const towardEntityId = categoryAllowsToward(category) && typeof raw.towardEntityId === 'string' && raw.towardEntityId ? raw.towardEntityId : null;
    if (towardEntityId && !allowedTowardEntityIds.has(towardEntityId)) throw errorWith('V3_CSE_MANUAL_TOWARD_INVALID', '所选关系对象当前不可用，请重新选择人物。');
    const nextMeaning = [itemText, raw.visibility, towardEntityId];
    if (original && JSON.stringify(manualItemMeaning(original, category)) === JSON.stringify(nextMeaning)) {
      if (original.sourceDeltaId !== oldDeltaId) { output.push(original); continue; }
      const rebased = { ...original, sourceDeltaId: deltaId };
      rebased.id = await deterministicUuid(['v3-cse-manual-rebase-item', deltaId, original.id, subjectEntityId, category, index]);
      output.push(rebased);
      continue;
    }
    const next = {
      id: await deterministicUuid(['v3-cse-manual-state-item', deltaId, subjectEntityId, category, index, itemText, raw.visibility, towardEntityId]),
      text: itemText,
      visibility: raw.visibility,
      reason: '用户纠正当前状态',
      origin: 'manual',
      towardEntityId,
      sourceFloorId: floorId,
      sourceDeltaId: deltaId,
    };
    output.push(next);
  }
  return output;
}

export function mergeManualCseEdits({ currentSubject, original, edits, manualChanges = [] }) {
  const merged = {};
  for (const category of ['core', 'adaptive', 'situational']) {
    const current = currentSubject[category] ?? [];
    const copy = item => ({ itemId: item.id, text: item.text, visibility: item.visibility, towardEntityId: item.towardEntityId ?? null });
    merged[category] = current.map(copy);
    if (!Object.hasOwn(edits, category)) continue;
    const desired = edits[category];
    if (!Array.isArray(desired) || desired.some(item => !item || typeof item !== 'object')) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', '人物状态编辑内容无效。');
    const editedIds = desired.map(item => item.itemId).filter(Boolean);
    if (new Set(editedIds).size !== editedIds.length) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', '人物状态编辑条目重复。');
    const baseline = original?.[category] ?? current.map(item => ({ ...copy(item), origin: item.origin }));
    const baselineIds = new Set(baseline.map(item => item.itemId));
    if (desired.some(item => item.itemId && !baselineIds.has(item.itemId))) throw errorWith('V3_CSE_MANUAL_STALE', '所编辑条目已变化，请保留草稿并重新打开。');
    const same = (left, right) => JSON.stringify(manualItemMeaning(left, category)) === JSON.stringify(manualItemMeaning(right, category));
    for (const before of baseline) {
      const after = desired.find(item => item.itemId === before.itemId);
      if (after && same(before, after)) continue;
      const equivalent = current.filter(item => item.origin === before.origin && same(item, before));
      const latest = current.find(item => item.id === before.itemId) ?? (equivalent.length === 1 ? equivalent[0] : null);
      const removed = manualChanges.some(change => change.category === category && !change.after
        && (change.before?.id === before.itemId || (change.before && same(change.before, before)) || current.length === 0));
      const revised = manualChanges.some(change => change.category === category && change.before?.id === before.itemId
        && change.after?.origin === 'manual' && !same(change.after, before));
      if (revised || (latest?.origin === 'manual' && !same(latest, before)) || (after && removed) || (!latest && after && before.origin === 'manual')) {
        throw errorWith('V3_CSE_MANUAL_STALE', '所编辑条目已被人工修改或删除，请保留草稿并重新打开。');
      }
      merged[category] = merged[category].filter(item => item.itemId !== before.itemId && item.itemId !== latest?.id);
      if (after) merged[category].push({ ...after, itemId: latest?.id ?? null });
    }
    merged[category].push(...desired.filter(item => !item.itemId));
  }
  return merged;
}

export async function createManualCseCorrection({ anchorDelta, currentState, subjectEntityId, subjectMemberEntityIds = [subjectEntityId], edits, allowedTowardEntityIds = [], deltaId, now }) {
  const currentSubject = currentState?.subjects?.find(subject => subject.subjectEntityId === subjectEntityId);
  if (!currentSubject || !anchorDelta?.subjectSnapshots || typeof deltaId !== 'string') throw errorWith('V3_CSE_MANUAL_TARGET_INVALID', '当前人物状态或纠正锚点不可用。');
  const allowed = new Set(allowedTowardEntityIds);
  const categories = ['core', 'adaptive', 'situational'];
  const normalizedEdits = Object.fromEntries(categories.map(category => [category, Object.hasOwn(edits ?? {}, category) ? edits[category] : currentSubject[category].map(item => ({ itemId: item.id, ...item }))]));
  if (categories.some(category => !Array.isArray(normalizedEdits[category]))) throw errorWith('V3_CSE_MANUAL_INPUT_INVALID', '人物状态编辑内容不完整。');
  const unchanged = categories.every(category => JSON.stringify(normalizedEdits[category].map(item => [String(item?.text ?? '').trim(), item?.visibility, categoryAllowsToward(category) ? item?.towardEntityId || null : null])) === JSON.stringify(currentSubject[category].map(item => manualItemMeaning(item, category))));
  if (unchanged) return Object.freeze({ status: 'unchanged', delta: null });

  const corrected = { subjectEntityId, changeSummary: ['用户纠正当前状态'], coreChallenges: [] };
  for (const category of categories) corrected[category] = await manualStateItems({ edits: normalizedEdits[category], originals: currentSubject[category], category, subjectEntityId, floorId: anchorDelta.floorId, oldDeltaId: anchorDelta.id, deltaId, allowedTowardEntityIds: allowed });
  const memberIds = [...new Set([subjectEntityId, ...subjectMemberEntityIds].filter(id => typeof id === 'string' && id))];
  const memberIdSet = new Set(memberIds);
  const snapshots = anchorDelta.subjectSnapshots.filter(snapshot => !memberIdSet.has(snapshot.subjectEntityId)).map(snapshot => structuredClone(snapshot));
  for (const memberEntityId of memberIds) {
    if (memberEntityId === subjectEntityId) continue;
    snapshots.push({ subjectEntityId: memberEntityId, core: [], adaptive: [], situational: [], changeSummary: [], coreChallenges: [] });
  }
  snapshots.push(corrected);
  const snapshotIds = new Set(snapshots.map(snapshot => snapshot.subjectEntityId));
  const manualSubjectEntityIds = [...new Set([...(anchorDelta.source?.manualSubjectEntityIds ?? []), ...memberIds])].filter(id => snapshotIds.has(id));
  const coreChanged = JSON.stringify(normalizedEdits.core.map(item => [String(item?.text ?? '').trim(), item?.visibility])) !== JSON.stringify(currentSubject.core.map(item => [item.text, item.visibility]));
  const manualCoreSubjectEntityIds = [...new Set([...(anchorDelta.source?.manualCoreSubjectEntityIds ?? []), ...(coreChanged ? [subjectEntityId] : [])])].filter(id => snapshotIds.has(id));
  const noMaterialChange = false;
  const originalSubject = structuredClone(currentSubject);
  if (anchorDelta.source?.manualSubjectEntityIds?.includes(subjectEntityId)) {
    const previousChanges = anchorDelta.fixedChanges?.find(subject => subject.subjectEntityId === subjectEntityId)?.items ?? [];
    for (const change of [...previousChanges].reverse()) {
      originalSubject[change.category] = originalSubject[change.category].filter(item => !change.after || (item.id !== change.after.id && JSON.stringify(stateMeaning(item)) !== JSON.stringify(stateMeaning(change.after))));
      if (change.before) originalSubject[change.category].push(change.before);
    }
  }
  const targetItems = actualSubjectChanges({ before: originalSubject, after: corrected, audits: [] });
  const fixedChanges = [
    ...(anchorDelta.fixedChanges ?? []).filter(subject => !memberIdSet.has(subject.subjectEntityId)),
    ...(targetItems.length ? [{ subjectEntityId, items: targetItems }] : []),
  ];
  const fingerprint = `sha256:${await sha256(JSON.stringify([anchorDelta.floorId, anchorDelta.floorMemoryId, snapshots, noMaterialChange, { fixedChanges }]))}`;
  const delta = validateStateDeltaRecord({
    ...anchorDelta,
    id: deltaId,
    previousCurrentStateId: anchorDelta.previousCurrentStateId,
    subjectSnapshots: snapshots,
    fixedChanges,
    noMaterialChange,
    fingerprint,
    source: {
      promptVersion: CSE_PROMPT_VERSION,
      compilerVersion: CSE_COMPILER_VERSION,
      ...(isSupportedCseCalibrationVersion(anchorDelta.source?.calibrationVersion) ? { calibrationVersion: anchorDelta.source.calibrationVersion } : {}),
      ...(Array.isArray(anchorDelta.source?.calibrationAudit) ? { calibrationAudit: anchorDelta.source.calibrationAudit } : {}),
      ...(anchorDelta.source?.userCoreExtraction ? { userCoreExtraction: anchorDelta.source.userCoreExtraction } : {}),
      ...(anchorDelta.source?.userCoreCheck ? { userCoreCheck: anchorDelta.source.userCoreCheck } : {}),
      ...(anchorDelta.source?.isolationSummary ? { isolationSummary: anchorDelta.source.isolationSummary } : {}),
      ...(manualCoreSubjectEntityIds.length ? { manualCoreSubjectEntityIds } : {}),
      manualSubjectEntityIds,
    },
    createdAt: now,
    updatedAt: now,
    recordStatus: 'active',
    supersedes: anchorDelta.id,
  }, { expectedChatId: anchorDelta.chatId });
  return Object.freeze({ status: 'ready', delta });
}

export function buildCseTaskOptions({ envelope, promptGuidance = '', processingPrompt = '' }) {
  return {
    promptTask: 'cse',
    promptOwnerId: envelope.scope?.chatId,
    systemPrompt: buildCseSystemPrompt(promptGuidance, processingPrompt),
    taskMessages: [{ role: 'user', content: JSON.stringify(envelope.request) }],
    maxTokens: 30000, temperature: 0, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic',
  };
}

export async function runCseRequest({ generateAnalysisTask, envelope, previousCurrentState, now, deltaId, promptGuidance = '', processingPrompt = '', signal, transportBudget = { remaining: 3, used: 0 } }) {
  const taskOptions = buildCseTaskOptions({ envelope, promptGuidance, processingPrompt });
  for (let attempts = 1; attempts <= (transportBudget.totalAttempts ?? 3); attempts += 1) {
    let candidate = null, metadata = sanitizeTaskMetadata(null), receivedResult = false;
    try {
      const result = await generateAnalysisTask({ ...taskOptions, signal, transportBudget });
      receivedResult = true;
      if (transportBudget.diagnostic) Object.assign(transportBudget.diagnostic, { phase: 'compile', phaseStartedAt: Date.now(), attemptEndedAt: Date.now(), outcome: 'running', endedAt: null });
      candidate = result?.jsonData ?? result?.textData ?? result;
      metadata = sanitizeTaskMetadata(result?.taskMetadata);
      const compiled = await compileCseResponse({ response: candidate, finishReason: result?.taskMetadata?.finishReason, envelope, previousCurrentState, now, deltaId, userCoreExtraction: envelope.scope.userCoreExtraction });
      return Object.freeze({ ...compiled, metadata, attempts, transportAttempts: transportBudget.used || result?.taskMetadata?.transportAttempts || null, responseFingerprint: `sha256:${await sha256(JSON.stringify(candidate))}` });
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
      const retryable = receivedResult || error?.retryableRecognitionFormat === true || ['QQJ_TIMEOUT', 'QQJ_EMPTY'].includes(error?.code);
      if (retryable && attempts < (transportBudget.totalAttempts ?? 3) && transportBudget.remaining > 0) continue;
      const failedAttempts = transportBudget.used || attempts;
      if (failedAttempts > 1) error.message = `已尝试 ${failedAttempts} 次仍失败：${error.message}`;
      const subjectResolution = error?.cseDiagnostics?.subjectResolution ?? projectCseSubjectDiagnostic({
        trackedSubjects: envelope.request.payload.trackedSubjects, knownPeople: envelope.request.payload.knownPeople,
      });
      error.cseDiagnostics = { attempts, transportAttempts: transportBudget.used || error?.transportAttempts || null, metadata: sanitizeTaskMetadata(error?.taskMetadata ?? metadata), response: sanitizeCompletionDiagnostic(error?.responseDiagnostic), candidate: (() => { try { return JSON.stringify(candidate).slice(0, 24000); } catch { return null; } })(), providerError: sanitizeDiagnosticValue(error?.providerError ?? null), subjectResolution };
      throw error;
    }
  }
}

export function filterReachableDeltas({ floors = [], stateDeltas = [] }) {
  const order = new Map(floors.map((floor, index) => [floor.id, index]));
  const candidates = new Map();
  for (const delta of stateDeltas) {
    if (delta.recordStatus !== 'active' || !order.has(delta.floorId)) continue;
    candidates.set(delta.floorId, [...(candidates.get(delta.floorId) ?? []), delta]);
  }
  const result = [];
  for (const floor of floors) {
    const matches = candidates.get(floor.id) ?? [];
    if (matches.length === 1) result.push(matches[0]);
  }
  return result;
}

const EMPTY_CSE_SUBJECT = Object.freeze({ core: Object.freeze([]), adaptive: Object.freeze([]), situational: Object.freeze([]) });
const CSE_STATE_CATEGORIES = Object.freeze(['core', 'adaptive', 'situational']);
const itemMeaningKey = item => JSON.stringify(stateMeaning(item));

function applyDeltaSnapshot(subjects, delta, snapshot) {
  const previous = subjects.get(snapshot.subjectEntityId);
  const manualCore = delta.source?.manualSubjectEntityIds?.includes(snapshot.subjectEntityId) === true;
  const calibrated = isSupportedCseCalibrationVersion(delta.source?.calibrationVersion);
  const applied = {
    subjectEntityId: snapshot.subjectEntityId,
    core: calibrated || manualCore ? snapshot.core : previous?.core?.length ? previous.core : snapshot.core,
    adaptive: snapshot.adaptive,
    situational: snapshot.situational,
  };
  subjects.set(snapshot.subjectEntityId, applied);
  return applied;
}

function categoryChanges({ before, after, category, audits }) {
  const usedBefore = new Set(), usedAfter = new Set(), changes = [];
  const beforeKeys = before.map(itemMeaningKey), afterKeys = after.map(itemMeaningKey);
  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const afterIndex = afterKeys.findIndex((key, index) => !usedAfter.has(index) && key === beforeKeys[beforeIndex]);
    if (afterIndex >= 0) {
      usedBefore.add(beforeIndex); usedAfter.add(afterIndex);
      const change = { category, action: 'update', before: before[beforeIndex], after: after[afterIndex] };
      if (isCseQuantificationOnlyChange(change)) changes.push(change);
    }
  }
  const findBefore = (value, toward) => before.findIndex((item, index) => !usedBefore.has(index) && normalized(item.text) === normalized(value) && (item.towardEntityId ?? null) === (toward ?? null));
  const findAfter = (value, toward) => after.findIndex((item, index) => !usedAfter.has(index) && normalized(item.text) === normalized(value) && (item.towardEntityId ?? null) === (toward ?? null));
  for (const audit of audits) {
    if (audit.action === 'refine') {
      const beforeIndex = findBefore(audit.previousText, audit.previousTowardEntityId), afterIndex = findAfter(audit.text, audit.towardEntityId);
      if (beforeIndex < 0 || afterIndex < 0) continue;
      usedBefore.add(beforeIndex); usedAfter.add(afterIndex);
      changes.push({ category, action: 'refine', before: before[beforeIndex], after: after[afterIndex] });
    } else if (audit.action === 'remove') {
      const beforeIndex = findBefore(audit.previousText, audit.previousTowardEntityId);
      if (beforeIndex < 0) continue;
      usedBefore.add(beforeIndex); changes.push({ category, action: 'remove', before: before[beforeIndex], after: null });
    } else if (audit.action === 'add') {
      const afterIndex = findAfter(audit.text, audit.towardEntityId);
      if (afterIndex < 0) continue;
      usedAfter.add(afterIndex); changes.push({ category, action: 'add', before: null, after: after[afterIndex] });
    }
  }
  const remainingBefore = before.map((item, index) => ({ item, index })).filter(({ index }) => !usedBefore.has(index));
  const remainingAfter = after.map((item, index) => ({ item, index })).filter(({ index }) => !usedAfter.has(index));
  if (category === 'situational' && remainingBefore.length === 1 && remainingAfter.length === 1) {
    changes.push({ category, action: 'update', before: remainingBefore[0].item, after: remainingAfter[0].item });
    usedBefore.add(remainingBefore[0].index); usedAfter.add(remainingAfter[0].index);
  }
  for (const { item, index } of before.map((value, position) => ({ item: value, index: position }))) if (!usedBefore.has(index)) changes.push({ category, action: 'remove', before: item, after: null });
  for (const { item, index } of after.map((value, position) => ({ item: value, index: position }))) if (!usedAfter.has(index)) changes.push({ category, action: 'add', before: null, after: item });
  return changes;
}

function actualSubjectChanges({ before, after, audits }) {
  return CSE_STATE_CATEGORIES.flatMap(category => categoryChanges({
    before: before[category] ?? [],
    after: after[category] ?? [],
    category,
    audits: audits.filter(entry => entry.category === category),
  }));
}

function summarizeActualState(item, category, knownBindings) {
  const details = [];
  if (categoryAllowsToward(category) && item?.towardEntityId) {
    const target = knownBindings.find(binding => binding.entityId === item.towardEntityId)?.labels?.[0];
    details.push(`对象：${target || '已绑定人物'}`);
  }
  const visibilityName = { private: '私密', expressed: '已表达', observable: '可观察', shared: '共享', authorial: '作者设定' }[item?.visibility];
  if (visibilityName) details.push(`信息范围：${visibilityName}`);
  const originName = { baseline: '初始设定', floor: '本楼', reasonableProgression: '合理进展', manual: '用户纠正' }[item?.origin];
  if (originName) details.push(`来源：${originName}`);
  return `${item?.text ?? ''}${details.length ? `（${details.join('；')}）` : ''}`;
}

function summarizeActualChange(change, knownBindings) {
  const categoryName = { core: '核心人格', adaptive: '长期适应', situational: '情境状态' }[change.category] ?? '人物状态';
  const before = change.before ? summarizeActualState(change.before, change.category, knownBindings) : '';
  const after = change.after ? summarizeActualState(change.after, change.category, knownBindings) : '';
  if (change.action === 'refine') return `调整${categoryName}：${before} → ${after}`.slice(0, 2000);
  if (change.action === 'update') return `更新${categoryName}：${before} → ${after}`.slice(0, 2000);
  if (change.action === 'remove') return `移除${categoryName}：${before}`.slice(0, 2000);
  return `新增${categoryName}：${after}`.slice(0, 2000);
}

export function deriveCseTimeline(stateDeltas = []) {
  const timeline = [];
  for (const delta of stateDeltas) {
    const changes = Object.hasOwn(delta, 'fixedChanges')
      ? delta.fixedChanges.map(subject => Object.freeze({ subjectEntityId: subject.subjectEntityId, items: Object.freeze(subject.items.map(item => Object.freeze(item))) }))
      : [];
    const endStateSubjects = delta.subjectSnapshots.map(subject => Object.freeze({ subjectEntityId: subject.subjectEntityId, core: Object.freeze([...(subject.core ?? [])]), adaptive: Object.freeze([...(subject.adaptive ?? [])]), situational: Object.freeze([...(subject.situational ?? [])]) }));
    timeline.push(Object.freeze({ deltaId: delta.id, floorId: delta.floorId, noMaterialChange: delta.noMaterialChange, changes: Object.freeze(changes), endStateSubjects: Object.freeze(endStateSubjects), isolationSummary: delta.source?.isolationSummary ? Object.freeze({ count: delta.source.isolationSummary.count, codes: Object.freeze([...delta.source.isolationSummary.codes]) }) : null }));
  }
  return Object.freeze(timeline);
}

function manualDeltaChanges(delta) {
  const ids = new Set(delta.source?.manualSubjectEntityIds ?? []);
  if (Object.hasOwn(delta, 'fixedChanges')) return delta.fixedChanges.filter(subject => ids.has(subject.subjectEntityId));
  return delta.subjectSnapshots.filter(snapshot => ids.has(snapshot.subjectEntityId)).map(snapshot => ({
    subjectEntityId: snapshot.subjectEntityId,
    items: ['core', 'adaptive', 'situational'].flatMap(category => snapshot[category].filter(item => item.origin === 'manual')
      .map(after => ({ category, action: 'add', before: null, after }))),
  }));
}

function applyManualDeltaChanges(subjects, delta, changes) {
  const snapshots = [];
  for (const change of changes) {
    const snapshot = delta.subjectSnapshots.find(item => item.subjectEntityId === change.subjectEntityId);
    if (!snapshot) continue;
    const before = subjects.get(change.subjectEntityId) ?? EMPTY_CSE_SUBJECT;
    const next = { subjectEntityId: change.subjectEntityId, core: [...before.core], adaptive: [...before.adaptive], situational: [...before.situational] };
    for (const item of change.items) {
      const values = next[item.category];
      const clear = item.action === 'remove' && snapshot[item.category]?.length === 0;
      next[item.category] = clear ? [] : values.filter(value => value.id !== item.before?.id && (!item.before || itemMeaningKey(value) !== itemMeaningKey(item.before)));
      if (item.after?.origin === 'manual' && !next[item.category].some(value => value.id === item.after.id)) next[item.category].push(item.after);
    }
    if (delta.source?.manualCoreSubjectEntityIds?.includes(change.subjectEntityId) && !snapshot.core.length) next.core = [];
    subjects.set(change.subjectEntityId, next);
    snapshots.push(next);
  }
  return snapshots;
}

export async function preserveManualCseDelta(automaticDelta, manualDelta) {
  if (!manualDelta?.source?.manualSubjectEntityIds?.length) return automaticDelta;
  const changes = manualDeltaChanges(manualDelta);
  const subjects = new Map(automaticDelta.subjectSnapshots.map(snapshot => [snapshot.subjectEntityId, snapshot]));
  applyManualDeltaChanges(subjects, manualDelta, changes);
  const subjectSnapshots = [...subjects.values()].map(subject => ({ ...subject,
    changeSummary: subject.changeSummary ?? [], coreChallenges: subject.coreChallenges ?? [] }));
  const ids = new Set(manualDelta.source.manualSubjectEntityIds);
  const fixedChanges = [...(automaticDelta.fixedChanges ?? []).filter(subject => !ids.has(subject.subjectEntityId)), ...changes.filter(subject => subject.items.length)];
  const noMaterialChange = false;
  const fingerprint = `sha256:${await sha256(JSON.stringify([automaticDelta.floorId, automaticDelta.floorMemoryId, subjectSnapshots, noMaterialChange, { fixedChanges }]))}`;
  return validateStateDeltaRecord({ ...automaticDelta, subjectSnapshots, fixedChanges, noMaterialChange, fingerprint,
    source: { ...automaticDelta.source, manualSubjectEntityIds: [...ids],
      ...(manualDelta.source.manualCoreSubjectEntityIds ? { manualCoreSubjectEntityIds: manualDelta.source.manualCoreSubjectEntityIds } : {}) } }, { expectedChatId: automaticDelta.chatId });
}

export function projectCseDeltasForSources({ floors = [], stateDeltas = [], confirmedFloorIds }) {
  const subjects = new Map(), projected = [];
  for (const delta of filterReachableDeltas({ floors, stateDeltas })) {
    if (confirmedFloorIds.has(delta.floorId)) {
      for (const snapshot of delta.subjectSnapshots) applyDeltaSnapshot(subjects, delta, snapshot);
      projected.push(delta);
      continue;
    }
    const changes = manualDeltaChanges(delta);
    const snapshots = applyManualDeltaChanges(subjects, delta, changes);
    if (snapshots.length) projected.push({ ...delta, subjectSnapshots: snapshots, fixedChanges: changes.filter(subject => subject.items.length) });
  }
  return projected;
}

export async function replayCurrentState({ chatId, narrativeGeneration, baselineId, floors = [], floorMemories = [], stateDeltas = [], now, id = null, previousId = null }) {
  const deltas = filterReachableDeltas({ floors, floorMemories, stateDeltas });
  const subjects = new Map();
  for (const delta of deltas) for (const snapshot of delta.subjectSnapshots) applyDeltaSnapshot(subjects, delta, snapshot);
  const subjectList = [...subjects.values()];
  const appliedDeltaIds = deltas.map(delta => delta.id);
  const headFloorId = deltas.at(-1)?.floorId ?? null;
  const fingerprint = await stateFingerprint(subjectList, appliedDeltaIds, headFloorId);
  const recordId = id ?? await deterministicUuid(['v3-cse-current-state', chatId, narrativeGeneration, fingerprint]);
  return validateCurrentStateRecord({ schemaVersion: 3, recordType: 'currentState', id: recordId, chatId, narrativeGeneration, baselineId, subjects: subjectList, appliedDeltaIds, headFloorId, fingerprint, createdAt: now, updatedAt: now, recordStatus: 'active', supersedes: previousId }, { expectedChatId: chatId });
}
