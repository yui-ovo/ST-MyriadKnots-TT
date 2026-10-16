import test from 'node:test';
import assert from 'node:assert/strict';
import { worldbookTextDiff, createWorldbookDiffView } from '../src/ui/worldbook-text-diff.js';

const reconstruct = (parts, exclude) => parts.filter(p => p.kind !== exclude).map(p => p.text).join('');
test('Chinese field edits highlight changed characters and preserve other lines', () => {
  const before = '姓名：小雨\n关系：新女友\n职业：模特\n住所：旧家\n';
  const after = '姓名：小雨\n关系：前女友\n职业：模特\n住所：新家\n';
  const parts = worldbookTextDiff(before, after);
  assert.equal(reconstruct(parts, 'insert'), before);
  assert.equal(reconstruct(parts, 'delete'), after);
  assert.equal(parts.filter(p => p.kind === 'delete').map(p => p.text).join(''), '新旧');
  assert.equal(parts.filter(p => p.kind === 'insert').map(p => p.text).join(''), '前新');
});

test('insertions, removals, emoji, repeated fields and CRLF round-trip without losing text', () => {
  for (const [before, after] of [
    ['', '整段新增\n'], ['整段删除\n', ''], ['相同', '相同'], ['', ''],
    ['甲\r\n😀关系：朋友\r\n乙\r\n关系：朋友', '甲\r\n😀关系：恋人\r\n乙\r\n关系：朋友'],
    ['a\nb\na\nb\n', 'a\na\nb\nb\n'],
  ]) {
    const parts = worldbookTextDiff(before, after);
    assert.equal(reconstruct(parts, 'insert'), before); assert.equal(reconstruct(parts, 'delete'), after);
  }
});

test('large unrelated records use bounded fallback without truncating the comparison', () => {
  const before = '前缀\n' + '旧'.repeat(40000) + '\n后缀';
  const after = '前缀\n' + '新'.repeat(40000) + '\n后缀';
  const parts = worldbookTextDiff(before, after);
  assert.equal(reconstruct(parts, 'insert'), before); assert.equal(reconstruct(parts, 'delete'), after);
  assert.equal(parts.length, 4);
});

test('diff renders untrusted text safely and labels both panes with semantic del/ins', () => {
  const documentRef = { createElement(tag) { return { tag, children: [], append(...nodes) { this.children.push(...nodes); }, setAttribute(key, value) { this[key] = value; } }; } };
  const before = '<script>旧</script>', after = '<script>新</script>';
  const node = createWorldbookDiffView(before, after, documentRef);
  const panes = node.children.filter(n => n.tag === 'pre');
  assert.equal(panes.length, 2);
  assert.equal(panes[0]['aria-label'], '修改前'); assert.equal(panes[1]['aria-label'], '修改后');
  assert.equal(panes[0].children.map(n => n.textContent).join(''), before);
  assert.equal(panes[1].children.map(n => n.textContent).join(''), after);
  assert.ok(panes[0].children.some(n => n.tag === 'del' && n.textContent === '旧'));
  assert.ok(panes[1].children.some(n => n.tag === 'ins' && n.textContent === '新'));
  assert.ok(panes.every(p => p.children.every(n => n.innerHTML === undefined)));
});
