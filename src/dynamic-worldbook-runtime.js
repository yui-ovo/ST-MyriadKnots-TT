import { sanitizeMemoryContent } from './memory-content-sanitizer.js';
import { selectAssistantMessage } from './v3/foundation-domain.js';
import { sha256 } from './identity.js';
import { parseJsonOutput } from './compact-api-client.js';
import { withBaseProcessingPrompt } from './internal-processing-prompt.js';
import { CLASSIFY_PROMPT, buildWorldbookUpdatePrompt, buildWorldbookSources, cseForFloor, validateWorldbookDecision } from './dynamic-worldbook-update.js';
import { inspectSource, synchronizeSource, resolveSourceConflict } from './dynamic-worldbook-source.js';
import { buildWorldbookSelectionRequest, sortWorldbookSelectionEntries } from './dynamic-worldbook-selection.js';
import { addHistory, applyChanges, bookError, bookFingerprint, createBook, createDynamicBookStore, messageSignature,
  canMaintain, canReadEntry, entryContentForSending, isSourceDisabled, classifyEntry, nativeSelectionReason, overlayCandidates, primaryBook, sourceEntries, stableJson, verifyWitness, witness } from './dynamic-worldbook.js';

// Semantic API tasks return textData; older adapters may already supply jsonData.
const jsonResult = result => parseJsonOutput(result?.jsonData ?? result?.textData ?? result,
  { finishReason: result?.taskMetadata?.finishReason });
const clone = value => structuredClone(value);
const abortError = () => new DOMException('已取消', 'AbortError');
function matchesExpected(entry, token) {
  if (!token) return true;
  try {
    const expected = JSON.parse(token), actual = { ...entry };
    // This field is refreshed from the source, not a user-edited revision.
    delete expected.sourceDisabled; delete actual.sourceDisabled;
    delete expected.sourcePending; delete actual.sourcePending;
    return stableJson(expected) === stableJson(actual);
  } catch { return false; }
}
function batches(entries, limit = 48000) {
  const result = []; let batch = [], size = 0;
  for (const entry of entries) {
    const length = JSON.stringify(entry).length;
    if (batch.length && (size + length > limit || batch.length >= 8)) { result.push(batch); batch = []; size = 0; }
    batch.push(entry); size += length;
  }
  if (batch.length) result.push(batch);
  return result;
}

export function createDynamicWorldbookRuntime({ client, hostAdapter, identityProvider, memoryState, generateUpdate, generateSelect,
  processingPrompt = () => '', updateGuidance = () => '',
  isEnabled = () => true, isGenerating = () => false, isBookAllowed = () => true, sanitizerOptions = () => ({}), notifyUser = () => {} } = {}) {
  const store = createDynamicBookStore(client), listeners = new Set();
  let cached = null, operation = null, epoch = 0, plan = null, lastSelection = null, failure = '', phase = 'idle', timer = null, disposed = false;
  let lastAutomaticAttempt = null;
  let updateAttempt = null;
  let sourceInspection = null;
  const bindings = [];
  function capture() {
    if (!isEnabled()) throw bookError('请先启用千千结。');
    const context = hostAdapter.getContext(), identity = identityProvider();
    const hostId = String(context.chatId ?? context.getCurrentChatId?.() ?? '');
    if (!identity?.chatId || !hostId || identity.hostChatId !== hostId || context.groupId != null) throw bookError('请先等待当前单角色聊天身份准备完成。');
    return { context, identity, key: stableJson([identity.chatId, hostId, identity.characterLocator, identity.personaLocator]), chat: context.chat };
  }
  function current(target) {
    try { const value = capture(); return value.key === target.key && value.chat === target.chat; } catch { return false; }
  }
  function getState() {
    let target = null; try { target = capture(); } catch { /* settings remain accessible without a chat */ }
    const data = target && cached?.key === target.key ? clone(cached.data) : null;
    if (data && sourceInspection?.key === target.key) projectSourceFlags(data, sourceInspection.status);
    return { phase, error: failure, data, lastSelection: lastSelection ? clone(lastSelection) : null,
      sourceStatus: clone(target && sourceInspection?.key === target.key ? sourceInspection.status : null),
      updateReadiness: updateReadiness(target, data),
      lastUpdate: clone(target && updateAttempt?.key === target.key ? updateAttempt.receipt : data?.lastUpdate ?? null) };
  }
  function emit() { for (const listener of listeners) { try { listener(getState()); } catch { /* UI cannot break storage */ } } }
  function abortAll() { epoch += 1; plan = null; lastSelection = null; operation?.controller.abort(); clearTimeout(timer); timer = null; }
  async function run(kind, task) {
    if (operation) throw bookError('动态世界书正在处理，请等待完成或点击停止。');
    const target = capture(), op = { kind, target, token: epoch, controller: new AbortController() };
    operation = op; phase = kind; if (kind !== 'updating') failure = ''; emit();
    const guard = () => { if (op.controller.signal.aborted || op.token !== epoch || !current(target)) throw abortError(); };
    op.promise = (async () => {
      try { return await task(target, guard, op.controller.signal); }
      catch (error) {
        if (current(target)) {
          failure = error.name === 'AbortError' ? '任务已停止，已保存资料保留。' : error.message;
          if (kind === 'updating') {
            const receipt = updateAttempt?.key === target.key && updateAttempt.receipt.status === 'running'
              ? updateAttempt.receipt : newUpdateReceipt();
            if (error.taskMetadata) receipt.api = { model: String(error.taskMetadata.model ?? '').slice(0, 160), sourceLabel: String(error.taskMetadata.sourceLabel ?? '').slice(0, 160) };
            updateAttempt = { key: target.key, receipt: { ...receipt, status: error.name === 'AbortError' ? 'stopped' : 'failed', at: new Date().toISOString(), message: failure } };
          }
        }
        throw error;
      }
      finally { if (operation === op) { operation = null; phase = 'idle'; emit(); } }
    })();
    return op.promise;
  }
  async function load(target, guard, force = false) {
    if (cached?.key !== target.key || force) {
      const result = await store.read(target.identity.chatId); guard();
      cached = { ...result, key: target.key };
    }
    return cached;
  }
  async function source(target, guard) {
    const name = primaryBook(hostAdapter.getContext());
    if (!name || !isBookAllowed(name)) throw bookError('角色没有主绑定世界书，或该书已被千千结排除。');
    const loader = hostAdapter.getContext().loadWorldInfo ?? hostAdapter.getWorldInfoBindings?.().loadWorldInfo;
    if (typeof loader !== 'function') throw bookError('当前宿主没有世界书读取接口。');
    const raw = await loader(name); guard();
    if (name !== primaryBook(hostAdapter.getContext()) || !isBookAllowed(name)) throw abortError();
    const entries = sourceEntries(raw);
    const signature = stableJson([name, await bookFingerprint(entries),
      entries.map(entry => [entry.uid, isSourceDisabled(entry), Boolean(entry.constant)])]);
    guard(); return { name, entries, signature };
  }
  async function checkedSource(target, data, guard) {
    const book = await source(target, guard);
    const status = sourceStatus(data, book);
    sourceInspection = { key: target.key, status };
    projectSourceFlags(data, status);
    guard(); return book;
  }
  function sourceStatus(data, book) {
    const status = inspectSource(data, book.entries);
    status.bookName = book.name; status.previousBookName = data.book; status.bookChanged = book.name !== data.book;
    if (status.bookChanged) { status.needsSync = true; status.blockedUids = data.entries.map(entry => entry.uid); }
    const byId = new Map(book.entries.map(e => [e.uid, e]));
    status.disabledUids = data.entries.filter(entry => !byId.has(entry.uid) || isSourceDisabled(byId.get(entry.uid))).map(entry => entry.uid);
    return status;
  }
  function projectSourceFlags(data, status) {
    const blocked = new Set(status.blockedUids);
    const disabled = new Set(status.disabledUids);
    for (const entry of data.entries) {
      if (entry.sourceDisabled && !disabled.has(entry.uid)) requestRecheck(data, entry);
      entry.sourceDisabled = disabled.has(entry.uid);
      entry.sourcePending = blocked.has(entry.uid);
    }
  }
  async function checkedHistory(target, data, guard) {
    if (!await verifyWitness(target.chat, data.processed)) throw bookError('已处理的旧楼被编辑、删除或切换候选，动态副本暂停使用。请重新建立副本。');
    guard();
  }
  async function save(target, data, revision, guard, signal) {
    guard(); plan = null;
    const persisted = clone(data);
    for (const entry of persisted.entries) delete entry.sourcePending;
    const saved = await store.write(target.identity.chatId, persisted, revision, signal);
    // A late save belongs exclusively to the captured chat; never populate the next chat's cache.
    guard(); cached = { ...saved, key: target.key };
    if (sourceInspection?.key === target.key) {
      const blocked = new Set(sourceInspection.status.blockedUids);
      for (const entry of cached.data.entries) entry.sourcePending = blocked.has(entry.uid);
    }
    emit(); return getState();
  }
  const refresh = () => run('loading', async (target, guard) => {
    const previous = await load(target, guard, true);
    if (previous.data) await checkedSource(target, previous.data, guard);
    return getState();
  });
  const syncSource = ({ expectedChatId = null } = {}) => run('syncing', async (target, guard, signal) => {
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    if (isGenerating()) throw bookError('请等当前任务结束后同步原书。');
    const previous = await load(target, guard, true);
    if (!previous.data) throw bookError('请先建立世界书副本。');
    const book = await source(target, guard), before = inspectSource(previous.data, book.entries);
    sourceInspection = { key: target.key, status: sourceStatus(previous.data, book) };
    const data = await synchronizeSource(previous.data, book.entries);
    for (const entry of data.entries) if (before.updated.includes(entry.uid) && canMaintain(entry)) requestRecheck(data, entry);
    data.book = book.name; guard();
    if ((await source(target, guard)).signature !== book.signature) throw bookError('同步期间原书再次变化，请刷新后重试。');
    await save(target, data, previous.revision, guard, signal);
    sourceInspection = { key: target.key, status: sourceStatus(data, book) }; emit(); wake(); return getState();
  });
  const resolveSource = (uid, { choice, expectedEntry } = {}, expectedChatId = null) => run('saving', async (target, guard, signal) => {
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    if (isGenerating()) throw bookError('请等当前任务结束后处理原书冲突。');
    const previous = await load(target, guard, true);
    if (!previous.data) throw bookError('请先建立世界书副本。');
    const book = await checkedSource(target, previous.data, guard), entry = previous.data.entries.find(e => e.uid === uid);
    if (!entry || !matchesExpected(entry, expectedEntry)) throw bookError('此条资料已有新版本，请刷新后再决定。');
    if (entry.sourcePending) throw bookError('原书又有更新，请先同步变化再处理冲突。');
    const data = resolveSourceConflict(previous.data, uid, choice);
    const resolved = data.entries.find(entry => entry.uid === uid);
    if (canMaintain(resolved)) requestRecheck(data, resolved);
    if ((await source(target, guard)).signature !== book.signature) throw bookError('原书已变化，请重新同步。');
    await save(target, data, previous.revision, guard, signal);
    sourceInspection = { key: target.key, status: sourceStatus(data, book) }; emit(); wake(); return getState();
  });
  async function classifyPending(target, guard, signal, { uid = null, expectedEntry = null } = {}) {
    let previous = await load(target, guard, true);
    if (!previous.data) throw bookError('请先建立世界书副本。');
    const sourceAtStart = await checkedSource(target, previous.data, guard);
    const pending = previous.data.entries.filter(e => canReadEntry(e) && !e.sourceConflict && (uid ? e.uid === uid : e.classification === 'pending'));
    if (uid && previous.data.entries.some(e => e.uid === uid && !canReadEntry(e))) throw bookError('此条已排除或在原书中禁用，不会发送给分类 AI。');
    if (uid && (!pending.length || !matchesExpected(pending[0], expectedEntry))) throw bookError('此条资料已有新版本，请刷新后重新分类。');
    for (const batch of batches(pending.map(({ uid, label, content }) => ({ uid, label, content })))) {
      let results = [];
      if (JSON.stringify(batch).length <= 100000) {
        const response = jsonResult(await generateUpdate({ systemPrompt: withBaseProcessingPrompt(CLASSIFY_PROMPT, processingPrompt()),
          promptTask: 'worldbookClassify', promptOwnerId: target.identity.chatId,
          taskMessages: [{ role: 'user', content: JSON.stringify({ entries: batch }) }],
          maxTokens: 12000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic' }));
        guard();
        if (!Array.isArray(response?.entries) || new Set(response.entries.map(e => e.uid)).size !== response.entries.length || response.entries.some(e => !batch.some(input => input.uid === e.uid))) throw bookError('分类回复格式无效，已完成的批次保留。请点击继续分类。');
        results = response.entries;
      }
      if ((await checkedSource(target, previous.data, guard)).signature !== sourceAtStart.signature) throw bookError('分类期间原书发生变化，请刷新并同步后重试。');
      const data = clone(previous.data);
      data.entries = data.entries.map(entry => batch.some(input => input.uid === entry.uid) ? classifyEntry(entry, results.find(r => r.uid === entry.uid)) : entry);
      for (const entry of data.entries) if (batch.some(input => input.uid === entry.uid) && canMaintain(entry)) requestRecheck(data, entry);
      await save(target, data, previous.revision, guard, signal);
      previous = cached;
    }
    wake(); return getState();
  }
  const classify = ({ expectedChatId = null, uid = null, expectedEntry = null } = {}) => run('classifying', async (target, guard, signal) => {
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    if (isGenerating()) throw bookError('请等当前回复结束后分类。');
    return classifyPending(target, guard, signal, { uid, expectedEntry });
  });
  const initialize = ({ expectedChatId = null } = {}) => run('loading', async (target, guard, signal) => {
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    if (isGenerating()) throw bookError('请等当前回复生成结束后建立副本。');
    const previous = await load(target, guard, true), book = await source(target, guard);
    const data = await createBook(target.identity.chatId, book.name, book.entries); guard();
    updateAttempt = null; sourceInspection = null;
    // Rebuild must not silently revoke the user's exclusions.
    if (previous.data?.book === book.name) for (const entry of data.entries) {
      const old = previous.data.entries.find(e => e.uid === entry.uid);
      if (old?.excluded) entry.excluded = true;
    }
    // Give the user a chance to exclude active scripts/status bars before the
    // first model request. Building the local copy itself makes no AI call.
    return save(target, data, previous.revision, guard, signal);
  });
  const configure = (patch, expectedChatId = null) => run('saving', async (target, guard, signal) => {
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    const previous = await load(target, guard, true);
    if (!previous.data) throw bookError('请先建立世界书副本。');
    const data = clone(previous.data);
    for (const key of ['enabled', 'automatic']) if (typeof patch[key] === 'boolean') data[key] = patch[key];
    if (typeof patch.automatic === 'boolean') data.updateMode = patch.automatic ? 'auto' : 'manual';
    if (patch.updateMode !== undefined) {
      if (!['auto', 'manual', 'paused'].includes(patch.updateMode)) throw bookError('更新模式无效。');
      data.updateMode = patch.updateMode; data.automatic = patch.updateMode === 'auto';
    }
    if (patch.selectionMode !== undefined) {
      if (!['ai', 'native'].includes(patch.selectionMode)) throw bookError('选材模式无效。');
      data.selectionMode = patch.selectionMode;
    }
    if (patch.interval !== undefined) {
      if (!Number.isInteger(patch.interval) || patch.interval < 1 || patch.interval > 20) throw bookError('更新间隔须为 1–20 个 AI 回复。');
      data.interval = patch.interval;
    }
    const result = await save(target, data, previous.revision, guard, signal); wake(); return result;
  });
  function requestRecheck(data, entry) {
    if (data.processed.length) {
      if (!Number.isSafeInteger(entry.recheckFrom)) entry.recheckBase = clone(entry.segments);
      entry.recheckFrom = 0;
    }
  }
  function applyPermissionPatch(data, entry, patch, strict = true) {
    if (typeof patch.excluded === 'boolean' && entry.excluded !== patch.excluded) {
      entry.excluded = patch.excluded;
      if (!entry.excluded) requestRecheck(data, entry);
    }
    if (typeof patch.managed === 'boolean' && entry.managed !== patch.managed) {
      entry.managed = patch.managed;
      if (entry.managed) requestRecheck(data, entry);
    }
    if (typeof patch.locked === 'boolean') entry.locked = patch.locked;
    if (typeof patch.writable === 'boolean') {
      if (patch.writable && entry.kind === 'rule') throw bookError('规则类条目不参与自动维护，仍可手动编辑正文。');
      if (patch.writable && (strict && !canReadEntry(entry) || entry.sourcePending || entry.sourceMissing || entry.sourceConflict)) throw bookError('所选条目包含已排除、已禁用或原书待处理条目，未修改任何权限。');
      entry.segments.forEach(s => { s.writable = patch.writable; });
      entry.locked = false; entry.classification = 'manual'; entry.protectedReason = '';
      if (patch.writable) { entry.managed = true; requestRecheck(data, entry); }
    }
  }
  const bulkEdit = async (uids, patch, expectedChatId = null, expectedEntries = {}) => {
    if (!Array.isArray(uids) || !uids.length || uids.length > 1000 || new Set(uids).size !== uids.length
      || !patch || !Object.keys(patch).length || Object.keys(patch).some(key => !['excluded', 'managed', 'writable'].includes(key) || typeof patch[key] !== 'boolean')) {
      throw bookError('批量操作范围或权限无效。');
    }
    const clickedTarget = capture(), exclusionOnly = patch.excluded === true && Object.keys(patch).length === 1;
    if (exclusionOnly && operation) { const running = operation; abortAll(); await running.promise.catch(() => {}); }
    if (!current(clickedTarget)) throw abortError();
    return run('saving', async (target, guard, signal) => {
      if (!current(clickedTarget) || expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
      if (isGenerating() && !exclusionOnly) throw bookError('请等当前任务结束后批量修改。');
      const previous = await load(target, guard, true);
      if (!previous.data) throw bookError('请先建立世界书副本。');
      const data = clone(previous.data);
      if (!exclusionOnly) await checkedSource(target, data, guard);
      const selected = uids.map(uid => data.entries.find(entry => entry.uid === uid));
      if (selected.some((entry, index) => !entry || !Object.hasOwn(expectedEntries, uids[index])
        || !matchesExpected(entry, expectedEntries[uids[index]]))) throw bookError('勾选条目已有新版本，请刷新后重试；本次未修改任何条目。');
      for (const entry of selected) applyPermissionPatch(data, entry, patch);
      const result = await save(target, data, previous.revision, guard, signal); wake(); return result;
    });
  };
  const edit = async (uid, patch, expectedChatId = null) => {
    const clickedTarget = capture();
    if (patch.excluded === true && operation) {
      const running = operation; abortAll(); await running.promise.catch(() => {});
      if (!current(clickedTarget)) throw abortError();
    }
    return run('saving', async (target, guard, signal) => {
    if (!current(clickedTarget)) throw abortError();
    if (expectedChatId && target.identity.chatId !== expectedChatId) throw bookError('聊天已切换，请重新打开设置。');
    const exclusionOnly = typeof patch.excluded === 'boolean' && Object.keys(patch).every(key => ['excluded', 'expectedEntry'].includes(key));
    if (isGenerating() && !(exclusionOnly && patch.excluded)) throw bookError('请等当前回复结束后修改资料。');
    const previous = await load(target, guard, true);
    if (!previous.data) throw bookError('请先建立世界书副本。');
    const data = clone(previous.data), entry = data.entries.find(e => e.uid === uid);
    if (!entry) throw bookError('条目不存在，请刷新设置。');
    if (!(exclusionOnly && patch.excluded) && !matchesExpected(entry, patch.expectedEntry)) throw bookError('此条资料已有新版本，请复制草稿并刷新后再保存。');
    if (!(exclusionOnly && patch.excluded)) await checkedSource(target, data, guard);
    applyPermissionPatch(data, entry, patch, false);
    if (patch.restore === true) {
      delete entry.recheckFrom; delete entry.recheckBase;
      addHistory(entry, entry.original, 'restore', entry.sourceMetadata ? '用户恢复最近同步的原文' : '用户恢复建档时的原文');
      entry.segments = [{ id: 'body', text: entry.original, writable: false }];
      entry.classification = 'pending'; entry.protectedReason = '原文已恢复，可重新分类维护权限。';
    }
    else if (patch.segments !== undefined) {
      if (!Array.isArray(patch.segments) || patch.segments.length !== entry.segments.length || patch.segments.some((s, i) => s.id !== entry.segments[i].id || typeof s.text !== 'string' || typeof s.writable !== 'boolean' || entry.kind === 'rule' && s.writable)) throw bookError('片段结构或权限无效，请刷新重试。');
      const opensPermission = patch.segments.some((s, i) => s.writable && !entry.segments[i].writable);
      const content = patch.segments.map(s => s.text).join('');
      if (content.length > 1000000) throw bookError('条目正文超过 100 万字符，未保存。');
      entry.segments = patch.segments.map(({ id, text, writable }) => ({ id, text, writable }));
      addHistory(entry, content, 'manual', '用户手动修改');
      entry.classification = 'manual'; entry.protectedReason = '';
      if (opensPermission) requestRecheck(data, entry);
    }
    else if (patch.content !== undefined) {
      if (typeof patch.content !== 'string' || patch.content.length > 1000000 || entry.segments.length !== 1) throw bookError('混合条目请逐片段编辑，正文最多 100 万字符。');
      addHistory(entry, patch.content, 'manual', '用户手动修改'); entry.segments[0].text = patch.content;
      entry.classification = 'manual';
    }
    if ((patch.content !== undefined || patch.segments !== undefined) && Number.isSafeInteger(entry.recheckFrom)) {
      entry.recheckBase = clone(entry.segments); entry.recheckFrom = 0;
    }
    const result = await save(target, data, previous.revision, guard, signal); wake(); return result;
    });
  };
  function updateWindow(data) {
    const writable = data.entries.filter(canMaintain);
    const rechecking = writable.filter(entry => Number.isSafeInteger(entry.recheckFrom) && entry.recheckFrom < data.processed.length);
    if (!rechecking.length) return { from: data.processed.length, to: null, entries: writable, rechecking: false };
    const from = Math.min(...rechecking.map(entry => entry.recheckFrom));
    return { from, to: data.processed.length, entries: rechecking.filter(entry => entry.recheckFrom === from), rechecking: true };
  }
  function pendingState(target, data, window = { from: data.processed.length, to: null }) {
    const state = memoryState();
    if (state.chatId !== target.identity.chatId || state.memorySnapshotStatus !== 'ready') return { floors: [], reason: '等待当前聊天的千千结记忆读取完成' };
    const byIndex = new Map(), unavailable = new Map();
    for (const floor of state.floors ?? []) {
      if (floor.frozen || floor.inherited) unavailable.set(floor.messageIndex, '属于冻结或继承记忆，当前更新流程不读取该楼');
      else if (floor.status !== 'ready') unavailable.set(floor.messageIndex, '摘要尚未完成，请先在记忆管理中补齐缺失');
    }
    for (const floor of state.floors ?? []) if (floor.status === 'ready' && !floor.frozen && !floor.inherited) {
      for (const index of floor.sourceMessageIndexes ?? [floor.messageIndex]) byIndex.set(index, floor);
    }
    const result = [];
    // A later user turn confirms the selected reply, including replies now hidden by QQJ.
    const lastUser = target.chat.findLastIndex(message => {
      if (message?.is_user !== true || message.extra?.type === 'narrator' || typeof message.mes !== 'string' || !message.mes.trim()) return false;
      const hidden = message.extra?.qianqianjieAutoHide;
      return message.is_system !== true || (hidden?.schemaVersion === 1 && hidden.chatId === target.identity.chatId);
    });
    for (let index = window.from; index < Math.min(target.chat.length, window.to ?? target.chat.length); index += 1) {
      const message = target.chat[index];
      if (message.is_user || message.extra?.type === 'narrator' || message.is_system === true && message.extra?.type) continue;
      const saved = byIndex.get(index);
      if (index >= lastUser || saved?.sourceMessageIndexes?.some(i => i >= lastUser)) {
        return { floors: result, reason: '等待你发送下一条聊天消息后，再处理本轮 AI 回复' };
      }
      if (!saved) return { floors: result, reason: `第 ${index} 楼${unavailable.get(index) ?? '尚无可用记忆，等待摘要完成；旧楼可在记忆管理中补齐缺失'}` };
      if (saved.sourceUnavailable) return { floors: result, reason: `等待第 ${index} 楼的记忆与当前回复同步` };
      const cse = cseForFloor(saved, state);
      if (!['ready', 'noChange'].includes(cse?.status) || !Array.isArray(cse.record?.endStateSubjects)) return { floors: result, reason: `第 ${index} 楼 CSE 尚未完成，请先在记忆管理中补齐人物状态` };
      result.push({ index, saved });
    }
    return { floors: result, reason: '' };
  }
  function pendingFloors(target, data) {
    return pendingState(target, data).floors.map(({ index, saved }) => ({ index, summary: saved.summary ?? '',
      text: sanitizeMemoryContent(target.chat[index].mes, sanitizerOptions()) }));
  }
  function updateReadiness(target, data) {
    if (!target) return '等待当前聊天身份准备完成';
    if (!data) return '尚未建立或读取动态世界书副本';
    if (!data.enabled) return '当前聊天未启用动态世界书';
    if (data.updateMode === 'paused') return '已暂停维护，已有副本仍可用于聊天';
    if (operation?.kind === 'updating') return '正在检查更新条件或处理本批资料';
    if (operation) return '等待当前动态世界书任务完成';
    if (isGenerating()) return '等待聊天回复生成结束';
    const memory = memoryState();
    if (memory.memoryWorkBusy || memory.activeCse || memory.activeExtraction) return '等待千千结摘要和 CSE 任务结束';
    if (!data.entries.some(canMaintain) && data.entries.some(e => canReadEntry(e) && !e.sourceConflict && e.classification === 'pending')) return '尚未调用：请先继续分类维护权限';
    if (!data.entries.some(canMaintain)) return '尚未调用：没有允许自动更新的条目或正文片段';
    if (data.updateHold) return '上次更新失败或中断，自动更新已暂停；请点击手动更新／重试';
    const window = updateWindow(data), pending = pendingState(target, data, window);
    if (window.rechecking && pending.floors.length) return `正在补核 ${window.entries.length} 个条目的历史（从第 ${window.from} 楼起），其余条目的进度保留`;
    if (!pending.floors.length) return pending.reason ? `尚未调用：${pending.reason}`
      : data.processed.length ? '已检查到当前可用末尾，等待新的已记忆 AI 回复' : '尚未调用：当前没有可处理的已记忆 AI 回复';
    if (!data.automatic) return `自动更新已关闭；有 ${pending.floors.length} 楼可手动更新`;
    if (!data.catchingUp && pending.floors.length < data.interval) return `尚未调用：已攒 ${pending.floors.length}/${data.interval} 条已记忆 AI 回复${pending.reason ? `；${pending.reason}` : ''}。可点击立即更新一批`;
    if (updateAttempt?.key === target.key && ['failed', 'stopped'].includes(updateAttempt.receipt.status)) return '上次任务未完成，可点击立即更新一批重试';
    return `有 ${pending.floors.length} 楼待核对，等待自动更新或点击立即更新一批`;
  }
  function newUpdateReceipt() {
    return { version: 1, status: 'running', at: new Date().toISOString(), floors: [], calls: 0, responses: 0, changedEntries: 0, api: null };
  }
  async function update({ manual = false } = {}) {
    if (operation || isGenerating()) { emit(); if (manual) throw bookError('请等当前任务结束后更新。'); return; }
    const memory = memoryState();
    if (memory.memoryWorkBusy || memory.activeCse || memory.activeExtraction) { emit(); if (manual) throw bookError('请等千千结摘要和 CSE 处理完成。'); return; }
    return run('updating', async (target, guard, signal) => {
      const previous = await load(target, guard);
      if (!previous.data?.enabled || !manual && (!previous.data.automatic || previous.data.updateHold)) return;
      const data = clone(previous.data);
      if (data.updateMode === 'paused') { if (manual) throw bookError('维护已暂停，请先切换为手动或自动模式。'); return; }
      const sourceAtStart = await checkedSource(target, data, guard);
      const window = updateWindow(data), writable = window.entries;
      if (!writable.length && data.entries.some(e => canReadEntry(e) && !e.sourceConflict && e.classification === 'pending')) {
        if (manual) throw bookError('请先点击“继续分类维护权限”，完成分类后再更新资料。');
        return;
      }
      if (!writable.length) return;
      const pending = pendingState(target, data, window).floors;
      if (!pending.length) {
        if (window.rechecking && !pendingState(target, data, window).reason) {
          for (const entry of window.entries) { delete entry.recheckFrom; delete entry.recheckBase; }
          await save(target, data, previous.revision, guard, signal); wake();
        }
        return;
      }
      if (!manual && !window.rechecking && !data.catchingUp && pending.length < data.interval) return;
      const captured = target.chat.map(messageSignature);
      const attempt = stableJson([target.key, previous.revision, captured]);
      if (!manual && lastAutomaticAttempt === attempt) return;
      failure = '';
      // A manual batch follows the saved size even during historical catch-up.
      // Background catch-up stays small; merged memories remain indivisible.
      let count = Math.min(pending.length, manual ? data.interval : data.catchingUp || window.rechecking ? 3 : 20);
      // Never split a single merged memory across historical batches.
      while (count < pending.length && (pending[count - 1].saved.sourceMessageIndexes ?? []).includes(pending[count].index)) count++;
      const floors = pending.slice(0, count);
      const end = floors.at(-1).index;
      for (const { index, saved } of floors) {
        const sourceId = saved.sourceFloorIds?.[saved.sourceMessageIndexes?.indexOf(index)];
        const expected = saved.memory?.sourceFloorSnapshots?.find(item => item.floorId === sourceId)?.rawFingerprint
          ?? (index === saved.messageIndex ? saved.memory?.sourceRawFingerprint ?? saved.rawFingerprint : null);
        if (!expected) continue;
        const selected = selectAssistantMessage(target.chat[index]);
        if (!selected || `sha256:${await sha256(selected.rawContent)}` !== expected) {
          guard();
          failure = `等待第 ${index} 楼的记忆与当前选中的回复同步`;
          return;
        }
      }
      guard();
      lastAutomaticAttempt = attempt;
      const receipt = newUpdateReceipt();
      updateAttempt = { key: target.key, receipt }; emit();
      await checkedHistory(target, data, guard);
      const checkFrame = () => {
        if (captured.length !== target.chat.length || captured.some((value, index) => value !== messageSignature(target.chat[index]))) throw abortError();
      };
      checkFrame();
      const snapshot = memoryState();
      const sourceInput = buildWorldbookSources({ pending: floors, state: snapshot, chat: target.chat, from: window.from,
        sanitize: text => sanitizeMemoryContent(text, sanitizerOptions()) });
      const systemPrompt = buildWorldbookUpdatePrompt(updateGuidance(), processingPrompt());
      const sourceSignature = stableJson(sourceInput);
      receipt.floors = floors.map(floor => floor.index);
      receipt.materials = { memoryFloors: [...new Set(sourceInput.sources.filter(s => s.kind === 'memory').flatMap(s => s.floors))],
        backgroundFloors: [...new Set(sourceInput.sources.filter(s => s.kind === 'background').flatMap(s => s.floors))],
        dialogueFloors: sourceInput.sources.filter(s => s.kind === 'dialogue').flatMap(s => s.floors),
        cseFloor: end, cseSubjects: sourceInput.cseSnapshot.subjectCount };
      receipt.decisions = [];
      // Persist a hold before spending tokens. Reloading or new chat messages cannot silently retry a failed batch.
      await save(target, { ...data, updateHold: true }, previous.revision, guard, signal);
      const revision = cached.revision;
      let next = data;
      const materials = writable.map(({ uid, label, segments }) => ({ uid, label, segments: segments.filter(s => s.writable).map(({ id, text }) => ({ id, text })) }));
      for (const batch of batches(materials)) {
        checkFrame();
        receipt.calls += 1; emit();
        const response = await generateUpdate({ systemPrompt,
          promptTask: 'worldbookUpdate', promptOwnerId: target.identity.chatId,
          taskMessages: [{ role: 'user', content: JSON.stringify({ entries: batch, ...sourceInput }) }],
          maxTokens: 12000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic' });
        guard();
        receipt.responses += 1;
        if (response?.taskMetadata) receipt.api = { model: String(response.taskMetadata.model ?? '').slice(0, 160), sourceLabel: String(response.taskMetadata.sourceLabel ?? '').slice(0, 160) };
        emit();
        const result = validateWorldbookDecision(jsonResult(response), sourceInput, batch);
        receipt.decisions.push(...result.changes.map(c => ({ kind: 'changed', uid: c.uid, reason: c.reason, evidenceRefs: c.evidenceRefs })),
          ...(result.unchangedReason ? [{ kind: 'unchanged', reason: result.unchangedReason, evidenceRefs: [] }] : []),
          ...result.reviewNeeded.map(r => ({ kind: 'review', ...r })));
        next = applyChanges(next, result, [...new Set(sourceInput.sources.flatMap(s => s.floors))].map(index => ({ index })));
      }
      guard();
      if ((await checkedSource(target, data, guard)).signature !== sourceAtStart.signature) throw bookError('更新期间原书发生变化，本批未保存，请同步后重试。');
      if (window.rechecking) {
        for (const entry of next.entries) if (window.entries.some(input => input.uid === entry.uid)) {
          if (pending.length === floors.length && !pendingState(target, data, window).reason) { delete entry.recheckFrom; delete entry.recheckBase; }
          else entry.recheckFrom = end + 1;
        }
      } else {
        next.processed = await witness(target.chat, end); next.catchingUp = pending.length > floors.length;
      }
      guard();
      next.updateHold = false;
      checkFrame();
      const latest = memoryState();
      if (latest.memoryWorkBusy || latest.activeCse || latest.activeExtraction || isGenerating()) throw abortError();
      const refreshed = pendingState(target, data, window).floors.filter(f => f.index <= end);
      if (refreshed.length !== floors.length || stableJson(buildWorldbookSources({ pending: refreshed, state: latest, chat: target.chat, from: window.from,
        sanitize: text => sanitizeMemoryContent(text, sanitizerOptions()) })) !== sourceSignature) throw abortError();
      const changedEntries = next.entries.filter((entry, index) => entry.content !== data.entries[index].content).length;
      next.lastUpdate = { ...receipt, at: new Date().toISOString(), status: changedEntries ? 'updated' : 'unchanged', changedEntries };
      await save(target, next, revision, guard, signal);
      updateAttempt = { key: target.key, receipt: clone(cached.data.lastUpdate) }; emit();
      wake();
    });
  }
  async function prepare(type = 'normal') {
    plan = null; lastSelection = null;
    if (!isEnabled() || !['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
    // Chat generation gets priority over background maintenance, with no late mutation of its source.
    if (operation) { operation.controller.abort(); await operation.promise.catch(() => {}); }
    return run('selecting', async (target, guard, signal) => {
      const previous = await load(target, guard, true), data = previous.data;
      if (!data?.enabled || !data.entries.some(e => e.managed)) return;
      const book = await checkedSource(target, data, guard);
      if (!data.entries.some(e => canReadEntry(e) && e.managed && e.classification !== 'pending')) {
        lastSelection = { selected: [], status: '尚无可用动态条目；待同步或待分类的条目继续按原书处理。' }; emit(); return;
      }
      if (data.catchingUp && data.processed.length && data.entries.some(canMaintain) && pendingFloors(target, data).length) throw bookError('动态资料正在追平历史，本轮仍使用原世界书。可在设置中立即更新。');
      await checkedHistory(target, data, guard);
      if (data.selectionMode === 'native') {
        plan = { target, selected: [], data: clone(data), frame: target.chat.map(messageSignature), token: epoch, mode: 'native' };
        lastSelection = { selected: [], status: '沿用酒馆触发规则，本轮未调用世界书选材 AI' }; emit(); return;
      }
      const constants = new Set(book.entries.filter(e => e.constant).map(e => e.uid));
      const native = new Set(book.entries.filter(nativeSelectionReason).map(e => e.uid));
      const candidates = data.entries.filter(e => canReadEntry(e) && e.managed && entryContentForSending(e, data) !== null && e.classification !== 'pending' && e.kind !== 'rule' && !native.has(e.uid) && !constants.has(e.uid));
      const frame = target.chat.map(messageSignature);
      const recent = target.chat.slice(-8).map(m => ({ role: m.is_user ? 'user' : 'assistant', content: sanitizeMemoryContent(m.mes, sanitizerOptions()).slice(-6000) }));
      let selected = [];
      const sourceById = new Map(book.entries.map(entry => [entry.uid, entry]));
      const catalog = sortWorldbookSelectionEntries(candidates.map(entry => ({ uid: entry.uid, label: entry.label, content: entryContentForSending(entry, data), keys: sourceById.get(entry.uid)?.key ?? [] })));
      for (const batch of batches(catalog)) {
        const request = buildWorldbookSelectionRequest({ entries: batch, recent });
        let correction = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
          guard();
          // Only retry locally detected output problems, never transport/provider failures.
          const response = await generateSelect({ systemPrompt: withBaseProcessingPrompt(request.systemPrompt + correction, processingPrompt()),
            promptTask: 'worldbookSelect', promptOwnerId: target.identity.chatId,
            taskMessages: request.taskMessages,
            maxTokens: 2000, temperature: 0, signal, includeCharacterCard: false, worldInfoSource: 'none', parseMode: 'semantic' });
          guard();
          try {
            selected.push(...request.decode(jsonResult(response)));
            break;
          } catch (error) {
            if (attempt === 1) throw bookError(`选材纠正重试后仍失败：${error.message}。本轮使用原世界书。`);
            correction = `\n上次回复校验未通过：${error.message}。请重新选材，只返回一个完整 JSON 对象，selected 为 uid 字符串数组。允许的 uid：${JSON.stringify(request.allowedIds)}。`;
          }
        }
      }
      guard();
      if (frame.length !== target.chat.length || frame.some((value, index) => value !== messageSignature(target.chat[index]))) throw abortError();
      if ((await checkedSource(target, data, guard)).signature !== book.signature) throw bookError('选材期间原书发生变化，请重新发送。');
      guard();
      if (frame.length !== target.chat.length || frame.some((value, index) => value !== messageSignature(target.chat[index]))) throw abortError();
      plan = { target, selected, data: clone(data), frame, token: epoch };
      lastSelection = { book: data.book, selected: [...selected, ...data.entries.filter(e => canReadEntry(e) && e.managed && constants.has(e.uid)).map(e => e.uid)], status: '已选材，最终发送仍受酒馆预算约束' };
      emit();
    });
  }
  function apply(payload) {
    const p = plan;
    if (!p || p.token !== epoch || !isEnabled() || !current(p.target) || primaryBook(hostAdapter.getContext()) !== p.data.book || !isBookAllowed(p.data.book)) return;
    if (p.frame.length !== p.target.chat.length || p.frame.some((value, index) => value !== messageSignature(p.target.chat[index]))) { plan = null; return; }
    overlayCandidates(payload, p, p.data);
  }
  function wake() {
    if (disposed || timer || !isEnabled()) return;
    timer = setTimeout(() => { timer = null; if (!disposed) void update().catch(() => {}); }, 600);
  }
  function bind({ eventSource, eventTypes = {} }) {
    const on = (key, callback) => { const name = eventTypes[key]; if (name && eventSource?.on) { eventSource.on(name, callback); bindings.push(() => eventSource.removeListener?.(name, callback)); } };
    on('WORLDINFO_ENTRIES_LOADED', apply);
    on('MESSAGE_SENT', wake);
    for (const key of ['CHAT_CHANGED', 'CHAT_RENAMED', 'PERSONA_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'WORLDINFO_UPDATED']) on(key, () => { abortAll(); cached = null; failure = ''; emit(); });
    on('GENERATION_STARTED', () => { abortAll(); });
    on('GENERATION_STOPPED', abortAll);
    on('GENERATION_ENDED', () => { plan = null; wake(); });
  }
  async function intercept(recall, coreChat, contextSize, abort, type) {
    let aborted = false;
    const stop = (...args) => { aborted = true; abort(...args); };
    const result = await recall(coreChat, contextSize, stop, type);
    if (aborted) return result;
    try { await prepare(type); }
    catch (error) {
      plan = null;
      if (error.name === 'AbortError') { stop(true); return; }
      lastSelection = { selected: [], status: `已退回原世界书：${error.message}` };
      notifyUser(`动态世界书本轮未启用：${error.message}`); emit();
    }
    return result;
  }
  return { getState, getActivityState: () => ({ busy: phase !== 'idle', phase: phase !== 'idle' ? 'worldbook' : null }), refresh, initialize, syncSource, resolveSource, classify, configure, edit, bulkEdit, update, prepare, apply, intercept, wake, bind, abortAll,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { disposed = true; abortAll(); bindings.forEach(fn => fn()); listeners.clear(); } };
}
