import {
  AUX_BUILTIN_ID, builtinTask, discardUnusedEntries, editSuite, newPromptId, normalizeSuiteData,
  readAuxHost, requiredName, rowMetadata, suiteList, validRoute,
} from './aux-prompt-suites.js';

export { AUX_BUILTIN_ID };

const validRoles = new Set(['system', 'user', 'assistant']);
const canonical = new WeakSet();
const keyOf = value => typeof value === 'string' ? value.trim() : '';
const asLibrary = lib => canonical.has(lib) ? lib : normalizeAuxPromptLibrary(lib);
const suiteActions = new Set(['selectSuite', 'createSuite', 'copySuite', 'renameSuite', 'deleteSuite', 'updateHostPrompt']);

// Only definitions, placement options and bindings belong in extension settings.
// Expanded macros can contain chat material and are never part of this representation.
export function normalizeAuxPromptLibrary(raw, legacySettings) {
  const library = normalizeSuiteData(raw, legacySettings);
  canonical.add(library);
  return library;
}

export function listAuxSuites(lib) {
  return suiteList(asLibrary(lib));
}

export function getAuxHostPrompt(lib, key, { display = false } = {}) {
  return readAuxHost(asLibrary(lib), key, display);
}

function expandedPreset(library, preset) {
  const entries = new Map(library.entries.map(entry => [entry.id, entry]));
  const rows = preset.rows.map(row => {
    const { name, content } = entries.get(row.entryId);
    return { ...row, name, content };
  });
  return { ...preset, rows };
}

export function listAuxPresets(lib, taskId) {
  const library = asLibrary(lib);
  return [builtinTask(taskId), ...library.presets.filter(preset => preset.suiteId === library.activeSuiteId && preset.taskId === taskId).map(preset => expandedPreset(library, preset))];
}

export function getAuxPromptPreset(lib, taskId, presetId) {
  if (presetId === AUX_BUILTIN_ID) return builtinTask(taskId);
  const library = asLibrary(lib);
  const preset = library.presets.find(item => item.suiteId === library.activeSuiteId && item.id === presetId && item.taskId === taskId);
  return preset ? expandedPreset(library, preset) : null;
}

export function getAuxPromptBinding(lib, taskId, routeKey = '') {
  const library = asLibrary(lib);
  const binding = library.bindings.find(item => item.suiteId === library.activeSuiteId && item.taskId === taskId && item.routeKey === routeKey);
  return binding?.presetId ?? null;
}

export function resolveAuxPromptPreset(lib, taskId, routeKey = '') {
  const library = asLibrary(lib);
  const selected = getAuxPromptBinding(library, taskId, routeKey) ?? getAuxPromptBinding(library, taskId)
    ?? library.presets.find(item => item.suiteId === library.activeSuiteId && item.taskId === taskId && item.base)?.id;
  return getAuxPromptPreset(library, taskId, selected) ?? builtinTask(taskId);
}

export function getAuxEntryUses(lib, entryId) {
  const library = asLibrary(lib);
  const names = new Map(library.suites.map(suite => [suite.id, suite.name]));
  return library.presets.filter(preset => preset.rows.some(row => row.entryId === entryId))
    .map(({ id: presetId, name, taskId, suiteId }) => ({ presetId, name, taskId, suiteId, suiteName: names.get(suiteId) }));
}

function requiredTask(value) {
  const taskId = keyOf(value);
  if (!taskId) throw new Error('请选择任务。');
  return taskId;
}

function requiredRole(role) {
  if (!validRoles.has(role)) throw new Error('请选择有效的消息角色。');
  return role;
}

function requiredContent(content) {
  if (typeof content !== 'string') throw new Error('条目内容须为文本。');
  return content;
}

function requiredEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('条目启用状态无效。');
  return enabled;
}

function editablePreset(library, id) {
  if (id === AUX_BUILTIN_ID) throw new Error('请先复制内置默认预设。');
  const preset = library.presets.find(item => item.id === id && item.suiteId === library.activeSuiteId);
  if (!preset) throw new Error('找不到此提示词预设。');
  return preset;
}

function sourceEntry(library, entryId) {
  const entry = library.entries.find(item => item.id === entryId);
  if (!entry) throw new Error('找不到此提示词条目。');
  return entry;
}

function addDefinition(library, name, content) {
  const entry = { id: newPromptId(), name: requiredName(name), content: requiredContent(content) };
  library.entries.push(entry);
  return entry;
}

function appendRow(preset, entryId, role, enabled, metadata = {}) {
  const row = { id: newPromptId(), entryId, role: requiredRole(role), enabled: requiredEnabled(enabled), ...rowMetadata(metadata) };
  preset.rows.push(row);
  return row;
}

function copyPreset(library, source, taskId, name) {
  const preset = { id: newPromptId(), suiteId: library.activeSuiteId, taskId: requiredTask(taskId), name: requiredName(name), rows: [] };
  const copies = new Map();
  for (const row of source.rows) {
    if (!copies.has(row.entryId)) copies.set(row.entryId, addDefinition(library, row.name, row.content));
    appendRow(preset, copies.get(row.entryId).id, row.role, row.enabled, row);
  }
  library.presets.push(preset);
  return { library, presetId: preset.id };
}

function bindPreset(library, action) {
  const taskId = requiredTask(action.taskId), routeKey = action.routeKey ?? '';
  if (typeof routeKey !== 'string' || !validRoute(routeKey)) throw new Error('API 连接标识无效。');
  if (action.presetId !== null && !getAuxPromptPreset(library, taskId, action.presetId)) throw new Error('请选择当前任务的提示词预设。');
  const suiteId = library.activeSuiteId;
  const match = binding => binding.suiteId === suiteId && binding.taskId === taskId && binding.routeKey === routeKey;
  const existing = library.bindings.find(match);
  if (action.presetId === null) library.bindings = library.bindings.filter(binding => !match(binding));
  else if (existing) existing.presetId = action.presetId;
  else library.bindings.push({ suiteId, taskId, routeKey, presetId: action.presetId });
  return { library, presetId: action.presetId };
}

function addEntryRow(library, preset, action) {
  let entry, origin;
  if (action.type === 'addEntry') entry = addDefinition(library, action.name, action.content);
  else {
    const source = sourceEntry(library, action.entryId);
    entry = action.type === 'referenceEntry' ? source : addDefinition(library, source.name, source.content);
    for (const recipe of library.presets) {
      origin = recipe.rows.find(row => row.entryId === source.id && row.source)?.source;
      if (origin) break;
    }
  }
  const row = appendRow(preset, entry.id, action.role ?? 'system', action.enabled ?? true, { source: origin });
  return { library, presetId: preset.id, rowId: row.id, entryId: entry.id };
}

function editEntry(library, row, action) {
  let entry = sourceEntry(library, row.entryId);
  if (action.mode && !['local', 'shared'].includes(action.mode)) throw new Error('请选择条目的修改范围。');
  const name = action.name === undefined ? entry.name : requiredName(action.name);
  const content = action.content === undefined ? entry.content : requiredContent(action.content);
  const textChanged = content !== entry.content;
  if (action.mode === 'local') {
    entry = addDefinition(library, name, content);
    row.entryId = entry.id;
    if (textChanged) row.source = '用户编辑';
    discardUnusedEntries(library);
    return;
  }
  if (name === entry.name && content === entry.content) return;
  const references = library.presets.flatMap(preset => preset.rows.filter(item => item.entryId === entry.id));
  if (references.length > 1 && action.mode !== 'shared') throw new Error('此条目被多处引用。请选择同步修改或仅修改本处。');
  Object.assign(entry, { name, content });
  if (textChanged) for (const reference of references) reference.source = '用户编辑';
}

// Edits are atomic and return a new library, so an open editor can stage or discard them.
export function editAuxPromptLibrary(lib, action) {
  const library = normalizeAuxPromptLibrary(lib);
  if (suiteActions.has(action.type)) return editSuite(library, action);
  if (library.activeSuiteId === AUX_BUILTIN_ID) throw new Error('请先复制千千结默认预设。');
  if (action.type === 'bind') return bindPreset(library, action);
  if (action.type === 'createPreset') return copyPreset(library, builtinTask(action.taskId), action.taskId, action.name);
  if (action.type === 'copyPreset') {
    const source = getAuxPromptPreset(library, action.taskId, action.presetId);
    if (!source) throw new Error('找不到要复制的提示词预设。');
    return copyPreset(library, source, action.targetTaskId ?? action.taskId, action.name);
  }
  const preset = editablePreset(library, action.presetId);
  switch (action.type) {
    case 'renamePreset':
      preset.name = requiredName(action.name);
      return { library, presetId: preset.id };
    case 'deletePreset':
      if (preset.base) throw new Error('本套的任务基础配置可直接编辑。');
      library.presets = library.presets.filter(item => item !== preset);
      library.bindings = library.bindings.filter(binding => binding.presetId !== preset.id);
      discardUnusedEntries(library);
      return { library };
    case 'addEntry':
    case 'referenceEntry':
    case 'copyEntry':
      return addEntryRow(library, preset, action);
  }
  const index = preset.rows.findIndex(item => item.id === action.rowId);
  if (index < 0) throw new Error('找不到预设中的此条目。');
  const row = preset.rows[index];
  switch (action.type) {
    case 'updateEntry':
      editEntry(library, row, action);
      break;
    case 'updateRow':
      if (action.role !== undefined) row.role = requiredRole(action.role);
      if (action.enabled !== undefined) row.enabled = requiredEnabled(action.enabled);
      break;
    case 'moveRow':
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= preset.rows.length) throw new Error('条目位置无效。');
      preset.rows.splice(index, 1);
      preset.rows.splice(action.index, 0, row);
      break;
    case 'removeRow':
      preset.rows.splice(index, 1);
      discardUnusedEntries(library);
      return { library, presetId: preset.id };
    default:
      throw new Error('未知的提示词预设操作。');
  }
  return { library, presetId: preset.id, rowId: row.id, entryId: row.entryId };
}
