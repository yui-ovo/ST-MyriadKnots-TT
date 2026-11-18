import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/identity.js';
import { bookFingerprint, canMaintain, canReadEntry, createBook, entryContentForSending, overlayCandidates, stableJson, validateBook } from '../src/dynamic-worldbook.js';
import { inspectSource, isCompatibleSource, normalizeSourceMetadata, resolveSourceConflict, synchronizeSource } from '../src/dynamic-worldbook-source.js';

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const raw = () => [{ uid: '1', comment: '住所', content: '甲住在旧公寓。', key: ['旧公寓'], constant: false },
  { uid: '2', comment: '工作', content: '甲是编辑。', key: ['职业'] }];
async function fixture() {
  const source = raw(), data = await createBook(CHAT, '原书', source);
  data.enabled = true; data.catchingUp = false; data.processed = [{ index: 0, hash: 'a'.repeat(64) }];
  for (const entry of data.entries) { entry.classification = 'manual'; entry.segments[0].writable = true; }
  return { source, data };
}

test('runtime switches, native defaults and editor formatting do not invalidate source; unknown effective metadata does', async () => {
  const { data, source } = await fixture();
  const changed = structuredClone(source);
  Object.assign(changed[0], { uid: 1, disable: true, disabled: true, enabled: false, constant: true, displayIndex: 800,
    keysecondary: [], selective: true, sticky: false, delay: null, useProbability: false, probability: 20,
    position: 0, depth: 4, order: 100, groupWeight: 100, key: ['旧公寓'], characterFilter: { isExclude: null }, extensions: { display_index: 44 } });
  assert.equal(await bookFingerprint(changed), data.sourceHash);
  assert.equal(inspectSource(data, changed).needsSync, false);
  assert.equal(await isCompatibleSource(data, changed), true);
  const synced = await synchronizeSource(data, changed);
  assert.equal(synced.entries[0].sourceDisabled, true);
  assert.equal(canReadEntry(synced.entries[0]), false);
  assert.equal(synced.entries[0].content, data.entries[0].content);
  assert.deepEqual(synced.entries[0].segments, data.entries[0].segments);
  for (const patch of [{ order: 110 }, { position: 1 }, { depth: 5 }, { key: ['新关键词'] }, { extensions: { newCondition: true } }, { futureRule: { mode: 2 } }]) {
    const authored = structuredClone(source); Object.assign(authored[0], patch);
    assert.deepEqual(inspectSource(data, authored).updated, ['1']);
    assert.equal(await isCompatibleSource(data, authored), false);
  }
});

test('equivalent regexp keys normalize while active secondary and probability rules remain strict', () => {
  assert.deepEqual(normalizeSourceMetadata({ key: ['/a/ig'], selective: true, keysecondary: [] }), normalizeSourceMetadata({ key: ['/a/gi'] }));
  assert.notDeepEqual(normalizeSourceMetadata({ keysecondary: ['x'], selective: true }), normalizeSourceMetadata({ keysecondary: ['x'], selective: false }));
  assert.notDeepEqual(normalizeSourceMetadata({ useProbability: true, probability: 25 }), normalizeSourceMetadata({ useProbability: false, probability: 25 }));
});

test('one changed source protects only its new body, retains user permissions and progress on untouched entries', async () => {
  const { data, source } = await fixture();
  data.entries[0].excluded = true; data.entries[0].locked = true;
  const other = structuredClone(data.entries[1]);
  source[0].content = '甲住在东城公寓。'; source[0].comment = '住所新版';
  source.push({ uid: '3', comment: '新地点', content: '学校在山上。' });
  const status = inspectSource(data, source);
  assert.deepEqual(status.updated, ['1']); assert.deepEqual(status.added, ['3']); assert.deepEqual(status.blockedUids, ['1']);
  const synced = await synchronizeSource(data, source);
  assert.deepEqual(synced.processed, data.processed); assert.equal(synced.catchingUp, false);
  assert.deepEqual(synced.entries[1], other);
  assert.equal(synced.entries[0].content, source[0].content); assert.equal(synced.entries[0].label, '住所新版');
  assert.equal(synced.entries[0].classification, 'pending'); assert.equal(synced.entries[0].segments[0].writable, false);
  assert.equal(synced.entries[0].excluded, true); assert.equal(synced.entries[0].locked, true);
  assert.equal(synced.entries[0].history.at(-1).kind, 'source');
  assert.equal(synced.entries[2].classification, 'pending'); assert.equal(canMaintain(synced.entries[2]), false);
  assert.equal(inspectSource(synced, source).needsSync, false);
  assert.deepEqual(validateBook(synced, CHAT), synced);
  assert.equal(data.entries[0].content, '甲住在旧公寓。');
});

test('author change and plot edit produce three-way conflict; pending conflict keeps current selectable but cannot be AI-maintained', async () => {
  const { data, source } = await fixture();
  data.entries[0].content = '甲已经正式搬入新家。'; data.entries[0].segments[0].text = data.entries[0].content;
  source[0].content = '甲租住旧公寓，地址是东街。';
  const before = structuredClone(data.entries[0]), synced = await synchronizeSource(data, source), entry = synced.entries[0];
  assert.deepEqual(entry.sourceConflict, { base: before.original, incoming: source[0].content, deleted: false });
  assert.equal(entry.original, source[0].content); assert.equal(entry.content, before.content);
  assert.deepEqual(entry.segments, before.segments);
  assert.equal(canReadEntry(entry), true); assert.equal(canMaintain(entry), false);
  const payload = { characterLore: source.map(e => ({ ...e, world: '原书' })) };
  overlayCandidates(payload, { selected: ['1', '2'] }, synced);
  assert.equal(payload.characterLore[0].content, before.content);
  const kept = resolveSourceConflict(synced, '1', 'keep');
  assert.equal(kept.entries[0].content, before.content); assert.equal(kept.entries[0].sourceConflict, undefined); assert.equal(canMaintain(kept.entries[0]), true);
  const adopted = resolveSourceConflict(synced, '1', 'source');
  assert.equal(adopted.entries[0].content, source[0].content); assert.equal(adopted.entries[0].classification, 'pending');
  assert.equal(adopted.entries[0].segments[0].writable, false); assert.equal(adopted.entries[0].history.at(-1).before, before.content);
  assert.deepEqual(kept.processed, data.processed); assert.deepEqual(adopted.processed, data.processed);
});

test('repeated source versions retain conflict base and current text, metadata-only sync never changes permissions', async () => {
  const { data, source } = await fixture();
  data.entries[0].content = '剧情的新家'; data.entries[0].segments[0].text = '剧情的新家';
  source[0].content = '作者版本二';
  const first = await synchronizeSource(data, source);
  source[0].content = '作者版本三';
  const second = await synchronizeSource(first, source);
  assert.deepEqual(second.entries[0].sourceConflict, { base: data.entries[0].original, incoming: '作者版本三', deleted: false });
  assert.equal(second.entries[0].content, '剧情的新家');
  source[1].order = 200;
  const metadata = await synchronizeSource(second, source);
  assert.deepEqual(metadata.entries[1].segments, data.entries[1].segments);
  assert.equal(metadata.entries[1].classification, 'manual'); assert.equal(metadata.entries[1].history.length, 0);
});

test('deleted sources are retained as inactive archives and returning UIDs are reconciled without resurrecting old content silently', async () => {
  const { data, source } = await fixture();
  const synced = await synchronizeSource(data, source.slice(1));
  const missing = synced.entries.find(entry => entry.uid === '1');
  assert.equal(missing.sourceMissing, true); assert.equal(canReadEntry(missing), false);
  assert.deepEqual(missing.sourceConflict, { base: missing.original, incoming: null, deleted: true });
  assert.equal(inspectSource(synced, source.slice(1)).needsSync, false);
  assert.equal(await isCompatibleSource(synced, source.slice(1)), true);
  assert.throws(() => resolveSourceConflict(synced, '1', 'source'), /移除/);
  const kept = resolveSourceConflict(synced, '1', 'keep');
  assert.equal(kept.entries[0].content, data.entries[0].content); assert.equal(canReadEntry(kept.entries[0]), false);
  source[0].content = '作者用此编号描述另一个住址';
  assert.deepEqual(inspectSource(kept, source).updated, ['1']);
  const returned = await synchronizeSource(kept, source);
  assert.equal(returned.entries[0].sourceMissing, false); assert.equal(returned.entries[0].content, source[0].content);
  assert.equal(canMaintain(returned.entries[0]), false);
});

test('legacy migration keeps old plot text, permissions and history; import requires original raw hash proof', async () => {
  const { data, source } = await fixture();
  delete data.sourceHashVersion;
  for (const entry of data.entries) { delete entry.sourceMetadata; delete entry.sourceMissing; }
  data.sourceHash = await sha256(stableJson(source));
  data.entries[0].content = '剧情中新家'; data.entries[0].segments[0].text = '剧情中新家';
  const previous = structuredClone(data.entries[0]);
  assert.equal(inspectSource(data, source).legacy, true); assert.equal(inspectSource(data, source).needsSync, true);
  assert.equal(await isCompatibleSource(data, source), true);
  const formatted = structuredClone(source); formatted[0].displayIndex = 80;
  assert.equal(await isCompatibleSource(data, formatted), false);
  const next = await synchronizeSource(data, formatted);
  assert.equal(next.sourceHashVersion, 2); assert.deepEqual(next.entries[0].segments, previous.segments);
  assert.equal(next.entries[0].content, previous.content); assert.deepEqual(next.entries[0].history, previous.history);
  assert.deepEqual(next.processed, data.processed); assert.equal(next.entries[0].sourceConflict, undefined);
  assert.equal(await isCompatibleSource(next, formatted), true);
});

test('corrupt metadata/conflicts/recheck offsets fail validation, transient pending source flags are never persisted', async () => {
  const { data } = await fixture();
  data.entries[0].sourcePending = true;
  assert.equal(canReadEntry(data.entries[0]), false);
  const clean = validateBook(data, CHAT); assert.equal(clean.entries[0].sourcePending, undefined);
  for (const patch of [{ sourceMetadata: [] }, { sourceConflict: { base: '', incoming: 'x', deleted: true } }, { sourceMissing: 'yes' }, { recheckFrom: 2 }]) {
    const bad = structuredClone(data); Object.assign(bad.entries[0], patch);
    assert.throws(() => validateBook(bad, CHAT));
  }
  clean.entries[0].recheckFrom = 0;
  assert.equal(validateBook(clean, CHAT).entries[0].recheckFrom, 0);
});

test('pending author additions and changed entries stay on native path while healthy entries use selected plot text', async () => {
  const { data, source } = await fixture();
  data.entries[1].content = '甲已经转行为老师。'; data.entries[1].segments[0].text = data.entries[1].content;
  source[0].content = '作者修改了住所。';
  source.push({ uid: '3', content: '新加入的人物资料。', key: ['新人'] });
  const synced = await synchronizeSource(data, source);
  const payload = { characterLore: source.map(entry => ({ ...entry, world: '原书' })) };
  overlayCandidates(payload, { selected: ['2'] }, synced);
  assert.equal(payload.characterLore.length, 3);
  assert.equal(payload.characterLore[0].content, source[0].content);
  assert.equal(payload.characterLore[1].content, data.entries[1].content);
  assert.equal(payload.characterLore[2].content, source[2].content);
  assert.equal(payload.characterLore[2].constant, undefined);
});

test('legacy schema migration cannot auto-maintain a pending entry just because its old segment allowed writes', async () => {
  const { data } = await fixture(); data.schemaVersion = 1;
  const migrated = validateBook(data, CHAT);
  assert.equal(migrated.entries[0].classification, 'pending');
  assert.equal(migrated.entries[0].segments[0].writable, true);
  assert.equal(canMaintain(migrated.entries[0]), false);
});

test('partial historical rechecks send the stable current snapshot; old rechecks with no snapshot stay native', async () => {
  const { data, source } = await fixture();
  const entry = data.entries[0];
  entry.recheckFrom = 0; entry.recheckBase = [{ id: 'body', text: '当前已确认的新家', writable: true }];
  entry.content = '正在复核的旧时临时住址'; entry.segments[0].text = entry.content;
  assert.equal(entryContentForSending(entry, data), entry.recheckBase[0].text);
  for (const mode of ['ai', 'native']) {
    const payload = { characterLore: source.map(item => ({ ...item, world: '原书' })) };
    overlayCandidates(payload, { selected: ['1', '2'], mode }, data);
    assert.equal(payload.characterLore[0].content, entry.recheckBase[0].text);
  }
  const legacy = structuredClone(data); delete legacy.entries[0].recheckBase;
  assert.equal(entryContentForSending(legacy.entries[0], legacy), null);
  const native = { characterLore: source.map(item => ({ ...item, world: '原书' })) };
  overlayCandidates(native, { selected: ['2'] }, legacy);
  assert.equal(native.characterLore.length, 2);
  assert.equal(native.characterLore[0].content, source[0].content);
  delete entry.recheckFrom; delete entry.recheckBase;
  assert.equal(entryContentForSending(entry, data), entry.content);
});

test('author-body adoption clears old recheck snapshots while metadata-only sync retains them', async () => {
  const { data, source } = await fixture();
  data.entries[0].recheckFrom = 0; data.entries[0].recheckBase = [{ id: 'body', text: '当前快照', writable: true }];
  const metadataSource = structuredClone(source); metadataSource[0].order = 300;
  const metadata = await synchronizeSource(data, metadataSource);
  assert.equal(metadata.entries[0].recheckFrom, 0); assert.deepEqual(metadata.entries[0].recheckBase, data.entries[0].recheckBase);
  source[0].content = '作者新地址';
  const changed = await synchronizeSource(data, source);
  assert.equal(changed.entries[0].recheckFrom, undefined); assert.equal(changed.entries[0].recheckBase, undefined);
  const invalid = structuredClone(data); delete invalid.entries[0].recheckFrom;
  assert.throws(() => validateBook(invalid, CHAT));
  const wrongType = structuredClone(data); wrongType.entries[0].recheckBase = 7;
  assert.throws(() => validateBook(wrongType, CHAT));
  for (const snapshot of [[], [{ id: 'a', text: 'x', writable: true }, { id: 'a', text: 'y', writable: false }],
    [{ id: '', text: 'x', writable: true }], [{ id: 'a', text: 'x' }], [{ id: 'a', text: 'x'.repeat(1000001), writable: false }]]) {
    const bad = structuredClone(data); bad.entries[0].recheckBase = snapshot;
    assert.throws(() => validateBook(bad, CHAT));
  }
});

test('author changes during partial recheck conflict against the stable complete copy and preserve protected segment permissions', async () => {
  const { data, source } = await fixture();
  const entry = data.entries[0];
  entry.recheckFrom = 0;
  entry.recheckBase = [{ id: 'rule', text: '固定规则。', writable: false }, { id: 'fact', text: '当前已经搬家。', writable: true }];
  entry.segments = [{ id: 'rule', text: '固定规则。', writable: false }, { id: 'fact', text: '旧楼仍在租房。', writable: false }];
  entry.content = entry.segments.map(segment => segment.text).join('');
  source[0].content = '作者新补充的住所设定。';
  const synced = await synchronizeSource(data, source), actual = synced.entries[0];
  assert.equal(actual.content, '固定规则。当前已经搬家。');
  assert.deepEqual(actual.segments, [{ id: 'rule', text: '固定规则。', writable: false }, { id: 'fact', text: '当前已经搬家。', writable: false }]);
  assert.deepEqual(actual.sourceConflict, { base: entry.original, incoming: source[0].content, deleted: false });
  assert.equal(actual.recheckFrom, undefined); assert.equal(actual.recheckBase, undefined);
  assert.equal(actual.history.at(-1).after, actual.content);
  assert.deepEqual(validateBook(synced, CHAT), synced);
  const removed = await synchronizeSource(data, source.slice(1));
  assert.equal(removed.entries[0].content, actual.content);
  assert.equal(removed.entries[0].sourceConflict.deleted, true);
  assert.equal(removed.entries[0].recheckBase, undefined);
  assert.equal(canReadEntry(removed.entries[0]), false);
});

test('source update can safely adopt against an unchanged stable baseline even when internal historical text differs', async () => {
  const { data, source } = await fixture();
  const entry = data.entries[0];
  entry.recheckFrom = 0; entry.recheckBase = structuredClone(entry.segments);
  entry.content = '补核到更早的住处'; entry.segments[0].text = entry.content;
  source[0].content = '作者新增的住址';
  const synced = await synchronizeSource(data, source);
  assert.equal(synced.entries[0].content, source[0].content);
  assert.equal(synced.entries[0].sourceConflict, undefined);
  assert.equal(synced.entries[0].classification, 'pending');
  assert.equal(synced.entries[0].recheckBase, undefined);
});
