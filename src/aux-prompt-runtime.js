import { AUX_BUILTIN_ID, resolveAuxPromptPreset } from './aux-prompt-library.js';
import { AUX_TASKS, getAuxDemoTaskOptions, getAuxPromptValues } from './aux-prompt-tasks.js';
import { prependProcessingPrompt, resolveSharedProcessingPrompt } from './shared-processing-prompt.js';

const taskIds = new Set(AUX_TASKS.map(task => task.id));
const fallbackInstructions = 'Process only the supplied task input. Return only JSON matching the requested schema.';
const macroPattern = /\{\{\s*(qqj_[\w]+)\s*\}\}/gu;
const roles = new Set(['system', 'user', 'assistant']);
const presetError = message => Object.assign(new Error(message), { code: 'QQJ_PROMPT_PRESET_INVALID' });

function taskInput(options) {
  return {
    systemPrompt: typeof options.systemPrompt === 'string' && options.systemPrompt.trim() ? options.systemPrompt.trim() : fallbackInstructions,
    taskMessages: (Array.isArray(options.taskMessages) ? options.taskMessages : [])
      .filter(message => roles.has(message?.role) && typeof message.content === 'string')
      .map(({ role, content }) => ({ role, content })),
  };
}

export function renderAuxPrompt(taskId, preset, options, prefix) {
  const input = taskInput(options);
  if (!preset || preset.id === AUX_BUILTIN_ID) {
    return { messages: [
      { role: 'system', content: prependProcessingPrompt(input.systemPrompt, prefix) },
      ...input.taskMessages.filter(message => message.role !== 'assistant'),
    ], warnings: [] };
  }
  if (preset.taskId !== taskId) throw presetError('所选提示词预设属于其他任务。');
  const values = getAuxPromptValues(taskId, input, prefix);
  const messages = [], warnings = [];
  for (const row of preset.rows) {
    if (!row.enabled) continue;
    if (!roles.has(row.role)) throw presetError(`「${row.name}」的消息角色无效。`);
    // A single input placeholder keeps separate upstream messages (e.g. a catalog and a query).
    const parts = /^\s*\{\{\s*qqj_input\s*\}\}\s*$/u.test(row.content)
      ? input.taskMessages.map(message => message.content)
      : [row.content.replace(macroPattern, (token, key) => {
        if (!Object.hasOwn(values, key)) throw presetError(`「${row.name}」使用了本任务无法识别的宏 ${token}。`);
        return values[key];
      })];
    const nonempty = parts.filter(part => part.trim());
    if (!nonempty.length) warnings.push(`「${row.name}」展开后为空，已跳过。`);
    for (const content of nonempty) messages.push({ role: row.role, content });
  }
  if (!messages.length) throw presetError('预设展开后没有可发送的消息，请启用含有内容的条目。');
  return { messages, warnings };
}

function policyText(preset, prefix) {
  if (!preset || preset.id === AUX_BUILTIN_ID) return prefix;
  return JSON.stringify([prefix, preset.rows.filter(row => row.enabled).map(row => [row.role, row.content])]);
}

export const auxRouteKey = route => {
  const id = route?.config?.id || route?.selectedPresetId;
  return route?.source !== 'qqj-main' && id ? `preset:${id}` : 'main';
};

export function createAuxPromptRuntime({ settings, resolver, currentIdentity, listSources, readSource }) {
  const pinned = new WeakMap(), recent = new Map();
  let owner = '', serial = 0, contextRevision = 0;
  const clear = () => { owner = ''; recent.clear(); contextRevision++; };
  const scope = () => {
    let identity;
    try { identity = currentIdentity(); } catch { /* no prepared chat */ }
    const key = identity?.chatId ? JSON.stringify([identity.chatId, identity.hostChatId]) : '';
    if (key !== owner) { clear(); owner = key; }
    return { key, chatId: identity?.chatId };
  };
  const selected = (taskId, routeKey) => resolveAuxPromptPreset(settings.get().auxPromptLibrary, taskId, routeKey);
  const signature = (taskId, routeKey, prefix) => policyText(selected(taskId, routeKey), resolveSharedProcessingPrompt(prefix));
  function prepare(options, prefix) {
    const { promptTask: taskId, routeKey, transportBudget } = options;
    const id = JSON.stringify([taskId, routeKey]);
    let recipes = transportBudget && pinned.get(transportBudget);
    if (!recipes && transportBudget) { recipes = new Map(); pinned.set(transportBudget, recipes); }
    let recipe = recipes?.get(id);
    if (!recipe) {
      recipe = { preset: taskIds.has(taskId) ? selected(taskId, routeKey) : null, prefix };
      recipes?.set(id, recipe);
    }
    if (taskIds.has(taskId)) {
      const { chatId } = scope();
      if (chatId && chatId === options.promptOwnerId) {
        // Keep one input per task, in memory, for its current chat only. Never retain transport options.
        const input = taskInput(options);
        recent.set(taskId, { id: `request:${++serial}`, input });
      }
    }
    return { ...renderAuxPrompt(taskId, recipe.preset, options, recipe.prefix),
      policy: policyText(recipe.preset, recipe.prefix), custom: Boolean(recipe.preset && recipe.preset.id !== AUX_BUILTIN_ID) };
  }
  function sources(taskId) {
    if (!taskIds.has(taskId)) return [];
    const current = scope(), captured = recent.get(taskId);
    return [...(current.key ? listSources?.(taskId) ?? [] : []),
      ...(captured ? [{ id: captured.id, label: '本次打开聊天后最近一次任务的材料' }] : []),
      { id: 'demo', label: '格式演示（示例材料）' }];
  }
  async function preview({ taskId, sourceId, preset }) {
    if (!taskIds.has(taskId)) throw presetError('请选择可用的任务。');
    const prefix = resolveSharedProcessingPrompt(settings.processingPrompt());
    if (sourceId === 'demo') {
      const result = renderAuxPrompt(taskId, preset, getAuxDemoTaskOptions(taskId), prefix);
      result.warnings.unshift('此处使用示例材料和简短任务指令演示排布。');
      return result;
    }
    const initial = scope().key, revision = contextRevision;
    if (!initial) throw presetError('请先打开已准备好的聊天并选择任务。');
    const captured = recent.get(taskId);
    const input = captured && sourceId === captured.id ? captured.input : await readSource(taskId, sourceId);
    if (!input || initial !== scope().key || revision !== contextRevision) throw presetError('预览资料已变化，请重新选择。');
    return renderAuxPrompt(taskId, preset, input, prefix);
  }
  const routes = () => [
    { id: 'main', label: '千千结主配置' },
    ...resolver.describeSevenDaysPresets().map(({ id, name }) => ({ id: `preset:${id}`, label: name })),
  ];
  return { prepare, signature, clear, preview, routes, sources };
}
