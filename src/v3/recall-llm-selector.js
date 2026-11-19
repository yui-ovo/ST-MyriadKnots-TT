import { RECALL_LLM_SYSTEM_PROMPT } from './analysis-prompts.js';
export { RECALL_LLM_SYSTEM_PROMPT } from './analysis-prompts.js';
import { withBaseProcessingPrompt } from '../internal-processing-prompt.js';
import { addSemanticHistory, mergeSemanticHistoryPool, semanticHistoryCharacters } from './recall-selector.js';
import { parseJsonOutput } from '../compact-api-client.js';
import { buildRecallAnnualCandidatePool, buildRecallCseCandidatePool, buildRecallHistoryCandidatePool, cseSelectionContext, estimateRecallTokens, historySelectionContext, recallBudget, selectRecall } from './recall-selector.js';
import { formatChronologyAnchor } from './recall-source.js';
import { sanitizeTaskMetadata } from './safe-metadata.js';
import { projectQianshiCandidateSelection, qianshiRecallPendingHeader } from './qianshi-domain.js';

const abortError = reason => {
  try { return new DOMException(String(reason ?? 'The operation was aborted.'), 'AbortError'); }
  catch { const error = new Error(String(reason ?? 'The operation was aborted.')); error.name = 'AbortError'; return error; }
};

function validateExcludedKeys(value, field, allowed, optional = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new TypeError('历史选材输出结构无效'), { code: 'V3_RECALL_LLM_SCHEMA_INVALID' });
  }
  if (!Object.hasOwn(value, field)) {
    return [];
  }
  if (!Array.isArray(value[field])) {
    if (optional) return [];
    throw Object.assign(new TypeError('历史选材输出结构无效'), { code: 'V3_RECALL_LLM_SCHEMA_INVALID' });
  }
  const seen = new Set(), selected = [];
  for (const key of value[field]) {
    if (typeof key !== 'string' || !allowed.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key); selected.push(key);
  }
  return selected;
}

function optionalExcludedKeys(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new TypeError('历史选材输出结构无效'), { code: 'V3_RECALL_LLM_SCHEMA_INVALID' });
  if (!Object.hasOwn(value, field)) return [];
  const raw = typeof value[field] === 'string' ? [value[field]] : value[field];
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), selected = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !allowed.has(key)) continue;
    if (!seen.has(key)) { seen.add(key); selected.push(key); }
  }
  return selected;
}

function optionalPriority(value, candidatesByKey, excludedKeys) {
  if (!Object.hasOwn(value, 'priority_keys')) return { status: 'missing', keys: [], candidates: [], ignoredCount: 0 };
  if (!Array.isArray(value.priority_keys)) return { status: 'invalid', keys: [], candidates: [], ignoredCount: 1 };
  if (!value.priority_keys.length) return { status: 'empty', keys: [], candidates: [], ignoredCount: 0 };
  const seen = new Set(), keys = [], candidates = [];
  let ignoredCount = 0;
  for (const key of value.priority_keys) {
    if (typeof key !== 'string' || !candidatesByKey.has(key) || excludedKeys.has(key) || seen.has(key) || keys.length >= 8) {
      ignoredCount += 1;
      continue;
    }
    seen.add(key);
    keys.push(key);
    const candidate = candidatesByKey.get(key);
    candidates.push(Object.freeze({ key, stableKey: candidate.stableKey }));
  }
  return { status: keys.length ? 'applied' : 'invalid', keys, candidates, ignoredCount: Math.min(10000, ignoredCount) };
}

const qianshiBlock = value => value?.text ? `<qqj_qianshi_progress>\n${value.text}\n</qqj_qianshi_progress>` : '';
const qianshiTokens = value => value?.text ? estimateRecallTokens(`\n\n${qianshiBlock(value)}`) : 0;
const qianshiCharacters = value => value?.text ? `\n\n${qianshiBlock(value)}`.length : 0;
const QIANSHI_SHELL = '\n\n<qqj_qianshi_progress>\n\n</qqj_qianshi_progress>';
const QIANSHI_SHELL_TOKENS = estimateRecallTokens(QIANSHI_SHELL);

const exactRecallLine = value => String(value ?? '').normalize('NFKC').replace(/^\s*[-•]\s*/u, '').replace(/\s+/gu, ' ').trim();

export function removeExactQianshiDuplicates(progress, selection) {
  if (!progress?.text || !Array.isArray(progress.eventIds) || !progress.eventIds.length) return progress;
  const recalledLines = new Set((selection?.floors ?? []).flatMap(floor => floor.items ?? [])
    .filter(item => item.category === 'objective').map(item => exactRecallLine(item.text)).filter(Boolean));
  if (!recalledLines.size) return progress;
  const blocks = progress.text.split(/\n\n/u), timelineIndex = blocks.findIndex(block => block.startsWith('[相关时间线]'));
  if (timelineIndex < 0) return progress;
  const timelineLines = blocks[timelineIndex].split('\n'), keptRows = [], keptEventIds = [];
  let eventIndex = 0, removed = false;
  for (const line of timelineLines.slice(1)) {
    if (!line.trim()) continue;
    const eventId = progress.eventIds[eventIndex++];
    if (eventId && recalledLines.has(exactRecallLine(line))) { removed = true; continue; }
    keptRows.push(line);
    if (eventId) keptEventIds.push(eventId);
  }
  if (!removed) return progress;
  if (keptRows.length) blocks[timelineIndex] = ['[相关时间线]', ...keptRows].join('\n');
  else blocks.splice(timelineIndex, 1);
  const remaining = blocks.filter(Boolean);
  const hasQianshiMaterial = remaining.some(block => block.startsWith('[相关时间线]')
    || qianshiRecallPendingHeader(block, null) !== null);
  const text = (hasQianshiMaterial ? remaining : remaining.filter(block => !/^本轮千事资料来源截至：AI #\d+。$/u.test(block))).join('\n\n');
  return Object.freeze({ ...progress, text, characterCount: text.length, eventIds: Object.freeze(keptEventIds) });
}

const diagnostic = ({ semantic = null, mode, metadata = null, error = null, priority = null, durationMs = 0, utilityRoundTripMs = null, localSelectionMs = null, historyCandidateCount = null, stateCandidateCount = null, historyExcludedCount = null, stateExcludedCount = null, historyRetainedCount = null, stateRetainedCount = null, requestCharacters = null, requestEstimatedTokens = null, progressState = null } = {}) => {
  const api = sanitizeTaskMetadata(metadata);
  return Object.freeze({
    mode,
    ...(semantic ? { semantic } : {}),
    ...(priority ? { priority } : {}),
    code: typeof error?.code === 'string' ? error.code.slice(0, 120) : null,
    httpStatus: Number.isSafeInteger(error?.httpStatus ?? error?.status) ? (error.httpStatus ?? error.status) : null,
    formatStage: typeof error?.formatStage === 'string' ? error.formatStage.slice(0, 80) : null,
    finishReason: String(api.finishReason ?? '').slice(0, 32),
    source: api.source,
    sourceLabel: api.sourceLabel,
    model: api.model,
    transportAttempts: Number.isSafeInteger(api.transportAttempts) ? api.transportAttempts : null,
    sourceStage: api.sourceStage || 'recall-selector',
    requestCharacters: Number.isSafeInteger(requestCharacters) && requestCharacters >= 0 ? requestCharacters : null,
    requestEstimatedTokens: Number.isSafeInteger(requestEstimatedTokens) && requestEstimatedTokens >= 0 ? requestEstimatedTokens : null,
    durationMs: Math.max(0, Math.floor(Number(durationMs) || 0)),
    utilityRoundTripMs: Number.isFinite(utilityRoundTripMs) ? Math.max(0, Math.floor(utilityRoundTripMs)) : null,
    localSelectionMs: Number.isFinite(localSelectionMs) ? Math.max(0, Math.floor(localSelectionMs)) : null,
    historyCandidateCount: Number.isSafeInteger(historyCandidateCount) && historyCandidateCount >= 0 ? historyCandidateCount : null,
    stateCandidateCount: Number.isSafeInteger(stateCandidateCount) && stateCandidateCount >= 0 ? stateCandidateCount : null,
    historyModelSelectedCount: null,
    stateModelSelectedCount: null,
    historyExcludedCount: Number.isSafeInteger(historyExcludedCount) && historyExcludedCount >= 0 ? historyExcludedCount : null,
    stateExcludedCount: Number.isSafeInteger(stateExcludedCount) && stateExcludedCount >= 0 ? stateExcludedCount : null,
    historyRetainedCount: Number.isSafeInteger(historyRetainedCount) && historyRetainedCount >= 0 ? historyRetainedCount : null,
    stateRetainedCount: Number.isSafeInteger(stateRetainedCount) && stateRetainedCount >= 0 ? stateRetainedCount : null,
    pendingStep: ['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].includes(progressState?.pendingStep) ? progressState.pendingStep : null,
    lastCompletedStep: ['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].includes(progressState?.lastCompletedStep) ? progressState.lastCompletedStep : null,
    stageTimings: Object.fromEntries(['semanticQuery', 'candidateBuild', 'utilityTask', 'responseParse', 'localSelection'].map(key => [key, Number.isFinite(progressState?.stageTimings?.[key]) ? Math.max(0, progressState.stageTimings[key]) : null])),
  });
};

export async function selectRecallWithLlm({
  source,
  queryContext,
  contextSize = 8192,
  maxFloors,
  maxItems,
  reservedTokens = 0,
  reservedCharacters = 0,
  generateUtilityTask,
  processingPrompt = '',
  signal,
  transportBudget = { remaining: 3, used: 0 },
  semanticProvider = null,
  onProgress = null,
} = {}) {
  const systemPrompt = withBaseProcessingPrompt(RECALL_LLM_SYSTEM_PROMPT, typeof processingPrompt === 'function' ? processingPrompt() : processingPrompt);
  const selectorStarted = Date.now();
  const progressState = { pendingStep: null, lastCompletedStep: null, stageTimings: {} };
  let stepStarted = null;
  const updateStep = pendingStep => {
    if (stepStarted !== null && progressState.pendingStep) {
      const key = progressState.pendingStep;
      progressState.stageTimings[key] = (progressState.stageTimings[key] ?? 0) + Math.max(0, Date.now() - stepStarted);
      progressState.lastCompletedStep = key;
    }
    progressState.pendingStep = pendingStep;
    stepStarted = pendingStep ? Date.now() : null;
    if (typeof onProgress === 'function') try { onProgress(Object.freeze({ pendingStep, lastCompletedStep: progressState.lastCompletedStep, stageTimings: Object.freeze({ ...progressState.stageTimings }) })); } catch {}
  };
  updateStep('semanticQuery');
  let historyContext = historySelectionContext(source, queryContext);
  let semantic = { candidates: [], diagnostic: { status: 'disabled', candidateCount: 0, durationMs: 0 } };
  if (historyContext && typeof semanticProvider === 'function') {
    try { semantic = await semanticProvider({ source, queryContext, signal, eligibleFloorMemoryIds: historyContext.oldMemories.map(value => value.floorMemoryId) }); }
    catch { semantic = { candidates: [], diagnostic: { status: 'unavailable', candidateCount: 0, durationMs: 0 } }; }
    if (signal?.aborted) throw abortError(signal.reason);
  }
  updateStep('candidateBuild');
  let nativeHistoryContext = historyContext;
  if (semantic.candidates?.length) historyContext = addSemanticHistory(historyContext, semantic.candidates);
  if (historyContext?.semantic?.length) {
    const linked = historyContext.semantic.flatMap(raw => {
      const witness = raw.rawWitness;
      return historyContext.summaries.filter(summary => summary.floorMemoryId === witness.floorMemoryId
        && summary.floorId === (witness.memoryFloorId ?? witness.floorId))
        .map(summary => ({...summary, score:Math.max(summary.score ?? 0,raw.score ?? 0)}));
    });
    nativeHistoryContext = {...nativeHistoryContext,direct:[...nativeHistoryContext.direct,...linked]};
    historyContext = {...historyContext,direct:[...historyContext.direct,...linked]};
  }
  const cseContext = cseSelectionContext(source, queryContext);
  const baseInput = { source, queryContext, historyContext, cseContext, contextSize, maxFloors, maxItems, reservedTokens, reservedCharacters };
  // 原文片段与人工摘要共用最多12个语义位置；命中已有摘要时只替换该候选，不另加重复项。
  const hasSemantic = historyContext.semantic?.length > 0;
  const nativeHistoryPool = buildRecallHistoryCandidatePool({ source, queryContext, historyContext: nativeHistoryContext, maxCandidates: hasSemantic ? 36 : 48, maxCharacters: 24000 - semanticHistoryCharacters(historyContext) });
  const historyPool = hasSemantic ? mergeSemanticHistoryPool(nativeHistoryPool, historyContext) : nativeHistoryPool;
  const csePool = buildRecallCseCandidatePool({ source, queryContext, cseContext });
  const annualCandidates = buildRecallAnnualCandidatePool({ source, queryContext, historyContext });
  const qianshiCandidates = Array.isArray(source?.qianshiCandidates) ? source.qianshiCandidates : [];
  const suppliedQianshiTokens = qianshiTokens(source?.qianshiProgress);
  const suppliedQianshiCharacters = qianshiCharacters(source?.qianshiProgress);
  const externalReservedTokens = Math.max(0, reservedTokens - suppliedQianshiTokens);
  const externalReservedCharacters = Math.max(0, reservedCharacters - suppliedQianshiCharacters);
  const totalBudget = recallBudget(contextSize);
  const qianshiContentBudget = Math.max(0, Math.min(4000,
    totalBudget.totalCharacters - externalReservedCharacters - QIANSHI_SHELL.length,
    totalBudget.totalTokens - externalReservedTokens - QIANSHI_SHELL_TOKENS));
  const projectCandidates = excludedKeys => projectQianshiCandidateSelection(qianshiCandidates, {
    excludedKeys,
    characterBudget: qianshiContentBudget,
  });
  const maximumCandidateQianshi = qianshiCandidates.some(candidate => projectQianshiCandidateSelection([candidate], { characterBudget: qianshiContentBudget }).text)
    ? { characters: QIANSHI_SHELL.length + qianshiContentBudget, tokens: QIANSHI_SHELL_TOKENS + qianshiContentBudget }
    : { characters: 0, tokens: 0 };
  const allCandidates = [...historyPool.candidates, ...csePool.candidates];
  const candidateCounts = { historyCandidateCount: historyPool.candidates.length, stateCandidateCount: csePool.candidates.length };
  if (!allCandidates.length && !annualCandidates.length) {
    updateStep('localSelection');
    const projectedQianshi = qianshiCandidates.length ? projectCandidates([]) : source?.qianshiProgress ?? null;
    const qianshiProgress = projectedQianshi;
    const selection = selectRecall({ ...baseInput,
      reservedTokens: externalReservedTokens + qianshiTokens(qianshiProgress),
      reservedCharacters: externalReservedCharacters + qianshiCharacters(qianshiProgress),
      selectedHistoryCandidates: [], selectedCseCandidates: [], selectedAnnualReminderIds: [] });
    const durationMs = Date.now() - selectorStarted;
    updateStep(null);
    return Object.freeze({ ...selection, qianshiProgress: removeExactQianshiDuplicates(qianshiProgress, selection),
      selectorDiagnostic: diagnostic({ mode: 'local', durationMs, utilityRoundTripMs: 0, localSelectionMs: durationMs, ...candidateCounts, historyRetainedCount: 0, stateRetainedCount: 0, progressState }) });
  }
  if (typeof generateUtilityTask !== 'function') throw Object.assign(new Error('历史智能选材服务不可用。'), { code: 'V3_RECALL_LLM_UNAVAILABLE' });
  const plannedQianshi = qianshiCandidates.length ? maximumCandidateQianshi
    : { characters: suppliedQianshiCharacters, tokens: suppliedQianshiTokens };
  const planned = selectRecall({ ...baseInput,
    reservedTokens: externalReservedTokens + plannedQianshi.tokens,
    reservedCharacters: externalReservedCharacters + plannedQianshi.characters,
    selectedHistoryCandidates: [], selectedCseCandidates: [], selectedAnnualReminderIds: [] });
  const chronologyByFloor = new Map((source?.floorMemories ?? []).map(memory => [memory.floorId, formatChronologyAnchor(memory.chronology ?? [])]));
  const cseByKeyForPayload = new Map(csePool.candidates.map(candidate => [candidate.key, candidate]));
  const recentContinuation = planned.floors.flatMap(floor => floor.items
    .filter(item => item.recallSection === 'recent')
    .map(item => ({ floorId:floor.floorId, floorMemoryId:floor.floorMemoryId, assistantSeq:floor.assistantSeq, time:formatChronologyAnchor(floor.chronology ?? []) || null, summary:item.text, truncated:item.truncated === true })));
  const recentByKey = new Map(recentContinuation.map((value, index) => [`P${index + 1}`, value]));
  const payload = {
    query: {
      latestUser: String(queryContext?.latestUserText ?? ''),
      recentAssistant: String(queryContext?.recentAssistantText ?? ''),
      previousUser: String(queryContext?.previousUserText ?? ''),
      currentStoryTime: typeof source?.qianshiCurrentStoryTime === 'string' ? source.qianshiCurrentStoryTime : null,
    },
    alreadyProvided: {
      recentContinuation: [...recentByKey].map(([key, value]) => ({ key, assistantSeq:value.assistantSeq, time:value.time, summary:value.summary, truncated:value.truncated })),
      savedStateThroughAssistantSeq: source?.coverage?.cseThroughAssistantSeq ?? null,
      coreCoveredAssistantSeq: (source?.floorMemories ?? [])
        .filter(memory => (source?.bodyMatch?.coveredFloorIds ?? []).includes(memory.floorId))
        .map(memory => memory.assistantSeq),
    },
    candidates: historyPool.candidates.map(candidate => ({ key: candidate.key, fact: candidate.text })),
    ...(annualCandidates.length ? { annualCandidates: annualCandidates.map(({ key, fact }) => ({ key, fact })) } : {}),
    qianshiCandidates: qianshiCandidates.map(candidate => ({ key: candidate.key, kind: candidate.kind, fact: candidate.fact })),
    cseContextGroups: csePool.groups.map(group => ({ ...group, items: group.items.map(item => {
      const candidate = cseByKeyForPayload.get(item.key);
      const floorId = candidate?.value?.floorId ?? candidate?.value?.sourceFloorId ?? candidate?.value?.after?.sourceFloorId ?? candidate?.value?.before?.sourceFloorId;
      return { ...item, sourceTime: chronologyByFloor.get(floorId) || null };
    }) })),
  };
  const sourceGroups = new Map();
  for (const candidate of historyPool.candidates.filter(row => row.value.rawWitness)) {
    const witness = candidate.value.rawWitness, floorId = witness.memoryFloorId ?? witness.floorId;
    const summaryKeys = historyPool.candidates.filter(row => row.value.kind === 'summary'
      && row.value.floorMemoryId === witness.floorMemoryId && row.value.floorId === floorId).map(row => row.key);
    summaryKeys.push(...[...recentByKey].filter(([,row]) => row.floorId === floorId
      && (!row.floorMemoryId || row.floorMemoryId === witness.floorMemoryId)).map(([key]) => key));
    if (!summaryKeys.length) continue;
    const groupKey = JSON.stringify([floorId,witness.floorMemoryId]);
    const group = sourceGroups.get(groupKey) ?? {rawKeys:[],summaryKeys};
    group.rawKeys.push(candidate.key); sourceGroups.set(groupKey,group);
  }
  if (sourceGroups.size) payload.sourceGroups = [...sourceGroups.values()];
  const serializedTaskInput = JSON.stringify(payload);
  const requestCharacters = systemPrompt.length + serializedTaskInput.length;
  const requestEstimatedTokens = estimateRecallTokens(`${systemPrompt}\n${serializedTaskInput}`);
  let result = null;
  const utilityStarted = Date.now();
  try {
    // The runtime and transport share this logical selection budget.
    const taskMessages = [{ role: 'user', content: serializedTaskInput }];
    updateStep('utilityTask');
    result = await generateUtilityTask({
      promptTask: 'recall', promptOwnerId: source?.chatId,
      systemPrompt,
      taskMessages,
      temperature: 0,
      maxTokens: 8192,
      parseMode: 'semantic',
      includeCharacterCard: false,
      worldInfoSource: 'none',
      signal,
      transportBudget,
    });
    const utilityCompleted = Date.now();
    if (signal?.aborted) throw abortError(signal.reason);
    updateStep('responseParse');
    const raw = result?.jsonData ?? result?.textData ?? result;
    const parsed = parseJsonOutput(raw, { finishReason: result?.taskMetadata?.finishReason });
    const historyAllowed = new Set(historyPool.candidates.map(candidate => candidate.key));
    const stateAllowed = new Set(csePool.candidates.map(candidate => candidate.key));
    const historyKeys = validateExcludedKeys(parsed, 'history_exclude_keys', historyAllowed);
    const artifactAllowed = new Set(historyPool.candidates.filter(candidate => candidate.sourceKind === 'manualArtifact').map(candidate => candidate.key));
    const artifactKeys = validateExcludedKeys(parsed, 'artifact_select_keys', artifactAllowed, true);
    const stateKeys = validateExcludedKeys(parsed, 'state_exclude_keys', stateAllowed);
    // 未返回保留键时不默认塞回所有生日；周年正选仅消费本次候选中的合法键。
    const annualKeys = validateExcludedKeys(parsed, 'annual_retain_keys', new Set(annualCandidates.map(candidate => candidate.key)), true);
    // 历史、状态或周年任一非空池有对应数组答复即可；各字段仅消费本池合法键。
    const answeredNonemptyPool = (historyAllowed.size > 0 && Object.hasOwn(parsed, 'history_exclude_keys'))
      || (stateAllowed.size > 0 && Object.hasOwn(parsed, 'state_exclude_keys'))
      || (annualCandidates.length > 0 && (Array.isArray(parsed.annual_retain_keys)
        || Array.isArray(parsed.history_exclude_keys) || Array.isArray(parsed.state_exclude_keys)));
    if (!answeredNonemptyPool) throw Object.assign(new TypeError('非空历史候选池没有收到有效选材答复'), { code: 'V3_RECALL_LLM_FIELDS_MISSING' });
    const qianshiKeys = optionalExcludedKeys(parsed, 'qianshi_exclude_keys', new Set(qianshiCandidates.map(candidate => candidate.key)));
    const historyByKey = new Map(historyPool.candidates.map(candidate => [candidate.key, candidate]));
    const cseByKey = new Map(csePool.candidates.map(candidate => [candidate.key, candidate]));
    const excludedHistory = historyKeys.map(key => historyByKey.get(key)).filter(Boolean);
    const excludedCse = stateKeys.map(key => cseByKey.get(key)).filter(Boolean);
    const retainedHistory = historyPool.candidates.filter(candidate => candidate.sourceKind !== 'manualArtifact' && !historyKeys.includes(candidate.key));
    retainedHistory.push(...historyPool.candidates.filter(candidate => artifactKeys.includes(candidate.key)));
    const retainedCse = csePool.candidates.filter(candidate => !stateKeys.includes(candidate.key));
    const priorityCandidatesByKey = new Map([...retainedHistory, ...retainedCse].map(candidate => [candidate.key, candidate]));
    // A malformed optional hint is ignored locally; it never retries the request or restores excluded material.
    const parsedPriority = optionalPriority(parsed, priorityCandidatesByKey, new Set([...historyKeys, ...stateKeys]));
    const projectedQianshi = qianshiCandidates.length
      ? projectCandidates(qianshiKeys)
      : source?.qianshiProgress ?? null;
    const qianshiProgress = projectedQianshi;
    updateStep('localSelection');
    const finalInput = { ...baseInput,
      reservedTokens: externalReservedTokens + qianshiTokens(qianshiProgress),
      reservedCharacters: externalReservedCharacters + qianshiCharacters(qianshiProgress) };
    const selection = selectRecall({
        ...finalInput,
        selectedHistoryCandidates: retainedHistory,
        selectedCseCandidates: retainedCse,
        priorityCandidates: parsedPriority.candidates,
        selectedAnnualReminderIds: annualCandidates.filter(candidate => annualKeys.includes(candidate.key)).map(candidate => candidate.itemId),
        excludedHistoryCandidates: excludedHistory,
        excludedCseCandidates: excludedCse,
      });
    const selectorCompleted = Date.now();
    updateStep(null);
    // 向量阶段单独计时；本地选材只包含候选准备、回包解析与最终材料选择。
    const priorityDiagnostic = Object.freeze({
      status: selection.prioritySelection?.timeGuard ? 'timeGuard' : parsedPriority.status,
      keys: Object.freeze(parsedPriority.keys),
      selectedKeys: Object.freeze(selection.prioritySelection?.selectedKeys ?? []),
      ignoredCount: parsedPriority.ignoredCount,
    });
    const { prioritySelection: _prioritySelection, ...selectionResult } = selection;
    return Object.freeze({
      ...selectionResult,
      qianshiProgress: removeExactQianshiDuplicates(qianshiProgress, selection),
      selectorDiagnostic: diagnostic({
        semantic: semantic.diagnostic, mode: 'llm', metadata: result?.taskMetadata, priority: priorityDiagnostic,
        durationMs: selectorCompleted - selectorStarted,
        utilityRoundTripMs: utilityCompleted - utilityStarted,
        localSelectionMs: Math.max(0, (utilityStarted - selectorStarted) + (selectorCompleted - utilityCompleted) - (Number(semantic.diagnostic?.durationMs) || 0)),
        ...candidateCounts,
        requestCharacters, requestEstimatedTokens,
        historyExcludedCount: historyKeys.length, stateExcludedCount: stateKeys.length,
        historyRetainedCount: retainedHistory.length, stateRetainedCount: retainedCse.length,
        progressState,
      }),
    });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal.reason);
    const metadata = result?.taskMetadata ?? error?.taskMetadata ?? null;
    const utilityCompleted = Date.now();
    const failureMetadata = result && metadata ? { ...metadata, sourceStage: 'selector-parse' } : metadata;
    const failureDiagnostic = diagnostic({ semantic: semantic.diagnostic, mode: 'llm', metadata: failureMetadata, error, durationMs: utilityCompleted - selectorStarted,
      utilityRoundTripMs: utilityCompleted - utilityStarted,
      localSelectionMs: Math.max(0, utilityStarted - selectorStarted - (Number(semantic.diagnostic?.durationMs) || 0)),
      ...candidateCounts, requestCharacters, requestEstimatedTokens, progressState });
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      error.selectorDiagnostic = failureDiagnostic;
      if (metadata) error.taskMetadata = metadata;
    }
    throw error;
  }
}
