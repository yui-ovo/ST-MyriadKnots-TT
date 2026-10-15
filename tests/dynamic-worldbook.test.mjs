import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, bookFingerprint, createBook, createDynamicBookStore, DYNAMIC_BOOK_RECORD, overlayCandidates, protectedReason, nativeSelectionReason, classifyEntry, validateBook, stableJson, sourceEntries, verifyWitness, witness } from '../src/dynamic-worldbook.js';
import { createDynamicWorldbookRuntime } from '../src/dynamic-worldbook-runtime.js';
import { createCompactApiClient } from '../src/compact-api-client.js';
import { createTaskRouter } from '../src/api-routing.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const completedFloor = floor => ({ summary: '搬家', cse: { status: 'noChange', record: { endStateSubjects: [] } }, ...floor });
const raw = () => ({ entries: {
  1: { uid: 1, comment: '住所', key: ['旧公寓'], content: '甲住在旧公寓。', constant: false, selective: true, keysecondary: [] },
  2: { uid: 2, comment: '城市', key: ['城市'], content: '城市临海。', constant: true },
  3: { uid: 3, comment: 'MVU变量', content: '<% getvar("stat_data") %>' },
  4: { uid: 4, comment: '事件', content: '三轮后发生。', delay: 3 },
} });
function memoryClient() {
  const records = new Map(), writes = [];
  const client = {
    async get(collection, id) { const item = records.get(`${collection}/${id}`); if (!item) throw Object.assign(new Error('missing'), { status: 404 }); return structuredClone(item); },
    async put(collection, id, data, expectedRevision, { signal } = {}) {
      if (signal?.aborted) throw new DOMException('stop', 'AbortError');
      const key = `${collection}/${id}`, revision = records.get(key)?.revision ?? 0;
      if (expectedRevision !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
      const value = { revision: revision + 1, data: structuredClone(data) };
      records.set(key, value); writes.push({ collection, id }); return structuredClone(value);
    },
  };
  return { client, records, writes };
}
async function fixture(t, overrides = {}) {
  const storage = memoryClient(), book = overrides.book ?? raw(), warnings = [], events = new Map();
  let identity = { chatId: CHAT, hostChatId: 'chat-a', characterLocator: 'a.png', personaLocator: 'u.png' }, enabled = true, generating = false;
  let context = { chatId: 'chat-a', groupId: null, characters: [{ data: { extensions: { world: '书' } } }], characterId: 0,
    chat: [{ mes: '甲住在旧公寓。', is_user: false }, { mes: '我们搬家吧', is_user: true }, { mes: '甲搬入新家，旧公寓已经退租。', is_user: false }, { mes: '好的', is_user: true }] };
  let state = { chatId: CHAT, memorySnapshotStatus: 'ready', floors: [0, 2].map(messageIndex => completedFloor({ status: 'ready', messageIndex, summary: '搬家', sourceMessageIndexes: [messageIndex] })) };
  let updates = 0, selections = 0;
  const reply = async (request, result) => {
    result = await result;
    if (!overrides.rawUpdate && Array.isArray(result?.jsonData?.changes)) {
      result = structuredClone(result);
      const input = JSON.parse(request.taskMessages[0].content);
      result.jsonData.unchangedReason ??= '本批没有新的设定变化'; result.jsonData.reviewNeeded ??= [];
      for (const change of result.jsonData.changes) {
        change.segmentId ??= 'body';
        change.evidenceRefs ??= (change.floors ?? []).map(index => input.sources.find(s => s.kind === 'memory' && s.floors.includes(index))?.id ?? `invalid:${index}`);
      }
    }
    if (!overrides.apiTransport) return result;
    const compactClient = createCompactApiClient({ fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '```json\n' + JSON.stringify(result.jsonData) + '\n```' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
    const route = () => ({ kind: 'independent', config: { url: 'https://example.invalid/v1', key: 'test', model: 'test' } });
    const router = createTaskRouter({ compactClient, resolver: { resolve: route, resolveUtility: route, resolveRecall: route } });
    return router.generateUtilityTask(request);
  };
  const runtime = createDynamicWorldbookRuntime({ client: storage.client,
    hostAdapter: { getContext: () => context, getWorldInfoBindings: () => ({ loadWorldInfo: async () => structuredClone(book) }) },
    identityProvider: () => identity, memoryState: () => state, isEnabled: () => enabled, isGenerating: () => generating,
    processingPrompt: () => overrides.processing ?? '', updateGuidance: () => overrides.guidance ?? '',
    generateUpdate: async request => {
      if (request.systemPrompt.includes('分析世界书资料的维护权限')) {
        if (overrides.classify) return reply(request, overrides.classify(request));
        return reply(request, { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: e.uid === '3' ? 'rule' : 'fact', segments: [{ id: 'body', writable: e.uid !== '3' }] })) } });
      }
      updates++; return reply(request, overrides.update ? overrides.update(request) : { jsonData: { changes: [{ uid: '1', content: '甲已经搬入新家。', reason: '正文明确搬入新家', floors: [2] }] } }); },
    generateSelect: async request => { selections++; return reply(request, overrides.select ? overrides.select(request) : { jsonData: { selected: ['1'] } }); },
    notifyUser: text => warnings.push(text), isBookAllowed: () => overrides.allowed !== false,
  });
  t.after(() => runtime.dispose());
  const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'WORLDINFO_ENTRIES_LOADED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'WORLDINFO_UPDATED'].map(key => [key, key]));
  runtime.bind({ eventTypes, eventSource: { on(key, fn) { events.set(key, fn); }, removeListener(key) { events.delete(key); } } });
  if (overrides.allowed !== false && !overrides.skipSetup) {
    await runtime.initialize(); await runtime.classify(); await runtime.edit('1', { managed: true }); await runtime.edit('2', { managed: true });
    await runtime.configure({ enabled: true, interval: 1 });
  }
  return { runtime, book, context, warnings, events, ...storage,
    get updates() { return updates; }, get selections() { return selections; },
    setState: value => { state = { ...state, ...value, ...(value.floors ? { floors: value.floors.map(completedFloor) } : {}) }; }, setEnabled: value => { enabled = value; }, setGenerating: value => { generating = value; },
    switchChat() { identity = { ...identity, chatId: OTHER, hostChatId: 'chat-b' }; context = { ...context, chatId: 'chat-b', chat: [{ mes: '另一个故事', is_user: false }] }; events.get('CHAT_CHANGED')(); },
    payload() { return { characterLore: Object.values(structuredClone(book.entries)).map(entry => ({ ...entry, world: '书' })), globalLore: [], chatLore: [], personaLore: [] }; },
  };
}
test('update combines memory, historical CSE and all visible completed dialogue with prompt ordering', async t => {
  const requests = [];
  const f = await fixture(t, { processing: 'PREFIX_MARKER', guidance: 'GUIDANCE_MARKER', update: request => { requests.push(request); return { jsonData: { changes: [] } }; } });
  f.context.chat[0].is_system = true;
  f.context.chat[0].mes = 'HIDDEN_BODY';
  f.setState({ cseSubjects: [{ displayName: 'FUTURE_STATE_NOT_ALLOWED' }], floors: [0, 2].map(messageIndex => ({ status: 'ready', messageIndex, summary: `MEMORY_${messageIndex}`,
    cse: { status: 'ready', record: { endStateSubjects: [{ subjectEntityId: 'person', displayName: '甲', core: [], adaptive: [], situational: [{ text: `STATE_AT_${messageIndex}`, visibility: 'private' }] }] } } })) });
  await f.runtime.update({ manual: true });
  const input = JSON.parse(requests[0].taskMessages[0].content);
  assert.match(requests[0].systemPrompt, /^PREFIX_MARKER\n\nGUIDANCE_MARKER/);
  assert.match(requests[0].systemPrompt, /固定输出与权限要求/);
  assert.ok(input.sources.some(s => s.id === 'memory:0' && s.text === 'MEMORY_0'));
  assert.deepEqual(input.sources.filter(s => s.kind === 'dialogue').map(s => [s.floors[0], s.role]), [[1, 'user'], [2, 'assistant']]);
  assert.match(JSON.stringify(input), /STATE_AT_2/);
  assert.doesNotMatch(JSON.stringify(input), /HIDDEN_BODY|STATE_AT_0|FUTURE_STATE_NOT_ALLOWED/);
  const r = f.runtime.getState().lastUpdate;
  assert.deepEqual(r.materials.dialogueFloors, [1, 2]); assert.equal(r.materials.cseFloor, 2);
  assert.equal(r.decisions[0].kind, 'unchanged'); assert.ok(r.decisions[0].reason);
});

test('missing CSE prevents updating that floor and reports a waiting reason', async t => {
  const f = await fixture(t);
  f.setState({ floors: [{ status: 'ready', messageIndex: 0, cse: { status: 'failed' } }] });
  await f.runtime.update({ manual: true });
  assert.equal(f.updates, 0); assert.match(f.runtime.getState().updateReadiness, /第 0 楼 CSE/);
});

test('invented evidence is rejected and automatic failure hold survives reload and new messages', async t => {
  let valid = false;
  const f = await fixture(t, { rawUpdate: true, update: () => ({ jsonData: valid
    ? { changes: [], unchangedReason: '现状没有变化', reviewNeeded: [] }
    : { changes: [{ uid: '1', segmentId: 'body', content: '未知地点', reason: '不存在的证据', evidenceRefs: ['memory:999'] }], reviewNeeded: [] } }) });
  await assert.rejects(f.runtime.update(), /无效证据/);
  await f.runtime.refresh(); assert.equal(f.runtime.getState().data.updateHold, true);
  const reloaded = createDynamicWorldbookRuntime({ client: f.client, hostAdapter: { getContext: () => f.context },
    identityProvider: () => ({ chatId: CHAT, hostChatId: 'chat-a', characterLocator: 'a.png', personaLocator: 'u.png' }),
    memoryState: () => ({}), generateUpdate: () => { throw new Error('must not call'); } });
  t.after(() => reloaded.dispose());
  await reloaded.update(); assert.equal(reloaded.getState().data.updateHold, true);
  f.context.chat.push({ is_user: false, mes: '另一轮' });
  f.setState({ floors: [0, 2, 4].map(messageIndex => ({ status: 'ready', messageIndex })) });
  await f.runtime.update(); assert.equal(f.updates, 1);
  assert.equal(f.runtime.getState().data.entries[0].content, '甲住在旧公寓。');
  valid = true; await f.runtime.update({ manual: true });
  assert.equal(f.updates, 2); assert.equal(f.runtime.getState().data.updateHold, false);
  assert.equal(f.runtime.getState().lastUpdate.decisions[0].reason, '现状没有变化');
});

test('manual and paused modes avoid automatic calls; normal interval consumes five memories in one request', async t => {
  const f = await fixture(t, { update: () => ({ jsonData: { changes: [] } }) });
  await f.runtime.configure({ updateMode: 'manual', interval: 5 });
  await f.runtime.update(); assert.equal(f.updates, 0);
  await f.runtime.update({ manual: true }); assert.equal(f.updates, 1);
  await f.runtime.configure({ updateMode: 'paused' });
  await assert.rejects(f.runtime.update({ manual: true }), /暂停/);
  await f.runtime.configure({ updateMode: 'auto' });
  for (let i = 0; i < 5; i++) {
    if (i) f.context.chat.push({ is_user: true, mes: '继续' });
    f.context.chat.push({ is_user: false, mes: `变化 ${i}` });
    f.setState({ floors: [0, 2, ...Array.from({ length: i + 1 }, (_, j) => 4 + j * 2)].map(messageIndex => ({ status: 'ready', messageIndex })) });
    await f.runtime.update();
    assert.equal(f.updates, i === 4 ? 2 : 1);
  }
  assert.deepEqual(f.runtime.getState().lastUpdate.floors, [4, 6, 8, 10, 12]);
  await f.runtime.update(); assert.equal(f.updates, 2);
});

test('changed CSE during a request rejects late output without overwriting the copy', async t => {
  let release;
  const f = await fixture(t, { update: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.runtime.update({ manual: true });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.setState({ floors: [0, 2].map(messageIndex => ({ status: 'ready', messageIndex, summary: '记忆被更正' })) });
  release({ jsonData: { changes: [] } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.runtime.getState().data.processed.length, 0);
  assert.equal(f.runtime.getState().data.updateHold, true);
});

test('native selection replaces only the local copy and preserves keyword activation without calls', async t => {
  const f = await fixture(t);
  await f.runtime.edit('1', { content: '副本新家' });
  await f.runtime.configure({ selectionMode: 'native', updateMode: 'paused' });
  await f.runtime.prepare(); const payload = f.payload(); f.runtime.apply(payload);
  assert.equal(f.selections, 0); assert.equal(payload.characterLore[0].constant, false);
  assert.deepEqual(payload.characterLore[0].key, ['旧公寓']);
  assert.equal(payload.characterLore[0].content, '副本新家');
  assert.equal(f.book.entries[1].content, '甲住在旧公寓。');
});

test('activation metadata is independent of maintenance permission; executable syntax is recognized separately', () => {
  for (const entry of [{ content: 'x', sticky: 3 }, { content: 'x', keysecondary: ['a'], selective: true }, { content: 'x', extensions: { arbitrary: true } }]) {
    assert.equal(protectedReason(entry), ''); assert.ok(nativeSelectionReason(entry));
  }
  assert.ok(protectedReason({ content: '<% script %>' }));
  assert.equal(protectedReason({ content: '{{char}}住在{{user}}隔壁。' }), '');
});

test('book fingerprint survives native TT object-key reordering', async () => {
  assert.equal(await bookFingerprint([{ uid: 'a', key: ['x'], content: 'y' }]), await bookFingerprint([{ content: 'y', key: ['x'], uid: 'a' }]));
});
test('replacement never mutates original rows, keeps constant and protected material, handles book duplicates', async () => {
  const data = await createBook(CHAT, '书', sourceEntries(raw())); data.entries[2].kind = 'rule'; data.entries[0].content = '新家';
  const original = Object.values(raw().entries).map(e => ({ ...e, world: '书' }));
  const snapshot = structuredClone(original), payload = { characterLore: [...original], globalLore: [...original], chatLore: [{ uid: 1, world: '其他书', content: '另一个人' }] };
  overlayCandidates(payload, { selected: ['1'] }, data);
  assert.deepEqual(original, snapshot);
  for (const list of [payload.characterLore, payload.globalLore]) { assert.equal(list[0].content, '新家'); assert.equal(list[0].constant, true); assert.equal(list[2].content, raw().entries[3].content); }
  assert.equal(payload.chatLore[0].content, '另一个人');
  const empty = { characterLore: [...original] }; overlayCandidates(empty, { selected: [] }, data);
  assert.deepEqual(empty.characterLore.map(e => e.uid), [2, 3, 4]);
});
test('CAS and corrupt record handling do not turn failures into empty records', async () => {
  const { client, records } = memoryClient(), store = createDynamicBookStore(client), data = await createBook(CHAT, '书', sourceEntries(raw()));
  await store.write(CHAT, data, 0); await assert.rejects(store.write(CHAT, data, 0), { status: 409 });
  records.set(`chat-${CHAT}/${DYNAMIC_BOOK_RECORD}`, { revision: 2, data: { schemaVersion: 9 } });
  await assert.rejects(store.read(CHAT), /数据无效/);
});
test('invalid or unauthorized model change rejects the whole batch', async () => {
  const data = await createBook(CHAT, '书', sourceEntries(raw())); data.entries[0].managed = true; data.entries[0].segments[0].writable = true;
  const good = { uid: '1', content: '新家', reason: '搬家', floors: [2] };
  for (const bad of [{ ...good, uid: '2' }, { ...good, floors: [99] }, { ...good, content: '<script>alert(1)</script>' }, { ...good, reason: '' }]) {
    assert.throws(() => applyChanges(data, { changes: [good, bad] }, [{ index: 2 }]));
    assert.equal(data.entries[0].content, data.entries[0].original);
  }
});
test('saved witness ignores auto-hide flags but detects edited text, swipe and deletion', async () => {
  const chat = [{ mes: 'a', is_user: false }], saved = await witness(chat, 0);
  chat[0].is_system = true; assert.equal(await verifyWitness(chat, saved), true);
  assert.equal(await verifyWitness([], saved), false);
  chat[0].mes = 'b'; assert.equal(await verifyWitness(chat, saved), false);
});
test('update persists evidence and reload survives; generation replaces rather than appends', async t => {
  const f = await fixture(t); await f.runtime.update({ manual: true });
  const e = f.runtime.getState().data.entries[0]; assert.equal(e.content, '甲已经搬入新家。'); assert.deepEqual(e.history[0].floors, [2]);
  await f.runtime.refresh(); assert.equal(f.runtime.getState().data.processed.length, 3);
  await f.runtime.prepare(); const payload = f.payload(); f.runtime.apply(payload);
  assert.equal(payload.characterLore[0].content, e.content); assert.equal(payload.characterLore.length, 4);
  assert.equal(f.book.entries[1].content, '甲住在旧公寓。');
  assert.equal(f.updates, 1); assert.equal(f.selections, 1);
});
test('manual edits preserve permissions; explicit protection blocks the model and restore is reviewable', async t => {
  const f = await fixture(t);
  await f.runtime.edit('1', { content: '甲住在用户指定地点。' });
  assert.equal(f.runtime.getState().data.entries[0].segments[0].writable, true);
  await f.runtime.edit('1', { writable: false });
  await assert.rejects(f.runtime.update({ manual: true }), /未授权或锁定/);
  assert.equal(f.runtime.getState().data.entries[0].content, '甲住在用户指定地点。');
  await f.runtime.edit('1', { restore: true });
  assert.equal(f.runtime.getState().data.entries[0].content, '甲住在旧公寓。');
});
test('history change stops use of updated copy until explicit rebuild', async t => {
  const f = await fixture(t); await f.runtime.update({ manual: true }); f.context.chat[0].mes = '不同的开场';
  await assert.rejects(f.runtime.prepare(), /旧楼被编辑/);
  const p = f.payload(); f.runtime.apply(p); assert.equal(p.characterLore[0].content, '甲住在旧公寓。');
});
test('source worldbook changes, including conditions, suspend replacement', async t => {
  const f = await fixture(t); await f.runtime.update({ manual: true }); f.book.entries[1].sticky = 3;
  await assert.rejects(f.runtime.prepare(), /原世界书已变化/);
  const p = f.payload(); f.runtime.apply(p); assert.equal(p.characterLore[0].content, '甲住在旧公寓。');
});
test('late maintenance after switching chat cannot persist into either chat', async t => {
  let resolve; const f = await fixture(t, { update: () => new Promise(r => { resolve = r; }) });
  const before = f.writes.length, pending = f.runtime.update({ manual: true });
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  f.switchChat(); resolve({ jsonData: { changes: [] } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.writes.length, before + 1, '仅提前保存暂停标记，迟到结果不能写入');
  const old = await createDynamicBookStore(f.client).read(CHAT);
  assert.equal(old.data.updateHold, true); assert.equal(old.data.entries[0].content, '甲住在旧公寓。');
  await f.runtime.refresh(); assert.equal(f.runtime.getState().data, null);
});
test('stop and disabled master never apply cached plan', async t => {
  const f = await fixture(t); await f.runtime.edit('1', { content: '新家' }); await f.runtime.prepare();
  f.setEnabled(false); const p = f.payload(); f.runtime.apply(p); assert.equal(p.characterLore[0].content, '甲住在旧公寓。');
  f.setEnabled(true); f.events.get('GENERATION_STOPPED')(); const q = f.payload(); f.runtime.apply(q); assert.equal(q.characterLore[0].content, '甲住在旧公寓。');
});
test('selection failure falls back with visible diagnostic; recall abort skips selection', async t => {
  const f = await fixture(t, { select: () => ({ jsonData: { selected: ['not-found'] } }) });
  let aborts = 0; await f.runtime.intercept(async () => {}, [], 1000, () => { aborts++; }, 'normal');
  assert.equal(aborts, 0); assert.equal(f.warnings.length, 1); assert.match(f.runtime.getState().lastSelection.status, /原世界书/);
  assert.equal(f.selections, 2); assert.match(f.warnings[0], /本批候选以外的编号/);
  const payload = f.payload(), original = structuredClone(payload); f.runtime.apply(payload); assert.deepEqual(payload, original);
  const count = f.selections; await f.runtime.intercept(async (chat, size, abort) => abort(true), [], 1000, () => { aborts++; }, 'normal');
  assert.equal(f.selections, count); assert.equal(aborts, 1);
});

test('actual API textData envelope works for classification, maintenance and selection', async t => {
  const f = await fixture(t, { apiTransport: true });
  await f.runtime.update({ manual: true });
  await f.runtime.prepare();
  const payload = f.payload(); f.runtime.apply(payload);
  assert.equal(payload.characterLore[0].content, '甲已经搬入新家。');
  assert.equal(f.book.entries[1].content, '甲住在旧公寓。');
  assert.equal(f.updates, 1); assert.equal(f.selections, 1);
  assert.equal(f.warnings.length, 0);
  const receipt = f.runtime.getState().lastUpdate;
  assert.equal(receipt.status, 'updated'); assert.equal(receipt.changedEntries, 1);
  assert.equal(receipt.calls, 1); assert.equal(receipt.responses, 1);
  assert.deepEqual(receipt.floors, [0, 2]); assert.equal(receipt.api.model, 'test');
  const saved = await createDynamicBookStore(f.client).read(CHAT);
  assert.deepEqual(saved.data.lastUpdate, receipt, '成功回执与资料一起持久保存');
});

test('unchanged updates have a durable receipt and waiting does not overwrite it', async t => {
  const f = await fixture(t, { update: () => ({ jsonData: { changes: [] } }) });
  await f.runtime.update({ manual: true });
  const receipt = f.runtime.getState().lastUpdate;
  assert.equal(receipt.status, 'unchanged'); assert.equal(receipt.changedEntries, 0);
  assert.equal(receipt.calls, 1); assert.equal(f.runtime.getState().data.entries[0].history.length, 0);
  assert.equal(f.runtime.getState().data.processed.length, 3);
  await f.runtime.update();
  assert.deepEqual(f.runtime.getState().lastUpdate, receipt);
  assert.match(f.runtime.getState().updateReadiness, /等待新的/);
  assert.equal((await createDynamicBookStore(f.client).read(CHAT)).data.lastUpdate.status, 'unchanged');
});

test('readiness names memory gaps, batch threshold and busy state without claiming a model call', async t => {
  const f = await fixture(t);
  f.setState({ floors: [{ status: 'ready', messageIndex: 2 }] });
  await f.runtime.update();
  assert.equal(f.runtime.getState().lastUpdate, null); assert.equal(f.updates, 0);
  assert.match(f.runtime.getState().updateReadiness, /第 0 楼尚无可用记忆/);
  f.setState({ floors: [{ status: 'ready', messageIndex: 0, frozen: true }] });
  assert.match(f.runtime.getState().updateReadiness, /冻结或继承/);
  f.setState({ memoryWorkBusy: true });
  await f.runtime.update(); assert.match(f.runtime.getState().updateReadiness, /CSE/);
  f.setState({ memoryWorkBusy: false, floors: [0, 2].map(messageIndex => ({ status: 'ready', messageIndex })) });
  await f.runtime.update(); await f.runtime.configure({ interval: 3 });
  f.context.chat.push({ mes: '新的剧情', is_user: false });
  f.setState({ floors: [0, 2, 4].map(messageIndex => ({ status: 'ready', messageIndex })) });
  await f.runtime.update(); assert.match(f.runtime.getState().updateReadiness, /已攒 1\/3/);
  assert.equal(f.updates, 1);
});

test('update receipt shows in-flight calls, failure and chat isolation without persisting failed results', async t => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { update: () => response });
  const pending = f.runtime.update({ manual: true });
  while (!f.updates) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.getState().lastUpdate.status, 'running');
  assert.equal(f.runtime.getState().lastUpdate.calls, 1);
  assert.equal(f.runtime.getState().lastUpdate.responses, 0);
  release({ jsonData: {} });
  await assert.rejects(pending);
  const receipt = f.runtime.getState().lastUpdate;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.responses, 1);
  assert.equal((await createDynamicBookStore(f.client).read(CHAT)).data.lastUpdate, undefined);
  f.switchChat(); assert.equal(f.runtime.getState().lastUpdate, null);
});

test('empty update response failure receipt reports the actual API model', async t => {
  const f = await fixture(t, { update: () => { throw Object.assign(new Error('模型没有返回内容'), {
    code: 'QQJ_EMPTY', taskMetadata: { sourceLabel: '世界书专用', model: 'book-model' },
  }); } });
  await assert.rejects(f.runtime.update({ manual: true }), { code: 'QQJ_EMPTY' });
  assert.deepEqual(f.runtime.getState().lastUpdate.api, { sourceLabel: '世界书专用', model: 'book-model' });
  assert.equal(f.runtime.getState().lastUpdate.responses, 0);
});

test('selection normalizes exact numeric IDs and whitespace without a second API call', async t => {
  const f = await fixture(t, { select: () => ({ textData: '{"selected":[1," 1 ",1]}' }) });
  await f.runtime.prepare();
  assert.deepEqual(f.runtime.getState().lastSelection.selected, ['1', '2']);
  assert.equal(f.selections, 1);
});

test('invalid selection is corrected once using only the same allowed candidates', async t => {
  const requests = [];
  const f = await fixture(t, { select: request => {
    requests.push(request);
    return { textData: requests.length === 1 ? '{"selected":["住所"]}' : '{"selected":["1"]}' };
  } });
  await f.runtime.prepare();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].taskMessages, requests[1].taskMessages);
  assert.match(requests[1].systemPrompt, /允许的 uid：\["1"\]/);
  assert.deepEqual(f.runtime.getState().lastSelection.selected, ['1', '2']);
});

test('missing, malformed and truncated selection output gets one correction; empty selection is valid', async t => {
  for (const response of [{ textData: 'not json' }, { textData: '{}' }, { textData: '{"selected":["1"]}', taskMetadata: { finishReason: 'length' } }]) {
    let calls = 0;
    const f = await fixture(t, { select: () => ++calls === 1 ? response : { textData: '{"selected":[]}' } });
    await f.runtime.prepare();
    assert.equal(calls, 2);
    assert.deepEqual(f.runtime.getState().lastSelection.selected, ['2']);
  }
});

test('provider failure and chat switch never trigger a selection correction', async t => {
  const failure = Object.assign(new Error('provider failure'), { code: 'QQJ_PROVIDER_ERROR' });
  const f = await fixture(t, { select: () => { throw failure; } });
  await assert.rejects(f.runtime.prepare(), error => error === failure);
  assert.equal(f.selections, 1);
  const switched = await fixture(t, { select: () => { switched.switchChat(); return { textData: '{}' }; } });
  await assert.rejects(switched.runtime.prepare(), { name: 'AbortError' });
  assert.equal(switched.selections, 1);
});
test('quiet generations make no selection calls and never use old plans', async t => {
  const f = await fixture(t); await f.runtime.prepare('quiet'); assert.equal(f.selections, 0);
});
test('automatic update respects interval, memory gaps and QQJ busy state', async t => {
  const f = await fixture(t); await f.runtime.configure({ interval: 3 }); await f.runtime.update(); assert.equal(f.updates, 1, '首次历史补齐不等待攒满间隔');
  f.context.chat.push({ mes: '一天过去', is_user: false }, { mes: '继续', is_user: true });
  f.setState({ floors: [0, 2, 4].map(messageIndex => ({ status: 'ready', messageIndex })) });
  await f.runtime.update(); assert.equal(f.updates, 1, '之后不足间隔不调用');
  f.setState({ memoryWorkBusy: true }); await assert.rejects(f.runtime.update({ manual: true }), /CSE/); assert.equal(f.updates, 1);
  f.setState({ memoryWorkBusy: false, floors: [{ status: 'failed', messageIndex: 0 }, { status: 'ready', messageIndex: 2 }] });
  await f.runtime.update({ manual: true }); assert.equal(f.updates, 1);
});
test('bad background response does not loop on unchanged input', async t => {
  const f = await fixture(t, { update: () => ({ jsonData: {} }) });
  await assert.rejects(f.runtime.update()); await f.runtime.update(); assert.equal(f.updates, 1);
  assert.equal(f.runtime.getState().data.processed.length, 0);
});
test('excluded worldbooks cannot be initialized', async t => {
  const f = await fixture(t, { allowed: false }); await assert.rejects(f.runtime.initialize(), /排除/); assert.equal(f.writes.length, 0);
});
test('old editor confirmation cannot edit a new chat with the same entry uid', async t => {
  const f = await fixture(t); f.switchChat(); await f.runtime.initialize(); const before = f.writes.length;
  await assert.rejects(f.runtime.edit('1', { content: '旧窗口的输入' }, CHAT), /聊天已切换/);
  await assert.rejects(f.runtime.initialize({ expectedChatId: CHAT }), /聊天已切换/);
  assert.equal(f.writes.length, before);
});
test('partial historical scan is not injected as current world state', async t => {
  const f = await fixture(t, { update: () => ({ jsonData: { changes: [] } }) });
  f.context.chat.push({ mes: '更晚的剧情', is_user: false }, { mes: '继续', is_user: true }, { mes: '现在的剧情', is_user: false });
  f.setState({ floors: [0, 2, 4, 6].map(messageIndex => ({ status: 'ready', messageIndex })) });
  await f.runtime.update({ manual: true }); assert.equal(f.runtime.getState().data.catchingUp, true);
  await assert.rejects(f.runtime.prepare(), /追平历史/);
  await f.runtime.update({ manual: true }); assert.equal(f.runtime.getState().data.catchingUp, false);
  await f.runtime.prepare(); assert.equal(f.selections, 1);
});

test('mixed classification preserves every original byte and ambiguous boundaries require review', async () => {
  const book = await createBook(CHAT, '书', sourceEntries({ entries: { 1: { content: '规则：固定输出。\r\n现状：住在旧家。\n', comment: '规则和人物' } } }));
  const original = book.entries[0];
  const classified = classifyEntry(original, { kind: 'npc', segments: [{ id: 'rule', writable: false }, { id: 'state', start: '现状：', writable: true }] });
  assert.equal(classified.segments.map(s => s.text).join(''), original.original);
  assert.equal(classified.segments[0].text, '规则：固定输出。\r\n');
  assert.equal(classified.classification, 'ready');
  for (const segments of [
    [{ id: 'x', writable: true, text: '模型重抄正文' }],
    [{ id: 'x', writable: false }, { id: 'y', writable: true, start: '不存在' }],
    [{ id: 'x', writable: true }, { id: 'x', writable: true, start: '现状：' }],
  ]) {
    const reviewed = classifyEntry(original, { kind: 'npc', segments });
    assert.equal(reviewed.classification, 'review'); assert.equal(reviewed.content, original.content);
    assert.ok(reviewed.segments.every(s => !s.writable));
  }
  const rule = classifyEntry(original, { kind: 'rule', segments: [{ id: 'body', writable: true }] });
  assert.equal(rule.segments[0].writable, false);
});

test('legacy migration keeps edits, history, participation and locks without writing on read', async () => {
  const { client, records, writes } = memoryClient(), store = createDynamicBookStore(client);
  const data = await createBook(CHAT, '书', sourceEntries(raw())); data.schemaVersion = 1;
  for (const entry of data.entries) { delete entry.segments; delete entry.kind; delete entry.classification; }
  data.entries[0].content = '手动新家'; data.entries[0].locked = true;
  data.entries[0].history = [{ before: '旧家', after: '手动新家', at: '2026-10-13', kind: 'manual', reason: '用户', floors: [] }];
  data.entries[1].managed = false; data.entries[1].protectedReason = '含扩展规则';
  records.set(`chat-${CHAT}/${DYNAMIC_BOOK_RECORD}`, { data, revision: 7 });
  const migrated = await store.read(CHAT);
  assert.equal(writes.length, 0); assert.equal(migrated.revision, 7); assert.equal(migrated.data.schemaVersion, 2);
  assert.equal(migrated.data.entries[0].content, '手动新家'); assert.equal(migrated.data.entries[0].locked, true);
  assert.deepEqual(migrated.data.entries[0].history, data.entries[0].history);
  assert.equal(migrated.data.entries[1].managed, false); assert.equal(migrated.data.entries[1].classification, 'pending');
  assert.equal(records.get(`chat-${CHAT}/${DYNAMIC_BOOK_RECORD}`).data.schemaVersion, 1);
  await store.write(CHAT, migrated.data, 7);
  assert.equal((await store.read(CHAT)).data.entries[0].segments[0].text, '手动新家');
});

test('mixed maintenance sends only writable segments and rejects protected writes atomically', async t => {
  let captured;
  const f = await fixture(t, { update: request => {
    captured = JSON.parse(request.taskMessages[0].content);
    return { jsonData: { changes: [{ uid: '1', segmentId: 'state', content: '住在新家。', reason: '搬家', floors: [2] }] } };
  } });
  const key = `chat-${CHAT}/${DYNAMIC_BOOK_RECORD}`, record = f.records.get(key);
  record.data.entries[0].segments = [{ id: 'rule', text: '甲', writable: false }, { id: 'state', text: '住在旧公寓。', writable: true }];
  await f.runtime.refresh(); await f.runtime.update({ manual: true });
  const sent = captured.entries.find(e => e.uid === '1');
  assert.deepEqual(sent.segments, [{ id: 'state', text: '住在旧公寓。' }]);
  const data = f.runtime.getState().data, entry = data.entries[0];
  assert.equal(entry.content, '甲住在新家。'); assert.equal(entry.segments[0].text, '甲');
  assert.throws(() => applyChanges(data, { changes: [
    { uid: '1', segmentId: 'state', content: '另一个家。', reason: '搬家', floors: [2] },
    { uid: '1', segmentId: 'rule', content: '坏掉的规则', reason: '违规', floors: [2] },
  ] }, [{ index: 2 }]), /未授权/);
  assert.equal(entry.content, '甲住在新家。');
});

test('conditional facts remain editable and host activation fields are never overridden', async t => {
  const f = await fixture(t);
  await f.runtime.edit('4', { content: '事件现状已经改变。' });
  await f.runtime.prepare(); const payload = f.payload(); f.runtime.apply(payload);
  const event = payload.characterLore.find(e => e.uid === 4);
  assert.equal(event.content, '事件现状已经改变。'); assert.equal(event.delay, 3);
  assert.equal(event.constant, undefined);
  assert.equal(f.runtime.getState().data.entries.find(e => e.uid === '4').segments[0].writable, true);
});

test('protected rule text can be manually edited but cannot be granted automatic rule maintenance', async t => {
  const f = await fixture(t);
  await f.runtime.edit('3', { content: '<% getvar("user-chosen") %>' });
  assert.equal(f.runtime.getState().data.entries[2].content, '<% getvar("user-chosen") %>');
  await assert.rejects(f.runtime.edit('3', { writable: true }), /规则类/);
  await f.runtime.prepare(); const payload = f.payload(); f.runtime.apply(payload);
  assert.equal(payload.characterLore[2].content, '<% getvar("user-chosen") %>');
  assert.equal(payload.characterLore[2].constant, undefined);
});

test('stale editor cannot overwrite newer content or permissions', async t => {
  const f = await fixture(t), old = f.runtime.getState().data.entries[0];
  await f.runtime.edit('1', { content: '另一次保存' });
  await assert.rejects(f.runtime.edit('1', { content: '旧草稿', expectedEntry: stableJson(old) }), /新版本/);
  assert.equal(f.runtime.getState().data.entries[0].content, '另一次保存');
});

test('classification resumes completed batches and preserves manually reviewed entries', async t => {
  let count = 0, fail = false;
  const f = await fixture(t, { classify: request => {
    count++;
    if (fail && count === 3) throw new Error('classification offline');
    return { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: 'fact', segments: [{ id: 'body', writable: true }] })) } };
  } });
  for (let i = 5; i <= 20; i++) f.book.entries[i] = { uid: i, content: `人物${i}的住所。` };
  fail = true;
  await f.runtime.initialize();
  await assert.rejects(f.runtime.classify(), /offline/);
  assert.equal(f.runtime.getState().data.entries.filter(e => e.classification === 'ready').length, 8);
  await f.runtime.configure({ enabled: true });
  await f.runtime.prepare(); assert.equal(f.selections, 0, '未完成分类时不使用半份计划');
  await assert.rejects(f.runtime.update({ manual: true }), /分类/);
  assert.equal(f.updates, 0);
  await f.runtime.edit('9', { writable: false });
  await f.runtime.classify();
  assert.ok(f.runtime.getState().data.entries.every(e => e.classification !== 'pending'));
  assert.equal(f.runtime.getState().data.entries.find(e => e.uid === '9').classification, 'manual');
  assert.equal(f.runtime.getState().data.entries.find(e => e.uid === '9').segments[0].writable, false);
});

test('classification after a chat switch cannot save late results', async t => {
  let resolve, pause = false;
  const f = await fixture(t, { classify: request => pause ? new Promise(r => { resolve = r; }) : { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: 'fact', segments: [{ id: 'body', writable: true }] })) } } });
  pause = true;
  await f.runtime.initialize();
  const pending = f.runtime.classify();
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  const writes = f.writes.length; f.switchChat(); resolve({ jsonData: { entries: [] } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.writes.length, writes);
});

test('disabled entries are absent from every auxiliary request even after legacy participation is enabled', async t => {
  const book = raw(), requests = [];
  for (const [index, flags] of [{ disable: true }, { disabled: true }, { enabled: false }].entries()) {
    const uid = index + 5; book.entries[uid] = { uid, comment: `CLOSED_LABEL_${uid}`, content: `CLOSED_BODY_${uid}`, constant: true, ...flags };
  }
  const f = await fixture(t, { book, skipSetup: true,
    classify: request => { requests.push(request); return { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: 'fact', segments: [{ id: 'body', writable: true }] })) } }; },
    update: request => { requests.push(request); return { jsonData: { changes: [] } }; },
    select: request => { requests.push(request); return { jsonData: { selected: ['1'] } }; },
  });
  await f.runtime.initialize(); assert.equal(requests.length, 0, '本地建档不给模型发送任何正文');
  const record = f.records.get(`chat-${CHAT}/${DYNAMIC_BOOK_RECORD}`);
  for (const entry of record.data.entries) { delete entry.excluded; delete entry.sourceDisabled; }
  await f.runtime.refresh();
  for (const uid of ['5', '6', '7']) {
    assert.equal(f.runtime.getState().data.entries.find(e => e.uid === uid).sourceDisabled, true);
    await f.runtime.edit(uid, { managed: true, writable: true, content: `CHANGED_DISABLED_${uid}` });
    await assert.rejects(f.runtime.classify({ uid }), /禁用/);
  }
  await f.runtime.classify(); await f.runtime.configure({ enabled: true });
  await f.runtime.update({ manual: true }); await f.runtime.prepare();
  assert.ok(requests.length >= 3);
  assert.doesNotMatch(JSON.stringify(requests), /CLOSED_LABEL|CLOSED_BODY|CHANGED_DISABLED/);
  const payload = f.payload(); f.runtime.apply(payload);
  for (const uid of [5, 6, 7]) assert.deepEqual(payload.characterLore.find(e => e.uid === uid), { ...book.entries[uid], world: '书' });
});

test('excluded active status entry keeps native behavior and never enters classification, maintenance or selection', async t => {
  const book = raw(), requests = [];
  book.entries[5] = { uid: 5, comment: 'EXCLUDED_STATUS_LABEL', content: 'EXCLUDED_STATUS_BODY', constant: true, disable: false };
  const f = await fixture(t, { book, skipSetup: true,
    classify: request => { requests.push(request); return { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: 'fact', segments: [{ id: 'body', writable: true }] })) } }; },
    update: request => { requests.push(request); return { jsonData: { changes: [] } }; },
    select: request => { requests.push(request); return { jsonData: { selected: ['1'] } }; },
  });
  await f.runtime.initialize(); await f.runtime.edit('5', { excluded: true });
  await f.runtime.edit('5', { content: 'EDITED_EXCLUDED_STATUS', writable: true });
  await assert.rejects(f.runtime.classify({ uid: '5' }), /排除/);
  await f.runtime.classify(); await f.runtime.configure({ enabled: true });
  await f.runtime.update({ manual: true }); await f.runtime.prepare();
  assert.doesNotMatch(JSON.stringify(requests), /EXCLUDED_STATUS|EDITED_EXCLUDED/);
  assert.equal(f.runtime.getState().lastSelection.selected.includes('5'), false);
  const payload = f.payload(); f.runtime.apply(payload);
  assert.deepEqual(payload.characterLore.find(e => e.uid === 5), { ...book.entries[5], world: '书' });
  const data = f.runtime.getState().data;
  assert.throws(() => applyChanges(data, { changes: [{ uid: '5', content: 'forbidden', reason: 'x', floors: [2] }] }, [{ index: 2 }]), /未授权/);
  await f.runtime.refresh(); assert.equal(f.runtime.getState().data.entries.find(e => e.uid === '5').excluded, true);
  const count = requests.length; await f.runtime.initialize(); assert.equal(requests.length, count);
  assert.equal(f.runtime.getState().data.entries.find(e => e.uid === '5').excluded, true, '重建同一本书不会悄悄撤销排除');
});

test('excluded pending rows do not block ordinary entries and unexclusion restores the classification requirement', async t => {
  const f = await fixture(t, { skipSetup: true }); await f.runtime.initialize();
  for (const uid of ['2', '3', '4']) await f.runtime.edit(uid, { excluded: true });
  await f.runtime.classify(); await f.runtime.configure({ enabled: true });
  await f.runtime.prepare(); assert.equal(f.selections, 1);
  await f.runtime.update({ manual: true }); assert.equal(f.updates, 1);
  await f.runtime.edit('2', { excluded: false });
  await assert.rejects(f.runtime.update({ manual: true }), /分类/);
  await f.runtime.prepare(); assert.equal(f.selections, 1, '新开放的待分类资料不能直接发送');
});

test('excluding during a running classification cancels late results and does not overwrite new content', async t => {
  let resolve;
  const f = await fixture(t, { skipSetup: true, classify: () => new Promise(r => { resolve = r; }) });
  await f.runtime.initialize();
  const old = f.runtime.getState().data.entries[0];
  await f.runtime.edit('1', { content: '较新的玩家修改' });
  const running = f.runtime.classify({ uid: '1' }); const rejected = assert.rejects(running, { name: 'AbortError' });
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  const exclusion = f.runtime.edit('1', { excluded: true, expectedEntry: stableJson(old) }, CHAT);
  resolve({ jsonData: { entries: [{ uid: '1', kind: 'fact', segments: [{ id: 'body', writable: true }] }] } });
  await rejected; await exclusion;
  const entry = f.runtime.getState().data.entries[0];
  assert.equal(entry.excluded, true); assert.equal(entry.content, '较新的玩家修改');
  assert.equal(entry.classification, 'manual', '迟到的分类结果没有覆盖权限');
});

test('new source disable invalidates an already prepared plan before application', async t => {
  const f = await fixture(t); await f.runtime.edit('1', { content: '副本新家' }); await f.runtime.prepare();
  const payload = f.payload(); payload.characterLore[0].disable = true;
  f.runtime.apply(payload);
  assert.equal(payload.characterLore[0].content, f.book.entries[1].content);
  assert.equal(payload.characterLore[0].disable, true);
  f.book.entries[1].disable = true;
  const calls = f.selections;
  await assert.rejects(f.runtime.prepare(), /原世界书已变化/); assert.equal(f.selections, calls);
});
