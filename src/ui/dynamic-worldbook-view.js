import { createSettingsDrawer } from './settings-drawer.js';
import { canReadEntry, stableJson } from '../dynamic-worldbook.js';
import { createWorldbookDiffView } from './worldbook-text-diff.js';

export function createDynamicWorldbookView({ runtime, settings = null, documentRef = globalThis.document, confirmImpl = async () => false, open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '动态世界书 · 自用试验', level: 'group', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), content = el('div');
  body.append(el('p', '先建立本地副本，排除不想让动态世界书 AI 读取的条目，再点击继续分类。原书已禁用的条目自动跳过。分类和更新使用世界书 API（默认跟随分析），选材使用召回 API。原世界书保留。', 'settings-hint'), status, content);
  const receiptBox = el('div', '', 'settings-sub-body'), readiness = el('p', '', 'settings-hint'), receiptText = el('p', '', 'settings-hint');
  receiptBox.append(el('strong', '最近更新回执'), readiness, receiptText);
  const decisionDrawer = el('details'), decisionText = el('p', '', 'settings-hint');
  decisionText.style.whiteSpace = 'pre-wrap';
  decisionDrawer.append(el('summary', '修改、保持现状与待核对理由'), decisionText); receiptBox.append(decisionDrawer);
  receiptText.style.whiteSpace = 'pre-wrap';
  // Separate from editable rows: background progress must never destroy unsaved text.
  let progressLabel = null;
  let disposed = false, rendering = false, owner = null;
  let hideSourceDisabled = settings?.get?.()?.dynamicWorldbookHideSourceDisabled === true;
  const states = { idle: '空闲', loading: '读取中', classifying: '正在分类维护权限，已完成批次会保存', saving: '保存中', updating: '更新资料中', selecting: '本轮选材中' };
  function updateStatus(state) {
    status.textContent = state.error || states[state.phase] || state.phase;
    readiness.textContent = state.updateReadiness || '';
    const receipt = state.lastUpdate ?? state.data?.lastUpdate;
    const progress = state.data ? `${state.data.book} · 已核对至第 ${state.data.processed.length ? state.data.processed.length - 1 : '—'} 楼` : '';
    if (progressLabel) progressLabel.textContent = progress;
    decisionText.textContent = (receipt?.decisions ?? []).map(d => `${{ changed: '修改', unchanged: '保持现状', review: '待核对' }[d.kind]}${d.uid ? `（${state.data?.entries.find(e => e.uid === d.uid)?.label ?? d.uid}）` : ''}：${d.reason}${d.evidenceRefs.length ? `\n依据：${d.evidenceRefs.join('、')}` : ''}`).join('\n\n') || '暂无详细理由。旧版回执不会补算。';
    if (!receipt) { receiptText.textContent = '尚无更新回执。旧版本的调用未记录；未修改正文不代表没有调用。'; return; }
    const result = { running: '正在处理，尚未保存本批结果', updated: `已保存：修改 ${receipt.changedEntries} 个条目`, unchanged: '已调用并完成核对：本批无需修改', failed: '更新失败，本批结果未确认保存', stopped: '任务已停止，本批结果未确认保存' }[receipt.status] || receipt.status;
    receiptText.textContent = [result, `时间：${new Date(receipt.at).toLocaleString()}`,
      `发起调用 ${receipt.calls} 次 · 收到回复 ${receipt.responses} 次（按更新批次计，接口内部重试另计）`,
      receipt.floors.length ? `本批核对：第 ${receipt.floors.join('、')} 楼` : '本批尚未读取楼层',
      receipt.api && (receipt.api.sourceLabel || receipt.api.model) ? `API：${[receipt.api.sourceLabel, receipt.api.model].filter(Boolean).join(' · ')}` : '',
      receipt.materials ? `记忆楼号：${receipt.materials.memoryFloors.join('、')}\n历史背景：${receipt.materials.backgroundFloors.join('、') || '无'}\nCSE：截至第 ${receipt.materials.cseFloor} 楼 · ${receipt.materials.cseSubjects} 人\n未隐藏正文：${receipt.materials.dialogueFloors.join('、') || '无'}` : '',
      receipt.message || '', progress].filter(Boolean).join('\n');
  }
  async function action(callback) {
    try { await callback(); if (!disposed) render(runtime.getState()); }
    catch (error) { if (!disposed) { if (!owner && runtime.getState().data) render(runtime.getState()); status.textContent = error.message; } }
  }
  function button(label, callback, disabled = false) { const node = el('button', label, 'secondary-action'); node.type = 'button'; node.disabled = disabled; node.addEventListener('click', () => { if (!node.disabled) void action(callback); }); return node; }
  function checkbox(label, value, callback, disabled = false, draftOnly = false) {
    const wrapper = el('label', '', 'setting-switch'), input = el('input'); input.type = 'checkbox'; input.checked = value; input.disabled = disabled;
    input.addEventListener('change', () => { if (draftOnly) { callback(input.checked); return; } void action(async () => { try { await callback(input.checked); } catch (error) { input.checked = value; throw error; } }); });
    wrapper.append(input, el('span', label)); return wrapper;
  }
  function select(label, value, choices, callback) {
    const wrapper = el('label', label), control = el('select', '', 'settings-input');
    for (const [id, title] of choices) { const option = el('option', title); option.value = id; control.append(option); }
    control.value = value; control.setAttribute('aria-label', label);
    control.addEventListener('change', () => void action(() => callback(control.value)));
    wrapper.append(control); return wrapper;
  }
  function render(state) {
    if (disposed || rendering) return;
    rendering = true; progressLabel = null; updateStatus(state); content.replaceChildren();
    const data = state.data; owner = data?.chatId ?? null;
    const tools = el('div', '', 'settings-actions');
    tools.append(button('刷新状态', () => runtime.refresh()), button('停止', async () => runtime.abortAll()));
    tools.append(button(data ? '重新建立副本' : '建立世界书副本', async () => {
      if (data && !await confirmImpl({ title: '重新建立动态世界书副本', body: '将清除当前聊天的动态资料修改、锁定与记录，重新读取原世界书。同一本书已有条目的排除设置保留。原世界书和千千结记忆保留。是否继续？' })) return;
      await runtime.initialize({ expectedChatId: data?.chatId ?? null });
    }));
    content.append(tools);
    content.append(receiptBox);
    if (!data) { content.append(el('p', '建立副本本身不调用 AI。建立后先勾选需要排除的条目，再继续分类。', 'settings-hint')); rendering = false; return; }
    const pending = data.entries.filter(e => canReadEntry(e) && e.classification === 'pending').length;
    if (pending) content.append(el('p', `${pending} 条尚待分类。旧版正文、开关和修改记录已保留，无需重建副本。`, 'settings-hint'), button('继续分类维护权限', () => runtime.classify({ expectedChatId: data.chatId })));
    progressLabel = el('p', `${data.book} · 已核对至第 ${data.processed.length ? data.processed.length - 1 : '—'} 楼`, 'settings-hint');
    content.append(progressLabel);
    content.append(checkbox('在当前聊天启用动态世界书', data.enabled, value => runtime.configure({ enabled: value }, data.chatId)));
    content.append(select('世界书维护方式', data.updateMode ?? (data.automatic ? 'auto' : 'manual'), [
      ['manual', '仅手动更新'], ['auto', '每 N 条 AI 回复自动更新'], ['paused', '暂停维护（已有副本仍可使用）'],
    ], value => runtime.configure({ updateMode: value }, data.chatId)));
    const intervalLabel = el('label', '自动触发间隔／手动每批条数（AI 回复）：'), interval = el('input', '', 'settings-input');
    interval.type = 'number'; interval.min = '1'; interval.max = '20'; interval.value = String(data.interval);
    intervalLabel.append(interval, button('保存间隔', () => runtime.configure({ interval: Number(interval.value) }, data.chatId)));
    content.append(intervalLabel, button('手动更新／重试', () => runtime.update({ manual: true }), data.updateMode === 'paused'));
    content.append(el('p', `修改数字后先保存间隔。手动每批按已保存的 ${data.interval} 条处理，补历史也一样；不足时处理实际已就绪的条数，不等待攒满。这里按 AI 回复计数，不含用户消息，合并记忆整组处理。自动补历史仍每批约 3 条，追平后达到间隔且摘要、CSE 就绪才调用，每批最多 20 条。手动成功后从新进度重新计数；失败或中断会暂停自动更新，刷新页面不会自动重试。`, 'settings-hint'));
    content.append(select('世界书选材方式', data.selectionMode ?? 'ai', [
      ['ai', 'AI 按需选材（发送前可能调用召回 API）'], ['native', '沿用酒馆触发规则（不调用选材 AI）'],
    ], value => runtime.configure({ selectionMode: value }, data.chatId)));
    content.append(el('p', '“保护”只禁止自动修改；“排除”让此条退出动态世界书的分类、选材、更新和正文替换。排除不关闭原书条目，也不阻止酒馆将原书内容交给聊天模型；已写进聊天正文的内容仍按聊天正文处理。', 'settings-hint'));
    if (state.lastSelection) {
      const names = state.lastSelection.selected.map(uid => data.entries.find(e => e.uid === uid)?.label ?? uid);
      content.append(el('p', `${state.lastSelection.status}${names.length ? `：${names.join('、')}` : ''}`, 'settings-hint'));
    }
    const search = el('input', '', 'settings-input'); search.type = 'search'; search.value = ''; search.placeholder = '搜索条目'; search.setAttribute('aria-label', '搜索动态世界书条目');
    const rows = [];
    const hiddenHint = el('p', '', 'settings-hint');
    const filterRows = () => {
      const query = search.value.toLowerCase();
      for (const row of rows) row.details.hidden = (hideSourceDisabled && row.sourceDisabled) || !row.text.includes(query);
      const count = hideSourceDisabled ? rows.filter(row => row.sourceDisabled).length : 0;
      hiddenHint.hidden = count === 0;
      hiddenHint.textContent = count ? `已隐藏 ${count} 条原书已禁用条目` : '';
    };
    content.append(checkbox('隐藏原书已禁用条目', hideSourceDisabled, value => {
      hideSourceDisabled = value;
      settings?.update?.({ dynamicWorldbookHideSourceDisabled: value });
      filterRows();
    }, false, true), hiddenHint, search);
    for (const entry of data.entries) {
      const writable = !entry.locked && entry.segments.some(s => s.writable), mixed = writable && entry.segments.some(s => !s.writable);
      const blocked = !canReadEntry(entry);
      const details = el('details', '', 'settings-sub'), summary = el('summary', `${entry.label} · ${entry.sourceDisabled ? '原书已禁用' : entry.excluded ? '已排除' : !entry.managed ? '原生' : mixed ? '部分可更新' : writable ? '可更新' : '正文受保护'}${!blocked && entry.classification === 'review' ? ' · 待核对' : !blocked && entry.classification === 'pending' ? ' · 待分类' : ''}`, 'settings-sub-summary');
      const area = el('div', '', 'settings-sub-body'); details.append(summary, area);
      const edit = patch => runtime.edit(entry.uid, { ...patch, expectedEntry: stableJson(entry) }, data.chatId);
      if (entry.protectedReason) area.append(el('p', entry.protectedReason, 'settings-hint'));
      area.append(checkbox('排除此条（动态世界书 AI 不读取、不修改）', entry.excluded === true, value => edit({ excluded: value })));
      if (entry.sourceDisabled) area.append(el('p', '原世界书已关闭此条，分类、选材和自动更新都会跳过，动态副本不会替换其正文。', 'settings-hint'));
      else if (entry.excluded) area.append(el('p', '此条继续按原世界书工作。排除立即保存，对之后的请求生效，已经发送的内容无法撤回。', 'settings-hint'));
      area.append(checkbox('使用当前聊天的动态副本', entry.managed, value => edit({ managed: value }), blocked));
      if (entry.locked) area.append(checkbox('旧版锁定（取消后按片段权限维护）', entry.locked, value => edit({ locked: value })));
      if (entry.kind === 'rule') area.append(el('p', '规则类条目不交给 AI 自动维护，仍可在下方手动修改副本正文。', 'settings-hint'));
      else area.append(button('允许全部正文自动维护', () => edit({ writable: true }), blocked));
      area.append(button('保护全部正文', () => edit({ writable: false })));
      area.append(button('重新分类此条', () => runtime.classify({ uid: entry.uid, expectedEntry: stableJson(entry), expectedChatId: data.chatId }), blocked));
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
        // Old records also have before/after; calculate only when opened so a
        // large worldbook with 50 revisions per entry remains responsive.
        let diffRendered = false;
        record.addEventListener('toggle', () => {
          if (!record.open || diffRendered) return;
          diffRendered = true; record.append(createWorldbookDiffView(change.before, change.after, documentRef));
        });
        history.append(record);
      }
      area.append(history); content.append(details); rows.push({ details, sourceDisabled: entry.sourceDisabled === true, text: `${entry.label}\n${entry.content}`.toLowerCase() });
    }
    search.addEventListener('input', filterRows);
    filterRows();
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

