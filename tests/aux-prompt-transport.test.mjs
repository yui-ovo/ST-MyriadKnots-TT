import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';
import { createAuxPromptRuntime, renderAuxPrompt } from '../src/aux-prompt-runtime.js';
import { editAuxPromptLibrary, getAuxPromptPreset, resolveAuxPromptPreset } from '../src/aux-prompt-library.js';
import { getAuxOriginalInstructions } from '../src/aux-prompt-defaults.js';
import { createSettingsStore } from '../src/settings.js';
import { BASE_PROCESSING_PROMPT } from '../src/shared-processing-prompt.js';

function library(first) {
  const entries = [
    { id: 'a', name: '正文', content: first },
    { id: 'b', name: '停用', content: '{{qqj_prefix}}' },
    { id: 'c', name: '规则', content: '{{qqj_instructions}}' },
  ];
  return { entries, presets: [{ id: 'edited', name: '按模型调整', taskId: 'summary', rows: [
    { id: 'ra', entryId: 'a', role: 'user', enabled: true },
    { id: 'rb', entryId: 'b', role: 'system', enabled: false },
    { id: 'rc', entryId: 'c', role: 'assistant', enabled: true },
  ] }], bindings: [{ taskId: 'summary', routeKey: 'preset:a', presetId: 'edited' }] };
}

const instructions = getAuxOriginalInstructions('summary');
const options = { promptTask: 'summary', promptOwnerId: 'chat', systemPrompt: instructions, taskMessages: [
  { role: 'user', content: JSON.stringify({ payload: { canonicalContent: '原文 {{qqj_prefix}}', precedingUserInput: '刚才的输入' } }) },
] };

test('按实际连接应用预设，同一任务重试固定模板并使用新的任务输入。预览和发送的角色、内容完全相同', async () => {
  let routeId = 'a';
  const settings = createSettingsStore({ extensionSettings: {
    qianqianjie: { auxPromptLibrary: library('{{qqj_floor_body}}') },
    'schedule-planner': { processingPrompt: '前缀' },
  } });
  const route = () => ({ kind: 'independent', source: 'shared-preset', sourceLabel: routeId.toUpperCase(), config: { id: routeId, url: 'https://test.invalid', key: 'offline-key' } });
  const resolver = { resolve: route, resolveUtility: route, describeSevenDaysPresets: () => [{ id: 'a', name: 'A', key: 'offline-key' }] };
  const runtime = createAuxPromptRuntime({ settings, resolver, currentIdentity: () => ({ chatId: 'chat', hostChatId: 'file' }) });
  const requests = [];
  const client = createCompactApiClient({ processingPrompt: settings.processingPrompt, promptPresets: runtime,
    fetchImpl: async (_url, { body }) => {
      requests.push(JSON.parse(body).messages);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    } });
  const router = createTaskRouter({ resolver, compactClient: client });
  const transportBudget = { remaining: 3, used: 0 };
  await router.generateUtilityTask({ ...options, transportBudget });
  const expected = [{ role: 'user', content: '原文 {{qqj_prefix}}' }, { role: 'assistant', content: instructions }];
  assert.deepEqual(requests[0], expected);
  const sourceId = runtime.sources('summary')[0].id;
  const draft = getAuxPromptPreset(settings.get().auxPromptLibrary, 'summary', 'edited');
  assert.deepEqual((await runtime.preview({ taskId: 'summary', sourceId, preset: draft })).messages, expected);
  assert.equal(requests.length, 1);
  assert.deepEqual(runtime.routes(), [{ id: 'main', label: '千千结主配置' }, { id: 'preset:a', label: 'A' }]);
  assert.deepEqual(runtime.activeRoute('summary'), { id: 'preset:a', label: 'A' });
  const edited = editAuxPromptLibrary(settings.get().auxPromptLibrary, {
    type: 'updateEntry', presetId: draft.id, rowId: draft.rows[0].id, content: '新模板', mode: 'local',
  }).library;
  settings.update({ auxPromptLibrary: edited });
  routeId = 'b';
  await router.generateUtilityTask({ ...options, taskMessages: [
    { role: 'user', content: JSON.stringify({ payload: { canonicalContent: '本次重试的正文' } }) },
  ], transportBudget });
  assert.deepEqual(requests[1], [{ role: 'user', content: '本次重试的正文' }, expected[1]]);
  await router.generateUtilityTask(options);
  assert.deepEqual(requests[2], [{ role: 'system', content: '前缀\n\n' + instructions }, ...options.taskMessages]);
  routeId = 'a';
  await router.generateUtilityTask(options);
  assert.equal(requests[3][0].content, '新模板');
});

test('顶栏所选整套立即作用于下一次摘要请求；副本的修改独立，原版和历史楼层材料可分别核对', async () => {
  const host = {};
  const settings = createSettingsStore({ extensionSettings: host });
  const route = () => ({ kind: 'independent', source: 'qqj-main', sourceLabel: '主配置', config: { url: 'https://example.invalid', key: 'offline-key' } });
  const resolver = { resolve: route, resolveUtility: route };
  const runtime = createAuxPromptRuntime({ settings, resolver, currentIdentity: () => ({ chatId: 'chat', hostChatId: 'file' }) });
  const sent = [];
  const client = createCompactApiClient({ processingPrompt: settings.processingPrompt, promptPresets: runtime,
    fetchImpl: async (_url, { body }) => {
      sent.push(JSON.parse(body).messages);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    } });
  const router = createTaskRouter({ resolver, compactClient: client });
  const edit = action => settings.update({ auxPromptLibrary: editAuxPromptLibrary(settings.get().auxPromptLibrary, action).library });
  await router.generateUtilityTask(options);
  const original = [{ role: 'system', content: BASE_PROCESSING_PROMPT + '\n\n' + instructions }, ...options.taskMessages];
  assert.deepEqual(sent[0], original);
  edit({ type: 'createSuite', name: '试用预设' });
  const suite = settings.get().auxPromptLibrary.activeSuiteId;
  const copy = resolveAuxPromptPreset(settings.get().auxPromptLibrary, 'summary');
  const guidance = copy.rows.find(row => row.name === '摘要内容指导');
  assert.ok(guidance.content.length > 30);
  await router.generateUtilityTask(options);
  assert.deepEqual(sent[1], original);
  edit({ type: 'updateEntry', presetId: copy.id, rowId: guidance.id, content: '写明本楼事件发生的地点。', mode: 'local' });
  await router.generateUtilityTask(options);
  assert.equal(sent[2][0].content, original[0].content.replace(guidance.content, '写明本楼事件发生的地点。'));
  assert.deepEqual(sent[2].slice(1), options.taskMessages);
  const effective = resolveAuxPromptPreset(settings.get().auxPromptLibrary, 'summary');
  const source = runtime.sources('summary')[0];
  assert.deepEqual((await runtime.preview({ taskId: 'summary', sourceId: source.id, preset: effective })).messages, sent[2]);
  edit({ type: 'selectSuite', suiteId: 'builtin' });
  await router.generateUtilityTask(options);
  assert.deepEqual(sent[3], original);
  edit({ type: 'selectSuite', suiteId: suite });
  await router.generateUtilityTask(options);
  assert.deepEqual(sent[4], sent[2]);
  const restored = createSettingsStore({ extensionSettings: structuredClone(host) });
  assert.equal(restored.get().auxPromptLibrary.activeSuiteId, suite);
  assert.ok(!JSON.stringify(host).includes('原文 {{qqj_prefix}}'));
});

test('独立输入宏保留多条消息，空材料可见，整份预设无消息或宏无效时终止', () => {
  const preset = { id: 'p', taskId: 'worldbookSelect', rows: [{ name: '材料', role: 'assistant', enabled: true, content: '{{qqj_input}}' }] };
  const input = { taskMessages: ['目录', '本轮查询'].map(content => ({ role: 'user', content })) };
  assert.deepEqual(renderAuxPrompt('worldbookSelect', preset, input, '').messages, ['目录', '本轮查询'].map(content => ({ role: 'assistant', content })));
  preset.rows.push({ role: 'user', name: '空材料', enabled: true, content: '{{qqj_recent}}' });
  assert.equal(renderAuxPrompt('worldbookSelect', preset, input, '').warnings.length, 1);
  preset.rows[0].enabled = false;
  assert.throws(() => renderAuxPrompt('worldbookSelect', preset, input, ''), /没有可发送/);
  preset.rows[1].content = '{{qqj_no_such_macro}}';
  assert.throws(() => renderAuxPrompt('worldbookSelect', preset, input, ''), /qqj_no_such_macro/);
});

test('演示可离线使用，后台聊天请求不可预览，切换聊天会清空最近材料并作废在途预览', async () => {
  const saved = library('示范'), preset = getAuxPromptPreset(saved, 'summary', 'edited');
  let owner = null, release;
  const runtime = createAuxPromptRuntime({ settings: { get: () => ({ auxPromptLibrary: saved }), processingPrompt: () => '' }, resolver: {},
    currentIdentity: () => owner, listSources: () => [], readSource: async () => new Promise(resolve => { release = resolve; }) });
  const demo = runtime.sources('summary')[0];
  assert.equal(demo.id, 'demo');
  assert.ok((await runtime.preview({ taskId: 'summary', sourceId: demo.id, preset })).warnings.length);
  owner = { chatId: 'chat', hostChatId: 'one' };
  runtime.prepare({ ...options, promptOwnerId: 'other', routeKey: 'preset:a' }, '前缀');
  assert.deepEqual(runtime.sources('summary'), [demo]);
  runtime.prepare({ ...options, routeKey: 'preset:a' }, '前缀');
  assert.equal(runtime.sources('summary').length, 2);
  const pending = runtime.preview({ taskId: 'summary', sourceId: 'floor', preset });
  owner = { chatId: 'other', hostChatId: 'two' };
  assert.deepEqual(runtime.sources('summary'), [demo]);
  release(options);
  await assert.rejects(pending, /预览资料已变化/);
});
