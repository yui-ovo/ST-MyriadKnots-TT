import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';
import { createAuxPromptRuntime, renderAuxPrompt } from '../src/aux-prompt-runtime.js';
import { getAuxPromptPreset } from '../src/aux-prompt-library.js';

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

const options = { promptTask: 'summary', promptOwnerId: 'chat', systemPrompt: '任务及输出格式', taskMessages: [
  { role: 'user', content: JSON.stringify({ payload: { canonicalContent: '原文 {{qqj_prefix}}', precedingUserInput: '刚才的输入' } }) },
] };

test('按实际连接应用预设，同一任务重试固定模板并使用新的任务输入。预览和发送的角色、内容完全相同', async () => {
  let saved = library('{{qqj_floor_body}}'), routeId = 'a';
  const settings = { get: () => ({ auxPromptLibrary: saved }), processingPrompt: () => '前缀' };
  const route = () => ({ kind: 'independent', source: 'shared-preset', config: { id: routeId, url: 'https://test.invalid', key: 'offline-key' } });
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
  const expected = [{ role: 'user', content: '原文 {{qqj_prefix}}' }, { role: 'assistant', content: '任务及输出格式' }];
  assert.deepEqual(requests[0], expected);
  const sourceId = runtime.sources('summary')[0].id;
  const draft = getAuxPromptPreset(saved, 'summary', 'edited');
  assert.deepEqual((await runtime.preview({ taskId: 'summary', sourceId, preset: draft })).messages, expected);
  assert.equal(requests.length, 1);
  assert.deepEqual(runtime.routes(), [{ id: 'main', label: '千千结主配置' }, { id: 'preset:a', label: 'A' }]);
  saved = library('新模板');
  routeId = 'b';
  await router.generateUtilityTask({ ...options, systemPrompt: '本次格式修正', transportBudget });
  assert.deepEqual(requests[1], [expected[0], { role: 'assistant', content: '本次格式修正' }]);
  await router.generateUtilityTask(options);
  assert.deepEqual(requests[2], [{ role: 'system', content: '前缀\n\n任务及输出格式' }, ...options.taskMessages]);
  routeId = 'a';
  await router.generateUtilityTask(options);
  assert.equal(requests[3][0].content, '新模板');
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
