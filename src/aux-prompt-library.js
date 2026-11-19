export const AUX_BUILTIN_ID = 'builtin';

const builtinRows = [
  { key: 'prefix', name: '通用前缀', role: 'system', content: '{{qqj_prefix}}' },
  { key: 'instructions', name: '任务指令', role: 'system', content: '{{qqj_instructions}}' },
  { key: 'input', name: '任务材料', role: 'user', content: '{{qqj_input}}' },
].map(({ key, ...row }) => ({ ...row, id: 'builtin:' + key, entryId: 'builtin:' + key, enabled: true }));

const validRoles = new Set(['system', 'user', 'assistant']);
const canonical = new WeakSet();
const list = value => Array.isArray(value) ? value : [];
const keyOf = value => typeof value === 'string' ? value.trim() : '';
const localId = value => Boolean(value && value !== AUX_BUILTIN_ID && !value.startsWith('builtin:'));
const validRoute = route => route === '' || route === 'main' || (route.startsWith('preset:') && route.slice(7).trim() !== '');
const builtinEntry = id => builtinRows.find(row => row.entryId === id);
const asLibrary = lib => canonical.has(lib) ? lib : normalizeAuxPromptLibrary(lib);

// Only definitions, placement options and bindings belong in extension settings.
// Expanded macros can contain chat material and are never part of this representation.
export function normalizeAuxPromptLibrary(raw) {
  const entries = new Map();
  for (const item of list(raw?.entries)) {
    const id = keyOf(item?.id);
    if (!localId(id) || entries.has(id) || typeof item.content !== 'string') continue;
    entries.set(id, { id, name: keyOf(item.name) || '未命名条目', content: item.content });
  }
  const presets = new Map();
  const usedEntries = new Set();
  for (const item of list(raw?.presets)) {
    const id = keyOf(item?.id), taskId = keyOf(item?.taskId);
    if (!localId(id) || !taskId || presets.has(id)) continue;
    const rows = [];
    const rowIds = new Set();
    for (const row of list(item.rows)) {
      const rowId = keyOf(row?.id), entryId = keyOf(row?.entryId);
      if (!localId(rowId) || rowIds.has(rowId) || (!entries.has(entryId) && !builtinEntry(entryId))) continue;
      if (!validRoles.has(row.role)) continue;
      rows.push({ id: rowId, entryId, role: row.role, enabled: row.enabled !== false });
      rowIds.add(rowId);
      usedEntries.add(entryId);
    }
    presets.set(id, { id, taskId, name: keyOf(item.name) || '未命名预设', rows });
  }
  const bindings = new Map();
  for (const item of list(raw?.bindings)) {
    const taskId = keyOf(item?.taskId), presetId = keyOf(item?.presetId);
    const routeKey = item?.routeKey ?? '';
    if (!taskId || typeof routeKey !== 'string' || !validRoute(routeKey)) continue;
    if (presetId !== AUX_BUILTIN_ID && presets.get(presetId)?.taskId !== taskId) continue;
    bindings.set(JSON.stringify([taskId, routeKey]), { taskId, routeKey, presetId });
  }
  const library = {
    version: 1,
    entries: [...entries.values()].filter(entry => usedEntries.has(entry.id)),
    presets: [...presets.values()],
    bindings: [...bindings.values()],
  };
  canonical.add(library);
  return library;
}

function builtinPreset(taskId) {
  return { id: AUX_BUILTIN_ID, taskId, name: '内置默认', rows: builtinRows.map(row => ({ ...row })) };
}

function expandedPreset(library, preset) {
  const entries = new Map(library.entries.map(entry => [entry.id, entry]));
  const rows = preset.rows.map(row => {
    const { name, content } = entries.get(row.entryId) ?? builtinEntry(row.entryId);
    return { ...row, name, content };
  });
  return { ...preset, rows };
}

export function listAuxPresets(lib, taskId) {
  const library = asLibrary(lib);
  return [builtinPreset(taskId), ...library.presets.filter(preset => preset.taskId === taskId).map(preset => expandedPreset(library, preset))];
}

export function getAuxPromptPreset(lib, taskId, presetId) {
  if (presetId === AUX_BUILTIN_ID) return builtinPreset(taskId);
  const library = asLibrary(lib);
  const preset = library.presets.find(item => item.id === presetId && item.taskId === taskId);
  return preset ? expandedPreset(library, preset) : null;
}

export function getAuxPromptBinding(lib, taskId, routeKey = '') {
  const binding = asLibrary(lib).bindings.find(item => item.taskId === taskId && item.routeKey === routeKey);
  return binding?.presetId ?? null;
}

export function resolveAuxPromptPreset(lib, taskId, routeKey = '') {
  const library = asLibrary(lib);
  const selected = getAuxPromptBinding(library, taskId, routeKey) ?? getAuxPromptBinding(library, taskId);
  return getAuxPromptPreset(library, taskId, selected) ?? builtinPreset(taskId);
}

export function getAuxEntryUses(lib, entryId) {
  return asLibrary(lib).presets.filter(preset => preset.rows.some(row => row.entryId === entryId))
    .map(({ id: presetId, name, taskId }) => ({ presetId, name, taskId }));
}

let nextId = 0;
function newId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'aux-' + Date.now().toString(36) + '-' + (++nextId).toString(36) + '-' + Math.random().toString(36).slice(2);
}

function requiredName(value) {
  const name = keyOf(value);
  if (!name) throw new Error('请填写名称。');
  return name;
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
  const preset = library.presets.find(item => item.id === id);
  if (!preset) throw new Error('找不到此提示词预设。');
  return preset;
}

function sourceEntry(library, entryId) {
  const entry = library.entries.find(item => item.id === entryId) ?? builtinEntry(entryId);
  if (!entry) throw new Error('找不到此提示词条目。');
  return entry;
}

function addDefinition(library, name, content) {
  const entry = { id: newId(), name: requiredName(name), content: requiredContent(content) };
  library.entries.push(entry);
  return entry;
}

function appendRow(preset, entryId, role, enabled) {
  const row = { id: newId(), entryId, role: requiredRole(role), enabled: requiredEnabled(enabled) };
  preset.rows.push(row);
  return row;
}

function copyPreset(library, source, taskId, name) {
  const preset = { id: newId(), taskId: requiredTask(taskId), name: requiredName(name), rows: [] };
  const copies = new Map();
  for (const row of source.rows) {
    if (!copies.has(row.entryId)) copies.set(row.entryId, addDefinition(library, row.name, row.content));
    appendRow(preset, copies.get(row.entryId).id, row.role, row.enabled);
  }
  library.presets.push(preset);
  return { library, presetId: preset.id };
}

function discardUnusedEntries(library) {
  const used = new Set(library.presets.flatMap(preset => preset.rows.map(row => row.entryId)));
  library.entries = library.entries.filter(entry => used.has(entry.id));
}

function bindPreset(library, action) {
  const taskId = requiredTask(action.taskId), routeKey = action.routeKey ?? '';
  if (typeof routeKey !== 'string' || !validRoute(routeKey)) throw new Error('API 连接标识无效。');
  if (action.presetId !== null && !getAuxPromptPreset(library, taskId, action.presetId)) throw new Error('请选择当前任务的提示词预设。');
  const match = binding => binding.taskId === taskId && binding.routeKey === routeKey;
  const existing = library.bindings.find(match);
  if (action.presetId === null) library.bindings = library.bindings.filter(binding => !match(binding));
  else if (existing) existing.presetId = action.presetId;
  else library.bindings.push({ taskId, routeKey, presetId: action.presetId });
  return { library, presetId: action.presetId };
}

function addEntryRow(library, preset, action) {
  let entry;
  if (action.type === 'addEntry') entry = addDefinition(library, action.name, action.content);
  else {
    const source = sourceEntry(library, action.entryId);
    entry = action.type === 'referenceEntry' ? source : addDefinition(library, source.name, source.content);
  }
  const row = appendRow(preset, entry.id, action.role ?? 'system', action.enabled ?? true);
  return { library, presetId: preset.id, rowId: row.id, entryId: entry.id };
}

function editEntry(library, row, action) {
  let entry = sourceEntry(library, row.entryId);
  if (action.mode && !['local', 'shared'].includes(action.mode)) throw new Error('请选择条目的修改范围。');
  const name = action.name === undefined ? entry.name : requiredName(action.name);
  const content = action.content === undefined ? entry.content : requiredContent(action.content);
  if (action.mode === 'local') {
    entry = addDefinition(library, name, content);
    row.entryId = entry.id;
    discardUnusedEntries(library);
    return;
  }
  if (name === entry.name && content === entry.content) return;
  if (builtinEntry(row.entryId)) throw new Error('请先将内置条目复制为独立条目。');
  const shared = library.presets.some(preset => preset.rows.some(other => other !== row && other.entryId === entry.id));
  if (shared && action.mode !== 'shared') throw new Error('此条目被多处引用。请选择同步修改或仅修改本处。');
  Object.assign(entry, { name, content });
}

// Edits are atomic and return a new library, so an open editor can stage or discard them.
export function editAuxPromptLibrary(lib, action) {
  const library = normalizeAuxPromptLibrary(lib);
  if (action.type === 'bind') return bindPreset(library, action);
  if (action.type === 'createPreset') return copyPreset(library, builtinPreset(action.taskId), action.taskId, action.name);
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
