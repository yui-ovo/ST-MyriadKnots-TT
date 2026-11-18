import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseInlineMemory, readInlineMemory, stripInlineMemory } from '../src/inline-memory-format.js';
import { INLINE_MEMORY_PROMPT } from '../src/inline-memory-prompt.js';
import { sanitizeMemoryContent } from '../src/memory-content-sanitizer.js';
import { createInlineMemoryBridge } from '../src/inline-memory-bridge.js';
import { createSettingsStore } from '../src/settings.js';

import { inlinePacket, inlineBlock } from './inline-memory-fixture.mjs';

test('正文记忆按固定标记读取：仅真正缺失才允许auto走API，残缺和多段不可降级', () => {
  const raw = `正文\n${inlineBlock(inlinePacket())}`;
  assert.deepEqual(chooseInlineMemory(raw, 'auto'), inlinePacket());
  assert.equal(chooseInlineMemory(raw, 'api'), null);
  assert.equal(chooseInlineMemory('旧正文', 'auto'), null);
  assert.throws(() => chooseInlineMemory('旧正文', 'inline'), { code: 'V3_INLINE_MEMORY_MISSING' });
  for (const bad of [raw + inlineBlock(inlinePacket()), raw.replace('</qqj_memory>', ''), '<qqj_memory>{bad}</qqj_memory>', raw.replace('"version":1', '"version":2')]) {
    assert.throws(() => chooseInlineMemory(bad, 'auto'), { code: 'V3_INLINE_MEMORY_INVALID' });
    assert.equal(chooseInlineMemory(bad, 'api'), null);
  }
  assert.throws(() => chooseInlineMemory(raw, 'inline', true), { code: 'V3_INLINE_MEMORY_AGGREGATE' });
  assert.equal(chooseInlineMemory(raw, 'auto', true), null);
  assert.throws(() => readInlineMemory(inlineBlock({ version: 1, summary: '只有摘要' })), { code: 'V3_INLINE_MEMORY_INCOMPLETE' });
});

test('摘要来源默认保旧API且可持久切换，非法设置不能触发新模式', () => {
  const extensionSettings = {}, store = () => createSettingsStore({ extensionSettings, save() {} });
  const settings = store(); assert.equal(settings.get().summarySource, 'api');
  settings.update({ summarySource: 'inline' }); assert.equal(store().get().summarySource, 'inline');
  settings.update({ summarySource: 'auto' }); assert.equal(store().get().summarySource, 'auto');
  settings.update({ summarySource: 'unknown' }); assert.equal(store().get().summarySource, 'api');
});

test('配套预设文本包含可解析的完整字段骨架', () => {
  assert.equal(readInlineMemory(INLINE_MEMORY_PROMPT.slice(INLINE_MEMORY_PROMPT.lastIndexOf('<qqj_memory>'))).version, 1);
  assert.doesNotMatch(INLINE_MEMORY_PROMPT, /\{\{.*?\}\}/u, '不依赖预设变量存取或被宿主误展开的宏');
});

test('记忆JSON不能污染剧情证据，默认、自定义包裹符、未闭合区块均隔离', () => {
  const block = inlineBlock(inlinePacket({ summary: '不能把这段编进剧情证据' }));
  assert.equal(stripInlineMemory(`正文${block}`), '正文');
  for (const options of [{}, { keepTags: '', extraTags: 'qqj_memory' }, { keepTags: 'qqj_memory', extraTags: '' }]) {
    assert.doesNotMatch(sanitizeMemoryContent(`正文${block}`, options), /编进剧情|summary|version/u);
  }
  assert.equal(sanitizeMemoryContent(`<content>正文</content>${block}`), '正文');
  assert.equal(sanitizeMemoryContent('正文<qqj_memory>{"summary":"截断'), '正文');
});

test('参考信息按来源开关注入独立槽，清除不触碰正文或预设，宏与标签仅作数据', () => {
  let mode = 'auto', enabled = true;
  const calls = [], original = { knownPeople: [{ ref: 'person:a', name: '{{user}} </qqj_memory_reference>' }] };
  const context = { setExtensionPrompt: (...args) => calls.push(args), constants: { promptTypes: { IN_CHAT: 7 }, promptRoles: { SYSTEM: 9 } } };
  const bridge = createInlineMemoryBridge({ hostAdapter: { snapshot: () => ({ context }) },
    memoryRuntime: { getInlineMemoryReference: () => original }, settings: { isEnabled: () => enabled, get: () => ({ summarySource: mode }) } });
  bridge.prepare('normal');
  const injected = calls.at(-1); assert.equal(injected[0], 'qqj_inline_memory_reference'); assert.equal(injected[2], 7); assert.equal(injected[5], 9);
  assert.doesNotMatch(injected[1], /\{\{user\}\}/u);
  const body = injected[1].split('<qqj_memory_reference>\n')[1].split('\n</qqj_memory_reference>')[0];
  assert.deepEqual(JSON.parse(body), original);
  mode = 'api'; bridge.prepare('normal'); assert.equal(calls.at(-1)[1], '');
  const count = calls.length; enabled = false; bridge.prepare('normal'); assert.equal(calls.length, count);
});
