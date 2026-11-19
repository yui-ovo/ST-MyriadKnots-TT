import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUX_BUILTIN_ID, editAuxPromptLibrary, getAuxEntryUses, getAuxPromptBinding,
  getAuxPromptPreset, listAuxPresets, normalizeAuxPromptLibrary, resolveAuxPromptPreset,
} from '../src/aux-prompt-library.js';
import { createSettingsStore } from '../src/settings.js';

function editor(initial) {
  let library = normalizeAuxPromptLibrary(initial);
  return {
    get library() { return library; },
    edit(type, fields) {
      const result = editAuxPromptLibrary(library, { type, ...fields });
      library = result.library;
      return result;
    },
    rows(taskId, presetId) { return getAuxPromptPreset(library, taskId, presetId).rows; },
  };
}

test('task defaults, explicit built-in and connection preferences survive reload', () => {
  const e = editor();
  const builtin = resolveAuxPromptPreset(e.library, 'summary', 'preset:A');
  assert.deepEqual(builtin.rows.map(({ content, role }) => [content, role]), [
    ['{{qqj_prefix}}', 'system'], ['{{qqj_instructions}}', 'system'], ['{{qqj_input}}', 'user'],
  ]);
  assert.throws(() => e.edit('renamePreset', { presetId: AUX_BUILTIN_ID, name: '改名' }), /复制/);
  const { presetId: summary } = e.edit('createPreset', { taskId: 'summary', name: '摘要模板' });
  const { presetId: compact } = e.edit('copyPreset', { taskId: 'summary', presetId: summary, name: '精简版' });
  e.edit('bind', { taskId: 'summary', presetId: summary });
  e.edit('bind', { taskId: 'summary', routeKey: 'preset:A', presetId: compact });
  e.edit('bind', { taskId: 'summary', routeKey: 'main', presetId: AUX_BUILTIN_ID });
  assert.throws(() => e.edit('bind', { taskId: 'cse', presetId: summary }), /当前任务/);
  const saved = JSON.parse(JSON.stringify(e.library));
  assert.equal(resolveAuxPromptPreset(saved, 'summary', 'preset:A').id, compact);
  assert.equal(resolveAuxPromptPreset(saved, 'summary', 'main').id, AUX_BUILTIN_ID);
  assert.equal(getAuxPromptBinding(saved, 'summary', 'preset:B'), null);
  assert.equal(resolveAuxPromptPreset(saved, 'summary', 'preset:B').id, summary);
  assert.equal(resolveAuxPromptPreset(saved, 'cse', 'preset:A').id, AUX_BUILTIN_ID);
  e.edit('bind', { taskId: 'summary', routeKey: 'main', presetId: null });
  assert.equal(resolveAuxPromptPreset(e.library, 'summary', 'main').id, summary);
  e.edit('deletePreset', { presetId: compact });
  assert.equal(getAuxPromptBinding(e.library, 'summary', 'preset:A'), null);
  assert.deepEqual(listAuxPresets(e.library, 'summary').map(preset => preset.id), [AUX_BUILTIN_ID, summary]);
});

test('shared, copied and detached entries keep independent placement options', () => {
  const e = editor();
  const { presetId: a } = e.edit('createPreset', { taskId: 'summary', name: '摘要' });
  const { presetId: b } = e.edit('createPreset', { taskId: 'cse', name: '人物' });
  const { rowId: original, entryId } = e.edit('addEntry', { presetId: a, name: '前缀', content: '  行一\n行二  ', role: 'assistant' });
  const { rowId: reference } = e.edit('referenceEntry', { presetId: b, entryId, role: 'user' });
  const { rowId: copy, entryId: copiedId } = e.edit('copyEntry', { presetId: b, entryId });
  assert.notEqual(copiedId, entryId);
  e.edit('moveRow', { presetId: b, rowId: reference, index: 0 });
  e.edit('updateRow', { presetId: b, rowId: reference, role: 'system', enabled: false });
  assert.deepEqual(e.rows('cse', b)[0], { id: reference, entryId, name: '前缀', content: '  行一\n行二  ', role: 'system', enabled: false });
  assert.equal(e.rows('summary', a).at(-1).role, 'assistant');
  assert.equal(e.rows('summary', a).at(-1).enabled, true);
  assert.deepEqual(getAuxEntryUses(e.library, entryId).map(use => [use.taskId, use.presetId]), [['summary', a], ['cse', b]]);
  assert.throws(() => e.edit('updateEntry', { presetId: a, rowId: original, content: '新版' }), /多处引用/);
  const before = e.library;
  e.edit('updateEntry', { presetId: a, rowId: original, name: '规则', content: '新版', mode: 'shared' });
  assert.equal(e.rows('cse', b)[0].content, '新版');
  assert.equal(getAuxPromptPreset(before, 'cse', b).rows[0].name, '前缀');
  assert.equal(e.rows('cse', b).find(item => item.id === copy).content, '  行一\n行二  ');
  const { entryId: detached } = e.edit('updateEntry', { presetId: b, rowId: reference, mode: 'local', content: '独立' });
  assert.notEqual(detached, entryId);
  assert.equal(e.rows('summary', a).at(-1).content, '新版');
  assert.equal(e.rows('cse', b)[0].content, '独立');
  e.edit('removeRow', { presetId: b, rowId: copy });
  assert.equal(e.library.entries.some(item => item.id === copiedId), false);
  assert.throws(() => e.edit('referenceEntry', { presetId: b, entryId: copiedId }), /找不到/);
});

test('copying a preset isolates it while keeping its internal references and surviving source deletion', () => {
  const e = editor();
  const { presetId: a } = e.edit('createPreset', { taskId: 'summary', name: '摘要' });
  const first = e.rows('summary', a)[0];
  e.edit('referenceEntry', { presetId: a, entryId: first.entryId });
  assert.equal(getAuxEntryUses(e.library, first.entryId).length, 1);
  assert.throws(() => e.edit('updateEntry', { presetId: a, rowId: first.id, name: '改名' }), /多处引用/);
  const { presetId: b } = e.edit('copyPreset', { taskId: 'summary', presetId: a, targetTaskId: 'cse', name: '人物' });
  const rows = e.rows('cse', b);
  assert.notEqual(rows[0].entryId, first.entryId);
  assert.equal(rows[0].entryId, rows.at(-1).entryId);
  e.edit('renamePreset', { presetId: b, name: '新版' });
  e.edit('referenceEntry', { presetId: b, entryId: first.entryId });
  e.edit('deletePreset', { presetId: a });
  assert.deepEqual(getAuxEntryUses(e.library, first.entryId), [{ presetId: b, taskId: 'cse', name: '新版' }]);
  assert.equal(e.rows('cse', b).at(-1).content, '{{qqj_prefix}}');
  assert.deepEqual(normalizeAuxPromptLibrary(e.library), e.library);
});

test('normalization drops dangling and reserved IDs without expanding or storing request material', () => {
  const raw = {
    extras: 'request material',
    entries: [{ id: 'e', name: '正文', content: ' {{qqj_input}} ', expansion: 'request material' }, { id: 'unused', content: 'unused' }],
    presets: [{ id: 'builtin', taskId: 'custom' }, { id: 'p', name: '自定义', taskId: 'custom', rows: [
      { id: 'missing', entryId: 'unknown', role: 'user' }, { id: 'invalid', entryId: 'e', role: 'wrong' },
      { id: 'r', entryId: 'e', role: 'user', enabled: false }, { id: 'r', entryId: 'e', role: 'system' },
    ] }],
    bindings: [{ taskId: 'other', presetId: 'p' }, { taskId: 'custom', routeKey: 'typo', presetId: 'p' }, { taskId: 'custom', presetId: 'p' }],
  };
  const lib = normalizeAuxPromptLibrary(raw);
  assert.deepEqual(lib.entries, [{ id: 'e', name: '正文', content: ' {{qqj_input}} ' }]);
  assert.deepEqual(lib.bindings, [{ taskId: 'custom', routeKey: '', presetId: 'p' }]);
  assert.deepEqual(lib.presets[0].rows, [{ id: 'r', entryId: 'e', role: 'user', enabled: false }]);
  assert.equal(JSON.stringify(lib).includes('request material'), false);
});

test('settings preserve existing prompt guidance and clean up only the deleted API connection', () => {
  const extensionSettings = { qianqianjie: { summaryPrompt: '原有摘要指导' }, 'schedule-planner': { processingPrompt: '原有前缀', apiPresets: [{ id: 'A', name: '连接A' }] } };
  const store = createSettingsStore({ extensionSettings });
  const e = editor(store.get().auxPromptLibrary);
  const { presetId } = e.edit('createPreset', { taskId: 'cse', name: '独立' });
  e.edit('bind', { taskId: 'cse', routeKey: 'preset:A', presetId });
  e.edit('bind', { taskId: 'cse', presetId });
  store.update({ auxPromptLibrary: e.library });
  const restored = createSettingsStore({ extensionSettings: structuredClone(extensionSettings) });
  assert.deepEqual(restored.get().auxPromptLibrary, e.library);
  assert.equal(restored.get().summaryPrompt, '原有摘要指导');
  assert.equal(restored.processingPrompt(), '原有前缀');
  assert.equal(restored.deleteSharedPreset('A'), true);
  assert.equal(getAuxPromptBinding(restored.get().auxPromptLibrary, 'cse', 'preset:A'), null);
  assert.equal(getAuxPromptBinding(restored.get().auxPromptLibrary, 'cse'), presetId);
  assert.equal(getAuxPromptPreset(restored.get().auxPromptLibrary, 'cse', presetId).name, '独立');
});

test('failed persistence rolls back its own edit and preserves later settings changes', async () => {
  let doSave = () => {};
  const extensionSettings = { 'schedule-planner': { processingPrompt: '前缀', apiPresets: [{ id: 'A' }] } };
  const store = createSettingsStore({ extensionSettings, save: () => doSave() });
  const e = editor();
  const { presetId } = e.edit('createPreset', { taskId: 'summary', name: '初版' });
  e.edit('bind', { taskId: 'summary', routeKey: 'preset:A', presetId });
  store.update({ auxPromptLibrary: e.library });
  const old = store.get().auxPromptLibrary;
  e.edit('renamePreset', { presetId, name: '改名' });
  doSave = () => { throw new Error('save failed'); };
  assert.throws(() => store.update({ auxPromptLibrary: e.library }, { observeSaveFailure: true }), /save failed/);
  assert.deepEqual(store.get().auxPromptLibrary, old);
  let reject;
  doSave = () => new Promise((_, fail) => { reject = fail; });
  const deletion = store.deleteSharedPreset('A', { observeSaveFailure: true });
  const afterDelete = editor(store.get().auxPromptLibrary);
  afterDelete.edit('renamePreset', { presetId, name: '后来修改' });
  doSave = () => {};
  store.update({ auxPromptLibrary: afterDelete.library });
  reject(new Error('delete failed'));
  await assert.rejects(deletion, /delete failed/);
  assert.equal(resolveAuxPromptPreset(store.get().auxPromptLibrary, 'summary', 'preset:A').name, '后来修改');
  assert.equal(getAuxPromptBinding(store.get().auxPromptLibrary, 'summary', 'preset:A'), presetId);
});

test('overlapping prompt saves restore the last successful library in either failure order', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const pending = [];
    const store = createSettingsStore({
      extensionSettings: { 'schedule-planner': { processingPrompt: '' } },
      save: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    });
    const empty = store.get().auxPromptLibrary;
    const e = editor();
    const { presetId } = e.edit('createPreset', { taskId: 'test', name: '初版' });
    const options = { observeSaveFailure: true };
    const first = store.update({ auxPromptLibrary: e.library }, options);
    e.edit('renamePreset', { presetId, name: '二版' });
    const second = store.update({ auxPromptLibrary: e.library }, options);
    const completions = [first, second];
    for (const index of order) {
      pending[index].reject(new Error('保存失败'));
      await assert.rejects(completions[index], /保存失败/);
    }
    assert.deepEqual(store.get().auxPromptLibrary, empty);
  }
});
