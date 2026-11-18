import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldbookSelectionRequest, sortWorldbookSelectionEntries } from '../src/dynamic-worldbook-selection.js';

const item = (uid, extra = {}) => ({ uid, label: '', keys: [], content: `完整正文 ${uid}`, ...extra });
const make = (entries, recent = [{ role: 'user', content: '继续' }]) => buildWorldbookSelectionRequest({ entries, recent });

test('选材目录稳定排序并放在变化剧情之前，保留完整正文、标签与关键词', () => {
  const text = '  第一行\n\n' + '很长的正文🔖'.repeat(12000) + '\n末尾  ';
  const source = [item('2', { content: text, keys: ['海边', '旧公寓'], label: '住所' }), item('1')];
  const first = make(source), second = make([...source].reverse(), [{ role: 'assistant', content: '新的剧情' }]);
  assert.equal(first.taskMessages[0].content, second.taskMessages[0].content);
  assert.notEqual(first.taskMessages[1].content, second.taskMessages[1].content);
  const catalog = JSON.parse(first.taskMessages[0].content).entries;
  assert.deepEqual(catalog, [{ uid: '1', content: '完整正文 1' }, { uid: '2', label: '住所', keys: ['海边', '旧公寓'], content: text }]);
  assert.deepEqual(JSON.parse(first.taskMessages[1].content), { recent: [{ role: 'user', content: '继续' }] });
  assert.deepEqual(sortWorldbookSelectionEntries(source).map(e => e.uid), ['1', '2']);
  assert.deepEqual(source.map(e => e.uid), ['2', '1']);
});

test('普通短编号保持兼容，整数回复与重复编号正确恢复，近似数字不混淆', () => {
  const request = make([item('1'), item('01'), item('2')]);
  assert.deepEqual(request.allowedIds, ['01', '1', '2']);
  assert.deepEqual(request.decode({ selected: [1, ' 1 ', '01', 2, '2'] }), ['1', '01', '2']);
  assert.deepEqual(request.decode({ selected: [] }), []);
  for (const invalid of [undefined, {}, { selected: '1' }, { selected: [1.5] }, { selected: [null] }, { selected: [{}] }, { selected: ['unknown'] }]) {
    assert.throws(() => request.decode(invalid), { code: 'QQJ_DYNAMIC_BOOK' });
  }
});

test('长编号只在本次请求缩短，避开所有真实短编号并拒绝猜测原编号', () => {
  const long = 'a'.repeat(60);
  const request = make([item(long), item('e1'), item('_e1')]);
  // _e1 sorts before the long id, whose preferred alias e1 is already real.
  const wire = JSON.parse(request.taskMessages[0].content).entries;
  const encoded = wire.find(e => e.content === `完整正文 ${long}`).uid;
  assert.equal(encoded, '__e1');
  assert.deepEqual(request.decode({ selected: [encoded, 'e1', '_e1'] }), [long, 'e1', '_e1']);
  assert.throws(() => request.decode({ selected: [long] }), /本批候选以外/);
  assert.equal(new Set(wire.map(e => e.uid)).size, 3);
  assert.equal(item(long).uid, long);
});

test('目录输入不能有重复或可被trim混淆的编号，不能静默省略坏正文与关键词', () => {
  for (const entries of [[item('1'), item('1')], [item(' 1')], [item('')], [item('1', { content: null })],
    [item('1', { label: {} })], [item('1', { keys: ['ok', 1] })]]) {
    assert.throws(() => make(entries), { code: 'QQJ_DYNAMIC_BOOK' });
  }
  assert.throws(() => buildWorldbookSelectionRequest({ entries: [], recent: null }), /格式无效/);
});

test('编码后的请求与映射冻结，不受调用方后续修改影响；两次请求互不串号', () => {
  const entries = [item('x'.repeat(50), { keys: ['旧关键词'] })], recent = [{ role: 'user', content: '原剧情' }];
  const first = make(entries, recent), second = make([item('y'.repeat(50))]);
  const uid = first.allowedIds[0];
  entries[0].uid = 'changed'; entries[0].keys.push('新关键词'); entries[0].content = '覆盖'; recent[0].content = '新剧情';
  assert.deepEqual(first.decode({ selected: [uid] }), ['x'.repeat(50)]);
  assert.deepEqual(second.decode({ selected: [uid] }), ['y'.repeat(50)]);
  assert.deepEqual(JSON.parse(first.taskMessages[0].content).entries[0].keys, ['旧关键词']);
  assert.equal(JSON.parse(first.taskMessages[1].content).recent[0].content, '原剧情');
  assert.ok(Object.isFrozen(first.allowedIds));
  assert.ok(Object.isFrozen(first.taskMessages[0]));
});

test('精简只去掉空字段和长编号，统计实际字符而不估算缓存或费用', () => {
  const entries = Array.from({ length: 8 }, (_, i) => item(`${i}-${'long-id-'.repeat(10)}`));
  const request = make(entries);
  assert.ok(request.stats.requestCharacters < request.stats.legacyCharacters);
  assert.equal(request.stats.requestCharacters, request.taskMessages.reduce((n, m) => n + m.content.length, 0));
  assert.deepEqual(request.decode({ selected: request.allowedIds }), sortWorldbookSelectionEntries(entries).map(e => e.uid));
  assert.deepEqual(make([]).decode({ selected: [] }), []);
  assert.throws(() => make([]).decode({ selected: ['e0'] }), /本批候选以外/);
});
