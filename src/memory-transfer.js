import { sha256, isUuid } from './identity.js';
import { CHAT_IDENTITY_COLLECTION } from './chat-identity.js';
import { createFoundationStore } from './v3/foundation-store.js';
import { captureTargetChatDescriptor } from './v3/host-adapter.js';
import { readTargetChat } from './v3/message-floor-anchor.js';
import { validatePeopleWorkspace } from './v3/people-workspace.js';
import { vectorRecordOwned } from './v3/vector-index.js';
import { normalizeStoryCalendar } from './v3/calendar-rules.js';
import { selectAssistantMessage } from './v3/foundation-domain.js';
import { DYNAMIC_BOOK_RECORD, validateBook, primaryBook, sourceEntries, bookFingerprint, stableJson } from './dynamic-worldbook.js';

export const MEMORY_PACKAGE_LIMIT = 64 * 1024 * 1024;
const FORMAT = 'qqj-chat-memory', VERSION = 1, ROLLBACK = 'self-use-memory-transfer-rollback-v1';
const ANCHOR = 'qianqianjie_floor', HIDDEN = 'qianqianjieAutoHide', RECEIPT = 'qqj_v3_recall_receipt';
const clone = value => structuredClone(value);
const fail = message => Object.assign(new Error(message), { code: 'QQJ_MEMORY_TRANSFER' });
const check = (condition, message) => { if (!condition) throw fail(message); };
const same = (a, b) => stableJson(a) === stableJson(b);
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const coreTypes = new Set(['root', 'floor', 'run', 'checkpoint', 'floorMemory', 'entity', 'baseline', 'stateDelta', 'currentState', 'migrationDescriptor', 'index']);
const isAux = id => id === DYNAMIC_BOOK_RECORD || id === 'v3-people-workspace' || /^v3-people-snapshot-[\da-f-]{36}$/i.test(id)
  || id === 'v3-time-head' || /^v3-time-batch-[\da-f]{32}$/.test(id) || id === 'qqj-vector-index' || /^qqj-vector-shard-[\da-f]{40}$/.test(id);

// Names and avatars may change on another device. Compare the entire selected
// conversation, including swipe selection and user timestamps used by stability proofs.
export async function transferWitness(chat) {
  check(Array.isArray(chat) && chat.length > 0 && chat.length <= 20000, '聊天内容为空或超过支持的楼数。');
  return Promise.all(chat.map(async message => sha256(stableJson({
    user: message.is_user === true, system: message.is_system === true && message.extra?.[HIDDEN]?.schemaVersion !== 1,
    text: String(message.mes ?? '').replace(/\r\n?/g, '\n'),
    swipe: message.swipe_id ?? null, swipes: message.swipes ?? null,
    sentAt: message.is_user ? message.send_date ?? null : null,
    userNameWithoutTimestamp: message.is_user && !message.send_date ? String(message.name ?? '').trim().slice(0, 200) : null,
    narrator: message.extra?.type === 'narrator',
  }))));
}

function memoryClient(records, chatId) {
  const data = new Map(records.map(item => [item.id, clone(item.data)]));
  return {
    async get(collection, id) {
      if (collection !== `chat-${chatId}` || !data.has(id)) throw Object.assign(new Error('missing'), { status: 404 });
      return { data: clone(data.get(id)), revision: 1 };
    },
    async put(collection, id, value) { data.set(id, clone(value)); return { data: clone(value), revision: 1 }; },
  };
}

async function validateRecords(records, chatId) {
  check(Array.isArray(records) && records.length > 0 && records.length <= 50000, '记忆包记录数量无效。');
  const client = memoryClient(records, chatId), store = createFoundationStore({ client, contextProvider: () => ({ chatId }) });
  const seen = new Set();
  for (const item of records) {
    check(item && typeof item.id === 'string' && !seen.has(item.id) && item.data?.chatId === chatId, '记忆包有重复记录或归属不一致。');
    seen.add(item.id);
    if (coreTypes.has(item.data.recordType)) {
      check(store.recordKey(item.data) === item.id, '记忆记录编号不匹配。');
      await store.readRecord(item.data.recordType, item.id);
    } else {
      check(isAux(item.id), '记忆包包含不支持的记录类型。');
      if (item.id === DYNAMIC_BOOK_RECORD) validateBook(item.data, chatId);
      else if (item.id === 'v3-people-workspace') validatePeopleWorkspace(item.data, chatId);
      else if (item.id.startsWith('v3-people-snapshot-')) {
        check(item.data.kind === 'qqj-v3-frozen-people-snapshot' && isUuid(item.data.sourceChatId), '人物历史副本无效。');
        validatePeopleWorkspace(item.data.workspace, chatId);
      } else if (item.id.startsWith('qqj-vector-')) check(vectorRecordOwned({ recordId: item.id, data: item.data }), '向量记录无效。');
      else check(item.data.schemaVersion === 1 && (item.id === 'v3-time-head' ? Array.isArray(item.data.batchIds) : item.data.id === item.id), '时间记录无效。');
    }
  }
  const graph = await store.readReachable({ mode: 'full' });
  check(graph.status === 'ready' && graph.checkpoint && !graph.root.activeRunId, '记忆包的摘要或人物状态记录不完整，请等待旧设备处理完成后重新导出。');
  const byId = new Map(records.map(item => [item.id, item.data]));
  for (const id of [...(byId.get('v3-time-head')?.batchIds ?? []), ...(byId.get('qqj-vector-index')?.shardIds ?? []),
    ...(graph.migrationDescriptor?.recordRefs?.timeBatchIds ?? []), ...(graph.migrationDescriptor?.recordRefs?.peopleSnapshotIds ?? []),
    ...(graph.migrationDescriptor?.recordRefs?.vectorShardIds ?? [])]) check(byId.has(id), '记忆包缺少关联的时间、人物或向量记录。');
  return graph;
}

export async function parseMemoryPackage(input) {
  check(bytes(input) <= MEMORY_PACKAGE_LIMIT, '记忆包不能超过 64 MB。');
  let value;
  try { value = typeof input === 'string' ? JSON.parse(input) : clone(input); } catch { throw fail('文件不是有效的 JSON 记忆包。'); }
  check(value?.format === FORMAT && value.formatVersion === VERSION && isUuid(value.source?.chatId), '这不是支持的千千结记忆包。请用“导出当前聊天记忆”生成文件。');
  const { checksum, ...payload } = value;
  check(typeof checksum === 'string' && checksum === await sha256(stableJson(payload)), '记忆包完整性校验失败，文件可能损坏。');
  check(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 20000
    && value.messages.every(hash => /^[a-f0-9]{64}$/.test(hash)), '聊天核对信息无效。');
  check(Array.isArray(value.markers) && value.markers.length === value.messages.length, '楼层标记数量不匹配。');
  check(value.prequel === null || typeof value.prequel === 'string', '前情内容无效。');
  check(value.calendar === null || normalizeStoryCalendar(value.calendar), '故事历法设置无效。');
  const graph = await validateRecords(value.records, value.source.chatId);
  const aliases = new Set((graph.migrationDescriptor?.carriedAliases ?? []).map(alias => alias.aliasId));
  for (const markers of value.markers) {
    check(markers && typeof markers.extra === 'object' && Array.isArray(markers.swipes), '楼层标记格式无效。');
    for (const extra of [markers.extra, ...markers.swipes]) {
      check(extra && typeof extra === 'object' && !Array.isArray(extra), '楼层标记格式无效。');
      const anchor = extra[ANCHOR], hidden = extra[HIDDEN], alias = extra.qianqianjie_migration_alias;
      if (anchor) check(anchor.schemaVersion === 1 && anchor.chatId === value.source.chatId && isUuid(anchor.floorId), '楼层锚点无效。');
      if (hidden) check(hidden.schemaVersion === 1 && hidden.chatId === value.source.chatId, '隐藏楼层标记无效。');
      if (alias) check(aliases.has(alias), '搬家楼层标记无效。');
    }
  }
  return { value, graph };
}

async function verifyConversation(graph, chat) {
  const frozen = new Set(graph.migrationDescriptor?.frozenFloorIds ?? []);
  for (const floor of graph.floors) {
    if (frozen.has(floor.id)) continue;
    const message = chat[floor.hostLocator.messageIndex], selected = selectAssistantMessage(message);
    check(selected && `sha256:${await sha256(selected.rawContent)}` === floor.content.rawFingerprint,
      '记忆中的楼层与聊天正文不一致，请在旧设备刷新记忆状态后重新导出。');
  }
}

function ownedMarkers(message, chatId, aliases) {
  const select = extra => Object.fromEntries([ANCHOR, HIDDEN, 'qianqianjie_migration_alias'].filter(key => key === 'qianqianjie_migration_alias'
    ? aliases.has(extra?.[key]) : extra?.[key]?.schemaVersion === 1 && extra[key].chatId === chatId).map(key => [key, clone(extra[key])]));
  return { extra: select(message.extra), swipes: (message.swipe_info ?? []).map(item => select(item?.extra)) };
}
function exportMarkers(chat, graph) {
  const chatId = graph.root.chatId, frozen = new Set(graph.migrationDescriptor?.frozenFloorIds ?? []);
  const aliases = new Set((graph.migrationDescriptor?.carriedAliases ?? []).map(alias => alias.aliasId));
  const markers = chat.map(message => ownedMarkers(message, chatId, aliases));
  // A native export may omit or contain stale inline markers. The validated
  // live graph owns these anchors; never regenerate floor IDs on the new device.
  for (const floor of graph.floors) if (!frozen.has(floor.id)) {
    const item = markers[floor.hostLocator.messageIndex];
    if (item) item.extra[ANCHOR] = { schemaVersion: 1, chatId, floorId: floor.id };
  }
  return markers;
}
function rehomeRecord(item, chatId) {
  const data = { ...clone(item.data), chatId };
  if (data.workspace) data.workspace.chatId = chatId;
  return { id: item.id, data };
}

export function createMemoryTransfer({ client, session, hostAdapter, isBusy = () => false, quiesce = async () => {},
  onSettled = async () => {}, captureCalendar = () => null, persistCalendar = async () => {},
  fetchImpl = globalThis.fetch, freshUuid = () => globalThis.crypto.randomUUID(), now = () => new Date(), pluginVersion = '0.7.8' } = {}) {
  let active = false;
  const previews = new WeakMap();
  const capture = () => {
    const snapshot = hostAdapter.snapshot(), identity = session.identity();
    return { identity, target: captureTargetChatDescriptor(snapshot, identity), persona: clone(snapshot.userIdentity), chat: clone(snapshot.chat), metadata: clone(snapshot.context.chatMetadata) };
  };
  const current = captured => {
    const snap = hostAdapter.snapshot();
    const character = snap.context.characters?.[snap.context.characterId];
    check(snap.chatId === captured.identity.hostChatId && character?.avatar === captured.target.avatarUrl
      && same(snap.userIdentity, captured.persona)
      && snap.context.chatMetadata?.qianqianjie?.chatId === captured.identity.chatId
      && same(snap.chat, captured.chat) && same(snap.context.chatMetadata, captured.metadata), '聊天已切换或内容有变化，请重新选择记忆包并预览。');
  };
  async function exclusive(captured, task) {
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再操作。'); current(captured);
    active = true;
    let suspended = false;
    try {
      session.suspend(captured.identity.chatId); suspended = true;
      await quiesce(); current(captured);
      return await task();
    } finally {
      if (suspended) session.resume(captured.identity.chatId);
      active = false;
      try { await onSettled(); } catch { /* Saved state can be reloaded from the host. */ }
    }
  }
  async function exportCurrent() {
    const captured = capture();
    return exclusive(captured, async () => {
      const collected = new Map();
      const tracking = { ...client, async get(collection, id) { const result = await client.get(collection, id); collected.set(id, result); return result; } };
      const store = createFoundationStore({ client: tracking, contextProvider: () => captured.identity });
      const graph = await store.readReachable({ mode: 'full' });
      check(graph.status === 'ready' && graph.checkpoint && !graph.root.activeRunId, '当前记忆尚未准备好，请先刷新状态或补齐缺失。');
      const list = await client.list(`chat-${captured.identity.chatId}`);
      check(Array.isArray(list), '存储接口未返回记录清单。');
      for (const record of list) if (isAux(record.recordId) && record.data?.chatId === captured.identity.chatId) collected.set(record.recordId, record);
      const records = [...collected].map(([id, record]) => ({ id, data: clone(record.data) }));
      await validateRecords(records, captured.identity.chatId);
      await verifyConversation(graph, captured.chat);
      const verify = await client.list(`chat-${captured.identity.chatId}`);
      check([...collected].every(([id, old]) => verify.some(item => item.recordId === id && item.revision === old.revision && same(item.data, old.data)))
        && verify.filter(item => isAux(item.recordId)).length === list.filter(item => isAux(item.recordId)).length, '导出期间记忆发生变化，请重试。');
      current(captured);
      const payload = { format: FORMAT, formatVersion: VERSION, pluginVersion, exportedAt: now().toISOString(),
        source: { chatId: captured.identity.chatId, character: captured.target.characterName },
        messages: await transferWitness(captured.chat), markers: exportMarkers(captured.chat, graph), records,
        prequel: typeof captured.metadata.qianqianjiePrequel === 'string' ? captured.metadata.qianqianjiePrequel : null,
        calendar: clone(captureCalendar(captured.identity.chatId)) };
      const value = { ...payload, checksum: await sha256(stableJson(payload)) };
      check(bytes(value) <= MEMORY_PACKAGE_LIMIT, '导出数据超过第一版支持的 64 MB。');
      return { filename: `千千结记忆-${now().toISOString().replace(/[:.]/g, '-')}.qqj-memory.json`, text: JSON.stringify(value) };
    });
  }
  async function dynamicCompatibility(value) {
    const book = value.records.find(item => item.id === DYNAMIC_BOOK_RECORD)?.data;
    if (!book) return { name: null, status: '记忆包不含动态世界书。' };
    try {
      const ctx = hostAdapter.getContext(), name = primaryBook(ctx), loader = ctx.loadWorldInfo ?? hostAdapter.getWorldInfoBindings?.().loadWorldInfo;
      if (name && loader && await bookFingerprint(sourceEntries(await loader(name))) === book.sourceHash) return { name, status: '世界书一致：恢复动态副本、权限与修改记录。' };
    } catch { /* A changed or unavailable book must never receive an old overlay. */ }
    return { name: null, status: '世界书已变化或无法核对：跳过旧动态副本，保留新版世界书。摘要与人物状态仍可恢复。' };
  }
  async function preview(input) {
    check(!active && !isBusy(), '请等待聊天生成和记忆任务完成后再导入。');
    const captured = capture(), { value, graph } = await parseMemoryPackage(input);
    check(same(await transferWitness(captured.chat), value.messages), '当前聊天与记忆包不一致（正文、楼数或候选发生变化）。请先导入同一次导出的酒馆 JSONL 聊天，再打开它。');
    await verifyConversation(graph, captured.chat);
    const dynamic = await dynamicCompatibility(value); current(captured);
    const oldRoot = await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root'); current(captured);
    const result = Object.freeze({ character: value.source.character, messages: value.messages.length,
      summaries: graph.floorMemories.filter(item => item.recordStatus === 'active' && item.summary).length,
      states: graph.stateDeltas.filter(item => item.recordStatus === 'active').length,
      dynamic: dynamic.status, replacesMemory: Boolean(oldRoot?.data?.headCheckpointId), exportedAt: value.exportedAt });
    previews.set(result, { captured, value, dynamic, oldRoot });
    return result;
  }
  async function optionalGet(collection, id) { try { return await client.get(collection, id); } catch (error) { if (error.status === 404) return null; throw error; } }
  async function publish(captured, initial, header, messages, chatId) {
    current(captured);
    const latest = await readTargetChat(captured.target, { fetchImpl });
    check(same(initial, latest), '聊天文件在导入期间有变化，已停止，原记忆保留。');
    current(captured);
    const response = await fetchImpl('/api/chats/save', { method: 'POST', cache: 'no-cache', headers: captured.target.requestHeaders,
      body: JSON.stringify({ ch_name: captured.target.characterName, file_name: captured.target.hostChatId,
        avatar_url: captured.target.avatarUrl, chat: [header, ...messages], force: false }) });
    check(response?.ok, '聊天文件未能保存。原记忆数据仍保留，请重新打开聊天核对状态。');
    const saved = await readTargetChat({ ...captured.target, chatId }, { fetchImpl });
    const withoutIntegrity = value => { const result = clone(value); delete result.chat_metadata.integrity; return result; };
    check(same(saved.chat, messages) && same(withoutIntegrity(saved.header), withoutIntegrity(header)), '保存后的聊天未通过核对。请重新打开聊天；原记忆仍可通过撤销导入恢复。');
    // Never refresh a different chat or overwrite an edit made while saving.
    try {
      current(captured);
      const snapshot = hostAdapter.snapshot();
      snapshot.chat.splice(0, snapshot.chat.length, ...clone(saved.chat));
      Object.keys(snapshot.context.chatMetadata).forEach(key => delete snapshot.context.chatMetadata[key]);
      Object.assign(snapshot.context.chatMetadata, clone(saved.header.chat_metadata));
    } catch { return { reload: true }; }
    return { reload: false };
  }
  async function importPreview(previewValue) {
    const plan = previews.get(previewValue);
    check(plan, '预览已失效，请重新选择文件。'); previews.delete(previewValue);
    const { captured, value, dynamic, oldRoot } = plan;
    return exclusive(captured, async () => {
      check(same(oldRoot, await optionalGet(`chat-${captured.identity.chatId}`, 'v3-root')), '预览后记忆发生变化，请重新预览。');
      const initial = await readTargetChat(captured.target, { fetchImpl });
      check(same(initial.chat, captured.chat) && same(initial.header.chat_metadata, captured.metadata), '当前聊天尚未保存完成，请稍后重新预览。');
      const dynamicNow = await dynamicCompatibility(value);
      check(dynamicNow.name === dynamic.name, '预览后世界书发生变化，请重新预览。'); current(captured);
      const chatId = freshUuid(); check(isUuid(chatId) && chatId !== captured.identity.chatId && chatId !== value.source.chatId, '新记忆编号无效。');
      check((await client.list(`chat-${chatId}`)).length === 0, '新记忆编号已存在，请重试。');
      const records = value.records.filter(item => item.id !== DYNAMIC_BOOK_RECORD || dynamic.name).map(item => rehomeRecord(item, chatId));
      const book = records.find(item => item.id === DYNAMIC_BOOK_RECORD); if (book) book.data.book = dynamic.name;
      await validateRecords(records, chatId);
      // Everything is staged in a fresh collection. The old collection is never overwritten.
      for (const item of records.filter(item => item.id !== 'v3-root')) {
        current(captured);
        const saved = await client.put(`chat-${chatId}`, item.id, item.data, 0);
        check(same(saved.data, item.data), '新副本的存储返回内容不一致，未切换当前记忆。');
      }
      const root = records.find(item => item.id === 'v3-root').data;
      const store = createFoundationStore({ client, contextProvider: () => ({ ...captured.identity, chatId }) });
      const committed = await store.commitRoot(root, 0);
      check(committed.status === 'saved', '新副本写入冲突，未切换当前记忆。');
      if (value.calendar) await persistCalendar(chatId, value.calendar);
      const createdAt = now().toISOString();
      await client.put(CHAT_IDENTITY_COLLECTION, `binding-${chatId}`, { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId,
        owner: { hostChatId: captured.identity.hostChatId, characterLocator: captured.identity.characterLocator, personaLocator: captured.identity.personaLocator },
        state: 'ready', sourceChatId: value.source.chatId, createdAt, updatedAt: createdAt }, 0);
      const header = clone(initial.header), messages = clone(initial.chat);
      header.chat_metadata.qianqianjie = { schemaVersion: 2, chatId };
      if (value.prequel === null) delete header.chat_metadata.qianqianjiePrequel; else header.chat_metadata.qianqianjiePrequel = value.prequel;
      messages.forEach((message, index) => {
        const apply = (extra, markers) => {
          const next = { ...extra }; delete next[RECEIPT]; delete next[ANCHOR]; delete next[HIDDEN]; delete next.qianqianjie_migration_alias;
          for (const key of [ANCHOR, HIDDEN, 'qianqianjie_migration_alias']) if (markers?.[key] !== undefined) {
            next[key] = clone(markers[key]);
            if (next[key]?.chatId === value.source.chatId) next[key].chatId = chatId;
          }
          return next;
        };
        message.extra = apply(message.extra, value.markers[index].extra);
        if (Array.isArray(message.swipe_info)) message.swipe_info.forEach((swipe, n) => { swipe.extra = apply(swipe.extra, value.markers[index].swipes?.[n]); });
      });
      await client.put(`chat-${chatId}`, ROLLBACK, { schemaVersion: 1, chatId, previousChatId: captured.identity.chatId,
        header: initial.header, messages: initial.chat, importedMessages: await transferWitness(messages), importedRoot: root }, 0);
      const result = await publish(captured, initial, header, messages, chatId);
      return { ...result, chatId, summaries: previewValue.summaries, dynamic: dynamic.status };
    });
  }
  async function undo() {
    const captured = capture();
    return exclusive(captured, async () => {
      const rollback = (await optionalGet(`chat-${captured.identity.chatId}`, ROLLBACK))?.data;
      check(rollback?.schemaVersion === 1 && rollback.chatId === captured.identity.chatId, '当前聊天没有可撤销的导入。');
      check(same(await transferWitness(captured.chat), rollback.importedMessages), '导入后已继续聊天或修改正文。请先导出当前记忆；本次不覆盖新剧情。');
      const initial = await readTargetChat(captured.target, { fetchImpl });
      check(same(initial.chat, captured.chat) && same(initial.header.chat_metadata, captured.metadata), '当前聊天尚未保存完成，请稍后重试。');
      const header = clone(initial.header), messages = clone(initial.chat);
      header.chat_metadata.qianqianjie = clone(rollback.header.chat_metadata.qianqianjie);
      if (rollback.header.chat_metadata.qianqianjiePrequel === undefined) delete header.chat_metadata.qianqianjiePrequel;
      else header.chat_metadata.qianqianjiePrequel = rollback.header.chat_metadata.qianqianjiePrequel;
      messages.forEach((message, index) => {
        const restore = (extra, previous) => { const result = { ...extra }; for (const key of [ANCHOR, HIDDEN, RECEIPT, 'qianqianjie_migration_alias']) {
          delete result[key]; if (previous?.[key] !== undefined) result[key] = clone(previous[key]);
        } return result; };
        message.extra = restore(message.extra, rollback.messages[index].extra);
        message.is_system = rollback.messages[index].is_system;
        message.swipe_info?.forEach((swipe, n) => { swipe.extra = restore(swipe.extra, rollback.messages[index].swipe_info?.[n]?.extra); });
      });
      return publish(captured, initial, header, messages, rollback.previousChatId);
    });
  }
  return Object.freeze({ exportCurrent, preview, importPreview, undo, getState: () => ({ active }) });
}
