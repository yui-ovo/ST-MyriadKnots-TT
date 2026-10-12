import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, bookFingerprint, createBook, createDynamicBookStore, DYNAMIC_BOOK_RECORD, overlayCandidates, protectedReason, nativeSelectionReason, classifyEntry, validateBook, stableJson, sourceEntries, verifyWitness, witness } from '../src/dynamic-worldbook.js';
import { createDynamicWorldbookRuntime } from '../src/dynamic-worldbook-runtime.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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
  const storage = memoryClient(), book = raw(), warnings = [], events = new Map();
  let identity = { chatId: CHAT, hostChatId: 'chat-a', characterLocator: 'a.png', personaLocator: 'u.png' }, enabled = true, generating = false;
  let context = { chatId: 'chat-a', groupId: null, characters: [{ data: { extensions: { world: '书' } } }], characterId: 0,
    chat: [{ mes: '甲住在旧公寓。', is_user: false }, { mes: '我们搬家吧', is_user: true }, { mes: '甲搬入新家，旧公寓已经退租。', is_user: false }, { mes: '好的', is_user: true }] };
  let state = { chatId: CHAT, memorySnapshotStatus: 'ready', floors: [0, 2].map(messageIndex => ({ status: 'ready', messageIndex, summary: '搬家', sourceMessageIndexes: [messageIndex] })) };
  let updates = 0, selections = 0;
  const runtime = createDynamicWorldbookRuntime({ client: storage.client,
    hostAdapter: { getContext: () => context, getWorldInfoBindings: () => ({ loadWorldInfo: async () => structuredClone(book) }) },
    identityProvider: () => identity, memoryState: () => state, isEnabled: () => enabled, isGenerating: () => generating,
    generateUpdate: async request => {
      if (request.systemPrompt.includes('分析世界书资料的维护权限')) {
        if (overrides.classify) return overrides.classify(request);
        return { jsonData: { entries: JSON.parse(request.taskMessages[0].content).entries.map(e => ({ uid: e.uid, kind: e.uid === '3' ? 'rule' : 'fact', segments: [{ id: 'body', writable: e.uid !== '3' }] })) } };
      }
      updates++; return overrides.update ? overrides.update(request) : { jsonData: { changes: [{ uid: '1', content: '甲已经搬入新家。', reason: '正文明确搬入新家', floors: [2] }] } }; },
    generateSelect: async request => { selections++; return overrides.select ? overrides.select(request) : { jsonData: { selected: ['1'] } }; },
    notifyUser: text => warnings.push(text), isBookAllowed: () => overrides.allowed !== false,
  });
  t.after(() => runtime.dispose());
  const eventTypes = Object.fromEntries(['CHAT_CHANGED', 'WORLDINFO_ENTRIES_LOADED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'WORLDINFO_UPDATED'].map(key => [key, key]));
  runtime.bind({ eventTypes, eventSource: { on(key, fn) { events.set(key, fn); }, removeListener(key) { events.delete(key); } } });
  if (overrides.allowed !== false) {
    await runtime.initialize(); await runtime.edit('1', { managed: true }); await runtime.edit('2', { managed: true });
    await runtime.configure({ enabled: true, interval: 1 });
  }
  return { runtime, book, context, warnings, events, ...storage,
    get updates() { return updates; }, get selections() { return selections; },
    setState: value => { state = { ...state, ...value }; }, setEnabled: value => { enabled = value; }, setGenerating: value => { generating = value; },
    switchChat() { identity = { ...identity, chatId: OTHER, hostChatId: 'chat-b' }; context = { ...context, chatId: 'chat-b', chat: [{ mes: '另一个故事', is_user: false }] }; events.get('CHAT_CHANGED')(); },
    payload() { return { characterLore: Object.values(structuredClone(book.entries)).map(entry => ({ ...entry, world: '书' })), globalLore: [], chatLore: [], personaLore: [] }; },
  };
}
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
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.writes.length, before);
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
  const count = f.selections; await f.runtime.intercept(async (chat, size, abort) => abort(true), [], 1000, () => { aborts++; }, 'normal');
  assert.equal(f.selections, count); assert.equal(aborts, 1);
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
  await assert.rejects(f.runtime.initialize(), /offline/);
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
  const pending = f.runtime.initialize();
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  const writes = f.writes.length; f.switchChat(); resolve({ jsonData: { entries: [] } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.writes.length, writes);
});
