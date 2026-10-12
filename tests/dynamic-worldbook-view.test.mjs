import test from 'node:test';
import assert from 'node:assert/strict';
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
    { uid: '1', label: '住所', content: '旧家', original: '原文', managed: false, locked: false, protectedReason: '', history: [] },
    { uid: '2', label: 'MVU', content: '<script>rule</script>', original: '<script>rule</script>', managed: false, locked: false, protectedReason: '变量', history: [] },
  ], interval: 3 };
  const runtime = { getState: () => ({ phase: 'idle', data }), subscribe(fn) { listener = fn; return () => { listener = null; }; },
    refresh: async () => {}, edit: async (...args) => { calls.push(args); }, configure: async (...args) => { calls.push(args); }, initialize: async () => {}, abortAll() {} };
  const view = createDynamicWorldbookView({ runtime, documentRef: { createElement: tag => new Node(tag) }, confirmImpl: async options => { confirms.push(options); return true; } });
  let nodes = flatten(view.node);
  const editor = nodes.find(node => node.tag === 'textarea' && !node.disabled); editor.value = '新家';
  nodes.find(node => node.textContent === '保存正文并锁定').fire('click'); await tick();
  assert.deepEqual(calls[0], ['1', { content: '新家' }, 'owner-a']);
  nodes = flatten(view.node); nodes.find(node => node.textContent === '恢复原文并锁定').fire('click'); await tick();
  assert.ok(confirms[0].body.includes('住所')); assert.deepEqual(calls[1], ['1', { restore: true }, 'owner-a']);
  assert.ok(nodes.some(node => node.tag === 'pre' && node.textContent === '<script>rule</script>'));
  assert.ok(nodes.filter(node => node.tag === 'textarea').every(node => node.innerHTML === undefined));
  listener({ phase: 'idle', data: null }); assert.equal(flatten(view.node).some(node => node.tag === 'textarea'), false);
  view.dispose(); assert.equal(listener, null);
});
