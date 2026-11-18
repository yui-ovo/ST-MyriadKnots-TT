import { sha256 } from './identity.js';

const clone = value => structuredClone(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const json = value => JSON.stringify(sorted(value));
const fail = message => { throw Object.assign(new Error(message), { code: 'QQJ_DYNAMIC_BOOK' }); };

// Read switches live. Helper scripts also serialize native defaults and editor
// positions, which do not constitute a new author version. Unknown fields stay
// in the comparison so a new host/plugin condition is never silently ignored.
const defaults = { comment: '', key: [], keysecondary: [], selectiveLogic: 0, scanDepth: null, vectorized: false,
  position: 0, role: 0, depth: 4, order: 100, excludeRecursion: false, preventRecursion: false, addMemo: true,
  matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false, group: '', groupOverride: false,
  groupWeight: 100, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '',
  ignoreBudget: false, outletName: '', triggers: [] };
export function normalizeSourceMetadata(raw) {
  const value = clone(raw ?? {});
  for (const key of ['uid', 'content', 'disable', 'disabled', 'enabled', 'constant', 'displayIndex']) delete value[key];
  for (const [key, fallback] of Object.entries(defaults)) value[key] ??= clone(fallback);
  for (const key of ['key', 'keysecondary']) if (Array.isArray(value[key])) value[key] = value[key].map(item => {
    if (typeof item !== 'string') return item;
    const match = item.match(/^\/(.*)\/([a-z]*)$/s);
    if (!match) return item;
    try { return new RegExp(match[1], match[2]).toString(); } catch { return item; }
  });
  value.probability = raw?.useProbability ? raw.probability ?? 100 : 100;
  delete value.useProbability;
  for (const key of ['sticky', 'cooldown', 'delay', 'delayUntilRecursion']) {
    if (value[key] == null || value[key] === false || value[key] === 0) value[key] = 0;
  }
  if (!value.keysecondary?.length) delete value.selective;
  else value.selective ??= false;
  value.characterFilter = { isExclude: false, names: [], tags: [], ...(value.characterFilter ?? {}) };
  for (const [key, fallback] of Object.entries({ isExclude: false, names: [], tags: [] })) value.characterFilter[key] ??= clone(fallback);
  if (value.extensions && typeof value.extensions === 'object' && !Array.isArray(value.extensions)) {
    delete value.extensions.display_index;
    if (!Object.keys(value.extensions).length) delete value.extensions;
  }
  return sorted(value);
}
export async function normalizedBookFingerprint(entries) {
  return sha256(json(entries.map(entry => ({ uid: String(entry.uid), content: String(entry.content ?? ''), metadata: normalizeSourceMetadata(entry) }))
    .sort((a, b) => a.uid.localeCompare(b.uid))));
}
const disabled = entry => Boolean(entry.disable || entry.disabled || entry.enabled === false);
const label = raw => String(raw.comment || (Array.isArray(raw.key) ? raw.key.join('、') : '') || `条目 ${raw.uid}`);
export function createSourceEntry(raw) {
  const original = String(raw.content ?? '');
  return { uid: String(raw.uid), label: label(raw), original, content: original, protectedReason: '',
    managed: !disabled(raw), locked: false, excluded: false, sourceDisabled: disabled(raw), sourceMissing: false,
    sourceMetadata: normalizeSourceMetadata(raw), kind: 'fact', classification: 'pending', history: [],
    segments: [{ id: 'body', text: original, writable: false }] };
}
const matches = (entry, raw) => entry.original === String(raw.content ?? '')
  && (!entry.sourceMetadata || json(entry.sourceMetadata) === json(normalizeSourceMetadata(raw)));

export function inspectSource(data, rawEntries) {
  const current = new Map(rawEntries.map(entry => [String(entry.uid), entry]));
  const previous = new Map(data.entries.map(entry => [entry.uid, entry]));
  const added = [], updated = [], removed = [], unchanged = [];
  for (const [uid, raw] of current) {
    const entry = previous.get(uid);
    if (!entry) added.push(uid);
    else if (entry.sourceMissing || !matches(entry, raw)) updated.push(uid);
    else unchanged.push(uid);
  }
  for (const entry of data.entries) if (!current.has(entry.uid) && !entry.sourceMissing) removed.push(entry.uid);
  const legacy = data.sourceHashVersion !== 2 || data.entries.some(entry => !entry.sourceMetadata);
  const conflicts = data.entries.filter(entry => entry.sourceConflict).map(entry => entry.uid);
  return { legacy, needsSync: legacy || Boolean(added.length || updated.length || removed.length),
    added, updated, removed, unchanged, conflicts, blockedUids: [...updated, ...removed],
    compatibility: !legacy && !added.length && !updated.length && !removed.length };
}

// Transfer needs proof of the whole old author baseline. A legacy save has only
// a raw aggregate hash, so unlike a local one-time sync it cannot infer metadata
// equivalence from matching body text alone.
export async function isCompatibleSource(data, rawEntries) {
  if (data.sourceHashVersion === 2) return await normalizedBookFingerprint(rawEntries) === data.sourceHash;
  return await sha256(json(rawEntries)) === data.sourceHash;
}
function recordContent(entry, text, reason) {
  if (entry.content === text) return;
  entry.history.push({ before: entry.content, after: text, kind: 'source', reason, floors: [], at: new Date().toISOString() });
  entry.history = entry.history.slice(-50);
  entry.content = text;
}
function adoptBody(entry, text, reason) {
  recordContent(entry, text, reason);
  delete entry.recheckFrom; delete entry.recheckBase;
  entry.segments = [{ id: 'body', text, writable: false }];
  entry.classification = 'pending';
  entry.protectedReason = '原书正文已更新，暂时保护；请重新分类或手动设置维护权限。';
}
function restoreRecheckBase(entry, data) {
  if (!Number.isSafeInteger(entry.recheckFrom) || entry.recheckFrom >= data.processed.length || !Array.isArray(entry.recheckBase)) return;
  const permissions = new Map(entry.segments.map(segment => [segment.id, segment.writable]));
  const segments = entry.recheckBase.map(segment => ({ id: segment.id, text: segment.text,
    writable: entry.kind !== 'rule' && permissions.get(segment.id) === true }));
  recordContent(entry, segments.map(segment => segment.text).join(''), '原书变化时保留补核历史前的完整副本');
  entry.segments = segments;
  delete entry.recheckFrom; delete entry.recheckBase;
}

export async function synchronizeSource(data, rawEntries) {
  const next = clone(data), current = new Map(rawEntries.map(entry => [String(entry.uid), entry]));
  const previous = new Map(next.entries.map(entry => [entry.uid, entry]));
  for (const entry of next.entries) {
    delete entry.sourcePending;
    const raw = current.get(entry.uid);
    if (!raw) {
      restoreRecheckBase(entry, next);
      if (!entry.sourceMissing) entry.sourceConflict = { base: entry.original, incoming: null, deleted: true };
      entry.sourceMissing = true; entry.sourceDisabled = true;
      continue;
    }
    const incoming = String(raw.content ?? ''), before = entry.original;
    entry.sourceDisabled = disabled(raw); entry.sourceMissing = false;
    entry.sourceMetadata = normalizeSourceMetadata(raw); entry.label = label(raw);
    if (incoming !== before) {
      restoreRecheckBase(entry, next);
      if (entry.content === incoming) delete entry.sourceConflict;
      else if (entry.content !== before || entry.sourceConflict) {
        entry.sourceConflict = { base: entry.sourceConflict?.base ?? before, incoming, deleted: false };
      } else {
        adoptBody(entry, incoming, '同步作者更新的原书正文');
        delete entry.sourceConflict;
      }
      entry.original = incoming;
    } else if (entry.sourceConflict?.deleted) delete entry.sourceConflict;
  }
  for (const [uid, raw] of current) if (!previous.has(uid)) next.entries.push(createSourceEntry(raw));
  // Retain deleted-source archives without silently dropping old plot edits.
  if (next.entries.length > 1000) fail('保留的原书条目与已移除条目合计超过 1000 条，未同步；当前副本已保留。');
  next.entries.sort((a, b) => a.uid.localeCompare(b.uid));
  next.sourceHashVersion = 2; next.sourceHash = await normalizedBookFingerprint(rawEntries);
  return next;
}

export function resolveSourceConflict(data, uid, choice) {
  if (!['keep', 'source'].includes(choice)) fail('请选择保留当前副本或采用原书新版。');
  const next = clone(data), entry = next.entries.find(item => item.uid === uid);
  if (!entry?.sourceConflict) fail('此条没有待处理的原书冲突，请刷新状态。');
  if (choice === 'source') {
    if (entry.sourceConflict.deleted || entry.sourceConflict.incoming === null) fail('原书已经移除此条，只能保留副本记录。');
    adoptBody(entry, entry.sourceConflict.incoming, '用户采用原书新版正文');
  }
  delete entry.sourceConflict; delete entry.sourcePending;
  return next;
}
