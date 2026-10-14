import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransfer, parseMemoryPackage, transferWitness } from '../src/memory-transfer.js';
import { createFoundationStore } from '../src/v3/foundation-store.js';
import { createFoundationRuntime } from '../src/v3/foundation-runtime.js';
import { createV3MemoryRuntime } from '../src/v3/memory-runtime.js';
import { createHostAdapter } from '../src/v3/host-adapter.js';
import { createChatSession } from '../src/chat-session.js';
import { createChatIdentityCoordinator } from '../src/chat-identity.js';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/v3/extractor.js';
import { sha256 } from '../src/identity.js';
import { stableJson, createBook, DYNAMIC_BOOK_RECORD, witness, verifyWitness } from '../src/dynamic-worldbook.js';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-09-05T00:00:00.000Z';
const assistant = mes => ({ is_user: false, is_system: false, mes, swipes: [mes], swipe_id: 0 });
const user = mes => ({ is_user: true, is_system: false, mes, send_date: `test-user:${mes}` });
const uuidFactory = () => { let value = 1000; return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };

function backendHarness() {
  const records = new Map();
  const calls = [];
  const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const envelope = (data, revision) => ({ revision, data: structuredClone(data), createdAt: NOW, updatedAt: NOW });
  const client = {
    async list(collection) { return [...records].filter(([key]) => key.startsWith(`${collection}/`)).map(([key, value]) => ({ recordId: key.slice(collection.length + 1), ...envelope(value.data, value.revision) })); },
    async get(collection, key) {
      calls.push(['get', collection, key]);
      const value = records.get(`${collection}/${key}`);
      if (!value) throw failure(404);
      return envelope(value.data, value.revision);
    },
    async put(collection, key, data, expectedRevision) {
      calls.push(['put', collection, key]);
      const mapKey = `${collection}/${key}`;
      const previous = records.get(mapKey);
      if ((previous?.revision ?? 0) !== expectedRevision) throw failure(409);
      const revision = (previous?.revision ?? 0) + 1;
      records.set(mapKey, { revision, data: structuredClone(data) });
      return envelope(data, revision);
    },
  };
  return { records, calls, client };
}

const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IMPORTED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function fixture() {
  const backend = backendHarness();
  const ctx = context('old-chat', SOURCE, [user('旧档开场'), assistant('她把钥匙放进木盒。'), user('继续'), assistant('最新一楼'), user('钥匙呢？')]);
  let selected = ctx;
  const host = createHostAdapter({ globalRef: { SillyTavern: { getContext: () => selected } } });
  const store = createFoundationStore({ client: backend.client, contextProvider: () => identity(ctx.chatId, SOURCE) });
  const foundation = createFoundationRuntime({ hostAdapter: host, store, contextProvider: () => ctx, newUuid: uuidFactory(), logger: { warn() {} } });
  await foundation.start();
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => ({ jsonData: { noMaterialChange: true } }),
    generateUtilityTask: async options => ({ jsonData: options.systemPrompt === EXTRACTOR_SYSTEM_PROMPT ? { summary: '钥匙在木盒里。' } : { noMaterialChange: true } }) });
  await memory.start();
  await memory.extractFloor(memory.getState().floors[0].floorId, { analyzeState: false });
  await memory.analyzeNextState();
  const graph = await store.readReachable({ mode: 'full' });
  const coordinator = createChatIdentityCoordinator({ client: backend.client });
  await backend.client.put('chat-identity-bindings', `binding-${SOURCE}`, { schemaVersion: 1, kind: 'qqj-chat-identity-binding', chatId: SOURCE,
    owner: { hostChatId: ctx.chatId, characterLocator: 'character.png', personaLocator: 'persona.png' }, state: 'ready', sourceChatId: null, createdAt: NOW, updatedAt: NOW }, 0);
  // A real session checks the new binding on import; no mocked identity acceptance.
  const session = createChatSession({ contextProvider: () => selected, identityCoordinator: coordinator });
  await session.prepare();
  let api = targetChatApi(selected);
  const runtime = createMemoryTransfer({ client: backend.client, session, hostAdapter: host, freshUuid: () => IMPORTED,
    fetchImpl: (...args) => api.fetch(...args), onSettled: async () => { session.invalidate(); await session.prepare(); } });
  const exported = await runtime.exportCurrent();
  return { backend, ctx, host, graph, runtime, exported, session,
    async target({ changed = false } = {}) {
      selected = context('imported-chat', TARGET, structuredClone(ctx.chat), 'updated-avatar.png');
      selected.name2 = '新版角色'; selected.characters[0].name = '新版角色'; selected.characters[0].data.description = '作者更新后的设定';
      if (changed) selected.chat[1].mes = '改写的正文';
      await session.prepare(); api = targetChatApi(selected); return selected;
    }, get api() { return api; }, setApi(value) { api = value; }, select(value) { selected = value; },
  };
}

test('real memory and CSE round trip onto an updated card, without analysis calls or original writes', async () => {
  const f = await fixture(), target = await f.target();
  const original = JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`)));
  const plan = await f.runtime.preview(f.exported.text);
  assert.equal(plan.summaries, 1); assert.equal(plan.states, 1);
  assert.equal(f.api.saves, 0);
  await f.runtime.importPreview(plan);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
  assert.equal(f.session.identity().chatId, IMPORTED);
  assert.equal(JSON.stringify([...f.backend.records].filter(([key]) => key.startsWith(`chat-${SOURCE}/`))), original);
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.summary), f.graph.floorMemories.map(item => item.summary));
  assert.equal(restored.stateDeltas.length, f.graph.stateDeltas.length);
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start();
  assert.equal(memory.getState().rememberedCount, 1);
  await f.runtime.undo();
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${IMPORTED}/v3-root`), 'undo preserves imported memory too');
});

test('tampering, missing graph records, incompatible chat and consumed previews are rejected', async () => {
  const f = await fixture(); await f.target({ changed: true });
  await assert.rejects(f.runtime.preview(f.exported.text), /当前聊天与记忆包不一致/);
  const damaged = JSON.parse(f.exported.text); damaged.prequel = 'tampered';
  await assert.rejects(parseMemoryPackage(damaged), /完整性/);
  damaged.records = damaged.records.filter(item => item.data.recordType !== 'floorMemory');
  const { checksum, ...payload } = damaged; damaged.checksum = await sha256(stableJson(payload));
  await assert.rejects(parseMemoryPackage(damaged));
  const target = await f.target(); const plan = await f.runtime.preview(f.exported.text);
  target.chat.push(user('new message'));
  await assert.rejects(f.runtime.importPreview(plan), /有变化/);
  assert.equal(f.api.saves, 0);
  await assert.rejects(f.runtime.importPreview(plan), /预览已失效/);
});

test('staging failure and a chat switch never publish over the old or another chat', async () => {
  const f = await fixture(); const target = await f.target();
  const plan = await f.runtime.preview(f.exported.text), put = f.backend.client.put;
  f.backend.client.put = async (...args) => { if (args[0] === `chat-${IMPORTED}`) throw new Error('disk full'); return put(...args); };
  await assert.rejects(f.runtime.importPreview(plan), /disk full/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET); assert.equal(f.api.saves, 0);
  f.backend.client.put = put;
  const next = await f.runtime.preview(f.exported.text);
  f.backend.client.put = async (...args) => {
    const result = await put(...args); f.select(context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')])); return result;
  };
  await assert.rejects(f.runtime.importPreview(next), /切换/); assert.equal(f.api.saves, 0);
});

test('dynamic book mismatch is skipped, exact updated book restores edited data and exclusions', async () => {
  for (const matches of [false, true]) {
    const f = await fixture();
    const entries = [{ uid: '0', content: 'old home', comment: '住所' }];
    const book = await createBook(SOURCE, 'old-book', entries); book.entries[0].excluded = true;
    await f.backend.client.put(`chat-${SOURCE}`, DYNAMIC_BOOK_RECORD, book, 0);
    const exported = await f.runtime.exportCurrent(), target = await f.target();
    target.characters[0].data.extensions = { world: 'updated-book' };
    target.loadWorldInfo = async () => ({ entries: { 0: { ...entries[0], content: matches ? 'old home' : 'new author setting' } } });
    const plan = await f.runtime.preview(exported.text); await f.runtime.importPreview(plan);
    const saved = f.backend.records.get(`chat-${IMPORTED}/${DYNAMIC_BOOK_RECORD}`);
    assert.equal(Boolean(saved), matches);
    if (matches) { assert.equal(saved.data.book, 'updated-book'); assert.equal(saved.data.entries[0].excluded, true); }
  }
});

test('undo refuses changed conversation and export excludes settings and credentials', async () => {
  const f = await fixture();
  await f.backend.client.put(`chat-${SOURCE}`, 'unrelated-api-settings', { key: 'SECRET' }, 0);
  const file = await f.runtime.exportCurrent(); assert.ok(!file.text.includes('SECRET'));
  const target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(file.text));
  target.chat.push(user('new story'));
  await assert.rejects(f.runtime.undo(), /继续聊天/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('host save failure leaves the previous identity and source collection untouched', async () => {
  const f = await fixture(), target = await f.target(), api = f.api;
  const plan = await f.runtime.preview(f.exported.text);
  f.setApi({ fetch: (url, options) => url === '/api/chats/save' ? Promise.resolve({ ok: false, status: 409 }) : api.fetch(url, options) });
  await assert.rejects(f.runtime.importPreview(plan), /聊天文件未能保存/);
  assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
  assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, TARGET);
  assert.ok(f.backend.records.has(`chat-${SOURCE}/v3-root`));
});

test('switching while host save completes publishes only to the captured file', async () => {
  const f = await fixture(), target = await f.target();
  const other = context('other', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', [assistant('other')]);
  const api = targetChatApi(target, { afterSave: () => f.select(other) }); f.setApi(api);
  const result = await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  assert.equal(result.reload, true); assert.equal(api.persistedHeader.chat_metadata.qianqianjie.chatId, IMPORTED);
  assert.equal(other.chat[0].mes, 'other'); assert.notEqual(other.chatMetadata.qianqianjie.chatId, IMPORTED);
});

test('hidden messages, local time records, vector cache and arbitrary non-QQJ metadata survive transfer', async () => {
  const f = await fixture();
  f.ctx.chat[1].is_system = true; f.ctx.chat[1].extra ??= {}; f.ctx.chat[1].extra.qianqianjieAutoHide = { schemaVersion: 1, chatId: SOURCE };
  f.ctx.chat[1].extra.variables = { home: 'new home' }; f.ctx.chatMetadata.otherPlugin = { enabled: true };
  await f.backend.client.put(`chat-${SOURCE}`, 'v3-time-head', { schemaVersion: 1, chatId: SOURCE, batchIds: [], bodyStart: 0 }, 0);
  await f.backend.client.put(`chat-${SOURCE}`, 'qqj-vector-index', { schemaVersion: 1, recordType: 'vectorCache', chatId: SOURCE,
    narrativeGeneration: f.graph.root.narrativeGeneration, modelKey: `sha256:${'a'.repeat(64)}`, dimensions: 1024, shardIds: [], chunkCount: 0 }, 0);
  const file = await f.runtime.exportCurrent(); const target = await f.target();
  target.chatMetadata.otherPlugin = { targetValue: true }; f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(file.text));
  assert.equal(target.chat[1].is_system, true); assert.equal(target.chat[1].extra.qianqianjieAutoHide.chatId, IMPORTED);
  assert.deepEqual(target.chat[1].extra.variables, { home: 'new home' }); assert.deepEqual(target.chatMetadata.otherPlugin, { targetValue: true });
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/v3-time-head`).data.chatId, IMPORTED);
  assert.equal(f.backend.records.get(`chat-${IMPORTED}/qqj-vector-index`).data.modelKey, `sha256:${'a'.repeat(64)}`);
});

test('source changed without reconciliation cannot be exported with stale memories', async () => {
  const f = await fixture(); f.ctx.chat[1].mes = 'changed'; f.ctx.chat[1].swipes[0] = 'changed';
  await assert.rejects(f.runtime.exportCurrent(), /记忆中的楼层与聊天正文不一致/);
});

test('cross-host timestamp, visibility, absent/default swipe index and unselected history changes preserve real memory/CSE', async () => {
  const f = await fixture(), target = await f.target();
  target.chat[0].send_date = 1790000000000; target.chat[0].name = 'renamed persona';
  target.chat[2].send_date = 'different host timestamp representation';
  target.chat[4].send_date = '2026-10-15T01:00:00.000Z';
  target.chat[1].is_system = true; // native import may omit the QQJ auto-hide marker
  target.chat[1].swipes = ['unused alternative', target.chat[1].mes]; target.chat[1].swipe_id = 1;
  target.chat[1].swipe_info = [{ extra: { unrelated: true } }, { extra: { variables: { retained: true } } }];
  delete target.chat[3].swipes; delete target.chat[3].swipe_id;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(f.exported.text));
  const store = createFoundationStore({ client: f.backend.client, contextProvider: () => f.session.identity() });
  const foundation = createFoundationRuntime({ hostAdapter: f.host, store, contextProvider: () => target, newUuid: uuidFactory(), logger: { warn() {} } });
  assert.equal((await foundation.start()).status, 'ready');
  const restored = await store.readReachable({ mode: 'full' });
  assert.deepEqual(restored.floorMemories.map(item => item.id), f.graph.floorMemories.map(item => item.id));
  assert.deepEqual(restored.stateDeltas.map(item => item.id), f.graph.stateDeltas.map(item => item.id));
  assert.equal(target.chat[1].swipe_id, 1); assert.equal(target.chat[0].send_date, 1790000000000);
  assert.deepEqual(target.chat[1].swipe_info[1].extra, { variables: { retained: true } });
  const memory = createV3MemoryRuntime({ foundationRuntime: foundation, store, hostAdapter: f.host,
    automationSettings: () => ({ enabled: false, batchSize: 1 }), newUuid: uuidFactory(), logger: { warn() {} },
    generateAnalysisTask: async () => assert.fail('must not reanalyze'), generateUtilityTask: async () => assert.fail('must not resummarize') });
  await memory.start(); assert.equal(memory.getState().rememberedCount, 1);
});

test('V2 diagnostics identify counts and the first differing story floor, including user edits and rerolls', async () => {
  const f = await fixture();
  let target = await f.target(); target.chat[0].mes = 'different user message';
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼.*发言方、正文/);
  target = await f.target(); target.chat[1].swipes.push('actually different selected answer'); target.chat[1].swipe_id = 1;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 1 楼/);
  target = await f.target(); target.chat.push(user('new'));
  await assert.rejects(f.runtime.preview(f.exported.text), /当前 6 条，记忆包 5 条/);
  target = await f.target(); target.chat[0].is_user = false;
  await assert.rejects(f.runtime.preview(f.exported.text), /第 0 楼/);
  assert.equal(f.api.saves, 0);
});

test('V1 stays readable when exact, and asks for a new export when the mixed hash cannot prove equality', async () => {
  const f = await fixture(), old = JSON.parse(f.exported.text);
  old.formatVersion = 1; old.messages = await transferWitness(f.ctx.chat, { version: 1 });
  const { checksum, ...payload } = old; old.checksum = await sha256(stableJson(payload));
  let target = await f.target(); assert.equal((await f.runtime.preview(old)).messages, 5);
  target.chat[0].send_date = 'timestamp changed';
  await assert.rejects(f.runtime.preview(old), /旧版记忆包.*第 0 楼.*重新导出/);
  target = await f.target(); await f.runtime.importPreview(await f.runtime.preview(old));
  await f.runtime.undo(); assert.equal(target.chatMetadata.qianqianjie.chatId, TARGET);
});

test('matching dynamic worldbook rebinds progress to local swipe representation without resetting edits', async () => {
  const f = await fixture(), entries = [{ uid: '0', content: 'old home', comment: '住所' }];
  const book = await createBook(SOURCE, 'old-book', entries);
  book.processed = await witness(f.ctx.chat, f.ctx.chat.length - 1); book.entries[0].excluded = true;
  await f.backend.client.put(`chat-${SOURCE}`, DYNAMIC_BOOK_RECORD, book, 0);
  const exported = await f.runtime.exportCurrent(), target = await f.target();
  target.characters[0].data.extensions = { world: 'new-book-name' };
  target.loadWorldInfo = async () => ({ entries: { 0: entries[0] } });
  target.chat[1].swipes = ['other', target.chat[1].mes]; target.chat[1].swipe_id = 1;
  f.api.reloadFromContext();
  await f.runtime.importPreview(await f.runtime.preview(exported.text));
  const saved = f.backend.records.get(`chat-${IMPORTED}/${DYNAMIC_BOOK_RECORD}`).data;
  assert.equal(await verifyWitness(target.chat, saved.processed), true);
  assert.equal(saved.entries[0].excluded, true); assert.equal(saved.book, 'new-book-name');
});

test('rebinding must not silently reactivate a source dynamic copy with stale story witnesses', async () => {
  const f = await fixture(), entries = [{ uid: '0', content: 'home' }];
  const book = await createBook(SOURCE, 'book', entries);
  book.processed = [{ index: 0, hash: '0'.repeat(64) }];
  await f.backend.client.put(`chat-${SOURCE}`, DYNAMIC_BOOK_RECORD, book, 0);
  const exported = await f.runtime.exportCurrent(), target = await f.target();
  target.characters[0].data.extensions = { world: 'book' };
  target.loadWorldInfo = async () => ({ entries: { 0: entries[0] } });
  const plan = await f.runtime.preview(exported.text);
  assert.match(plan.dynamic, /已处理剧情/);
  await f.runtime.importPreview(plan);
  assert.equal(f.backend.records.has(`chat-${IMPORTED}/${DYNAMIC_BOOK_RECORD}`), false);
});

function context(hostChatId, qqjChatId, chat, characterAvatar = 'character.png') {
  const value = {
    name1: '林岚', name2: '裴晚生', characterId: 0, groupId: null, chatId: hostChatId,
    characters: [{ avatar: characterAvatar, name: '裴晚生', data: { description: '角色描述', personality: '克制', scenario: '雨夜' } }],
    userAvatar: 'persona.png', powerUserSettings: { persona_description: '调查员' },
    chatMetadata: { qianqianjie: { schemaVersion: 2, chatId: qqjChatId } }, chat,
    async saveMetadata() {}, async saveChat() { return true; }, getRequestHeaders() { return {}; },
    getWorldInfoNames() { return []; }, async loadWorldInfoBatch() { return new Map(); },
  };
  return value;
}

function identity(hostChatId, chatId, characterLocator = 'character.png') {
  return { hostChatId, chatId, characterLocator, personaLocator: 'persona.png' };
}

function targetChatApi(context, { afterSave = null, beforeGet = null, hasIntegrity = true } = {}) {
  let header = { chat_metadata: structuredClone(context.chatMetadata) };
  if (!hasIntegrity) delete header.chat_metadata.integrity;
  let messages = structuredClone(context.chat);
  let saves = 0;
  return {
    get saves() { return saves; },
    get persistedHeader() { return structuredClone(header); },
    reloadFromContext() {
      header = { chat_metadata: structuredClone(context.chatMetadata) };
      messages = structuredClone(context.chat);
    },
    async fetch(url, options = {}) {
      if (url === '/api/chats/get') {
        await beforeGet?.({ header, messages });
        return { ok: true, async json() { return [{ ...structuredClone(header) }, ...structuredClone(messages)]; } };
      }
      assert.equal(url, '/api/chats/save');
      const body = JSON.parse(options.body);
      assert.equal(body.force, false);
      assert.equal(body.ch_name, context.name2);
      const currentIntegrity = header.chat_metadata?.integrity;
      if (currentIntegrity !== undefined) assert.equal(body.chat[0]?.chat_metadata?.integrity, currentIntegrity, '宿主保存必须携带当前 integrity');
      header = structuredClone(body.chat[0]);
      messages = structuredClone(body.chat.slice(1));
      saves += 1;
      if (hasIntegrity) header.chat_metadata.integrity = `test-integrity-${saves}`;
      else delete header.chat_metadata.integrity;
      afterSave?.({ header, messages, saves });
      return { ok: true, async json() { return hasIntegrity ? { integrity: header.chat_metadata.integrity } : {}; } };
    },
  };
}
