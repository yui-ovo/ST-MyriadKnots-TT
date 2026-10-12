import { isUuid, sha256 } from './identity.js';

export const DYNAMIC_BOOK_RECORD = 'self-use-dynamic-worldbook-v1';
const clone = value => structuredClone(value);
export const stableJson = value => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
export function bookError(message) { return Object.assign(new Error(message), { code: 'QQJ_DYNAMIC_BOOK' }); }
function check(condition, message = '动态世界书数据无效，已保留原记录。') { if (!condition) throw bookError(message); }
const has = value => Array.isArray(value) ? value.length > 0 : typeof value === 'object' && value !== null ? Object.keys(value).length > 0 : Boolean(value);
export function protectedReason(entry) {
  const content = String(entry.content ?? '');
  if (/<%|<\/?(?:script|style|iframe|UpdateVariable|JSONPatch|initvar)\b|\{\{(?!\s*(?:user|char)\s*\}\})|\b(?:getvar|setvar|stat_data|insertOrAssignVariables|z\.object)\b/iu.test(content)) return '含模板、脚本或变量指令';
  return '';
}
// Activation conditions are independent of permission to maintain the text.
export function nativeSelectionReason(entry) {
  if (entry.disable || entry.disabled || entry.enabled === false) return '原书已禁用';
  if (['sticky', 'cooldown', 'delay', 'delayUntilRecursion', 'vectorized', 'group', 'automationId', 'decorators', 'triggers'].some(key => has(entry[key]))) return '含特殊触发或分组条件';
  if (entry.useProbability && Number(entry.probability) !== 100) return '含概率条件';
  if (entry.selective && has(entry.keysecondary)) return '含二级关键词条件';
  if (has(entry.characterFilter?.names) || has(entry.characterFilter?.tags) || entry.characterFilter?.isExclude) return '含角色过滤条件';
  if (has(entry.extensions)) return '含扩展规则';
  return '';
}
export function primaryBook(context) {
  const character = context.characters?.[context.characterId];
  return String(character?.data?.extensions?.world ?? character?.extensions?.world ?? '').trim();
}
export function sourceEntries(book) {
  check(book && book.entries && typeof book.entries === 'object', '无法读取角色主世界书。');
  const entries = Object.entries(book.entries).map(([key, entry]) => ({ ...clone(entry), uid: String(entry.uid ?? key) }));
  check(entries.length <= 500 && stableJson(entries).length <= 1000000, '第一版支持最多 500 条、总计 100 万字符的主世界书。');
  check(new Set(entries.map(entry => entry.uid)).size === entries.length, '世界书条目编号重复。');
  return entries.sort((a, b) => a.uid.localeCompare(b.uid));
}
export async function bookFingerprint(entries) { return sha256(stableJson(entries)); }
export async function createBook(chatId, name, source) {
  return { schemaVersion: 2, chatId, book: name, sourceHash: await bookFingerprint(source), enabled: false, automatic: true, interval: 3,
    catchingUp: true, processed: [], entries: source.map(entry => ({ uid: entry.uid, label: String(entry.comment || entry.key?.join('、') || `条目 ${entry.uid}`),
      original: String(entry.content ?? ''), content: String(entry.content ?? ''), protectedReason: '', managed: !(entry.disable || entry.disabled || entry.enabled === false), locked: false, history: [],
      kind: 'fact', classification: 'pending', segments: [{ id: 'body', text: String(entry.content ?? ''), writable: false }] })) };
}
export function validateBook(value, chatId) {
  value = clone(value);
  if (value?.schemaVersion === 1 && Array.isArray(value.entries)) {
    value.schemaVersion = 2;
    for (const entry of value.entries) {
      entry.kind = 'fact'; entry.classification = 'pending';
      entry.segments = [{ id: 'body', text: entry.content, writable: !entry.protectedReason && !entry.locked }];
      entry.protectedReason = entry.protectedReason ? `旧版自动保护：${entry.protectedReason}。可重新分类或手动调整维护权限。` : '';
    }
  }
  check(isUuid(chatId) && value?.schemaVersion === 2 && value.chatId === chatId && typeof value.book === 'string' && value.book.length > 0);
  check(typeof value.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(value.sourceHash));
  check(typeof value.enabled === 'boolean' && typeof value.automatic === 'boolean' && Number.isInteger(value.interval) && value.interval >= 1 && value.interval <= 20);
  check(typeof value.catchingUp === 'boolean');
  check(Array.isArray(value.processed) && value.processed.length <= 20000);
  value.processed.forEach((w, index) => check(w.index === index && /^[a-f0-9]{64}$/.test(w.hash)));
  check(Array.isArray(value.entries) && value.entries.length <= 500 && new Set(value.entries.map(e => e.uid)).size === value.entries.length);
  for (const entry of value.entries) {
    check(typeof entry.uid === 'string' && typeof entry.label === 'string' && typeof entry.original === 'string' && typeof entry.content === 'string');
    check(typeof entry.protectedReason === 'string' && typeof entry.managed === 'boolean' && typeof entry.locked === 'boolean');
    check(['fact', 'rule', 'npc', 'npc_pool', 'event'].includes(entry.kind));
    check(['pending', 'ready', 'review', 'manual'].includes(entry.classification));
    check(Array.isArray(entry.segments) && entry.segments.length > 0 && entry.segments.length <= 100);
    check(new Set(entry.segments.map(s => s.id)).size === entry.segments.length);
    for (const segment of entry.segments) check(typeof segment.id === 'string' && segment.id.length > 0 && typeof segment.text === 'string' && typeof segment.writable === 'boolean');
    check(entry.segments.map(s => s.text).join('') === entry.content);
    check(entry.kind !== 'rule' || entry.segments.every(s => !s.writable));
    check(Array.isArray(entry.history) && entry.history.length <= 50);
    for (const h of entry.history) check(typeof h.before === 'string' && typeof h.after === 'string' && typeof h.reason === 'string' && typeof h.at === 'string'
      && ['model', 'manual', 'restore'].includes(h.kind) && Array.isArray(h.floors) && h.floors.every(Number.isSafeInteger));
  }
  check(stableJson(value).length <= 4000000, '动态世界书记录过大，请减少受管条目。');
  return clone(value);
}
export function createDynamicBookStore(client) {
  return {
    async read(chatId) {
      check(isUuid(chatId), '请先等待千千结建立当前聊天身份。');
      try {
        const result = await client.get(`chat-${chatId}`, DYNAMIC_BOOK_RECORD);
        check(Number.isSafeInteger(result.revision) && result.revision > 0);
        return { data: validateBook(result.data, chatId), revision: result.revision };
      } catch (error) { if (error.status === 404) return { data: null, revision: 0 }; throw error; }
    },
    async write(chatId, data, revision, signal) {
      const safe = validateBook(data, chatId);
      const result = await client.put(`chat-${chatId}`, DYNAMIC_BOOK_RECORD, safe, revision, { signal });
      check(result.revision === revision + 1, '保存版本未确认，请刷新动态世界书后重试。');
      return { data: validateBook(result.data, chatId), revision: result.revision };
    },
  };
}
export const messageSignature = message => stableJson([message?.mes ?? '', message?.is_user === true, message?.swipe_id ?? null]);
export async function witness(chat, end) {
  check(end < chat.length && end < 20000);
  return Promise.all(chat.slice(0, end + 1).map(async (message, index) => ({ index, hash: await sha256(messageSignature(message)) })));
}
export async function verifyWitness(chat, processed) {
  if (processed.length > chat.length) return false;
  const actual = await witness(chat, processed.length - 1);
  return actual.every((item, index) => item.hash === processed[index].hash);
}
export function addHistory(entry, content, kind, reason, floors = []) {
  if (entry.content === content) return;
  entry.history.push({ before: entry.content, after: content, kind, reason, floors, at: new Date().toISOString() });
  entry.history = entry.history.slice(-50);
  entry.content = content;
}
export const canMaintain = entry => entry.managed && !entry.locked && entry.kind !== 'rule' && entry.segments.some(s => s.writable);

// The model supplies boundaries, never the initial text. Ambiguous boundaries
// retain every source byte and are sent to the user for review.
export function classifyEntry(entry, result) {
  const next = clone(entry);
  const review = () => ({ ...next, classification: 'review', protectedReason: '分段或分类未能可靠核对，请手动检查维护权限。', segments: [{ id: 'body', text: entry.content, writable: false }] });
  if (!result || !['fact', 'rule', 'npc', 'npc_pool', 'event'].includes(result.kind) || !Array.isArray(result.segments) || !result.segments.length || result.segments.length > 100) return review();
  const ids = new Set(), offsets = [0];
  for (const [index, segment] of result.segments.entries()) {
    if (typeof segment.id !== 'string' || !segment.id || ids.has(segment.id) || typeof segment.writable !== 'boolean' || 'text' in segment) return review();
    ids.add(segment.id);
    if (!index) { if (segment.start != null && segment.start !== '') return review(); }
    else {
      if (typeof segment.start !== 'string' || !segment.start) return review();
      const position = entry.content.indexOf(segment.start);
      if (position <= offsets.at(-1) || entry.content.indexOf(segment.start, position + 1) !== -1) return review();
      offsets.push(position);
    }
  }
  next.kind = result.kind;
  next.segments = result.segments.map((s, index) => ({ id: s.id, text: entry.content.slice(offsets[index], offsets[index + 1]), writable: result.kind !== 'rule' && s.writable }));
  next.classification = result.needsReview === true ? 'review' : 'ready';
  if (result.needsReview === true) next.segments.forEach(s => { s.writable = false; });
  next.protectedReason = next.classification === 'review' ? '分类建议待核对，可手动调整维护权限。' : '';
  return next;
}

export function applyChanges(data, result, floors) {
  check(result && Array.isArray(result.changes) && result.changes.length <= data.entries.reduce((n, e) => n + e.segments.length, 0), '更新回复格式错误，未保存本批结果。');
  const next = clone(data), seen = new Set(), allowedFloors = new Set(floors.map(f => f.index));
  for (const change of result.changes) {
    const entry = next.entries.find(e => e.uid === change.uid);
    const segment = entry?.segments.find(s => s.id === (change.segmentId ?? (entry.segments.length === 1 ? entry.segments[0].id : null)));
    const key = stableJson([change.uid, segment?.id]);
    check(entry && canMaintain(entry) && segment?.writable && !seen.has(key), '模型修改了未授权或锁定片段，整批未保存。');
    seen.add(key);
    check(typeof change.content === 'string' && change.content.trim().length > 0 && change.content.length <= 100000 && !protectedReason({ content: change.content }), '模型输出包含脚本或无效正文，整批未保存。');
    check(typeof change.reason === 'string' && change.reason.length > 0 && change.reason.length <= 1500 && Array.isArray(change.floors) && change.floors.length > 0 && change.floors.every(index => allowedFloors.has(index)), '模型修改缺少有效来源楼号，整批未保存。');
    segment.text = change.content;
    addHistory(entry, entry.segments.map(s => s.text).join(''), 'model', change.reason, change.floors);
  }
  return next;
}

// Only modify the host's per-scan candidate copies. No writes to worldbook files or host caches.
export function overlayCandidates(payload, plan, data) {
  const byId = new Map(data.entries.filter(e => e.managed).map(e => [e.uid, e]));
  const selected = new Set(plan.selected);
  for (const name of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
    const list = payload?.[name];
    if (!Array.isArray(list)) continue;
    const updated = [];
    for (const source of list) {
      const entry = source.world === data.book ? byId.get(String(source.uid)) : null;
      if (!entry || source.content !== entry.original) { updated.push(source); continue; }
      // Keep conditional entries on the host's own activation path, while still
      // using the chat-local text. Selection never overrides author conditions.
      if (nativeSelectionReason(source) || entry.kind === 'rule') { updated.push({ ...source, content: entry.content }); continue; }
      if (!source.constant && !selected.has(entry.uid)) continue;
      updated.push({ ...source, content: entry.content, constant: true });
    }
    list.splice(0, list.length, ...updated);
  }
}
