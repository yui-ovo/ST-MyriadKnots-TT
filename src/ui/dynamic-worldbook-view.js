import { createSettingsDrawer } from './settings-drawer.js';
import { stableJson } from '../dynamic-worldbook.js';

export function createDynamicWorldbookView({ runtime, documentRef = globalThis.document, confirmImpl = async () => false, open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '动态世界书 · 自用试验', level: 'group', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), content = el('div');
  body.append(el('p', '为当前聊天的主世界书建立副本，自动分类并区分可更新事实与受保护片段。你可以调整维护权限，也可以手动编辑受保护正文；原世界书保留。分类和更新使用摘要 API，选材使用召回 API。', 'settings-hint'), status, content);
  let disposed = false, rendering = false, owner = null;
  const states = { idle: '空闲', loading: '读取中', classifying: '正在分类维护权限，已完成批次会保存', saving: '保存中', updating: '更新资料中', selecting: '本轮选材中' };
  function updateStatus(state) { status.textContent = state.error || states[state.phase] || state.phase; }
  async function action(callback) {
    try { await callback(); if (!disposed) render(runtime.getState()); }
    catch (error) { if (!disposed) { if (!owner && runtime.getState().data) render(runtime.getState()); status.textContent = error.message; } }
  }
  function button(label, callback) { const node = el('button', label, 'secondary-action'); node.type = 'button'; node.addEventListener('click', () => void action(callback)); return node; }
  function checkbox(label, value, callback, disabled = false, draftOnly = false) {
    const wrapper = el('label', '', 'setting-switch'), input = el('input'); input.type = 'checkbox'; input.checked = value; input.disabled = disabled;
    input.addEventListener('change', () => { if (draftOnly) { callback(input.checked); return; } void action(async () => { try { await callback(input.checked); } catch (error) { input.checked = value; throw error; } }); });
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
    if (!data) { content.append(el('p', '尚未建立副本。建立时会自动分类，普通事实可随剧情更新，规则正文保留。', 'settings-hint')); rendering = false; return; }
    const pending = data.entries.filter(e => e.classification === 'pending').length;
    if (pending) content.append(el('p', `${pending} 条尚待分类。旧版正文、开关和修改记录已保留，无需重建副本。`, 'settings-hint'), button('继续分类维护权限', () => runtime.classify({ expectedChatId: data.chatId })));
    content.append(el('p', `${data.book} · 已核对至第 ${data.processed.length ? data.processed.length - 1 : '—'} 楼`, 'settings-hint'));
    content.append(checkbox('在当前聊天启用动态世界书', data.enabled, value => runtime.configure({ enabled: value }, data.chatId)));
    content.append(checkbox('记忆任务空闲后自动更新', data.automatic, value => runtime.configure({ automatic: value }, data.chatId)));
    const intervalLabel = el('label', '每几个已记忆 AI 回复更新一次：'), interval = el('input', '', 'settings-input');
    interval.type = 'number'; interval.min = '1'; interval.max = '20'; interval.value = String(data.interval);
    intervalLabel.append(interval, button('保存间隔', () => runtime.configure({ interval: Number(interval.value) }, data.chatId)));
    content.append(intervalLabel, button('立即更新一批（最多 3 楼）', () => runtime.update({ manual: true })));
    content.append(el('p', '“保护”只限制 AI 自动改写，不限制手动编辑。特殊触发条件仍由酒馆处理。手动保存保留你设置的权限；恢复原文后需重新核对权限。记录保留每条最近 50 次修改。', 'settings-hint'));
    if (state.lastSelection) {
      const names = state.lastSelection.selected.map(uid => data.entries.find(e => e.uid === uid)?.label ?? uid);
      content.append(el('p', `${state.lastSelection.status}${names.length ? `：${names.join('、')}` : ''}`, 'settings-hint'));
    }
    const search = el('input', '', 'settings-input'); search.type = 'search'; search.placeholder = '搜索条目'; search.setAttribute('aria-label', '搜索动态世界书条目');
    content.append(search);
    const rows = [];
    for (const entry of data.entries) {
      const writable = !entry.locked && entry.segments.some(s => s.writable), mixed = writable && entry.segments.some(s => !s.writable);
      const details = el('details', '', 'settings-sub'), summary = el('summary', `${entry.label} · ${!entry.managed ? '原生' : mixed ? '部分可更新' : writable ? '可更新' : '正文受保护'}${entry.classification === 'review' ? ' · 待核对' : entry.classification === 'pending' ? ' · 待分类' : ''}`, 'settings-sub-summary');
      const area = el('div', '', 'settings-sub-body'); details.append(summary, area);
      const edit = patch => runtime.edit(entry.uid, { ...patch, expectedEntry: stableJson(entry) }, data.chatId);
      if (entry.protectedReason) area.append(el('p', entry.protectedReason, 'settings-hint'));
      area.append(checkbox('使用当前聊天的动态副本', entry.managed, value => edit({ managed: value })));
      if (entry.locked) area.append(checkbox('旧版锁定（取消后按片段权限维护）', entry.locked, value => edit({ locked: value })));
      if (entry.kind === 'rule') area.append(el('p', '规则类条目不交给 AI 自动维护，仍可在下方手动修改副本正文。', 'settings-hint'));
      else area.append(button('允许全部正文自动维护', () => edit({ writable: true })));
      area.append(button('保护全部正文', () => edit({ writable: false })));
      area.append(button('重新分类此条', () => runtime.classify({ uid: entry.uid, expectedEntry: stableJson(entry), expectedChatId: data.chatId })));
      const original = el('pre', entry.original, 'dynamic-worldbook-original'); original.style.whiteSpace = 'pre-wrap'; original.style.overflowWrap = 'anywhere';
      const originalDrawer = el('details'); originalDrawer.append(el('summary', '建档时原文'), original); area.append(originalDrawer);
      const drafts = entry.segments.map(segment => {
        const draft = { ...segment };
        area.append(el('p', `正文片段：${segment.id}`));
        area.append(checkbox('保护此片段（AI 不修改）', !segment.writable, value => { draft.writable = !value; }, entry.kind === 'rule', true));
        const textarea = el('textarea', '', 'settings-input'); textarea.rows = 7; textarea.value = segment.text;
        textarea.setAttribute('aria-label', `${entry.label} ${segment.id} 正文`); textarea.style.width = '100%'; textarea.style.boxSizing = 'border-box';
        area.append(textarea); return { draft, textarea };
      });
      area.append(el('p', '片段正文与勾选权限一起保存；上方整条权限按钮使用已保存正文，不保存下方草稿。', 'settings-hint'));
      area.append(button('保存正文与权限', () => edit({ segments: drafts.map(({ draft, textarea }) => ({ ...draft, text: textarea.value })) })), button('恢复建档原文', async () => {
        if (await confirmImpl({ title: '恢复条目原文', body: `将“${entry.label}”恢复为建立副本时的正文，暂时保护并等待重新分类。` })) await edit({ restore: true });
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

