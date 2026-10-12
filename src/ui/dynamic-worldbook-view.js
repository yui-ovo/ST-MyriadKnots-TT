import { createSettingsDrawer } from './settings-drawer.js';

export function createDynamicWorldbookView({ runtime, documentRef = globalThis.document, confirmImpl = async () => false, open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '动态世界书 · 自用试验', level: 'group', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), content = el('div');
  body.append(el('p', '只接管当前聊天的主世界书普通资料。先建立副本，再逐条勾选参与；原书、脚本和变量保留。使用摘要 API 更新、召回 API 选材，会增加调用。', 'settings-hint'), status, content);
  let disposed = false, rendering = false, owner = null;
  const states = { idle: '空闲', loading: '读取中', saving: '保存中', updating: '更新资料中', selecting: '本轮选材中' };
  function updateStatus(state) { status.textContent = state.error || states[state.phase] || state.phase; }
  async function action(callback) {
    try { await callback(); if (!disposed) render(runtime.getState()); }
    catch (error) { if (!disposed) status.textContent = error.message; }
  }
  function button(label, callback) { const node = el('button', label, 'secondary-action'); node.type = 'button'; node.addEventListener('click', () => void action(callback)); return node; }
  function checkbox(label, value, callback, disabled = false) {
    const wrapper = el('label', '', 'setting-switch'), input = el('input'); input.type = 'checkbox'; input.checked = value; input.disabled = disabled;
    input.addEventListener('change', () => void action(async () => { try { await callback(input.checked); } catch (error) { input.checked = value; throw error; } }));
    wrapper.append(input, el('span', label)); return wrapper;
  }
  function render(state) {
    if (disposed || rendering) return;
    rendering = true; updateStatus(state); content.replaceChildren();
    const data = state.data; owner = data?.chatId ?? null;
    const tools = el('div', '', 'settings-actions');
    tools.append(button('刷新状态', () => runtime.refresh()), button('停止', async () => runtime.abortAll()));
    tools.append(button(data ? '重新建立副本' : '建立世界书副本', async () => {
      if (data && !await confirmImpl({ title: '重新建立动态世界书副本', body: '将清除当前聊天的动态资料修改、锁定与记录，重新读取原世界书。原世界书和千千结记忆保留。是否继续？' })) return;
      await runtime.initialize({ expectedChatId: data?.chatId ?? null });
    }));
    content.append(tools);
    if (!data) { content.append(el('p', '尚未建立副本。建立后，请只勾选希望随剧情更新的普通资料条目。', 'settings-hint')); rendering = false; return; }
    content.append(el('p', `${data.book} · 已核对至第 ${data.processed.length ? data.processed.length - 1 : '—'} 楼`, 'settings-hint'));
    content.append(checkbox('在当前聊天启用动态世界书', data.enabled, value => runtime.configure({ enabled: value }, data.chatId)));
    content.append(checkbox('记忆任务空闲后自动更新', data.automatic, value => runtime.configure({ automatic: value }, data.chatId)));
    const intervalLabel = el('label', '每几个已记忆 AI 回复更新一次：'), interval = el('input', '', 'settings-input');
    interval.type = 'number'; interval.min = '1'; interval.max = '20'; interval.value = String(data.interval);
    intervalLabel.append(interval, button('保存间隔', () => runtime.configure({ interval: Number(interval.value) }, data.chatId)));
    content.append(intervalLabel, button('立即更新一批（最多 3 楼）', () => runtime.update({ manual: true })));
    content.append(el('p', '手改或恢复原文后会自动锁定，解锁后才会继续自动更新。记录保留每条最近 50 次修改。重开分支需单独建立副本。', 'settings-hint'));
    if (state.lastSelection) {
      const names = state.lastSelection.selected.map(uid => data.entries.find(e => e.uid === uid)?.label ?? uid);
      content.append(el('p', `${state.lastSelection.status}${names.length ? `：${names.join('、')}` : ''}`, 'settings-hint'));
    }
    const search = el('input', '', 'settings-input'); search.type = 'search'; search.placeholder = '搜索条目'; search.setAttribute('aria-label', '搜索动态世界书条目');
    content.append(search);
    const rows = [];
    for (const entry of data.entries) {
      const details = el('details', '', 'settings-sub'), summary = el('summary', `${entry.label}${entry.protectedReason ? ' · 受保护' : entry.managed ? ' · 已接管' : ' · 原生'}${entry.locked ? ' · 已锁定' : ''}`, 'settings-sub-summary');
      const area = el('div', '', 'settings-sub-body'); details.append(summary, area);
      if (entry.protectedReason) area.append(el('p', entry.protectedReason, 'settings-hint'));
      area.append(checkbox('参与动态更新与选材', entry.managed, value => runtime.edit(entry.uid, { managed: value }, data.chatId), !!entry.protectedReason));
      area.append(checkbox('锁定当前正文（仍可选材）', entry.locked, value => runtime.edit(entry.uid, { locked: value }, data.chatId), !!entry.protectedReason));
      const original = el('pre', entry.original, 'dynamic-worldbook-original'); original.style.whiteSpace = 'pre-wrap'; original.style.overflowWrap = 'anywhere';
      const originalDrawer = el('details'); originalDrawer.append(el('summary', '建档时原文'), original); area.append(originalDrawer);
      const textarea = el('textarea', '', 'settings-input'); textarea.rows = 7; textarea.value = entry.content; textarea.disabled = !!entry.protectedReason;
      textarea.setAttribute('aria-label', `${entry.label} 当前正文`); textarea.style.width = '100%'; textarea.style.boxSizing = 'border-box';
      area.append(el('p', '当前正文'), textarea);
      if (!entry.protectedReason) area.append(button('保存正文并锁定', () => runtime.edit(entry.uid, { content: textarea.value }, data.chatId)), button('恢复原文并锁定', async () => {
        if (await confirmImpl({ title: '恢复条目原文', body: `将“${entry.label}”恢复为建立副本时的正文，并锁定该条目。` })) await runtime.edit(entry.uid, { restore: true }, data.chatId);
      }));
      const history = el('details'); history.append(el('summary', `修改记录（${entry.history.length}）`));
      for (const change of [...entry.history].reverse()) {
        const record = el('details'); record.append(el('summary', `${change.at.slice(0, 19).replace('T', ' ')} · ${{ model: '自动更新', manual: '手动修改', restore: '恢复原文' }[change.kind]}`));
        record.append(el('p', `${change.reason}${change.floors.length ? ` · 来源第 ${change.floors.join('、')} 楼` : ''}`));
        const diff = el('pre', `修改前：\n${change.before}\n\n修改后：\n${change.after}`); diff.style.whiteSpace = 'pre-wrap'; diff.style.overflowWrap = 'anywhere'; record.append(diff); history.append(record);
      }
      area.append(history); content.append(details); rows.push({ details, text: `${entry.label}\n${entry.content}`.toLowerCase() });
    }
    search.addEventListener('input', () => { const query = search.value.toLowerCase(); for (const row of rows) row.details.hidden = !row.text.includes(query); });
    rendering = false;
  }
  const unsubscribe = runtime.subscribe(state => {
    updateStatus(state);
    // Preserve text drafts during background progress. A changed owner must never keep another chat's editor.
    if (owner && state.data?.chatId !== owner) render(state);
  });
  drawer.addEventListener('toggle', () => { if (drawer.open) void action(() => runtime.refresh()); });
  render(runtime.getState());
  if (open) void action(() => runtime.refresh());
  return { node: drawer, dispose() { disposed = true; unsubscribe(); } };
}

