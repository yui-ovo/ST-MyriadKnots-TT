import { BASE_PROCESSING_PROMPT, resolveSharedProcessingPrompt } from './shared-processing-prompt.js';
import { aggregateInstructionSections, DEFAULT_EXTRACTOR_GUIDANCE, extractorInstructionSections } from './v3/extractor-prompts.js';
import { cseInstructionSections, DEFAULT_CSE_GUIDANCE, DEFAULT_PROFILE_GUIDANCE, profileInstructionSections, RECALL_LLM_SYSTEM_PROMPT } from './v3/analysis-prompts.js';
import { ANNUAL_SETTING_SYSTEM_PROMPT, TIME_CURRENT_REVIEW_PROMPT, TIME_SYSTEM_PROMPT } from './v3/time-prompts.js';
import { PLACE_INITIALIZATION_PROMPT, PLACE_ORGANIZATION_PROMPT, QIANSHI_FOLLOWUP_SYSTEM_PROMPT, QIANSHI_HISTORY_INSTRUCTIONS,
  QIANSHI_REJUDGE_INSTRUCTIONS } from './v3/archive-maintenance-prompts.js';
import { CLASSIFY_PROMPT, DEFAULT_WORLDBOOK_GUIDANCE, worldbookInstructionSections } from './dynamic-worldbook-update.js';
import { WORLDBOOK_SELECTION_PROMPT } from './dynamic-worldbook-selection.js';

const guidanceDefaults = {
  summaryPrompt: DEFAULT_EXTRACTOR_GUIDANCE, csePrompt: DEFAULT_CSE_GUIDANCE,
  profilePrompt: DEFAULT_PROFILE_GUIDANCE, worldbookPrompt: DEFAULT_WORLDBOOK_GUIDANCE,
};

const contracts = {
  summary: { label: '逐楼摘要', guidance: '摘要内容指导', setting: 'summaryPrompt', sections: extractorInstructionSections },
  summaryBatch: { label: '合并摘要', guidance: '合并摘要内容指导', setting: 'summaryPrompt', sections: aggregateInstructionSections },
  cse: { label: 'CSE 人物状态', guidance: 'CSE 内容指导', setting: 'csePrompt', sections: cseInstructionSections, rulesFirst: true },
  recall: { label: '记忆召回选材', text: RECALL_LLM_SYSTEM_PROMPT },
  profile: { label: '人物基础资料', guidance: '人物资料内容指导', setting: 'profilePrompt', sections: profileInstructionSections },
  time: { label: '时间事项提取', text: TIME_SYSTEM_PROMPT },
  timeReview: { label: '时间事项现状评估', text: TIME_CURRENT_REVIEW_PROMPT },
  annualSetting: { label: '年度日期设定', text: ANNUAL_SETTING_SYSTEM_PROMPT },
  placeInit: { label: '地点初始化', text: PLACE_INITIALIZATION_PROMPT },
  places: { label: '地点整理', text: PLACE_ORGANIZATION_PROMPT },
  qianshiHistory: { label: '千事历史补齐', text: QIANSHI_HISTORY_INSTRUCTIONS },
  qianshiRejudge: { label: '千事记录重判', text: QIANSHI_REJUDGE_INSTRUCTIONS },
  qianshiFollowup: { label: '千事跟进复核', text: QIANSHI_FOLLOWUP_SYSTEM_PROMPT },
  worldbookClassify: { label: '资料条目分类', text: CLASSIFY_PROMPT },
  worldbookUpdate: { label: '资料条目更新', guidance: '资料更新内容指导', setting: 'worldbookPrompt', sections: worldbookInstructionSections },
  worldbookSelect: { label: '资料条目选材', text: WORLDBOOK_SELECTION_PROMPT },
};

export function hasLegacyAuxPromptOverrides(settings) {
  if (resolveSharedProcessingPrompt(settings?.processingPrompt) !== BASE_PROCESSING_PROMPT) return true;
  return Object.entries(guidanceDefaults).some(([key, defaults]) => {
    const text = settings?.[key];
    return typeof text === 'string' && text.trim() && text !== defaults;
  });
}

export function getAuxSelectionRetry(options) {
  const prompt = options?.systemPrompt;
  return typeof prompt === 'string' && prompt.startsWith(WORLDBOOK_SELECTION_PROMPT)
    ? prompt.slice(WORLDBOOK_SELECTION_PROMPT.length) : '';
}

// The transport trims the assembled instructions before prepending the prefix.
// Keep internal boundaries (including the CSE guidance heading's single newline).
function sectionTexts(contract, settings) {
  if (!contract.sections) return [contract.text];
  const [first, last] = contract.sections(settings?.[contract.setting]);
  return [first.trimStart(), last.trimEnd()];
}

export function getAuxOriginalInstructions(taskId, options = {}) {
  if (!Object.hasOwn(contracts, taskId)) return '';
  const text = sectionTexts(contracts[taskId]).join('\n\n');
  return taskId === 'worldbookSelect' ? text + getAuxSelectionRetry(options) : text;
}

const templateToken = /\{\{(\s*)(!*)(qqj_\w+)(\s*)\}\}/gu;
const quotedToken = (_, before, bangs, key, after) => '{{' + before + '!' + bangs + key + after + '}}';
export function escapeAuxPromptLiteral(text) {
  return String(text ?? '').replace(templateToken, quotedToken);
}

function instructionRows(taskId, settings) {
  const contract = contracts[taskId], texts = sectionTexts(contract, settings);
  return texts.map((text, index) => {
    const guidance = contract.sections && (contract.rulesFirst ? index === 1 : index === 0);
    const isLegacy = guidance && typeof settings?.[contract.setting] === 'string'
      && settings[contract.setting].trim() && settings[contract.setting] !== guidanceDefaults[contract.setting];
    const source = (isLegacy ? '旧设置 · ' : '千千结原版 · ') + (guidance ? contract.guidance : contract.label);
    const retrySlot = taskId === 'worldbookSelect' ? '{{qqj_selection_retry}}' : '';
    return { key: guidance ? 'guidance' : 'instructions', name: guidance ? contract.guidance : '任务规则与输出格式',
      source, role: 'system', enabled: true, messageGroup: 'systemPrompt', content: escapeAuxPromptLiteral(text) + retrySlot };
  });
}

export function getAuxTaskTemplateRows(taskId, legacySettings) {
  if (!Object.hasOwn(contracts, taskId)) return [];
  const prefix = resolveSharedProcessingPrompt(legacySettings?.processingPrompt);
  return [
    { key: 'prefix', name: '通用前缀', source: (prefix === BASE_PROCESSING_PROMPT ? '千千结原版' : '旧设置') + ' · 通用前缀',
      role: 'system', enabled: true, messageGroup: 'systemPrompt', content: escapeAuxPromptLiteral(prefix) },
    ...instructionRows(taskId, legacySettings),
    { key: 'input', name: '任务材料', source: '本次任务输入', role: 'user', enabled: true, content: '{{qqj_input}}' },
  ];
}

// v1 expanded unescaped macros once. Convert only the fixed prefix/instructions.
// Preserve all live material placeholders and quote any old literal ! syntax.
export function materializeLegacyTemplate(taskId, content, legacySettings) {
  if (typeof content !== 'string' || !Object.hasOwn(contracts, taskId)) return content;
  return content.replace(templateToken, (token, before, bangs, key, after) => {
    if (bangs) return quotedToken(token, before, bangs, key, after);
    if (key === 'qqj_prefix') return escapeAuxPromptLiteral(resolveSharedProcessingPrompt(legacySettings?.processingPrompt));
    if (key === 'qqj_instructions') return instructionRows(taskId, legacySettings).map(row => row.content).join('\n\n');
    return token;
  });
}
