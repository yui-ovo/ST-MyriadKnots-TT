import { createSettingsDrawer } from './settings-drawer.js';
import { canMaintain, canReadEntry, stableJson } from '../dynamic-worldbook.js';
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
  let progressLabel = null, sourceHint = null, syncButton = null;
  let disposed = false, rendering = false, owner = null;
  let searchQuery = '', filterValue = 'all', rowEditors = [];
  const selected = new Set(), openedRows = new Set();
  const textDrafts = new Map(), previousDrafts = new Map();
  let hideSourceDisabled = settings?.get?.()?.dynamicWorldbookHideSourceDisabled === true;
  const states = { idle: '空闲', loading: '读取中', syncing: '同步原书中', classifying: '正在分类维护权限，已完成批次会保存', saving: '保存中', updating: '更新资料中', selecting: '本轮选材中' };
  const filters = [
    ['all', '全部条目', () => true], ['modified', '已修改', entry => entry.content !== entry.original],
    ['updatable', '可更新', canMaintain], ['protected', '正文受保护', entry => entry.locked || entry.kind === 'rule' || !entry.segments.some(segment => segment.writable)],
    ['excluded', '已排除', entry => entry.excluded === true], ['sourceDisabled', '原书已禁用', entry => entry.sourceDisabled === true],
    ['pendingConflict', '原书冲突', entry => Boolean(entry.sourceConflict)], ['pendingClassification', '待分类／核对', entry => ['pending', 'review'].includes(entry.classification)],
  ];
  function sourceStatusText(state) {
    const value = state.sourceStatus;
    if (!value) return '刷新状态可检查原世界书的变化。同步只更新本聊天副本，不改原世界书，也不调用 AI。';
    const counts = `新增 ${value.added?.length ?? 0} 条 · 变化 ${value.updated?.length ?? 0} 条 · 移除 ${value.removed?.length ?? 0} 条`;
    const conflicts = value.conflicts?.length ?? state.data?.entries.filter(entry => entry.sourceConflict).length ?? 0;
    return [value.legacy && !value.added?.length && !value.updated?.length && !value.removed?.length ? '旧版副本可同步建立条目对照，已有正文和权限保留。' : value.needsSync ? `检测到原书变化：${counts}。同步后逐条处理冲突。` : '原书已核对，没有待同步变化。',
      conflicts ? `${conflicts} 条冲突待决定；当前副本保留，自动维护暂停这些条目。` : '',
      '同步不调用 AI；新增或改过正文的条目可稍后分类。'].filter(Boolean).join('\n');
  }
  function updateStatus(state) {
    status.textContent = state.error || states[state.phase] || state.phase;
    readiness.textContent = state.updateReadiness || '';
    const receipt = state.lastUpdate ?? state.data?.lastUpdate;
    const progress = state.data ? `${state.data.book} · 已核对至第 ${state.data.processed.length ? state.data.processed.length - 1 : '—'} 楼` : '';
    if (progressLabel) progressLabel.textContent = progress;
    if (sourceHint) sourceHint.textContent = sourceStatusText(state);
    if (syncButton) syncButton.disabled = state.phase !== 'idle' || !state.sourceStatus?.needsSync && !state.sourceStatus?.legacy;
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
  function button(label, callback, disabled = false, viewOnly = false) { const node = el('button', label, 'secondary-action'); node.type = 'button'; node.disabled = disabled; node.addEventListener('click', () => { if (!node.disabled) { if (viewOnly) callback(); else void action(callback); } }); return node; }
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
    const scrollPositions = [];
    for (let node = body; node; node = node.parentElement) if (Number.isFinite(node.scrollTop)) scrollPositions.push([node, node.scrollTop, node.scrollLeft]);
    const data = state.data, nextOwner = data?.chatId ?? null;
    if (nextOwner !== owner) { searchQuery = ''; filterValue = 'all'; selected.clear(); openedRows.clear(); textDrafts.clear(); previousDrafts.clear(); }
    else for (const row of rowEditors) {
      if (row.details.open) openedRows.add(row.uid); else openedRows.delete(row.uid);
      const segments = row.drafts.map(({ draft, textarea }) => ({ ...draft, text: textarea.value }));
      if (!row.submitted && stableJson(segments) !== stableJson(row.entry.segments)) textDrafts.set(row.uid, { token: stableJson(row.entry), segments });
      else textDrafts.delete(row.uid);
    }
    rendering = true; progressLabel = null; sourceHint = null; syncButton = null; updateStatus(state); content.replaceChildren(); rowEditors = [];
    owner = nextOwner;
    const tools = el('div', '', 'settings-actions');
    tools.append(button('刷新状态', () => runtime.refresh()), button('停止', async () => runtime.abortAll()));
    tools.append(button(data ? '重新建立副本' : '建立世界书副本', async () => {
      if (data && !await confirmImpl({ title: '重新建立动态世界书副本', body: '将清除当前聊天的动态资料修改、锁定与记录，重新读取原世界书。同一本书已有条目的排除设置保留。原世界书和千千结记忆保留。是否继续？' })) return;
      await runtime.initialize({ expectedChatId: data?.chatId ?? null });
    }));
    content.append(tools);
    content.append(receiptBox);
    if (!data) { content.append(el('p', '建立副本本身不调用 AI。建立后先勾选需要排除的条目，再继续分类。', 'settings-hint')); rendering = false; return; }
    sourceHint = el('p', sourceStatusText(state), 'settings-hint'); sourceHint.style.whiteSpace = 'pre-wrap';
    syncButton = button('同步原书变化', async () => {
      const currentSource = runtime.getState().sourceStatus;
      if (currentSource?.bookChanged && !await confirmImpl({ title: '同步新绑定的世界书', body: `主世界书已从“${data.book}”切换为“${currentSource.bookName || '新世界书'}”。将按条目编号对照，保留当前剧情副本，冲突逐条决定。原世界书不改动。` })) return;
      await runtime.syncSource({ expectedChatId: data.chatId });
    }, state.phase !== 'idle' || !state.sourceStatus?.needsSync && !state.sourceStatus?.legacy);
    content.append(sourceHint, syncButton);
    const pending = data.entries.filter(e => canReadEntry(e) && !e.sourceConflict && !e.sourcePending && e.classification === 'pending').length;
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
    const search = el('input', '', 'settings-input'); search.type = 'search'; search.value = searchQuery; search.placeholder = '搜索条目'; search.setAttribute('aria-label', '搜索动态世界书条目');
    const rows = [];
    const hiddenHint = el('p', '', 'settings-hint'), filterCount = el('p', '', 'settings-hint'), selectedHint = el('p', '', 'settings-hint');
    const filter = el('select', '', 'settings-input'); filter.setAttribute('aria-label', '筛选动态世界书条目');
    for (const [id, label, predicate] of filters) { const option = el('option', `${label}（${data.entries.filter(predicate).length}）`); option.value = id; filter.append(option); }
    filter.value = filterValue;
    const bulkActions = el('div', '', 'settings-actions');
    const bulkButtons = [];
    const selectionEntries = () => rows.filter(row => !row.details.hidden && selected.has(row.entry.uid)).map(row => row.entry);
    const cannotEnable = entry => entry.kind === 'rule' || !canReadEntry(entry) || entry.sourceMissing || entry.sourcePending || entry.sourceConflict;
    function updateSelection() {
      const entries = selectionEntries();
      for (const row of rows) row.selector.checked = selected.has(row.entry.uid);
      for (const { node, opensPermission } of bulkButtons) node.disabled = !entries.length || opensPermission && entries.some(cannotEnable);
      selectedHint.textContent = `已选 ${entries.length} 条可见条目。切换筛选后，隐藏条目会取消选择。${entries.some(cannotEnable) ? '所选含规则、排除、禁用或待同步条目，不能统一开启自动维护。' : ''}`;
    }
    const bulk = patch => async () => {
      const entries = selectionEntries();
      if (!entries.length) return;
      await runtime.bulkEdit(entries.map(entry => entry.uid), patch, data.chatId, Object.fromEntries(entries.map(entry => [entry.uid, stableJson(entry)])));
    };
    for (const [label, patch, opensPermission] of [['保护所选正文', { writable: false }, false], ['允许所选自动维护', { writable: true }, true], ['排除所选', { excluded: true }, false], ['取消所选排除', { excluded: false }, false]]) {
      const node = button(label, bulk(patch), true); bulkButtons.push({ node, opensPermission }); bulkActions.append(node);
    }
    const selectionActions = el('div', '', 'settings-actions');
    const selectVisible = button('选择筛选结果', () => { for (const row of rows) if (!row.details.hidden) selected.add(row.entry.uid); updateSelection(); }, false, true);
    const clearSelection = button('取消选择', () => { selected.clear(); updateSelection(); }, false, true);
    // These controls only change the view; do not rebuild editors or discard drafts.
    selectionActions.append(selectVisible, clearSelection);
    const filterRows = () => {
      const query = searchQuery.toLocaleLowerCase(), predicate = filters.find(([id]) => id === filterValue)?.[2] ?? filters[0][2];
      for (const row of rows) {
        row.details.hidden = (hideSourceDisabled && row.entry.sourceDisabled) || !row.text.includes(query) || !predicate(row.entry);
        if (row.details.hidden) selected.delete(row.entry.uid);
      }
      for (const uid of selected) if (!rows.some(row => row.entry.uid === uid)) selected.delete(uid);
      const count = hideSourceDisabled ? rows.filter(row => row.entry.sourceDisabled).length : 0;
      hiddenHint.hidden = count === 0;
      hiddenHint.textContent = count ? `已隐藏 ${count} 条原书已禁用条目` : '';
      const visible = rows.filter(row => !row.details.hidden).length;
      filterCount.textContent = `显示 ${visible} / ${rows.length} 条${visible ? '' : '；没有符合当前搜索与筛选的条目'}。`;
      selectVisible.disabled = visible === 0;
      updateSelection();
    };
    content.append(checkbox('隐藏原书已禁用条目', hideSourceDisabled, value => {
      hideSourceDisabled = value;
      settings?.update?.({ dynamicWorldbookHideSourceDisabled: value });
      filterRows();
    }, false, true), hiddenHint, search, filter, filterCount, selectionActions, selectedHint, bulkActions);
    for (const entry of data.entries) {
      const writable = !entry.locked && entry.segments.some(s => s.writable), mixed = writable && entry.segments.some(s => !s.writable);
      const blocked = !canReadEntry(entry) || Boolean(entry.sourceMissing || entry.sourcePending || entry.sourceConflict);
      const details = el('details', '', 'settings-sub'), summary = el('summary', `${entry.label} · ${entry.sourceMissing ? '原书已移除' : entry.sourceDisabled ? '原书已禁用' : entry.excluded ? '已排除' : !entry.managed ? '原生' : mixed ? '部分可更新' : writable ? '可更新' : '正文受保护'}${entry.content !== entry.original ? ' · 已修改' : ''}${entry.sourceConflict ? ' · 原书冲突' : entry.sourcePending ? ' · 原书待同步' : !blocked && entry.classification === 'review' ? ' · 待核对' : !blocked && entry.classification === 'pending' ? ' · 待分类' : ''}`, 'settings-sub-summary');
      details.setAttribute('data-worldbook-uid', entry.uid); details.open = openedRows.has(entry.uid);
      const selector = el('input'); selector.type = 'checkbox'; selector.checked = selected.has(entry.uid); selector.style.float = 'right'; selector.style.marginInlineStart = '0.75rem';
      selector.setAttribute('aria-label', `选择条目：${entry.label}`);
      selector.addEventListener('click', event => event?.stopPropagation?.());
      selector.addEventListener('change', () => { if (selector.checked) selected.add(entry.uid); else selected.delete(entry.uid); updateSelection(); });
      summary.append(selector);
      const area = el('div', '', 'settings-sub-body'); details.append(summary, area);
      const rowEditor = { details, uid: entry.uid, entry, drafts: [], submitted: false };
      const edit = patch => runtime.edit(entry.uid, { ...patch, expectedEntry: stableJson(entry) }, data.chatId);
      if (Number.isSafeInteger(entry.recheckFrom) && entry.recheckFrom < data.processed.length) area.append(el('p', '此条正在单独补核历史。完成前，正文生成继续使用补核前的副本；下方显示本次补核进度中的资料。', 'settings-hint'));
      if (entry.sourceConflict) {
        const conflict = entry.sourceConflict, box = el('div', '', 'settings-sub-body');
        box.append(el('strong', conflict.deleted ? '原书已移除此条，当前副本仍保留' : '原书与当前副本都有变化，请选择保留哪份正文'));
        box.append(el('p', conflict.deleted ? '此副本作为存档保留，不会发送，也不会自动更新。原书重新出现此条时会再次核对。' : '决定前继续保留当前副本；AI 暂不维护此条。接受新版后，新的正文会暂时受保护，等待重新分类。', 'settings-hint'));
        const comparison = (label, before, after) => {
          const details = el('details'); details.append(el('summary', label)); let shown = false;
          details.addEventListener('toggle', () => { if (details.open && !shown) { shown = true; details.append(createWorldbookDiffView(before, after, documentRef)); } });
          return details;
        };
        box.append(comparison('原书更新前 → 新版原文', conflict.base, conflict.incoming ?? ''));
        if (!conflict.deleted) box.append(comparison('当前副本 → 新版原文', entry.content, conflict.incoming));
        box.append(button(conflict.deleted ? '保留副本存档' : '保留当前剧情副本', () => runtime.resolveSource(entry.uid, { choice: 'keep', expectedEntry: stableJson(entry) }, data.chatId)));
        if (!conflict.deleted) box.append(button('采用新版原文', async () => {
          if (await confirmImpl({ title: '采用新版原文', body: `将“${entry.label}”的当前副本正文替换为新版原文，修改记录保留。原世界书不会改动。` })) await runtime.resolveSource(entry.uid, { choice: 'source', expectedEntry: stableJson(entry) }, data.chatId);
        }));
        area.append(box);
      } else if (entry.sourcePending) area.append(el('p', '原书此条有变化，点击上方“同步原书变化”进行对照；其他未变条目照常使用。', 'settings-hint'));
      else if (entry.sourceMissing) area.append(el('p', '原书已移除此条。当前副本仅作存档保留，不发送、不自动维护。', 'settings-hint'));
      if (entry.protectedReason) area.append(el('p', entry.protectedReason, 'settings-hint'));
      area.append(checkbox('排除此条（动态世界书 AI 不读取、不修改）', entry.excluded === true, value => edit({ excluded: value })));
      if (entry.sourceDisabled && !entry.sourceMissing) area.append(el('p', '原世界书已关闭此条，分类、选材和自动更新都会跳过，动态副本不会替换其正文。', 'settings-hint'));
      else if (entry.excluded) area.append(el('p', '此条继续按原世界书工作。排除立即保存，对之后的请求生效，已经发送的内容无法撤回。', 'settings-hint'));
      area.append(checkbox('使用当前聊天的动态副本', entry.managed, value => edit({ managed: value }), blocked));
      if (entry.locked) area.append(checkbox('旧版锁定（取消后按片段权限维护）', entry.locked, value => edit({ locked: value })));
      if (entry.kind === 'rule') area.append(el('p', '规则类条目不交给 AI 自动维护，仍可在下方手动修改副本正文。', 'settings-hint'));
      else area.append(button('允许全部正文自动维护', () => edit({ writable: true }), blocked));
      area.append(button('保护全部正文', () => edit({ writable: false })));
      area.append(button('重新分类此条', () => runtime.classify({ uid: entry.uid, expectedEntry: stableJson(entry), expectedChatId: data.chatId }), blocked));
      const original = el('pre', entry.original, 'dynamic-worldbook-original'); original.style.whiteSpace = 'pre-wrap'; original.style.overflowWrap = 'anywhere';
      const originalDrawer = el('details'); originalDrawer.append(el('summary', entry.sourceMetadata ? '最近同步的原文' : '建档时原文'), original); area.append(originalDrawer);
      let retainedDraft = textDrafts.get(entry.uid);
      if (retainedDraft && retainedDraft.token !== stableJson(entry)) {
        const older = previousDrafts.get(entry.uid) ?? [];
        if (!older.some(item => stableJson(item) === stableJson(retainedDraft))) older.push(retainedDraft);
        previousDrafts.set(entry.uid, older); textDrafts.delete(entry.uid); retainedDraft = null;
      }
      if (previousDrafts.has(entry.uid)) {
        const savedDrafts = el('details'); savedDrafts.open = true;
        savedDrafts.append(el('summary', '未保存草稿（来自更新前的资料）'), el('p', '此条资料已经更新。下面保留了尚未保存的草稿，可复制需要的文字后再编辑当前正文；这些草稿没有写入副本。', 'settings-hint'));
        for (const [index, previous] of previousDrafts.get(entry.uid).entries()) for (const segment of previous.segments) {
          savedDrafts.append(el('p', `草稿 ${index + 1} · ${segment.id} · ${segment.writable ? '允许自动维护' : '正文受保护'}`, 'settings-hint'));
          const text = el('textarea', '', 'settings-input'); text.value = segment.text; text.readOnly = true; text.rows = 5;
          text.setAttribute('aria-label', `${entry.label} 未保存草稿`); savedDrafts.append(text);
        }
        savedDrafts.append(button('丢弃保留的草稿', async () => {
          if (await confirmImpl({ title: '丢弃未保存草稿', body: `仅删除“${entry.label}”保留在当前窗口的旧草稿，已保存正文不受影响。` })) previousDrafts.delete(entry.uid);
        }));
        area.append(savedDrafts);
      }
      const drafts = entry.segments.map(segment => {
        const draft = { ...(retainedDraft?.segments.find(item => item.id === segment.id) ?? segment) };
        area.append(el('p', `正文片段：${segment.id}`));
        area.append(checkbox('保护此片段（AI 不修改）', !draft.writable, value => { draft.writable = !value; }, entry.kind === 'rule', true));
        const textarea = el('textarea', '', 'settings-input'); textarea.rows = 7; textarea.value = draft.text;
        textarea.setAttribute('aria-label', `${entry.label} ${segment.id} 正文`); textarea.style.width = '100%'; textarea.style.boxSizing = 'border-box';
        area.append(textarea); return { draft, textarea };
      });
      rowEditor.drafts = drafts;
      area.append(el('p', '片段正文与勾选权限一起保存；上方整条权限按钮使用已保存正文，不保存下方草稿。', 'settings-hint'));
      area.append(button('保存正文与权限', async () => { await edit({ segments: drafts.map(({ draft, textarea }) => ({ ...draft, text: textarea.value })) }); rowEditor.submitted = true; }), button(entry.sourceMetadata ? '恢复同步原文' : '恢复建档原文', async () => {
        if (await confirmImpl({ title: '恢复条目原文', body: `将“${entry.label}”恢复为${entry.sourceMetadata ? '最近同步的原书正文' : '建立副本时的正文'}，暂时保护并等待重新分类。` })) await edit({ restore: true });
      }));
      const history = el('details'); history.append(el('summary', `修改记录（${entry.history.length}）`));
      for (const change of [...entry.history].reverse()) {
        const record = el('details'); record.append(el('summary', `${change.at.slice(0, 19).replace('T', ' ')} · ${{ model: '自动更新', manual: '手动修改', restore: '恢复原文', source: '同步原书' }[change.kind] ?? change.kind}`));
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
      area.append(history); content.append(details); rows.push({ details, selector, entry, text: `${entry.label}\n${entry.content}`.toLocaleLowerCase() }); rowEditors.push(rowEditor);
    }
    search.addEventListener('input', () => { searchQuery = search.value; filterRows(); });
    filter.addEventListener('change', () => { filterValue = filter.value; filterRows(); });
    filterRows();
    for (const [node, top, left] of scrollPositions) { node.scrollTop = top; if (Number.isFinite(left)) node.scrollLeft = left; }
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

