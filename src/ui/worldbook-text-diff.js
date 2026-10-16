// Line alignment first, then character alignment inside changed blocks. Limit
// matrix work for long imported records; the fallback still preserves all text.
export function worldbookTextDiff(before, after) {
  const budget = { cells: 1000000 };
  const sequence = (left, right) => {
    let start = 0, leftEnd = left.length, rightEnd = right.length;
    while (start < leftEnd && start < rightEnd && left[start] === right[start]) start++;
    while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
    const out = [];
    const push = (kind, text) => { if (text) out.push({ kind, text }); };
    push('equal', left.slice(0, start).join(''));
    const a = left.slice(start, leftEnd), b = right.slice(start, rightEnd);
    const size = (a.length + 1) * (b.length + 1);
    if (!a.length || !b.length || size > budget.cells) {
      push('delete', a.join('')); push('insert', b.join(''));
    } else {
      budget.cells -= size;
      const width = b.length + 1, lengths = new Uint32Array(size);
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] = a[i] === b[j] ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
      let i = 0, j = 0;
      while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { push('equal', a[i++]); j++; }
        else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) push('delete', a[i++]);
        else push('insert', b[j++]);
      }
    }
    push('equal', left.slice(leftEnd).join(''));
    return out;
  };
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const aligned = sequence(lines(before), lines(after)), result = [];
  const append = part => {
    if (result.at(-1)?.kind === part.kind) result.at(-1).text += part.text;
    else result.push({ ...part });
  };
  for (let i = 0; i < aligned.length;) {
    if (aligned[i].kind === 'equal') { append(aligned[i++]); continue; }
    let removed = '', added = '';
    while (i < aligned.length && aligned[i].kind !== 'equal') {
      const part = aligned[i++];
      if (part.kind === 'delete') removed += part.text; else added += part.text;
    }
    for (const part of sequence(Array.from(removed), Array.from(added))) append(part);
  }
  return result;
}

export function createWorldbookDiffView(before, after, documentRef = globalThis.document) {
  const el = (tag, text, className = '') => {
    const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const root = el('div', '', 'qqj-worldbook-diff');
  if (before === after) { root.append(el('p', '正文未变化（仅权限或其他设置调整）', 'settings-hint')); return root; }
  root.append(el('p', '红色删除线＝移除的文字；绿色下划线＝新增的文字。未高亮部分保持不变。', 'settings-hint'));
  const parts = worldbookTextDiff(before, after);
  for (const [title, excluded, changed] of [['修改前', 'insert', 'delete'], ['修改后', 'delete', 'insert']]) {
    const pane = el('pre', '', 'qqj-worldbook-diff-text'); pane.setAttribute('aria-label', title);
    for (const part of parts) if (part.kind !== excluded) {
      pane.append(el(part.kind === changed ? (changed === 'delete' ? 'del' : 'ins') : 'span', part.text));
    }
    root.append(el('strong', title), pane);
  }
  return root;
}
