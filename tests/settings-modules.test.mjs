import test from 'node:test';
import assert from 'node:assert/strict';
import { createBodyReadSettings } from '../src/ui/settings/prompts-settings.js';
import { createPromptPresetsView } from '../src/ui/settings/aux-prompt-presets.js';
import { AUX_TASKS } from '../src/aux-prompt-tasks.js';
import { editAuxPromptLibrary, getAuxHostPrompt, getAuxPromptPreset, resolveAuxPromptPreset } from '../src/aux-prompt-library.js';
import { createAppearanceSettings } from '../src/ui/settings/appearance-settings.js';
import { resolveVectorConfig, VECTOR_DEFAULT_URL, VECTOR_DEFAULT_MODEL } from '../src/vector-api.js';
import { createApiSettings } from '../src/ui/settings/api-settings.js';
import { createVectorApiSettings } from '../src/ui/settings/vector-api-settings.js';
import { createSettingsStore } from '../src/settings.js';
import { createApiResolver, createTaskRouter } from '../src/api-routing.js';

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.events = {}; this.className = ''; this.id = '';
    this.open = false; this.checked = false; this.disabled = false; this.value = ''; this.type = '';
    this.placeholder = ''; this.min = ''; this.max = ''; this.step = ''; this.attributes = {}; this._text = '';
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Node) node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async fire(name, overrides = {}) { for (const handler of this.events[name] || []) await handler({ currentTarget: this, target: this, stopPropagation() {}, preventDefault() {}, ...overrides }); }
  focus(options) { this.focusOptions = options; documentRef.activeElement = this; }
  getRootNode() { return documentRef; }
  contains(target) { return target === this || this.descendants().includes(target); }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))) return node; return null; }
  getBoundingClientRect() { return this.rect ?? { top: 0, bottom: 100, height: 100 }; }
  get classList() { return { add: c => { if (!this.className.split(' ').includes(c)) this.className = `${this.className ? `${this.className} ` : ''}${c}`; }, remove: c => { this.className = this.className.split(' ').filter(value => value && value !== c).join(' '); }, contains: c => this.className.split(' ').includes(c) }; }
  get textContent() { return this._text || this.children.map(child => child?.textContent ?? '').join(''); }
  set textContent(value) { this._text = String(value); }
  descendants() { return this.children.flatMap(child => child instanceof Node ? [child, ...child.descendants()] : []); }
  find(predicate) { return this.descendants().find(predicate); }
  findAll(predicate) { return this.descendants().filter(predicate); }
}
const documentRef = { activeElement: null, createElement: tag => new Node(tag) };
const flush = () => new Promise(resolve => setImmediate(resolve));
const fieldControl = (node, label) => {
  const field = node.find(n => n.tagName === 'label' && n.children[0]?.textContent === label)?.children[1];
  if (field) return field;
  const role = ({ '分析API（建议高质模型）': '分析 API', '摘要API（建议快速模型）': '摘要 API', '召回API（默认跟随摘要）': '召回 API' })[label];
  return role ? node.find(n => n.className === 'qqj-api-purpose' && n.children[0]?.textContent === role)?.children[1]?.children[0] : undefined;
};
const createSiblingApiSettings = options => {
  let editor;
  const api = createApiSettings({ ...options, customImpl: value => { editor = value.content; return new Promise(() => {}); } }), vector = createVectorApiSettings({ ...options, open: options.vectorOpen });
  const node = documentRef.createElement('div'); node.append(api.node, vector.node);
  return { node, getApiEditor: () => editor, dispose() { api.dispose?.(); vector.dispose(); } };
};
const inlineTrigger = control => control.find(n => n.className.split(' ').includes('qqj-inline-select-trigger'));
const chooseInline = async (control, value) => {
  await inlineTrigger(control).fire('click');
  const option = control.find(n => n.attributes['data-value'] === value);
  assert.ok(option, `缺少内联选项 ${value}`);
  await option.fire('click');
};
const focusInline = control => inlineTrigger(control).fire('focus');

function auxManager(settings, options = {}) {
  const view = createPromptPresetsView({ documentRef, settings, ...options }), node = view.node;
  return {
    view, node,
    click: async label => {
      const button = node.find(n => n.tagName === 'button' && n.textContent === label);
      assert.ok(button, '缺少按钮 ' + label);
      await button.fire('click'); await flush();
    },
    choose: async (label, value) => {
      const trigger = node.find(n => n.attributes['aria-label'] === label && n.className.includes('qqj-inline-select-trigger'));
      assert.ok(trigger, '缺少选择器 ' + label);
      await chooseInline(trigger.parentNode, value); await flush();
    },
    control: label => fieldControl(node, label),
    byLabel: label => node.find(n => n.attributes['aria-label'] === label),
  };
}

test('预设页直接阅读锁定的内置指令，复制整套后留在原条目编辑并保存', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), task = AUX_TASKS[0];
  const ui = auxManager(settings);
  assert.equal(ui.byLabel('当前使用的预设').textContent, '千千结默认›');
  assert.doesNotMatch(ui.node.textContent, /提示词与包裹符|副 API 提示词预设/);
  const built = resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id);
  const rule = built.rows.find(row => row.id === 'builtin:instructions');
  const lockedSwitch = ui.byLabel('启用' + rule.name);
  assert.equal(lockedSwitch.attributes.role, 'switch');
  assert.equal(lockedSwitch.disabled, true);
  assert.equal(lockedSwitch.checked, rule.enabled);
  await ui.click(rule.name);
  assert.equal(ui.control('提示词内容').readOnly, true);
  assert.equal(ui.control('提示词内容').value, rule.content); assert.ok(rule.content.length > 80);
  assert.ok(ui.node.textContent.includes(rule.source));
  await ui.click('复制整套后编辑本条'); ui.control('预设名称').value = '我的预设'; await ui.click('复制并启用');
  assert.equal(ui.control('提示词内容').readOnly, false); assert.equal(ui.control('提示词内容').value, rule.content);
  const suiteId = settings.get().auxPromptLibrary.activeSuiteId;
  assert.notEqual(suiteId, 'builtin');
  const text = ui.control('提示词内容');
  text.value = '甲乙'; text.selectionStart = 1; text.selectionEnd = 1;
  await ui.choose('插入宏', 'qqj_input'); await ui.click('插入'); assert.equal(text.value, '甲{{qqj_input}}乙');
  await ui.choose('消息角色', 'assistant'); await ui.click('宏与输出格式说明');
  assert.ok(ui.node.textContent.includes(task.outputExample)); await ui.click('保存条目');
  const saved = resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id).rows.find(row => row.name === rule.name);
  assert.equal(saved.content, '甲{{qqj_input}}乙'); assert.equal(saved.role, 'assistant');
  await ui.choose('当前使用的预设', 'builtin');
  assert.equal(settings.get().auxPromptLibrary.activeSuiteId, 'builtin');
  assert.equal(resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id).rows.find(row => row.id === rule.id).content, rule.content);
  await ui.choose('当前使用的预设', suiteId); await ui.click(rule.name); ui.control('提示词内容').value = '未保存的草稿';
  ui.view.deactivate(); ui.view.activate(); assert.equal(ui.control('提示词内容').value, '未保存的草稿');
  await ui.click('取消'); await ui.click(rule.name); assert.equal(ui.control('提示词内容').value, saved.content);
  ui.view.dispose();
});

test('条目的启停和手机排序作为草稿，切换整套时可保留或放弃', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), task = AUX_TASKS[0], ui = auxManager(settings);
  await ui.click('新建'); ui.control('预设名称').value = '排序测试'; await ui.click('创建并启用');
  const suiteId = settings.get().auxPromptLibrary.activeSuiteId;
  await ui.click('新增条目'); ui.control('条目名称').value = '回顾'; ui.control('提示词内容').value = '核对'; await ui.click('保存条目');
  const included = ui.byLabel('启用回顾');
  assert.equal(included.attributes.role, 'switch');
  assert.equal(included.disabled, false);
  included.checked = false; await included.fire('change');
  await ui.click('排序'); await ui.byLabel('上移回顾').fire('click'); await ui.click('完成排序');
  await ui.choose('当前使用的预设', 'builtin'); assert.equal(settings.get().auxPromptLibrary.activeSuiteId, suiteId);
  await ui.click('继续编辑'); await ui.click('保存预设');
  let rows = resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id).rows;
  assert.equal(rows.at(-2).name, '回顾'); assert.equal(rows.at(-2).enabled, false);
  ui.byLabel('启用回顾').checked = true; await ui.byLabel('启用回顾').fire('change');
  await ui.choose('当前使用的预设', 'builtin'); await ui.click('放弃更改后继续');
  assert.equal(settings.get().auxPromptLibrary.activeSuiteId, 'builtin');
  await ui.choose('当前使用的预设', suiteId);
  rows = resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id).rows;
  assert.equal(rows.at(-2).enabled, false);
});

test('当前 API 覆盖显示有效配置，可创建独立配置并恢复跟随任务', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), task = AUX_TASKS[0];
  const api = { id: 'preset:flash', label: '快速模型' }, ui = auxManager(settings, { promptPreview: {
    activeRoute: () => api, routes: () => [{ id: 'main', label: '主配置' }, api],
  } });
  await ui.click('复制整套'); await ui.click('复制并启用');
  assert.match(ui.node.textContent, /快速模型.*跟随任务/);
  await ui.click('连接配置'); await ui.click('为此连接复制独立配置');
  const lib = settings.get().auxPromptLibrary, specific = resolveAuxPromptPreset(lib, task.id, api.id), common = resolveAuxPromptPreset(lib, task.id);
  assert.notEqual(common.id, specific.id); assert.match(ui.node.textContent, /快速模型.*连接指定/);
  const name = specific.rows[0].name;
  await ui.click(name); ui.control('提示词内容').value = '只给快速模型'; await ui.click('保存条目');
  assert.equal(resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id, api.id).rows[0].content, '只给快速模型');
  assert.equal(resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id).rows[0].content, common.rows[0].content);
  await ui.click('连接配置'); await ui.choose('使用的条目配置', '');
  assert.equal(resolveAuxPromptPreset(settings.get().auxPromptLibrary, task.id, api.id).id, common.id);
});

test('从另一项任务引用条目后，角色独立，共用文字须明确选择修改范围', async () => {
  const settings = createSettingsStore({ extensionSettings: {} });
  const [a, b] = AUX_TASKS;
  let lib = editAuxPromptLibrary(settings.get().auxPromptLibrary, { type: 'createSuite', name: '两项任务' }).library;
  const first = resolveAuxPromptPreset(lib, a.id).id, second = resolveAuxPromptPreset(lib, b.id).id;
  const source = editAuxPromptLibrary(lib, { type: 'addEntry', presetId: first, name: '统一措辞', content: '初稿', role: 'user' });
  settings.update({ auxPromptLibrary: source.library });
  const ui = auxManager(settings); await ui.choose('任务', b.id); await ui.click('从已有条目添加');
  await ui.choose('已有条目', source.entryId); await ui.choose('消息角色', 'assistant'); await ui.click('引用条目');
  await ui.click('统一措辞'); ui.control('提示词内容').value = '共用版'; await ui.click('保存条目');
  assert.match(ui.node.textContent, /请选择内容修改范围/); assert.ok(ui.node.textContent.includes(a.label)); assert.ok(ui.node.textContent.includes(b.label));
  await ui.choose('内容修改范围', 'shared'); await ui.click('保存条目');
  await ui.click('统一措辞'); ui.control('提示词内容').value = '独立版'; await ui.choose('内容修改范围', 'local'); await ui.click('保存条目');
  lib = settings.get().auxPromptLibrary;
  const x = getAuxPromptPreset(lib, a.id, first).rows.at(-1), y = getAuxPromptPreset(lib, b.id, second).rows.at(-1);
  assert.notEqual(x.entryId, y.entryId); assert.equal(x.content, '共用版'); assert.equal(y.content, '独立版');
  assert.equal(x.role, 'user'); assert.equal(y.role, 'assistant');
});

test('预览页面按楼展示真实草稿，离开顶栏后丢弃样本与迟到结果', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), pending = [];
  const ui = auxManager(settings, { promptPreview: {
    sources: () => [{ id: 'a', label: '第 2 楼' }, { id: 'b', label: '第 4 楼' }],
    preview: args => new Promise(resolve => pending.push({ args, resolve })),
  } });
  await ui.click('预览请求'); await ui.choose('预览材料', 'b');
  pending[1].resolve({ messages: [{ role: 'user', content: '最新样本' }], warnings: ['提示'] }); await flush();
  assert.match(ui.node.textContent, /提示1 · 用户最新样本/);
  pending[0].resolve({ messages: [{ role: 'user', content: '早先样本' }] }); await flush(); assert.doesNotMatch(ui.node.textContent, /早先样本/);
  await ui.choose('预览材料', 'a'); ui.view.deactivate();
  assert.doesNotMatch(ui.node.textContent, /最新样本/);
  pending[2].resolve({ messages: [{ role: 'user', content: '离开后的样本' }] }); await flush(); ui.view.activate();
  assert.doesNotMatch(ui.node.textContent, /离开后的样本|最新样本/);
});

test('全局包裹符与时钟开关独立保存，宿主的回显保留尚在输入的字段', async () => {
  const ext = { qianqianjie: { sourceKeepTags: 'content' }, 'schedule-planner': { extraTags: 'think' } };
  const settings = createSettingsStore({ extensionSettings: ext });
  const listeners = new Set(), clock = [];
  const view = createBodyReadSettings({ settings, documentRef, onStoryClockChange: options => { clock.push(options); return { label: '时间戳已刷新' }; },
    subscribeSettingsChange: callback => { listeners.add(callback); return () => listeners.delete(callback); } });
  assert.equal(view.node.open, false); assert.equal(view.node.id, 'qqj-settings-wrappers');
  const keep = fieldControl(view.node, '保留包裹符'), extra = fieldControl(view.node, '清洗包裹符');
  ext['schedule-planner'].bodyWrappers.extraTags = '[[...]]';
  keep.value = 'CONTENT，正文'; await keep.fire('change');
  assert.deepEqual(settings.wrappers(), { keepTags: 'content,正文', extraTags: '[[...]]' });
  extra.focus(); extra.value = '正在输入'; for (const callback of listeners) callback();
  assert.equal(extra.value, '正在输入'); documentRef.activeElement = null; await extra.fire('blur'); assert.equal(extra.value, '[[...]]');
  const check = view.node.find(n => n.type === 'checkbox'); check.checked = false; await check.fire('change');
  const reference = fieldControl(view.node, '正文时间参考标签'); reference.value = 'clock'; await reference.fire('change');
  assert.equal(settings.get().storyClockEnabled, false); assert.equal(settings.get().storyClockReferenceTags, 'clock');
  assert.deepEqual(clock, [{ readOnly: true }, undefined, undefined]); view.dispose(); assert.equal(listeners.size, 0);
});

test('主回复摘要、时间戳与头像提示词随套切换，内置可读，编辑/恢复只写活动套', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), refreshes = [];
  const ui = auxManager(settings, { onStoryClockChange: options => { refreshes.push(options); } });
  for (const [key, name] of [['inlineMemoryPrompt','主回复文末摘要'], ['storyClockPrompt','正文时间戳'], ['avatarPrompt','头像生图']]) {
    await ui.choose('当前使用的预设', 'builtin'); await ui.choose('任务', key); await ui.click(name + '提示词');
    const factory = ui.control('提示词内容').value; assert.ok(factory.length > 20); assert.equal(ui.control('提示词内容').readOnly, true);
    await ui.click('复制整套后编辑本条'); await ui.click('复制并启用');
    const id = settings.get().auxPromptLibrary.activeSuiteId;
    assert.equal(ui.control('提示词内容').readOnly, false);
    ui.control('提示词内容').value = '套内专用提示词'; await ui.click('保存提示词');
    assert.equal(getAuxHostPrompt(settings.get().auxPromptLibrary, key), '套内专用提示词');
    await ui.choose('当前使用的预设', 'builtin'); assert.equal(getAuxHostPrompt(settings.get().auxPromptLibrary, key), '');
    await ui.choose('当前使用的预设', id); await ui.click(name + '提示词'); assert.equal(ui.control('提示词内容').value, '套内专用提示词');
    await ui.click('恢复此项默认'); assert.equal(ui.control('提示词内容').value, factory); await ui.click('保存提示词');
    assert.equal(getAuxHostPrompt(settings.get().auxPromptLibrary, key), '');
  }
  assert.ok(refreshes.length > 2);
});

test('主回复文末摘要复制一行酒馆宏，剪贴板不可用时选中宏', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), copied = [];
  const navigatorRef = { clipboard: { writeText: text => copied.push(text) } };
  const ui = auxManager(settings, { navigatorRef });
  await ui.choose('任务', 'inlineMemoryPrompt');
  const field = ui.byLabel('酒馆文末摘要宏');
  assert.equal(field.readOnly, true);
  assert.equal(field.value, '{{qqj_memory_prompt}}');
  await ui.click('复制宏'); assert.deepEqual(copied, [field.value]);
  delete navigatorRef.clipboard;
  let selected = false; field.select = () => { selected = true; };
  await ui.click('复制宏'); assert.ok(selected); assert.equal(documentRef.activeElement, field);
  ui.view.dispose();
});

test('副本草稿遇到其他窗口已保存的更改时不覆盖外部数据', async () => {
  const settings = createSettingsStore({ extensionSettings: {} }), ui = auxManager(settings);
  await ui.click('新建'); ui.control('预设名称').value = '现用'; await ui.click('创建并启用');
  const original = settings.get().auxPromptLibrary.activeSuiteId, name = resolveAuxPromptPreset(settings.get().auxPromptLibrary, AUX_TASKS[0].id).rows[0].name;
  await ui.click(name); ui.control('提示词内容').value = '当前草稿';
  const outside = editAuxPromptLibrary(settings.get().auxPromptLibrary, { type: 'createSuite', name: '来自其他窗口' });
  settings.update({ auxPromptLibrary: outside.library });
  await ui.click('保存条目'); assert.match(ui.node.textContent, /其他位置/); assert.notEqual(settings.get().auxPromptLibrary.activeSuiteId, original);
  await ui.click('取消'); assert.match(ui.byLabel('当前使用的预设').textContent, /来自其他窗口/);
});

test('外观模块内联选择即存并即时应用；程序设置同步标签，改 URL 清空缓存 family', async () => {
  const patches = []; let applied = 0;
  const settings = { get: () => ({ appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '' }), update: patch => { patches.push(patch); return patch; } };
  const { node } = createAppearanceSettings({ settings, documentRef, applyAppearance: () => { applied += 1; } });
  assert.equal(node.find(n => n.tagName === 'select'), undefined, '外观设置不得唤起手机原生选择器');
  const theme = fieldControl(node, '主题');
  await chooseInline(theme, 'night');
  assert.deepEqual(patches.at(-1), { appearanceTheme: 'night' });
  assert.equal(theme.find(n => n.className === 'qqj-inline-select-value').textContent, '夜间');
  theme.value = 'day';
  assert.equal(theme.find(n => n.className === 'qqj-inline-select-value').textContent, '日间', '顶栏程序化切换应同步内联标签');
  const url = fieldControl(node, '自定义字体 CSS URL');
  url.value = 'https://f.test/a.css'; url.fire('change');
  assert.deepEqual(patches.at(-1), { appearanceFontCssUrl: 'https://f.test/a.css', appearanceFontFamily: '' });
  assert.equal(applied, 2);
  assert.equal(node.find(n => n.tagName === 'label' && n.children[0]?.textContent === '字体 family'), undefined);
});

test('外观设置的两个楼层卡片开关分别保存并立即应用', async () => {
  const current = { appearanceTheme: 'auto', appearanceScale: 1, appearanceFontCssUrl: '', inlineRecallVisible: true, inlineMemoryVisible: true };
  const patches = []; let applied = 0;
  const settings = { wrappers: () => ({ keepTags: 'content', extraTags: '' }), updateWrappers() {}, get: () => ({ ...current }), update: patch => { Object.assign(current, patch); patches.push(patch); return { ...current }; } };
  const { node } = createAppearanceSettings({ settings, documentRef, applyAppearance: () => { applied += 1; } });
  const recall = node.find(n => n.tagName === 'input' && n.attributes['aria-label'] === '显示楼层召回卡片');
  const memory = node.find(n => n.tagName === 'input' && n.attributes['aria-label'] === '显示楼层记忆卡片');
  assert.equal(recall.checked, true); assert.equal(memory.checked, true);
  recall.checked = false; await recall.fire('change');
  assert.deepEqual(patches.at(-1), { inlineRecallVisible: false });
  assert.equal(current.inlineMemoryVisible, true);
  memory.checked = false; await memory.fire('change');
  assert.deepEqual(patches.at(-1), { inlineMemoryVisible: false });
  assert.equal(applied, 2);
});

test('无构画设置可从 UI 点击已存预设，并让后续分析与摘要路由使用该配置', async () => {
  const extensionSettings = {};
  const settings = createSettingsStore({ extensionSettings, save() {}, now: () => 1, random: () => 0.5 });
  const presetId = settings.upsertSharedPreset('预设 A', { url: 'https://preset-a.test/v1', key: 'KEY_A', model: 'model-a', excludeParams: ['seed'], timeoutSec: 45, stream: true, qqjTemperature: 0.73 }, 'preset-a');
  assert.equal(presetId, 'preset-a');
  assert.equal(settings.sharedPresets().length, 1, '没有构画初始记录时仍能建立共享预设池');
  assert.equal(settings.sharedPresets()[0].qqjTemperature, 0.73, '共享预设保留千千结专属温度');

  const routed = [];
  const resolver = createApiResolver({ settings });
  const router = createTaskRouter({ resolver, compactClient: { generateTask: async ({ config }) => { routed.push(config); return { jsonData: { ok: true } }; } } });
  const { node } = createApiSettings({ settings, apiTools: { fetchModels: async () => [], testConnection: async () => ({ ok: true }) }, documentRef });
  const analysis = fieldControl(node, '分析API（建议高质模型）');
  const trigger = inlineTrigger(analysis);
  await trigger.fire('click');
  const optionA = analysis.find(n => n.attributes['data-value'] === 'preset-a');
  documentRef.activeElement = null;
  const focusout = analysis.fire('focusout', { relatedTarget: null });
  await focusout; await Promise.resolve();
  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-options').hidden, false, '焦点清理微任务结束时仍不能提前隐藏菜单');
  optionA.focus();
  await optionA.fire('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  await trigger.fire('focus');

  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-options').hidden, true);
  assert.equal(analysis.find(n => n.className === 'qqj-inline-select-value').textContent, '预设 A');
  assert.equal(settings.get().apiMode, 'seven-preset');
  assert.equal(settings.get().selectedSevenDaysPresetId, 'preset-a');
  assert.equal(fieldControl(node, 'URL'), undefined, '连接字段仅在点击编辑后出现');

  await router.generateAnalysisTask({});
  assert.equal(routed.at(-1).qqjTemperature, 0.73, '路由后的实际配置包含预设温度');
  await router.generateUtilityTask({});
  assert.deepEqual(routed.map(config => [config.url, config.key, config.model]), [
    ['https://preset-a.test/v1', 'KEY_A', 'model-a'],
    ['https://preset-a.test/v1', 'KEY_A', 'model-a'],
  ]);
});

test('共享预设更新保留宿主未知字段，清空温度后回显未设置', () => {
  const extensionSettings = { 'schedule-planner': { apiPresets: [{ id: 'shared', name: '旧名', url: 'https://old.test/v1', key: 'OLD_KEY', model: 'old', timeoutSec: 30, stream: false, qqjTemperature: 0.44, hostField: 'keep' }] } };
  const settings = createSettingsStore({ extensionSettings, save() {} });
  settings.upsertSharedPreset('更新后', { url: 'https://new.test/v1', key: 'NEW_KEY', model: 'new', timeoutSec: 45, stream: true, qqjTemperature: 0.91 }, 'shared');
  assert.equal(extensionSettings['schedule-planner'].apiPresets[0].qqjTemperature, 0.91);
  assert.equal(extensionSettings['schedule-planner'].apiPresets[0].hostField, 'keep');
  settings.upsertSharedPreset('更新后', { url: 'https://new.test/v1', key: 'NEW_KEY', model: 'new', timeoutSec: 45, stream: true, qqjTemperature: null }, 'shared');
  assert.equal(Object.hasOwn(extensionSettings['schedule-planner'].apiPresets[0], 'qqjTemperature'), false, '清空时删除旧值');
  assert.equal(settings.sharedPresets()[0].qqjTemperature, undefined, '清空后回显为空');
});

test('独立向量区开关靠右，默认地址模型直接回填，只保存向量配置且仅手动建立', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.saveMainConfig({ url: 'https://analysis.invalid/v1', key: 'analysis-key', model: 'analysis' });
  let builds = 0, aborts = 0;
  const vectorIndex = { getState: () => ({ status: 'idle' }), subscribe: () => () => {}, build: async () => { builds++; return { status: 'ready' }; }, abortAll: () => { aborts++; } };
  const calls = [];
  const apiTools = { fetchModels: async () => { calls.push(['models']); return []; }, testConnection: async () => { calls.push(['chat']); } };
  const vectorApi = { embed: async (config, input) => { calls.push(['embedding', config, input]); return [new Float32Array([1, 0])]; } };
  const { node, dispose } = createSiblingApiSettings({ settings, apiTools, vectorApi, vectorIndex, documentRef, vectorOpen: true });
  const vector = node.find(n => n.id === 'qqj-settings-vector-api');
  assert.equal(vector.open, true);
  const editor = node.find(n => n.className.includes('qqj-api-editor'));
  assert.ok(node.children.includes(vector), '向量区与聊天API是同级组件');
  assert.equal(editor.children.includes(vector), false);
  assert.equal(fieldControl(node, '向量API'), undefined, '向量不再混入聊天 API 的角色预设');
  assert.equal(vector.find(n => n.className.includes('qqj-inline-select')), undefined);
  assert.equal(vector.find(n => n.tagName === 'button' && n.textContent === '另存为'), undefined);
  const enabled = vector.find(n => n.attributes['aria-label'] === '开启向量召回');
  assert.equal(enabled.checked, false);
  assert.deepEqual(enabled.parentNode.children.map(n => n.tagName), ['span', 'input']);
  assert.match(enabled.parentNode.className, /setting-switch qqj-vector-enable/);
  assert.equal(enabled.parentNode.className.includes('settings-field'), false, '开关不套用输入框宽度与内边距');
  assert.equal(fieldControl(vector, 'URL').value, VECTOR_DEFAULT_URL);
  assert.equal(fieldControl(vector, '模型').value, VECTOR_DEFAULT_MODEL);
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, true);
  fieldControl(vector, 'URL').value = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/embeddings';
  await fieldControl(vector, 'URL').fire('input');
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, false);
  fieldControl(vector, 'URL').value = 'https://maas-api.cn-huabei-1.xf-yun.com.evil.test/v2';
  await fieldControl(vector, 'URL').fire('input');
  assert.equal(vector.find(n => n.className.includes('qqj-vector-xfyun-hint')).hidden, true);
  assert.equal(fieldControl(vector, 'Key').placeholder, '输入向量 API Key');
  fieldControl(vector, 'URL').value = VECTOR_DEFAULT_URL;
  await fieldControl(vector, 'URL').fire('input');
  const build = vector.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  const testConnection = vector.find(n => n.tagName === 'button' && n.textContent === '测试');
  assert.equal(build.disabled, true); assert.equal(testConnection.disabled, true);
  await build.fire('click'); await testConnection.fire('click'); assert.deepEqual(calls, []); assert.equal(builds, 0);
  enabled.checked = true; await enabled.fire('change');
  assert.equal(settings.get().vectorEnabled, true); assert.equal(build.disabled, false); assert.equal(builds, 0);
  fieldControl(vector, 'Key').value = 'vector-key';
  await vector.find(n => n.tagName === 'button' && n.textContent === '保存').fire('click');
  assert.equal(builds, 0); assert.equal(settings.get().apiKey, 'analysis-key');
  assert.equal(settings.get().vectorPresetId, '');
  assert.deepEqual(resolveVectorConfig(settings), { url: VECTOR_DEFAULT_URL, model: VECTOR_DEFAULT_MODEL, key: 'vector-key', dimensions: 1024 });
  await testConnection.fire('click');
  assert.deepEqual(calls, [['embedding', resolveVectorConfig(settings), ['连接测试']]], '向量测试不调用聊天接口');
  const abortsBeforeBuild = aborts;
  await build.fire('click'); assert.equal(builds, 1); assert.equal(aborts, abortsBeforeBuild, '相同配置重建不能清空可复用向量');
  assert.equal(settings.get().apiModel, 'analysis');
  enabled.checked = false; await enabled.fire('change');
  assert.equal(settings.get().vectorEnabled, false); assert.equal(settings.get().vectorKey, 'vector-key');
  assert.equal(settings.mainConfig().url, 'https://analysis.invalid/v1');
  assert.equal(settings.mainConfig().model, 'analysis');
  assert.equal(fieldControl(editor, 'URL'), undefined, '聊天参数只在编辑弹窗，不与向量字段混读');
  dispose();
});

test('已选向量预设回填但不自动改设置；保存复制凭证解除共享引用，不改其他 API 或原预设', async () => {
  let writes = 0;
  const settings = createSettingsStore({ extensionSettings: {}, save: () => { writes++; } });
  settings.saveMainConfig({ url: 'https://main.invalid/v1', key: 'main-key', model: 'chat-model' });
  const sharedId = settings.upsertSharedPreset('旧向量预设', { url: 'https://vector.invalid/v1', key: 'vector-key', model: 'embed', excludeParams: ['seed'], timeoutSec: 73, stream: true, qqjTemperature: 0.42 });
  settings.update({ vectorEnabled: true, vectorPresetId: sharedId });
  const initialWrites = writes;
  const { node, dispose } = createVectorApiSettings({ settings, documentRef });
  assert.equal(writes, initialWrites, '打开设置不自动迁移或保存');
  assert.equal(settings.get().vectorPresetId, sharedId);
  assert.equal(fieldControl(node, 'URL').value, 'https://vector.invalid/v1');
  assert.equal(fieldControl(node, '模型').value, 'embed');
  assert.equal(fieldControl(node, 'Key').value, ''); assert.match(fieldControl(node, 'Key').placeholder, /已保存/);
  fieldControl(node, '模型').value = 'embed-v2';
  await node.find(n => n.tagName === 'button' && n.textContent === '保存').fire('click');
  assert.equal(settings.get().vectorPresetId, ''); assert.equal(settings.get().vectorKey, 'vector-key');
  assert.equal(settings.get().vectorModel, 'embed-v2');
  const shared = settings.sharedPresets().find(item => item.id === sharedId);
  assert.equal(shared.model, 'embed'); assert.equal(shared.key, 'vector-key');
  assert.deepEqual(shared.excludeParams, ['seed']); assert.equal(shared.timeoutSec, 73); assert.equal(shared.stream, true); assert.equal(shared.qqjTemperature, 0.42);
  settings.deleteSharedPreset(sharedId);
  assert.equal(settings.get().vectorEnabled, true, '删除已脱离的共享预设不影响独立向量');
  assert.equal(resolveVectorConfig(settings).model, 'embed-v2');
  assert.equal(settings.get().apiMode, 'auto'); assert.equal(settings.summaryPresetId(), ''); assert.equal(settings.get().recallPresetId, '');
  assert.equal(settings.mainConfig().model, 'chat-model'); dispose();
});

test('向量区显示小字进度与取消，编辑其他 API 时进度保留，连接结果互不覆盖', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.update({ vectorEnabled: true, vectorKey: 'vector-key' });
  let state = { status: 'idle' }, listener, endBuild, endTest;
  const vectorIndex = {
    getState: () => state,
    subscribe: fn => { listener = fn; return () => { listener = null; }; },
    build: () => { state = { status: 'building', active: true, completed: 3, total: 7 }; listener?.(); return new Promise(resolve => { endBuild = resolve; }); },
    abortAll: () => { state = { status: 'idle', active: false }; listener?.(); endBuild?.(); },
  };
  const vectorApi = { embed: () => new Promise(resolve => { endTest = resolve; }) };
  const apiTools = { testConnection: async () => ({ model: 'chat-model' }) };
  const { node, dispose, getApiEditor } = createSiblingApiSettings({ settings, apiTools, vectorIndex, vectorApi, documentRef });
  const vector = node.find(n => n.id === 'qqj-settings-vector-api');
  const build = vector.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  const cancel = vector.find(n => n.tagName === 'button' && n.textContent === '取消');
  const building = build.fire('click'); await flush();
  assert.equal(build.disabled, true); assert.equal(cancel.hidden, false);
  const progress = vector.find(n => n.className.includes('qqj-vector-progress'));
  assert.equal(progress.textContent, '建立中 3/7');
  await focusInline(fieldControl(node, '分析API（建议高质模型）'));
  assert.equal(cancel.hidden, false); assert.equal(progress.hidden, false); listener?.();
  assert.equal(node.find(n => n.className === 'settings-result').textContent, '');
  await cancel.fire('click'); await building;
  assert.equal(build.disabled, false); assert.equal(cancel.hidden, true); assert.equal(typeof listener, 'function');
  const testing = vector.find(n => n.tagName === 'button' && n.textContent === '测试').fire('click'); await flush();
  await focusInline(fieldControl(node, '摘要API（建议快速模型）'));
  await node.find(n => n.tagName === 'button' && n.attributes['aria-label'] === '编辑摘要 API').fire('click');
  const editor = getApiEditor();
  await editor.find(n => n.tagName === 'button' && n.textContent === '测试').fire('click');
  const mainResult = editor.find(n => n.className === 'qqj-api-result success');
  assert.equal(mainResult.textContent, '连接成功 · chat-model');
  endTest([]); await testing;
  assert.equal(mainResult.textContent, '连接成功 · chat-model');
  assert.equal(vector.find(n => n.className === 'settings-result success').textContent, '连接成功');
  dispose(); assert.equal(listener, null);
});

test('索引切页后重新订阅进行中的任务，恢复完成/失败结果，不重复建索引或中止任务', async () => {
  const settings = createSettingsStore({ extensionSettings: {}, save: () => {} });
  settings.update({ vectorEnabled: true, vectorKey: 'vector-key' });
  let state = { status: 'idle', active: false, completed: 0, total: 0 }, builds = 0, aborts = 0;
  const listeners = new Set();
  const publish = next => { state = next; for (const listener of listeners) listener(state); };
  const vectorIndex = { getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, build: async () => { builds++; }, abortAll: () => { aborts++; } };
  const mount = () => createVectorApiSettings({ settings, vectorIndex, documentRef });
  const idle = mount();
  const idleBuild = idle.node.find(n => n.tagName === 'button' && n.textContent === '建立索引');
  assert.equal(idleBuild.disabled, false, '无已建索引时首次手动建立入口保持可用');
  assert.doesNotMatch(idle.node.textContent, /正在读取|建立中/);
  idle.dispose();
  publish({ status: 'building', active: true, completed: 3, total: 7 });
  const first = mount(); assert.match(first.node.textContent, /3\/7/);
  publish({ ...state, completed: 5 }); assert.match(first.node.textContent, /5\/7/);
  assert.equal(listeners.size, 1);
  first.dispose(); assert.equal(listeners.size, 0); assert.equal(aborts, 0);
  const second = mount(); assert.match(second.node.textContent, /5\/7/);
  publish({ status: 'ready', active: false, completed: 7, total: 7 });
  assert.match(second.node.textContent, /已索引 7 个片段/);
  assert.doesNotMatch(first.node.textContent, /已索引 7/);
  second.dispose();
  const complete = mount(); assert.match(complete.node.textContent, /已索引 7 个片段/); complete.dispose();
  publish({ status: 'error', active: false, completed: 5, total: 7, error: '向量请求超时。' });
  const failed = mount(); assert.match(failed.node.textContent, /向量请求超时/); failed.dispose();
  publish({ status: 'building', active: true, completed: 0, total: 0 });
  const preparing = mount(); assert.match(preparing.node.textContent, /正在读取原文/); assert.doesNotMatch(preparing.node.textContent, /0\/0/); preparing.dispose();
  publish({ status: 'ready', active: false, completed: 0, total: 0 });
  const empty = mount(); assert.match(empty.node.textContent, /当前没有可索引的原文/); empty.dispose();
  assert.equal(builds, 0); assert.equal(aborts, 0); assert.equal(listeners.size, 0);
});

test('千窗底图偏好只接受聊天UUID和支持的素材，保存不改变其它设置',()=>{
 const data={},store=createSettingsStore({extensionSettings:data}),chat='11111111-1111-4111-8111-111111111111';
 store.update({apiModel:'keep',qianchuangBasemaps:{[chat]:'town',bad:'palace','22222222-2222-4222-8222-222222222222':'unknown'}});
 assert.deepEqual(store.get().qianchuangBasemaps,{[chat]:'town'});assert.equal(store.get().apiModel,'keep');
});

test('三张新增通用底图可保存到原聊天偏好，保其它配置且未知值仍忽略',()=>{
 const store=createSettingsStore({extensionSettings:{}}),ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'],value=Object.fromEntries(ids.map((id,i)=>[id,['modern-town','old-town','sci-fi'][i]]));store.update({apiModel:'keep',qianchuangBasemaps:{...value,bad:'sci-fi'}});assert.deepEqual(store.get().qianchuangBasemaps,value);assert.equal(store.get().apiModel,'keep');
});
