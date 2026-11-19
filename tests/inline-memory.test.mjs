import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseInlineMemory, readInlineMemory, stripInlineMemory } from '../src/inline-memory-format.js';
import { INLINE_MEMORY_PROMPT } from '../src/inline-memory-prompt.js';
import { sanitizeMemoryContent } from '../src/memory-content-sanitizer.js';
import { createInlineMemoryBridge } from '../src/inline-memory-bridge.js';
import { createSettingsStore } from '../src/settings.js';

import { inlinePacket, inlineBlock } from './inline-memory-fixture.mjs';
import { block as textBlock, packet as textPacket } from './fixtures/main-reply-memory-text.mjs';

test('分栏文字与原JSON保留同一份完整资料，不缩短摘要或丢掉领域字段', () => {
  assert.deepEqual(readInlineMemory(textBlock), textPacket);
  assert.deepEqual(readInlineMemory(textBlock), readInlineMemory(inlineBlock(textPacket)));
  assert.deepEqual(readInlineMemory(textBlock.replaceAll('\n', '\r\n')), textPacket);
});

test('文字值保留引号、冒号、转义分隔符、原文换行与字面空值', () => {
  const raw = textBlock.replace('裴先生、晚生', String.raw`裴\、先生、晚生`)
    .replace('手背有一道擦伤', String.raw`他写道：“A: B｜C”。\n路径 C:\\notes；左\→右`.replace('B｜C', String.raw`B\｜C`))
    .replace('林岚｜裴晚生｜trust', String.raw`林岚｜\无｜trust`);
  const parsed = readInlineMemory(raw);
  assert.deepEqual(parsed.people[1].aliases, ['裴、先生', '晚生']);
  assert.equal(parsed.knowledge[0].description, '他写道：“A: B｜C”。\n路径 C:\\notes；左→右');
  assert.equal(parsed.cseSignals[0].object, '无');
});

test('文字区块缺栏目、重复栏目、错列、缺引用配对及断裂路径都拒绝，不回退摘要API', () => {
  for (const [raw, code] of [
    [textBlock.replace(/【状态线索】[^]*?(?=【空间地点】)/u, ''), 'V3_INLINE_MEMORY_INCOMPLETE'],
    [textBlock.replace('【人物】', '【摘要】'), 'V3_INLINE_MEMORY_INVALID'],
    [textBlock.replace('林岚｜injury｜手背有一道擦伤', '林岚｜手背有一道擦伤'), 'V3_INLINE_MEMORY_INVALID'],
    [textBlock.replace('钥匙｜否｜无｜无', '钥匙｜否｜matter:old｜无'), 'V3_INLINE_MEMORY_INVALID'],
    [textBlock.replace('place-mention-1→place-mention-2', 'place-mention-404→place-mention-2'), 'V3_INLINE_MEMORY_INVALID'],
  ]) assert.throws(() => chooseInlineMemory(raw, 'auto'), { code });
});

test('文字格式能明确复用旧人物、地点与事项，原引用交给入库时校验', () => {
  const raw = textBlock.replace('character｜present｜无', 'character｜present｜person:known')
    .replace('place-mention-1｜钟楼｜new｜canonicalContent｜林岚与裴晚生走进钟楼的一层书房。', 'place-mention-1｜钟楼｜existing｜canonicalContent｜林岚与裴晚生走进钟楼的一层书房。｜place:known｜钟楼旧称')
    .replace('钥匙｜否｜无｜无', '钥匙｜否｜matter:known｜progress');
  const parsed = readInlineMemory(raw);
  assert.equal(parsed.people[1].sameAsEntityKey, 'person:known');
  assert.equal(parsed.spatialFacts.places[0].sameAsPlaceKey, 'place:known');
  assert.deepEqual(parsed.spatialFacts.places[0].aliases, ['钟楼旧称']);
  assert.equal(parsed.placePaths[0].path[0].sameAsPlaceKey, 'place:known');
  assert.deepEqual(parsed.qianshi.events[0].links, [{ candidateKey: 'matter:known', kind: 'progress' }]);
});

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

test('配套预设文本用可解析的分栏文字，保留原摘要篇幅与全部栏目', () => {
  assert.equal(readInlineMemory(INLINE_MEMORY_PROMPT.slice(INLINE_MEMORY_PROMPT.lastIndexOf('<qqj_memory>'))).version, 1);
  assert.match(INLINE_MEMORY_PROMPT, /通常 200—500 字，最多 4000 字/u);
  assert.doesNotMatch(INLINE_MEMORY_PROMPT, /"version"\s*:|"summary"\s*:/u);
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
  assert.equal(sanitizeMemoryContent(`正文${textBlock}`), '正文');
  assert.equal(sanitizeMemoryContent('正文<qqj_memory>【摘要】\n未完成的摘要'), '正文');
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
