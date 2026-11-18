import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryComparisonTarget, comparisonAfterExtraction, showSummaryComparison } from '../src/ui/summary-comparison.js';

const state = (id = 'new', overrides = {}) => ({ chatId: 'chat', floors: [{ floorId: 'floor', messageIndex: 78,
  memoryId: id, status: 'ready', summarySource: 'user', summary: '人工确认：已搬家。\n<script>原文</script>', aiSummary: 'AI确认：已搬家。\n<script>原文</script>', ...overrides }] });
const flatten = node => [node, ...node.children.flatMap(flatten)];
const documentRef = { createElement(tag) { return { tag, textContent: '', children: [], attributes: {},
  setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); } }; } };
function harness(initial = state()) {
  let current = initial, dialog;
  const calls = [];
  const runtime = { getState: () => current, restoreAi: async (...args) => { calls.push(args); } };
  const show = () => showSummaryComparison({ runtime, target: summaryComparisonTarget(current, 'floor'), documentRef,
    customImpl(options) { dialog = options; return new Promise(resolve => { dialog.close = resolve; }); } });
  return { show, calls, setState(value) { current = value; }, get dialog() { return dialog; } };
}

test('人工与AI全文安全展示且高亮差异，关闭不写入，明确采用才切换', async () => {
  const h = harness(), viewing = h.show(), dialog = h.dialog;
  assert.equal(dialog.cancelText, '保留人工版'); assert.equal(dialog.confirmText, '采用 AI 新版');
  assert.equal(dialog.title, '第 78 楼 · 摘要对比');
  const panes = dialog.content.children.filter(node => node.className === 'qqj-summary-comparison-text');
  assert.deepEqual(panes.map(node => node.children.map(child => child.textContent).join('')), [state().floors[0].summary, state().floors[0].aiSummary]);
  assert.ok(flatten(panes[0]).some(node => node.tag === 'del'));
  assert.ok(flatten(panes[1]).some(node => node.tag === 'ins'));
  assert.ok(flatten(dialog.content).every(node => !Object.hasOwn(node, 'innerHTML')));
  dialog.close(null); await viewing; assert.equal(h.calls.length, 0);
  const reopened = h.show();
  const result = await h.dialog.submit(); h.dialog.close(result); assert.equal(await reopened, 'adopted');
  assert.deepEqual(h.calls, [['floor', { expectedMemory: { chatId: 'chat', memoryId: 'new' } }]]);
});

test('文字相同仍展示两版并解释来源切换', async () => {
  const h = harness(state('new', { aiSummary: state().floors[0].summary })), viewing = h.show();
  assert.match(flatten(h.dialog.content).map(node => node.textContent).join(''), /两版文字相同/);
  assert.equal(flatten(h.dialog.content).filter(node => ['del', 'ins'].includes(node.tag)).length, 0);
  h.dialog.close(null); await viewing;
});

test('只有本次成功保存的人工摘要会自动对比，失败、换聊天、并发更新均不弹出', () => {
  const before = state('old'), next = state();
  assert.equal(comparisonAfterExtraction(before, next, next, 'floor').memoryId, 'new');
  for (const result of [{ status: 'error' }, before, state('new', { status: 'failed' }), state('new', { summarySource: 'ai' })]) {
    assert.equal(comparisonAfterExtraction(before, result, result, 'floor'), null);
  }
  assert.equal(comparisonAfterExtraction(before, next, state('newer'), 'floor'), null);
  assert.equal(comparisonAfterExtraction(before, next, { ...next, chatId: 'other' }, 'floor'), null);
  assert.equal(summaryComparisonTarget(state('new', { aiSummary: '' }), 'floor'), null);
  assert.equal(summaryComparisonTarget(state('new', { frozen: true }), 'floor'), null);
});

test('对比期间切聊天或摘要发生变化，拒绝采用旧窗口的AI版本', async () => {
  for (const next of [state('newer'), { ...state(), chatId: 'other' }]) {
    const h = harness(), viewing = h.show(); h.setState(next);
    await assert.rejects(h.dialog.submit(), { code: 'V3_MEMORY_SUMMARY_STALE' });
    assert.equal(h.calls.length, 0); h.dialog.close(null); await viewing;
  }
});

test('采用失败保持对比窗口可重试，不把未保存结果当成功', async () => {
  let dialog;
  const runtime = { getState: () => state(), restoreAi: async () => { throw new Error('保存失败'); } };
  const viewing = showSummaryComparison({ runtime, target: summaryComparisonTarget(state(), 'floor'), documentRef,
    customImpl(options) { dialog = options; return null; } });
  await assert.rejects(dialog.submit(), /保存失败/); assert.equal(await viewing, null);
});
