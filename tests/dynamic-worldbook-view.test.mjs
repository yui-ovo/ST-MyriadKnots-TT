import test from 'node:test';
import assert from 'node:assert/strict';
import { stableJson } from '../src/dynamic-worldbook.js';
import { createDynamicWorldbookView } from '../src/ui/dynamic-worldbook-view.js';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.style = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, callback) { this.events[key] = callback; }
  fire(key) { this.events[key]?.(); }
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
  nodes.find(node => node.textContent === '保存正文与权限').fire('click'); await tick();
  assert.deepEqual(calls[0], ['1', { segments: [{ id: 'body', text: '新家', writable: false }], expectedEntry: stableJson(data.entries[0]) }, 'owner-a']);
  nodes = flatten(view.node); nodes.find(node => node.textContent === '恢复建档原文').fire('click'); await tick();
  assert.ok(confirms[0].body.includes('住所')); assert.deepEqual(calls[1], ['1', { restore: true, expectedEntry: stableJson(data.entries[0]) }, 'owner-a']);
  assert.ok(nodes.some(node => node.tag === 'pre' && node.textContent === '<script>rule</script>'));
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => node.innerHTML === undefined));
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => !node.disabled), '保护只约束 AI，不禁止玩家编辑');
  listener({ phase: 'idle', data: null }); assert.equal(flatten(view.node).some(node => node.tag === 'textarea'), false);
  view.dispose(); assert.equal(listener, null);
});
