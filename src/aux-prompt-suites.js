import { AUX_TASKS } from './aux-prompt-tasks.js';
import { getAuxTaskTemplateRows, hasLegacyAuxPromptOverrides, materializeLegacyTemplate } from './aux-prompt-defaults.js';
import { DEFAULT_AVATAR_PROMPT } from './avatar-generation.js';
import { DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT } from './story-clock.js';
import { INLINE_MEMORY_PROMPT } from './inline-memory-prompt.js';

export const AUX_BUILTIN_ID = 'builtin';
const legacySuiteId = 'suite:legacy';
const builtInSuite = Object.freeze({ id: AUX_BUILTIN_ID, name: '千千结默认' });
const hostDefaults = {
  storyClockPrompt: DEFAULT_MYKNOTS_STORY_CLOCK_PROMPT,
  avatarPrompt: DEFAULT_AVATAR_PROMPT,
  inlineMemoryPrompt: INLINE_MEMORY_PROMPT,
};
const array = value => Array.isArray(value) ? value : [];
const key = value => typeof value === 'string' ? value.trim() : '';
const localId = value => Boolean(value && value !== AUX_BUILTIN_ID && !value.startsWith('builtin:'));
const validRole = role => ['system', 'assistant', 'user'].includes(role);
const knownTask = taskId => AUX_TASKS.some(task => task.id === taskId);
export const validRoute = route => typeof route === 'string'
  && (route === '' || route === 'main' || (route.startsWith('preset:') && Boolean(route.slice(7).trim())));

let nextId = 0;
export function newPromptId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'aux-' + Date.now().toString(36) + '-' + (++nextId).toString(36) + '-' + Math.random().toString(36).slice(2);
}

export function requiredName(value) {
  const name = key(value);
  if (!name) throw new Error('请填写名称。');
  return name;
}

export function rowMetadata(row) {
  const result = {};
  if (typeof row.source === 'string' && row.source) result.source = row.source;
  if (row.messageGroup === 'systemPrompt') result.messageGroup = row.messageGroup;
  return result;
}

function hostValue(id, value, useDefault) {
  if (!Object.hasOwn(hostDefaults, id)) throw new Error('找不到此提示词。');
  if (!key(value)) return { content: hostDefaults[id], useDefault: true };
  return { content: value, useDefault: useDefault === true };
}

function hostPrompts(raw = {}, legacy) {
  return Object.fromEntries(Object.keys(hostDefaults).map(id => [
    id, legacy ? hostValue(id, legacy[id], false) : hostValue(id, raw?.[id]?.content, raw?.[id]?.useDefault),
  ]));
}

function customSuite(id, name, host = hostPrompts()) {
  return { id, name, hostPrompts: host };
}

export function readAuxHost(lib, id, display) {
  if (!Object.hasOwn(hostDefaults, id)) throw new Error('找不到此提示词。');
  const prompt = lib.suites.find(suite => suite.id === lib.activeSuiteId)?.hostPrompts[id];
  if (!prompt) return display ? hostDefaults[id] : '';
  return display || !prompt.useDefault || prompt.content !== hostDefaults[id] ? prompt.content : '';
}

export function suiteList(library) {
  return [{ ...builtInSuite }, ...library.suites.map(({ id, name }) => ({ id, name }))];
}

const cleanTemplates = new Map();
export function builtinTask(taskId) {
  if (!cleanTemplates.has(taskId)) {
    const template = knownTask(taskId) ? getAuxTaskTemplateRows(taskId) : [...legacyRows.values()].map(entry => ({
      ...entry, key: entry.id.slice(8), role: entry.id === 'builtin:input' ? 'user' : 'system',
    }));
    const rows = template.map(row => ({
      id: 'builtin:' + row.key, entryId: 'builtin:' + row.key, name: row.name, content: row.content,
      role: row.role, enabled: row.enabled !== false, ...rowMetadata(row),
    }));
    cleanTemplates.set(taskId, { id: AUX_BUILTIN_ID, suiteId: AUX_BUILTIN_ID, taskId, name: '千千结默认', rows });
  }
  const preset = cleanTemplates.get(taskId);
  return { ...preset, rows: preset.rows.map(row => ({ ...row })) };
}

// Keep a concrete, editable base for every task. New tasks also get a base when
// an older saved suite is loaded by a newer plugin.
function addTaskBase(lib, suiteId, taskId, allocate, legacy) {
  const preset = { id: allocate(), suiteId, taskId, name: '任务基础配置', base: true, rows: [] };
  for (const row of getAuxTaskTemplateRows(taskId, legacy)) {
    const entry = { id: allocate(), name: row.name, content: row.content };
    lib.entries.push(entry);
    preset.rows.push({ id: allocate(), entryId: entry.id, role: row.role, enabled: row.enabled !== false, ...rowMetadata(row) });
  }
  lib.presets.push(preset);
  return preset;
}

function hydrateBases(lib, allocate, legacy) {
  for (const suite of lib.suites) {
    const bases = new Set(lib.presets.filter(preset => preset.suiteId === suite.id && preset.base).map(preset => preset.taskId));
    for (const task of AUX_TASKS) if (!bases.has(task.id)) addTaskBase(lib, suite.id, task.id, allocate, legacy);
  }
}

const legacyRows = new Map(['prefix', 'instructions', 'input'].map((name, i) => {
  const id = 'builtin:' + name;
  return [id, { id, name: ['通用前缀', '任务指令', '任务材料'][i], content: '{{qqj_' + name + '}}' }];
}));

// Stable synthesized IDs allow migration to be retried after an interrupted save.
function migrationAllocator(raw) {
  const reserved = new Set();
  for (const item of [...array(raw?.presets), ...array(raw?.entries), ...array(raw?.suites)]) {
    reserved.add(key(item?.id));
    for (const row of array(item?.rows)) reserved.add(key(row?.id));
  }
  let index = 0;
  return () => {
    let id;
    do { id = 'migrated:' + ++index; } while (reserved.has(id));
    return id;
  };
}

function readTaskRecords(lib, raw, upgrading, legacy, allocate) {
  const definitions = new Map();
  for (const item of array(raw?.entries)) {
    const id = key(item?.id);
    if (localId(id) && !definitions.has(id) && typeof item.content === 'string') {
      definitions.set(id, { id, name: key(item.name) || '未命名条目', content: item.content });
    }
  }
  // A v1 shared instructions placeholder can represent different actual rules
  // across tasks. Preserve its reference when and only when the resulting texts agree.
  const copies = new Map();
  const restored = new Set();
  function resolveEntry(id, taskId) {
    const item = definitions.get(id) ?? (upgrading ? legacyRows.get(id) : null);
    if (!item) return null;
    if (!upgrading) {
      if (!restored.has(id)) { lib.entries.push(item); restored.add(id); }
      return id;
    }
    const content = knownTask(taskId) ? materializeLegacyTemplate(taskId, item.content, legacy) : item.content;
    const variants = copies.get(id) ?? new Map();
    if (!variants.has(content)) {
      const entryId = !variants.size && localId(id) ? id : allocate();
      lib.entries.push({ id: entryId, name: item.name, content });
      variants.set(content, entryId);
      copies.set(id, variants);
    }
    return variants.get(content);
  }
  const ids = new Map(), suiteIds = new Set(lib.suites.map(suite => suite.id)), primary = new Set();
  for (const item of array(raw?.presets)) {
    const id = key(item?.id), taskId = key(item?.taskId), suiteId = upgrading ? legacySuiteId : key(item?.suiteId);
    if (!localId(id) || !taskId || ids.has(id) || !suiteIds.has(suiteId)) continue;
    const preset = { id, suiteId, taskId, name: key(item.name) || '未命名配置', rows: [] };
    const scope = JSON.stringify([suiteId, taskId]);
    if (!upgrading && item.base === true && !primary.has(scope)) { preset.base = true; primary.add(scope); }
    const rowIds = new Set();
    for (const row of array(item.rows)) {
      const rowId = key(row?.id);
      if (!localId(rowId) || rowIds.has(rowId) || !validRole(row.role)) continue;
      const entryId = resolveEntry(key(row.entryId), taskId);
      if (!entryId) continue;
      preset.rows.push({ id: rowId, entryId, role: row.role, enabled: row.enabled !== false, ...(upgrading ? {} : rowMetadata(row)) });
      rowIds.add(rowId);
    }
    ids.set(id, preset);
    lib.presets.push(preset);
  }
  const bindings = new Map();
  for (const item of array(raw?.bindings)) {
    const taskId = key(item?.taskId), presetId = key(item?.presetId), routeKey = item?.routeKey ?? '';
    const suiteId = upgrading ? legacySuiteId : key(item?.suiteId);
    if (!taskId || !suiteIds.has(suiteId) || !validRoute(routeKey)) continue;
    const target = ids.get(presetId);
    if (presetId !== AUX_BUILTIN_ID && (target?.taskId !== taskId || target.suiteId !== suiteId)) continue;
    bindings.set(JSON.stringify([suiteId, taskId, routeKey]), { suiteId, taskId, routeKey, presetId });
  }
  lib.bindings = [...bindings.values()];
  if (!upgrading) {
    // Preserve entry ordering independently of placement order on a round trip.
    const order = new Map([...definitions.keys()].map((id, index) => [id, index]));
    lib.entries.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
}

export function normalizeSuiteData(raw, legacy = {}) {
  legacy ??= {};
  const lib = { version: 2, activeSuiteId: AUX_BUILTIN_ID, suites: [], entries: [], presets: [], bindings: [] };
  const upgrading = raw?.version !== 2;
  const textOverride = upgrading && hasLegacyAuxPromptOverrides(legacy);
  if (upgrading) {
    // A non-empty clock prompt also selects the host responsible for injection,
    // even when its spelling happens to match the stock prompt.
    const hasHost = Boolean(key(legacy.storyClockPrompt))
      || (key(legacy.avatarPrompt) && key(legacy.avatarPrompt) !== hostDefaults.avatarPrompt);
    if (!textOverride && !hasHost && !array(raw?.presets).length && !array(raw?.bindings).length) return lib;
    lib.activeSuiteId = legacySuiteId;
    lib.suites.push(customSuite(legacySuiteId, '我当前的预设', hostPrompts(undefined, legacy)));
  } else {
    const ids = new Set();
    for (const item of array(raw.suites)) {
      const id = key(item?.id);
      if (!localId(id) || ids.has(id)) continue;
      ids.add(id);
      lib.suites.push(customSuite(id, key(item.name) || '未命名预设', hostPrompts(item.hostPrompts)));
    }
    if (ids.has(raw.activeSuiteId)) lib.activeSuiteId = raw.activeSuiteId;
  }
  const allocate = migrationAllocator(raw);
  readTaskRecords(lib, raw, upgrading, legacy, allocate);
  hydrateBases(lib, allocate, upgrading ? legacy : undefined);
  if (textOverride) {
    for (const binding of lib.bindings) if (binding.presetId === AUX_BUILTIN_ID) {
      const base = lib.presets.find(item => item.base && item.taskId === binding.taskId);
      if (base) binding.presetId = base.id;
    }
  }
  return lib;
}

export function discardUnusedEntries(library) {
  const used = new Set(library.presets.flatMap(preset => preset.rows.map(row => row.entryId)));
  library.entries = library.entries.filter(entry => used.has(entry.id));
}

function copySuite(lib, sourceId, name) {
  const source = lib.suites.find(suite => suite.id === sourceId);
  if (!source && sourceId !== AUX_BUILTIN_ID) throw new Error('找不到要复制的整套预设。');
  const suite = customSuite(newPromptId(), requiredName(name), hostPrompts(source?.hostPrompts));
  if (!source) {
    for (const task of AUX_TASKS) addTaskBase(lib, suite.id, task.id, newPromptId);
  } else {
    const definitions = new Map(lib.entries.map(entry => [entry.id, entry]));
    const entryCopies = new Map(), presetCopies = new Map();
    for (const preset of lib.presets.filter(item => item.suiteId === source.id)) {
      const rows = preset.rows.map(row => {
        if (!entryCopies.has(row.entryId)) {
          const entry = { ...definitions.get(row.entryId), id: newPromptId() };
          lib.entries.push(entry);
          entryCopies.set(row.entryId, entry.id);
        }
        return { ...row, id: newPromptId(), entryId: entryCopies.get(row.entryId) };
      });
      const copy = { ...preset, id: newPromptId(), suiteId: suite.id, rows };
      lib.presets.push(copy);
      presetCopies.set(preset.id, copy.id);
    }
    for (const item of lib.bindings.filter(binding => binding.suiteId === source.id)) {
      lib.bindings.push({ ...item, suiteId: suite.id, presetId: presetCopies.get(item.presetId) ?? AUX_BUILTIN_ID });
    }
  }
  lib.suites.push(suite);
  lib.activeSuiteId = suite.id;
  return { library: lib, suiteId: suite.id };
}

export function editSuite(lib, action) {
  if (action.type === 'createSuite') return copySuite(lib, AUX_BUILTIN_ID, action.name);
  if (action.type === 'copySuite') return copySuite(lib, action.suiteId, action.name);
  const suiteId = action.suiteId ?? lib.activeSuiteId;
  const suite = lib.suites.find(item => item.id === suiteId);
  if (!suite && suiteId !== AUX_BUILTIN_ID) throw new Error('找不到此整套预设。');
  if (action.type === 'selectSuite') lib.activeSuiteId = suiteId;
  else {
    if (!suite) throw new Error('请先复制千千结默认预设。');
    switch (action.type) {
      case 'renameSuite':
        suite.name = requiredName(action.name);
        break;
      case 'deleteSuite':
        lib.suites = lib.suites.filter(item => item !== suite);
        lib.presets = lib.presets.filter(preset => preset.suiteId !== suite.id);
        lib.bindings = lib.bindings.filter(binding => binding.suiteId !== suite.id);
        if (lib.activeSuiteId === suite.id) lib.activeSuiteId = AUX_BUILTIN_ID;
        discardUnusedEntries(lib);
        break;
      case 'updateHostPrompt':
        if (typeof action.content !== 'string') throw new Error('提示词内容须为文本。');
        suite.hostPrompts[action.key] = hostValue(action.key, action.content, false);
        break;
      default:
        throw new Error('未知的整套预设操作。');
    }
  }
  return { library: lib, suiteId: lib.activeSuiteId };
}
