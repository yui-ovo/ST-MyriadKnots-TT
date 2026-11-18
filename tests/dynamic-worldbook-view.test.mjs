import test from 'node:test';
import assert from 'node:assert/strict';
import { stableJson } from '../src/dynamic-worldbook.js';
import { createDynamicWorldbookView } from '../src/ui/dynamic-worldbook-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.style = {}; this.textContent = ''; this.scrollTop = 0; this.scrollLeft = 0; }
  append(...nodes) { for (const node of nodes) node.parentElement = this; this.children.push(...nodes); }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, callback) { this.events[key] = callback; }
  fire(key, event) { this.events[key]?.(event); }
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const tick = () => new Promise(resolve => setImmediate(resolve));
test('settings view wires opt-in, text editing with owner, confirmations and safe text rendering', async () => {
  let listener, confirms = [], calls = [];
  const data = { chatId: 'owner-a', book: '<script>book</script>', processed: [], entries: [
    { uid: '1', label: '住所', content: '旧家', original: '原文', managed: false, locked: false, protectedReason: '', history: [], kind: 'fact', classification: 'ready', segments: [{ id: 'body', text: '旧家', writable: true }] },
    { uid: '2', label: 'MVU', content: '<script>rule</script>', original: '<script>rule</script>', managed: false, locked: false, protectedReason: '变量', history: [], kind: 'rule', classification: 'ready', segments: [{ id: 'body', text: '<script>rule</script>', writable: false }] },
  ], interval: 3 };
  const runtime = { getState: () => ({ phase: 'idle', data }), subscribe(fn) { listener = fn; return () => { listener = null; }; },
    refresh: async () => {}, edit: async (...args) => { calls.push(args); }, configure: async (...args) => { calls.push(args); }, initialize: async () => {}, abortAll() {} };
  const view = createDynamicWorldbookView({ runtime, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: async options => { confirms.push(options); return true; } });
  let nodes = flatten(view.node);
  const editor = nodes.find(node => node.tag === 'textarea' && !node.disabled); editor.value = '新家';
  const protection = nodes.find(node => node.tag === 'label' && node.children.some(child => child.textContent === '保护此片段（AI 不修改）')).children[0];
  protection.checked = true; protection.fire('change');
  assert.equal(flatten(view.node).includes(editor), true, '调整草稿权限不丢失正在输入的正文');
  assert.equal(editor.value, '新家');
  assert.equal(calls.length, 0, '草稿权限点击保存前不写入');
  listener({ phase: 'idle', data: { ...data, processed: [{}, {}, {}] }, updateReadiness: '等待新的已记忆 AI 回复',
    lastUpdate: { status: 'unchanged', at: '2026-10-16T00:00:00.000Z', floors: [0, 2], calls: 1, responses: 1, changedEntries: 0, api: { model: 'test' } } });
  const liveNodes = flatten(view.node);
  assert.ok(liveNodes.some(node => node.textContent.includes('本批无需修改')));
  assert.ok(liveNodes.some(node => node.textContent.includes('已核对至第 2 楼')));
  assert.ok(liveNodes.includes(editor)); assert.equal(editor.value, '新家', '更新回执不能重建编辑器并丢失草稿');
  nodes.find(node => node.textContent === '保存正文与权限').fire('click'); await tick();
  assert.deepEqual(calls[0], ['1', { segments: [{ id: 'body', text: '新家', writable: false }], expectedEntry: stableJson(data.entries[0]) }, 'owner-a']);
  nodes = flatten(view.node); nodes.find(node => node.textContent === '恢复建档原文').fire('click'); await tick();
  assert.ok(confirms[0].body.includes('住所')); assert.deepEqual(calls[1], ['1', { restore: true, expectedEntry: stableJson(data.entries[0]) }, 'owner-a']);
  assert.ok(nodes.some(node => node.tag === 'pre' && node.textContent === '<script>rule</script>'));
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => node.innerHTML === undefined));
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => !node.disabled), '保护只约束 AI，不禁止玩家编辑');
  const excluded = nodes.find(node => node.tag === 'label' && node.children.some(child => child.textContent === '排除此条（动态世界书 AI 不读取、不修改）')).children[0];
  excluded.checked = true; excluded.fire('change'); await tick();
  assert.deepEqual(calls[2], ['1', { excluded: true, expectedEntry: stableJson(data.entries[0]) }, 'owner-a']);
  listener({ phase: 'idle', data: null }); assert.equal(flatten(view.node).some(node => node.tag === 'textarea'), false);
  view.dispose(); assert.equal(listener, null);
});

test('existing history lazily highlights changes once without changing text drafts', () => {
  const data = { chatId: 'owner', book: '书', processed: [], entries: [{
    uid: '1', label: '关系', content: '前女友', original: '新女友', managed: true, kind: 'fact', classification: 'ready',
    segments: [{ id: 'body', text: '前女友', writable: true }],
    history: [{ at: '2026-10-16T10:00:00.000Z', kind: 'model', reason: '确认分手', floors: [2], before: '新女友', after: '前女友' }],
  }] };
  const runtime = { getState: () => ({ phase: 'idle', data }), subscribe: () => () => {} };
  const view = createDynamicWorldbookView({ runtime, documentRef: { createElement: tag => new Node(tag) } });
  const nodes = flatten(view.node), editor = nodes.find(n => n.tag === 'textarea'); editor.value = '未保存的草稿';
  const record = nodes.find(n => n.tag === 'details' && n.children[0]?.textContent.includes('自动更新'));
  assert.equal(nodes.some(n => n.tag === 'del'), false);
  record.open = true; record.fire('toggle');
  assert.ok(flatten(record).some(n => n.tag === 'del' && n.textContent === '新'));
  assert.ok(flatten(record).some(n => n.tag === 'ins' && n.textContent === '前'));
  record.open = false; record.fire('toggle'); record.open = true; record.fire('toggle');
  assert.equal(flatten(record).filter(n => n.tag === 'del').length, 1);
  assert.equal(editor.value, '未保存的草稿');
  view.dispose();
});

test('excluded and source-disabled pending rows show no classification action and keep manual editing available', () => {
  const data = { chatId: 'owner-a', book: '书', processed: [], entries: [
    { uid: '1', label: '状态栏', content: '状态', original: '状态', managed: true, excluded: true, classification: 'pending', kind: 'fact', segments: [{ id: 'body', text: '状态', writable: false }], history: [] },
    { uid: '2', label: '关闭条目', content: '关闭', original: '关闭', managed: false, sourceDisabled: true, classification: 'pending', kind: 'fact', segments: [{ id: 'body', text: '关闭', writable: false }], history: [] },
  ], interval: 3 };
  let classified = 0;
  const runtime = { getState: () => ({ phase: 'idle', data }), subscribe: () => () => {}, classify: () => { classified++; } };
  const view = createDynamicWorldbookView({ runtime, documentRef: { createElement: tag => new Node(tag) } });
  const nodes = flatten(view.node);
  assert.equal(nodes.some(node => node.textContent === '继续分类维护权限'), false);
  assert.ok(nodes.some(node => node.textContent === '状态栏 · 已排除'));
  assert.ok(nodes.some(node => node.textContent === '关闭条目 · 原书已禁用'));
  for (const button of nodes.filter(node => node.textContent === '重新分类此条')) { assert.equal(button.disabled, true); button.fire('click'); }
  assert.equal(classified, 0);
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => !node.disabled));
  view.dispose();
});

const entry = (uid, patch = {}) => ({ uid, label: `条目${uid}`, original: '原文', content: '原文', managed: true, locked: false,
  excluded: false, sourceDisabled: false, kind: 'fact', classification: 'ready', protectedReason: '', history: [],
  segments: [{ id: 'body', text: '原文', writable: true }], ...patch });
function viewHarness(entries, options = {}) {
  let listener, calls = [];
  let state = { phase: 'idle', data: { chatId: 'chat-a', book: '书', processed: [], entries, interval: 5, enabled: true }, sourceStatus: options.sourceStatus };
  const runtime = { getState: () => state, subscribe(fn) { listener = fn; return () => {}; },
    refresh: async () => {}, bulkEdit: async (...args) => { calls.push(['bulk', ...args]); await options.bulk?.(...args); },
    syncSource: async (...args) => calls.push(['sync', ...args]), resolveSource: async (...args) => calls.push(['resolve', ...args]) };
  const view = createDynamicWorldbookView({ runtime, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: options.confirmImpl ?? (async () => true) });
  return { view, calls, setState(value) { state = value; listener(state); }, getState: () => state,
    nodes: () => flatten(view.node), find(label) { return flatten(view.node).find(node => node.textContent === label); },
    control(label) { return flatten(view.node).find(node => node['aria-label'] === label); },
    rows: () => flatten(view.node).filter(node => node['data-worldbook-uid']),
    visible: () => flatten(view.node).filter(node => node['data-worldbook-uid'] && !node.hidden).map(node => node['data-worldbook-uid']) };
}

test('combined filters and search select only visible rows, keep view position and send exact expected versions', async () => {
  const entries = [entry('1', { label: '居所', content: '新家', segments: [{ id: 'body', text: '新家', writable: true }] }),
    entry('2', { label: '关闭居所', sourceDisabled: true }), entry('3', { label: '排除居所', excluded: true }),
    entry('4', { kind: 'rule', segments: [{ id: 'body', text: '原文', writable: false }] }),
    entry('5', { sourceConflict: { base: '原文', incoming: '新版', deleted: false } }),
    entry('6', { classification: 'pending', segments: [{ id: 'body', text: '原文', writable: false }] })];
  const h = viewHarness(entries);
  h.rows()[0].open = true; h.view.node.scrollTop = 240;
  const editor = h.nodes().find(node => node.tag === 'textarea'); editor.value = '尚未保存';
  h.find('选择筛选结果').fire('click');
  assert.equal(h.nodes().includes(editor), true, '选择不重建正文编辑器');
  assert.equal(h.find('允许所选自动维护').disabled, true, '规则、禁用和冲突不能批量放开');
  const filter = h.control('筛选动态世界书条目'); filter.value = 'updatable'; filter.fire('change');
  assert.deepEqual(h.visible(), ['1']);
  assert.equal(h.find('允许所选自动维护').disabled, false);
  assert.equal(h.nodes().includes(editor), true); assert.equal(editor.value, '尚未保存');
  const search = h.control('搜索动态世界书条目'); search.value = '居所'; search.fire('input');
  h.find('保护所选正文').fire('click'); await tick();
  assert.deepEqual(h.calls, [['bulk', ['1'], { writable: false }, 'chat-a', { '1': stableJson(entries[0]) }]]);
  assert.equal(h.control('筛选动态世界书条目').value, 'updatable');
  assert.equal(h.control('搜索动态世界书条目').value, '居所');
  assert.equal(h.rows()[0].open, true); assert.equal(h.view.node.scrollTop, 240);
  h.control('筛选动态世界书条目').value = 'all'; h.control('筛选动态世界书条目').fire('change');
  h.find('排除所选').fire('click'); await tick();
  assert.deepEqual(h.calls[1][1], ['1'], '被筛走的选择不会在换回筛选后重新加入批量操作');
  h.view.dispose();
});

test('disabled hiding combines with status filter and cannot leave hidden entries selected', async () => {
  const h = viewHarness([entry('1', { sourceDisabled: true }), entry('2', { excluded: true }), entry('3')]);
  h.find('选择筛选结果').fire('click');
  const hidden = h.nodes().find(node => node.tag === 'label' && node.children.some(child => child.textContent === '隐藏原书已禁用条目')).children[0];
  hidden.checked = true; hidden.fire('change');
  assert.deepEqual(h.visible(), ['2', '3']);
  h.find('排除所选').fire('click'); await tick();
  assert.deepEqual(h.calls[0][1], ['2', '3']);
  const filter = h.control('筛选动态世界书条目'); filter.value = 'sourceDisabled'; filter.fire('change');
  assert.deepEqual(h.visible(), []); assert.equal(h.find('选择筛选结果').disabled, true); assert.equal(h.find('排除所选').disabled, true);
  assert.ok(h.nodes().some(node => node.textContent.includes('显示 0 / 3 条')));
  h.view.dispose();
});

test('source conflicts show lazy differences and explicit versioned decisions, deletion keeps an archive only', async () => {
  let confirms = [];
  const changed = entry('1', { label: '住所', original: '作者新版', content: '玩家新家', sourceMetadata: {},
    segments: [{ id: 'body', text: '玩家新家', writable: true }], sourceConflict: { base: '作者旧版', incoming: '作者新版', deleted: false } });
  const deleted = entry('2', { sourceMissing: true, sourceDisabled: true, sourceConflict: { base: '原文', incoming: null, deleted: true } });
  const h = viewHarness([changed, deleted], { sourceStatus: { needsSync: true, legacy: false, added: ['3'], updated: ['1'], removed: ['2'], conflicts: ['1', '2'] },
    confirmImpl: async value => { confirms.push(value); return true; } });
  assert.ok(h.nodes().some(node => node.textContent.includes('新增 1 条 · 变化 1 条 · 移除 1 条')));
  h.find('同步原书变化').fire('click'); await tick(); assert.deepEqual(h.calls[0], ['sync', { expectedChatId: 'chat-a' }]);
  let row = h.rows()[0];
  const comparison = flatten(row).find(node => node.tag === 'details' && node.children[0]?.textContent === '当前副本 → 新版原文');
  assert.equal(flatten(comparison).some(node => node.tag === 'del'), false);
  comparison.open = true; comparison.fire('toggle');
  assert.ok(flatten(comparison).some(node => node.tag === 'del')); assert.ok(flatten(comparison).some(node => node.tag === 'ins'));
  h.find('保留当前剧情副本').fire('click'); await tick();
  assert.deepEqual(h.calls[1], ['resolve', '1', { choice: 'keep', expectedEntry: stableJson(changed) }, 'chat-a']);
  h.find('采用新版原文').fire('click'); await tick();
  assert.equal(confirms.length, 1); assert.ok(confirms[0].body.includes('住所'));
  assert.deepEqual(h.calls[2], ['resolve', '1', { choice: 'source', expectedEntry: stableJson(changed) }, 'chat-a']);
  assert.equal(flatten(h.rows()[1]).some(node => node.textContent === '采用新版原文'), false);
  h.find('保留副本存档').fire('click'); await tick(); assert.deepEqual(h.calls[3], ['resolve', '2', { choice: 'keep', expectedEntry: stableJson(deleted) }, 'chat-a']);
  assert.ok(h.nodes().some(node => node.textContent === '最近同步的原文'));
  h.view.dispose();
});

test('a switched source book requires explicit confirmation and a switched chat clears old selections', async () => {
  const entries = [entry('1')], h = viewHarness(entries, { sourceStatus: { needsSync: true, bookChanged: true, bookName: '新书', added: [], updated: ['1'], removed: [] }, confirmImpl: async () => false });
  h.find('同步原书变化').fire('click'); await tick(); assert.equal(h.calls.length, 0);
  h.find('选择筛选结果').fire('click');
  h.control('搜索动态世界书条目').value = '条目'; h.control('搜索动态世界书条目').fire('input');
  h.setState({ phase: 'idle', data: { ...h.getState().data, chatId: 'chat-b' } });
  assert.equal(h.control('搜索动态世界书条目').value, ''); assert.equal(h.find('排除所选').disabled, true);
  h.view.dispose();
});

test('bulk changes retain unrelated dirty text and permissions; changed rows keep a separate unsaved draft', async () => {
  let h;
  const original = [entry('1', { label: '正在编辑' }), entry('2', { label: '批量目标' })];
  h = viewHarness(original, { bulk: async uids => {
    const state = h.getState();
    h.setState({ ...state, data: { ...state.data, entries: state.data.entries.map(item => uids.includes(item.uid)
      ? { ...item, classification: 'manual', segments: item.segments.map(segment => ({ ...segment, writable: false })) } : item) } });
  } });
  const editor = h.control('正在编辑 body 正文'); editor.value = '玩家还没保存的新正文';
  const protection = flatten(h.rows()[0]).find(node => node.tag === 'label' && node.children.some(child => child.textContent === '保护此片段（AI 不修改）')).children[0];
  protection.checked = true; protection.fire('change');
  const target = h.control('选择条目：批量目标'); target.checked = true; target.fire('change');
  h.find('保护所选正文').fire('click'); await tick();
  assert.equal(h.control('正在编辑 body 正文').value, '玩家还没保存的新正文');
  assert.equal(flatten(h.rows()[0]).find(node => node.tag === 'label' && node.children.some(child => child.textContent === '保护此片段（AI 不修改）')).children[0].checked, true);
  assert.equal(h.nodes().some(node => node.textContent === '未保存草稿（来自更新前的资料）'), false);
  h.find('取消选择').fire('click');
  const first = h.control('选择条目：正在编辑'); first.checked = true; first.fire('change');
  h.find('保护所选正文').fire('click'); await tick();
  assert.equal(h.control('正在编辑 body 正文').value, '原文', '已改变条目使用最新保存值，不把旧草稿强加到新版本');
  const previous = h.control('正在编辑 未保存草稿');
  assert.equal(previous.value, '玩家还没保存的新正文'); assert.equal(previous.readOnly, true);
  h.find('刷新状态').fire('click'); await tick();
  assert.equal(h.control('正在编辑 未保存草稿').value, '玩家还没保存的新正文', '旧草稿在再次刷新后仍保留');
  h.view.dispose();
});
