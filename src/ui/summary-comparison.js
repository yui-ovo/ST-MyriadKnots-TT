import { worldbookTextDiff } from './worldbook-text-diff.js';

export function summaryComparisonTarget(state, floorId) {
  const floor = state?.floors?.find(item => item.floorId === floorId);
  if (!state?.chatId || !floor?.memoryId || floor.status !== 'ready' || floor.frozen
    || floor.summarySource !== 'user' || !floor.aiSummary?.trim()) return null;
  return Object.freeze({ chatId: state.chatId, floorId, memoryId: floor.memoryId,
    messageIndex: floor.messageIndex, manualText: floor.summary, aiText: floor.aiSummary });
}

export function comparisonAfterExtraction(before, result, current, floorId) {
  const target = summaryComparisonTarget(result, result?.extractionFloorId ?? floorId);
  const previous = before?.floors?.find(item => item.floorId === floorId);
  const live = target && summaryComparisonTarget(current, target.floorId);
  return target && before?.chatId === target.chatId && previous?.memoryId !== target.memoryId
    && live?.chatId === target.chatId && live.memoryId === target.memoryId ? target : null;
}

export async function showSummaryComparison({ runtime, target, customImpl, documentRef = globalThis.document,
  isCurrent = () => true } = {}) {
  if (!target || typeof customImpl !== 'function' || typeof runtime.restoreAi !== 'function') return null;
  const matches = () => {
    const live = summaryComparisonTarget(runtime.getState(), target.floorId);
    return isCurrent() && live?.chatId === target.chatId && live.memoryId === target.memoryId;
  };
  if (!matches()) return null;
  const el = (tag, text, className = '') => {
    const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const content = el('div', '', 'qqj-editor-dialog qqj-summary-comparison');
  const identical = target.manualText === target.aiText;
  content.append(el('p', '当前仍使用人工版。采用 AI 新版后，本楼摘要会切换为 AI 版；保留或关闭窗口不改变当前摘要。'));
  content.append(el('p', identical ? '两版文字相同，采用 AI 新版只会切换摘要来源。'
    : '红色删除线：人工版独有的文字；绿色下划线：AI 新版独有的文字。'));
  const parts = worldbookTextDiff(target.manualText, target.aiText);
  for (const [title, excluded, changed] of [['人工版 · 当前使用', 'insert', 'delete'], ['AI 新版 · 最近提取', 'delete', 'insert']]) {
    const pane = el('div', '', 'qqj-summary-comparison-text'); pane.setAttribute('aria-label', title);
    for (const part of parts) if (part.kind !== excluded) pane.append(el(part.kind === changed
      ? changed === 'delete' ? 'del' : 'ins' : 'span', part.text));
    content.append(el('h3', title), pane);
  }
  return customImpl({ title: `第 ${target.messageIndex} 楼 · 摘要对比`, content,
    confirmText: '采用 AI 新版', cancelText: '保留人工版',
    async submit() {
      if (!matches()) throw Object.assign(new Error('这份摘要或当前聊天已变化，请关闭窗口后重新对比。'), { code: 'V3_MEMORY_SUMMARY_STALE' });
      await runtime.restoreAi(target.floorId, { expectedMemory: { chatId: target.chatId, memoryId: target.memoryId } });
      return 'adopted';
    },
  });
}
