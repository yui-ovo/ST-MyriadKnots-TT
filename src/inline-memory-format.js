import { parseInlineMemoryText } from './inline-memory-text.js';

export const INLINE_MEMORY_TAG = 'qqj_memory';
export const SUMMARY_SOURCES = Object.freeze(['api', 'inline', 'auto']);
export const normalizeSummarySource = value => SUMMARY_SOURCES.includes(value) ? value : 'api';
const failure = (code, message) => Object.assign(new Error(message), { code });

// This dedicated block is metadata, never story/evidence, even if interrupted.
export function stripInlineMemory(raw) {
  return String(raw ?? '').replace(/<qqj_memory\b[^>]*>[\s\S]*?(?:<\/qqj_memory\s*>|$)/giu, '').trim();
}

export function readInlineMemory(raw) {
  const text = String(raw ?? '');
  const starts = [...text.matchAll(/<qqj_memory\b[^>]*>/giu)];
  const ends = [...text.matchAll(/<\/qqj_memory\s*>/giu)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index < starts[0].index
    || !/^<qqj_memory\s*>$/iu.test(starts[0][0])) {
    throw failure('V3_INLINE_MEMORY_INVALID', '本楼记忆区块重复或标签不完整，请修正本楼区块，或使用摘要 API 重提。');
  }
  const body = text.slice(starts[0].index + starts[0][0].length, ends[0].index).trim();
  if (body.length > 200000) throw failure('V3_INLINE_MEMORY_INVALID', '本楼记忆区块过长，未保存。');
  let packet;
  if (body.startsWith('【')) packet = parseInlineMemoryText(body);
  else {
    try { packet = JSON.parse(body); } catch { throw failure('V3_INLINE_MEMORY_INVALID', '本楼记忆区块格式不完整，未保存。请使用配套文字格式，或修正已有 JSON 后重读。'); }
  }
  if (!packet || Array.isArray(packet) || packet.version !== 1 || typeof packet.summary !== 'string' || !packet.summary.trim() || packet.summary.length > 4000) {
    throw failure('V3_INLINE_MEMORY_INVALID', '本楼记忆区块版本或摘要格式不正确，请使用配套提示词。');
  }
  const arrays = ['people', 'time', 'locations', 'actions', 'knowledge', 'informationTransfers', 'privateThoughts', 'commitments', 'exactQuotes', 'openLoops', 'cseSignals'];
  if (arrays.some(key => !Array.isArray(packet[key])) || !Array.isArray(packet.qianshi?.events) || !Array.isArray(packet.qianshi?.order)
    || ['places', 'containments', 'positions'].some(key => !Array.isArray(packet.spatialFacts?.[key])) || !Array.isArray(packet.placePaths)) {
    throw failure('V3_INLINE_MEMORY_INCOMPLETE', '本楼记忆区块缺少结构化字段，尚未入库。请使用配套提示词重新生成，或使用摘要 API 重提。');
  }
  return packet;
}

export function chooseInlineMemory(raw, source, aggregate = false) {
  const mode = normalizeSummarySource(source);
  if (mode === 'api') return null;
  if (aggregate) {
    if (mode === 'inline') throw failure('V3_INLINE_MEMORY_AGGREGATE', '正文记忆按单楼读取。整段压缩请使用摘要 API，或改为逐楼处理。');
    return null;
  }
  const packet = readInlineMemory(raw);
  if (!packet && mode === 'inline') throw failure('V3_INLINE_MEMORY_MISSING', '本楼没有配套记忆区块。开启预设摘要条目只影响之后的回复；本楼可使用摘要 API 重提。');
  return packet;
}

export const inlineCandidateRef = binding => binding.matterId ? `matter:${binding.matterId}` : `event:${binding.originEventId}`;
