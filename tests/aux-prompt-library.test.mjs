import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUX_BUILTIN_ID, editAuxPromptLibrary, getAuxEntryUses, getAuxPromptBinding,
  getAuxHostPrompt, getAuxPromptPreset, listAuxPresets, listAuxSuites, normalizeAuxPromptLibrary, resolveAuxPromptPreset,
} from '../src/aux-prompt-library.js';
import { createSettingsStore } from '../src/settings.js';
import { AUX_TASKS } from '../src/aux-prompt-tasks.js';
import { getAuxTaskTemplateRows } from '../src/aux-prompt-defaults.js';
import { BASE_PROCESSING_PROMPT } from '../src/shared-processing-prompt.js';
import { INLINE_MEMORY_PROMPT } from '../src/inline-memory-prompt.js';

function editor(initial) {
  let library = normalizeAuxPromptLibrary(initial);
  if (initial === undefined) library = editAuxPromptLibrary(library, { type: 'createSuite', name: '自用套' }).library;
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
  const builtin = getAuxPromptPreset(e.library, 'summary', 'builtin');
  assert.deepEqual(builtin.rows.map(({ content, role }) => [content, role]), getAuxTaskTemplateRows('summary').map(({ content, role }) => [content, role]));
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
  assert.equal(resolveAuxPromptPreset(saved, 'cse', 'preset:A').base, true);
  e.edit('bind', { taskId: 'summary', routeKey: 'main', presetId: null });
  assert.equal(resolveAuxPromptPreset(e.library, 'summary', 'main').id, summary);
  e.edit('deletePreset', { presetId: compact });
  assert.equal(getAuxPromptBinding(e.library, 'summary', 'preset:A'), null);
  assert.deepEqual(listAuxPresets(e.library, 'summary').filter(preset => !preset.base).map(preset => preset.id), [AUX_BUILTIN_ID, summary]);
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
  assert.deepEqual(getAuxEntryUses(e.library, first.entryId), [{ presetId: b, taskId: 'cse', name: '新版', suiteId: e.library.activeSuiteId, suiteName: '自用套' }]);
  assert.equal(e.rows('cse', b).at(-1).content, first.content);
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
  assert.deepEqual(lib.entries.find(item => item.id === 'e'), { id: 'e', name: '正文', content: ' {{qqj_input}} ' });
  assert.equal(lib.entries.some(item => item.id === 'unused'), false);
  assert.deepEqual(lib.bindings, [{ suiteId: lib.activeSuiteId, taskId: 'custom', routeKey: '', presetId: 'p' }]);
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

test('a clean install has only the locked factory suite; copying it materializes every task and host text', () => {
  const empty = normalizeAuxPromptLibrary(null, { processingPrompt: BASE_PROCESSING_PROMPT });
  assert.deepEqual(listAuxSuites(empty), [{ id: 'builtin', name: '千千结默认' }]);
  assert.deepEqual(empty.entries, []);
  assert.throws(() => editAuxPromptLibrary(empty, { type: 'updateHostPrompt', key: 'storyClockPrompt', content: 'edit' }), /复制/);
  const e = editor(empty);
  const { suiteId } = e.edit('copySuite', { suiteId: 'builtin', name: '我的副本' });
  assert.equal(e.library.activeSuiteId, suiteId);
  for (const task of AUX_TASKS) {
    const base = resolveAuxPromptPreset(e.library, task.id);
    const factory = getAuxPromptPreset(e.library, task.id, 'builtin');
    assert.equal(base.base, true);
    assert.notEqual(base.id, 'builtin');
    assert.deepEqual(base.rows.map(row => [row.content, row.source, row.messageGroup]), factory.rows.map(row => [row.content, row.source, row.messageGroup]));
    assert.equal(base.rows[0].content, BASE_PROCESSING_PROMPT);
    assert.equal(base.rows.at(-1).content, '{{qqj_input}}');
  }
  for (const key of ['storyClockPrompt', 'avatarPrompt', 'inlineMemoryPrompt']) {
    assert.equal(getAuxHostPrompt(e.library, key), '');
    const text = getAuxHostPrompt(e.library, key, { display: true });
    assert.ok(text.length > 10);
    assert.equal(e.library.suites[0].hostPrompts[key].content, text);
  }
  e.edit('updateHostPrompt', { key: 'storyClockPrompt', content: '  自用时间戳\n' });
  e.edit('renameSuite', { suiteId, name: '再改名' });
  assert.equal(listAuxSuites(e.library).at(-1).name, '再改名');
  assert.equal(getAuxHostPrompt(e.library, 'storyClockPrompt'), '  自用时间戳\n');
  e.edit('selectSuite', { suiteId: 'builtin' });
  assert.equal(getAuxHostPrompt(e.library, 'storyClockPrompt'), '');
  e.edit('selectSuite', { suiteId });
  e.edit('updateHostPrompt', { key: 'storyClockPrompt', content: '' });
  assert.equal(getAuxHostPrompt(e.library, 'storyClockPrompt'), '');
  e.edit('deleteSuite', { suiteId });
  assert.deepEqual(e.library, empty);
});

test('旧版已保存的整套预设自动带上主回复文末摘要，并保留原有选择和修改', () => {
  const e = editor();
  e.edit('updateHostPrompt', { key: 'storyClockPrompt', content: '旧套时间戳' });
  const saved = JSON.parse(JSON.stringify(e.library));
  delete saved.suites[0].hostPrompts.inlineMemoryPrompt;
  const settings = createSettingsStore({ extensionSettings: { qianqianjie: { auxPromptLibrary: saved } } });
  const restored = settings.get().auxPromptLibrary;
  assert.equal(restored.activeSuiteId, saved.activeSuiteId);
  assert.equal(getAuxHostPrompt(restored, 'storyClockPrompt'), '旧套时间戳');
  assert.equal(getAuxHostPrompt(restored, 'inlineMemoryPrompt', { display: true }), INLINE_MEMORY_PROMPT);
});

test('v1 migration retains chosen variants, connection overrides and task-specific legacy text', () => {
  const raw = { version: 1, entries: [
    { id: 'rules', name: '共享规则', content: '头 {{qqj_instructions}} 尾' },
    { id: 'shared', name: '共享文字', content: '旧固定文字 {{qqj_prefix}}' },
  ], presets: ['summary', 'cse'].map(taskId => ({
    id: 'old-' + taskId, taskId, name: '旧版 ' + taskId,
    rows: [{ id: 'a', entryId: 'rules', role: 'assistant', enabled: true }, { id: 'b', entryId: 'shared', role: 'user', enabled: false }],
  })), bindings: [
    { taskId: 'summary', routeKey: '', presetId: 'old-summary' }, { taskId: 'cse', routeKey: 'preset:route', presetId: 'old-cse' },
    { taskId: 'summary', routeKey: 'main', presetId: 'builtin' },
  ] };
  const oldSettings = { processingPrompt: '旧前缀', summaryPrompt: '旧摘要要求', csePrompt: '旧人物要求', profilePrompt: '旧资料要求',
    worldbookPrompt: '旧资料更新要求', storyClockPrompt: '旧时间戳', avatarPrompt: '旧头像绘制',
    apiKey: 'PRIVATE_TEST_KEY', chat: 'PRIVATE_TEST_CHAT' };
  const lib = normalizeAuxPromptLibrary(raw, oldSettings);
  assert.deepEqual(lib, normalizeAuxPromptLibrary(raw, oldSettings));
  assert.deepEqual(lib, normalizeAuxPromptLibrary(JSON.parse(JSON.stringify(lib)), { processingPrompt: '后来改过' }));
  assert.equal(listAuxSuites(lib).at(-1).name, '我当前的预设');
  const summary = resolveAuxPromptPreset(lib, 'summary');
  const cse = resolveAuxPromptPreset(lib, 'cse', 'preset:route');
  assert.equal(summary.id, 'old-summary');
  assert.equal(cse.id, 'old-cse');
  assert.equal(summary.rows[0].role, 'assistant');
  assert.equal(summary.rows[0].messageGroup, undefined);
  assert.equal(cse.rows[1].enabled, false);
  assert.match(summary.rows[0].content, /旧摘要要求/);
  assert.match(cse.rows[0].content, /旧人物要求/);
  assert.notEqual(summary.rows[0].entryId, cse.rows[0].entryId);
  assert.equal(summary.rows[1].entryId, cse.rows[1].entryId);
  assert.equal(summary.rows[1].content, '旧固定文字 旧前缀');
  const main = resolveAuxPromptPreset(lib, 'summary', 'main');
  assert.equal(main.base, true);
  assert.equal(main.rows[0].content, '旧前缀');
  assert.equal(main.rows[0].messageGroup, 'systemPrompt');
  assert.equal(getAuxHostPrompt(lib, 'avatarPrompt'), '旧头像绘制');
  assert.equal(getAuxHostPrompt(lib, 'storyClockPrompt'), '旧时间戳');
  assert.equal(/PRIVATE_TEST_(?:KEY|CHAT)/.test(JSON.stringify(lib)), false);
  const original = editAuxPromptLibrary(lib, { type: 'selectSuite', suiteId: 'builtin' }).library;
  assert.equal(resolveAuxPromptPreset(original, 'summary', 'main').rows[0].content, BASE_PROCESSING_PROMPT);
  assert.equal(getAuxPromptBinding(original, 'summary'), null);
  assert.equal(getAuxPromptPreset(original, 'summary', 'old-summary'), null);
  assert.equal(resolveAuxPromptPreset(original, 'cse').rows.some(row => row.content.includes('旧人物要求')), false);
});

test('suite copies retain internal links and connection overrides but share only explicitly referenced content across suites', () => {
  const e = editor(), a = e.library.activeSuiteId;
  const { presetId: routeA } = e.edit('createPreset', { taskId: 'summary', name: '连接 A' });
  const { entryId: sourceId, rowId: sourceRow } = e.edit('addEntry', { presetId: routeA, name: '规则', content: '第一版' });
  const { presetId: cseA } = e.edit('createPreset', { taskId: 'cse', name: '状态' });
  e.edit('referenceEntry', { presetId: cseA, entryId: sourceId });
  e.edit('bind', { taskId: 'cse', presetId: cseA });
  e.edit('bind', { taskId: 'summary', routeKey: 'preset:A', presetId: routeA });
  const { suiteId: b } = e.edit('copySuite', { suiteId: a, name: 'B套' });
  const routeB = resolveAuxPromptPreset(e.library, 'summary', 'preset:A');
  const cseB = resolveAuxPromptPreset(e.library, 'cse');
  assert.notEqual(routeB.id, routeA);
  assert.notEqual(routeB.rows.at(-1).entryId, sourceId);
  assert.equal(cseB.rows.at(-1).entryId, routeB.rows.at(-1).entryId);
  const { rowId } = e.edit('referenceEntry', { presetId: routeB.id, entryId: sourceId });
  assert.equal(getAuxEntryUses(e.library, sourceId).length, 3);
  assert.throws(() => e.edit('updateEntry', { presetId: routeB.id, rowId, content: '没有选择范围' }), /引用/);
  e.edit('updateEntry', { presetId: routeB.id, rowId, content: '明确同步', mode: 'shared' });
  e.edit('selectSuite', { suiteId: a });
  assert.equal(e.rows('summary', routeA).find(row => row.id === sourceRow).content, '明确同步');
  e.edit('deleteSuite', { suiteId: a });
  assert.equal(e.library.activeSuiteId, 'builtin');
  e.edit('selectSuite', { suiteId: b });
  assert.equal(resolveAuxPromptPreset(e.library, 'summary', 'preset:A').rows.at(-1).content, '明确同步');
  assert.equal(getAuxEntryUses(e.library, sourceId).length, 1);
});

test('initial migration saves once, restores failed raw writes and switches the host-facing fields with the suite', async () => {
  const extensionSettings = { qianqianjie: { storyClockPrompt: '原时间戳', avatarPrompt: '原头像', processingPrompt: '旧前缀' } };
  let writes = 0, fail = true;
  const save = () => { writes++; if (fail) throw new Error('保存失败'); };
  const store = createSettingsStore({ extensionSettings, save });
  assert.equal(writes, 1);
  assert.equal(extensionSettings.qianqianjie.auxPromptLibrary, undefined);
  assert.equal(extensionSettings.qianqianjie.storyClockPrompt, '原时间戳');
  const migrated = store.get().auxPromptLibrary;
  assert.equal(writes, 1);
  const clean = editAuxPromptLibrary(migrated, { type: 'selectSuite', suiteId: 'builtin' }).library;
  assert.throws(() => store.update({ auxPromptLibrary: clean }, { observeSaveFailure: true }), /保存失败/);
  assert.equal(store.get().auxPromptLibrary.activeSuiteId, migrated.activeSuiteId);
  assert.equal(store.get().storyClockPrompt, '原时间戳');
  assert.equal(store.get().avatarPrompt, '原头像');
  fail = false;
  const before = writes;
  await store.update({ auxPromptLibrary: clean }, { observeSaveFailure: true });
  assert.equal(writes, before + 1);
  assert.equal(extensionSettings.qianqianjie.storyClockPrompt, '');
  assert.equal(extensionSettings.qianqianjie.avatarPrompt, '');
  const restored = createSettingsStore({ extensionSettings: structuredClone(extensionSettings), save });
  assert.equal(writes, before + 1);
  assert.equal(restored.get().auxPromptLibrary.activeSuiteId, 'builtin');
  assert.equal(listAuxSuites(restored.get().auxPromptLibrary).length, 2);
  restored.update({ auxPromptLibrary: migrated });
  assert.equal(restored.get().storyClockPrompt, '原时间戳');
  assert.equal(restored.get().avatarPrompt, '原头像');
});

test('removing a shared connection clears every suite override and restores each on save failure', () => {
  let fail = false;
  const store = createSettingsStore({
    extensionSettings: { 'schedule-planner': { processingPrompt: '', apiPresets: [{ id: 'A' }] } },
    save() { if (fail) throw new Error('未保存'); },
  });
  const e = editor(), a = e.library.activeSuiteId;
  const { presetId } = e.edit('createPreset', { taskId: 'summary', name: '单独配置' });
  e.edit('bind', { taskId: 'summary', routeKey: 'preset:A', presetId });
  const { suiteId: b } = e.edit('copySuite', { suiteId: a, name: '第二套' });
  store.update({ auxPromptLibrary: e.library });
  fail = true;
  assert.throws(() => store.deleteSharedPreset('A', { observeSaveFailure: true }), /未保存/);
  assert.deepEqual(store.get().auxPromptLibrary.bindings.map(binding => binding.suiteId).sort(), [a, b].sort());
  fail = false;
  store.deleteSharedPreset('A', { observeSaveFailure: true });
  assert.deepEqual(store.get().auxPromptLibrary.bindings, []);
  assert.equal(store.get().auxPromptLibrary.suites.length, 2);
});

test('overlapping failed migration and suite selection retain the original v1 source', async () => {
  for (const first of ['migration', 'selection']) {
    const raw = { version: 1, entries: [], presets: [], bindings: [] };
    const ext = { qianqianjie: { auxPromptLibrary: raw, storyClockPrompt: '旧时间规则' }, 'schedule-planner': { processingPrompt: '' } };
    const pending = [];
    const store = createSettingsStore({ extensionSettings: ext, save: () => new Promise((_, reject) => pending.push(reject)) });
    const clean = editAuxPromptLibrary(store.get().auxPromptLibrary, { type: 'selectSuite', suiteId: 'builtin' }).library;
    const save = store.update({ auxPromptLibrary: clean }, { observeSaveFailure: true });
    const selectionFailure = () => { pending[1](new Error('未保存')); return assert.rejects(save, /未保存/); };
    const migrationFailure = async () => { pending[0](new Error('迁移未保存')); await Promise.resolve(); };
    if (first === 'migration') { await migrationFailure(); await selectionFailure(); }
    else { await selectionFailure(); await migrationFailure(); }
    assert.equal(ext.qianqianjie.auxPromptLibrary, raw);
    assert.equal(ext.qianqianjie.storyClockPrompt, '旧时间规则');
  }
});
