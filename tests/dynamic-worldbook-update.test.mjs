import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldbookUpdatePrompt, DEFAULT_WORLDBOOK_GUIDANCE, buildWorldbookSources, validateWorldbookDecision } from '../src/dynamic-worldbook-update.js';

const input = { scope: { fromIndex: 4, toIndex: 6 }, sources: [
  { id: 'memory:4', kind: 'memory', floors: [4, 6] },
  { id: 'dialogue:5', kind: 'dialogue', floors: [5] },
  { id: 'memory:0', kind: 'background', floors: [0] },
] };
const batch = [{ uid: '1', segments: [{ id: 'body', text: '旧家' }] }];
const change = () => ({ uid: '1', segmentId: 'body', replacements: [{ before: '旧家', after: '新家' }], reason: '完成搬迁', evidenceRefs: ['memory:4', 'dialogue:5'] });

test('guidance uses existing front matter and always preserves the fixed output contract', () => {
  const custom = buildWorldbookUpdatePrompt('CUSTOM_GUIDANCE', 'CUSTOM_PREFIX');
  assert.ok(custom.startsWith('CUSTOM_PREFIX\n\nCUSTOM_GUIDANCE'));
  assert.match(custom, /固定输出与权限要求/);
  const defaults = buildWorldbookUpdatePrompt();
  assert.ok(defaults.includes(DEFAULT_WORLDBOOK_GUIDANCE));
  assert.ok(defaults.indexOf('fictional_content_processing_protocol') < defaults.indexOf(DEFAULT_WORLDBOOK_GUIDANCE));
});

test('decision evidence is checked and floor references are derived from supplied sources only', () => {
  const result = validateWorldbookDecision({ changes: [{ ...change(), floors: [999] }], reviewNeeded: [] }, input, batch);
  assert.deepEqual(result.changes[0].floors, [4, 6, 5]);
  for (const invalid of [{ ...change(), evidenceRefs: ['missing'] }, { ...change(), evidenceRefs: ['memory:0'] }, { ...change(), segmentId: 'protected' }]) {
    assert.throws(() => validateWorldbookDecision({ changes: [invalid], reviewNeeded: [] }, input, batch));
  }
  assert.throws(() => validateWorldbookDecision({ changes: [], reviewNeeded: [] }, input, batch), /理由/);
  assert.throws(() => validateWorldbookDecision({ changes: [], unchangedReason: '无变化', reviewNeeded: [{ reason: '冲突', evidenceRefs: ['missing'] }] }, input, batch), /证据/);
});

test('same-text proposals are recorded as unchanged while conflicts remain reviewable', () => {
  const result = validateWorldbookDecision({ changes: [{ ...change(), replacements: [{ before: '旧家', after: '旧家' }] }], reviewNeeded: [{ reason: '人物说法不一致', evidenceRefs: ['memory:4'] }] }, input, batch);
  assert.deepEqual(result.changes, []); assert.match(result.unchangedReason, /一致/);
  assert.equal(result.reviewNeeded[0].reason, '人物说法不一致');
});

test('relation and address revisions preserve every unrelated character and field', () => {
  const text = 'npc_a:\n  姓名: 甲\n  与乙的关系: 新女友，交往约两个月\n  职业: 模特\nnpc_b:\n  姓名: 丙\n  住所: 旧家\n';
  const entries = [{ uid: '1', segments: [{ id: 'body', text }] }];
  const proposal = { ...change(), replacements: [
    { before: '与乙的关系: 新女友，交往约两个月', after: '与乙的关系: 前女友（曾交往约两个月；已分手）' },
    { before: '住所: 旧家', after: '住所: 新家' },
  ] };
  const result = validateWorldbookDecision({ changes: [proposal], reviewNeeded: [] }, input, entries);
  assert.equal(result.changes[0].content, text.replace(proposal.replacements[0].before, proposal.replacements[0].after).replace('住所: 旧家', '住所: 新家'));
  assert.equal(result.changes[0].replacements, undefined);
});

test('unanchored additions, ambiguous anchors, overlaps and legacy full rewrites fail closed', () => {
  const entries = [{ uid: '1', segments: [{ id: 'body', text: '甲: 旧家\n乙: 旧家\n' }] }];
  const edits = [
    [{ before: '', after: 'user:\n  当前状态: 酒店' }],
    [{ before: '旧家', after: '新家' }],
    [{ before: '不存在', after: '新家' }],
    [{ before: '甲: 旧家', after: '甲: 新家' }, { before: '甲:', after: '乙:' }],
  ];
  for (const replacements of edits) assert.throws(() => validateWorldbookDecision({ changes: [{ ...change(), replacements }], reviewNeeded: [] }, input, entries), /本批未保存/);
  assert.throws(() => validateWorldbookDecision({ changes: [{ ...change(), content: '整份重写' }], reviewNeeded: [] }, input, batch), /不能整段重写/);
  assert.throws(() => validateWorldbookDecision({ changes: [change(), change()], reviewNeeded: [] }, input, batch), /重复/);
});

test('fixed maintenance scope remains present with custom guidance and limits CSE to evidence', () => {
  const prompt = buildWorldbookUpdatePrompt('自定义指导', '前置内容');
  assert.match(prompt, /已有设定的局部维护/);
  assert.match(prompt, /不得追加新的 user\/char\/NPC 人物档案/);
  assert.match(prompt, /不能把参考用的 CSE 状态直接变成世界书正文/);
  assert.match(prompt, /不要返回 content 整段重写/);
});

test('merged memories are deduplicated and only the CSE snapshot at the batch boundary is used', () => {
  const saved = { memoryId: 'merged', sourceMessageIndexes: [0, 2], summary: '合并记忆', cse: { status: 'ready', record: { endStateSubjects: [] } } };
  const chat = [{ is_user: false, mes: 'hidden', is_system: true }, { is_user: true, mes: '用户正文' }, { is_user: false, mes: '本批AI' }, { is_user: false, mes: '未来正文' }];
  const result = buildWorldbookSources({ pending: [{ index: 0, saved }, { index: 2, saved }], state: { floors: [], cseSubjects: [{ text: '未来状态' }] }, chat, from: 0, sanitize: text => text });
  assert.equal(result.sources.filter(s => s.kind === 'memory').length, 1);
  assert.deepEqual(result.sources.filter(s => s.kind === 'dialogue').map(s => s.floors[0]), [1, 2]);
  assert.doesNotMatch(JSON.stringify(result), /hidden|未来/);
  assert.throws(() => buildWorldbookSources({ pending: [{ index: 0, saved }], state: { floors: [] }, chat, from: 0, sanitize: text => text }), /截断/);
});
