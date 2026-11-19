import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUX_TASKS, getAuxDemoTaskOptions, getAuxPromptValues } from '../src/aux-prompt-tasks.js';
import { getAuxOriginalInstructions } from '../src/aux-prompt-defaults.js';
import { BASE_PROCESSING_PROMPT } from '../src/shared-processing-prompt.js';
import { buildExtractorTaskOptions, createExtractorEnvelope, normalizeExtractorResponse, runExtractorRequest } from '../src/v3/extractor.js';
import { buildCseTaskOptions, runCseRequest } from '../src/v3/cse-engine.js';
import { buildWorldbookSelectionRequest } from '../src/dynamic-worldbook-selection.js';
import { validateWorldbookDecision } from '../src/dynamic-worldbook-update.js';
import { compileAnnualSettingResponse } from '../src/v3/time-annual-setting.js';

const asMessage = packet => ({ role: 'user', content: JSON.stringify(packet) });
const values = (task, ...packets) => getAuxPromptValues(task, { taskMessages: packets.map(asMessage) });

test('each task documents exactly its available macros and a parseable output example', () => {
  const protocols = {
    summary: 'summary', summaryBatch: 'summary', cse: 'subjects', recall: 'history_exclude_keys', profile: 'profiles',
    time: 'changes', timeReview: 'changes', annualSetting: 'sources', placeInit: 'placePaths', places: 'placePaths',
    qianshiHistory: 'floors', qianshiRejudge: 'floors', qianshiFollowup: 'decisions',
    worldbookClassify: 'entries', worldbookUpdate: 'changes', worldbookSelect: 'selected',
  };
  assert.deepEqual(AUX_TASKS.map(task => task.id).sort(), Object.keys(protocols).sort());
  for (const task of AUX_TASKS) {
    const names = task.macros.map(macro => macro.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names.sort(), Object.keys(getAuxPromptValues(task.id, {})).sort());
    assert.ok(task.macros.every(macro => macro.label && macro.description && /^qqj_\w+$/u.test(macro.name)));
    assert.ok(Object.hasOwn(JSON.parse(task.outputExample), protocols[task.id]));
    assert.ok(task.outputHint);
  }
});

test('summary sections preserve raw text, user snapshot numbers and unlisted evidence without reading other options', () => {
  const body = ' \n'+ '原文{{qqj_prefix}}'.repeat(20_000) + '  ';
  const users = [{ sourceSnapshotIndex: 0, content: '第一句话' }, { sourceSnapshotIndex: 1, content: '第二句话' }];
  const request = { task: 'extractFloorSemantics', locale: 'zh-CN', payload: { canonicalContent: body, precedingUserInput: users,
    storyClock: '10:30', knownPeople: [{ name: '甲' }], newField: { evidence: ['原句'] } } };
  const options = { taskMessages: [asMessage(request)], systemPrompt: ' 指令\n',
    chat: { content: '未授权的其他聊天' }, config: { apiKey: '本地密钥' }, promptOwnerId: '本地聊天归属' };
  const before = structuredClone(options);
  const actual = getAuxPromptValues('summary', options, '通用前缀');
  assert.equal(actual.qqj_prefix, BASE_PROCESSING_PROMPT);
  assert.equal(actual.qqj_instructions, getAuxOriginalInstructions('summary', options));
  assert.equal(actual.qqj_input, options.taskMessages[0].content);
  assert.equal(actual.qqj_floor_body, body);
  assert.deepEqual(JSON.parse(actual.qqj_user_input), users);
  assert.deepEqual(JSON.parse(actual.qqj_remaining), { task: request.task, locale: request.locale, payload: {
    storyClock: '10:30', knownPeople: [{ name: '甲' }], newField: { evidence: ['原句'] } } });
  assert.doesNotMatch(JSON.stringify(actual), /未授权的其他聊天|本地密钥|本地聊天归属/u);
  assert.deepEqual(options, before);
});

test('merged summary preserves member/anchor identities and keeps the rest of each row only once', () => {
  const userA = [{ sourceSnapshotIndex: 0, content: '请等我' }];
  const sourceFloors = [
    { floorKey: 'floor-1', assistantSeq: 5, messageIndex: 8, canonicalContent: '甲出发', precedingUserInput: userA, storyClock: '10:00' },
    { floorKey: 'floor-2', assistantSeq: 6, messageIndex: 10, canonicalContent: '甲抵达', precedingUserInput: [], locationReference: ['码头'] },
  ];
  const output = values('summaryBatch', { task: 'extractFloorSemantics', payload: {
    sourceFloorKey: 'floor-2', canonicalContent: '甲抵达', precedingUserInput: [], sourceFloors } });
  const bodies = JSON.parse(output.qqj_floor_body), users = JSON.parse(output.qqj_user_input);
  assert.equal(bodies.canonicalContent, '甲抵达');
  assert.deepEqual(bodies.sourceFloors.map(row => [row.floorKey, row.messageIndex, row.canonicalContent]), [
    ['floor-1', 8, '甲出发'], ['floor-2', 10, '甲抵达'],
  ]);
  assert.deepEqual(users.sourceFloors.map(row => row.precedingUserInput), [userA]);
  const remaining = JSON.parse(output.qqj_remaining).payload;
  assert.equal(remaining.sourceFloorKey, 'floor-2');
  assert.deepEqual(remaining.sourceFloors, [{ floorKey: 'floor-1', assistantSeq: 5, messageIndex: 8, storyClock: '10:00' },
    { floorKey: 'floor-2', assistantSeq: 6, messageIndex: 10, locationReference: ['码头'], precedingUserInput: [] }]);
  assert.deepEqual(remaining.precedingUserInput, []);
});

test('preview and generation share the same floor options and keep local scope out of the material', async () => {
  const envelope = { request: { payload: { canonicalContent: '本楼原文', currentUserInput: ['对应用户输入'] } }, scope: {
    chatId: 'target-chat', privateCompilerEvidence: '仅在编译时使用' } };
  const analysis = buildCseTaskOptions({ envelope, promptGuidance: '指引' });
  const single = buildExtractorTaskOptions({ envelope, promptGuidance: '指引' });
  const batch = buildExtractorTaskOptions({ envelope, promptGuidance: '指引', aggregate: true });
  assert.equal(single.promptTask, 'summary');
  assert.equal(batch.promptTask, 'summaryBatch');
  assert.equal(analysis.promptTask, 'cse');
  assert.notEqual(single.systemPrompt, batch.systemPrompt);
  for (const [opts, send] of [
    [single, capture => runExtractorRequest({ generateUtilityTask: capture, envelope, expectedScope: {}, promptGuidance: '指引' })],
    [batch, capture => runExtractorRequest({ generateUtilityTask: capture, envelope, expectedScope: {}, promptGuidance: '指引', aggregate: true })],
    [analysis, capture => runCseRequest({ generateAnalysisTask: capture, envelope, promptGuidance: '指引' })],
  ]) {
    assert.equal(opts.promptOwnerId, envelope.scope.chatId);
    assert.deepEqual(opts.taskMessages, [asMessage(envelope.request)]);
    assert.doesNotMatch(opts.taskMessages[0].content, /仅在编译时使用/u);
    let sent;
    await assert.rejects(send(({ signal, transportBudget, ...task }) => {
      sent = task;
      throw new DOMException('测试终止', 'AbortError');
    }), { name: 'AbortError' });
    assert.deepEqual(sent, opts);
  }
});

test('row projections preserve qianshi record bindings and worldbook evidence IDs and scope', () => {
  const floor = { floorKey: 'floor-3', source: '正文', summary: '摘要', precedingUserInput: ['回复'],
    records: [{ key: 'record-1', title: '交还' }], requiredRecordKeys: ['record-1'], qianshiCandidateKeys: ['c1'] };
  const options = values('qianshiRejudge', { floors: [floor], qianshiCandidates: [{ key: 'c1' }] });
  assert.deepEqual(JSON.parse(options.qqj_records), [{ floorKey: 'floor-3', records: floor.records }]);
  assert.deepEqual(JSON.parse(options.qqj_floor_body), [{ floorKey: 'floor-3', source: '正文' }]);
  assert.deepEqual(JSON.parse(options.qqj_remaining), { floors: [{ floorKey: 'floor-3', requiredRecordKeys: ['record-1'], qianshiCandidateKeys: ['c1'] }] });
  const sources = ['background', 'memory', 'cse', 'dialogue', 'future'].map((kind, i) => ({ kind, id: kind + i, floors: [6] }));
  const scope = { toIndex: 6 }, cseSnapshot = { floorIndex: 6, subjectCount: 2 };
  const result = values('worldbookUpdate', { entries: [{ uid: '一', segments: [] }], sources, scope, cseSnapshot });
  for (const [i, name] of ['qqj_background', 'qqj_memory', 'qqj_cse', 'qqj_visible_chat'].entries()) {
    assert.deepEqual(JSON.parse(result[name]), [sources[i]]);
  }
  assert.deepEqual(JSON.parse(result.qqj_remaining), { sources: [sources[4]], scope, cseSnapshot });
});

test('separate catalog and recent messages, empty sections and non-JSON input remain faithful', () => {
  const request = buildWorldbookSelectionRequest({ entries: [{ uid: '甲'.repeat(45), content: '保持原文' }],
    recent: [{ role: 'user', content: '{{qqj_floor_body}}' }] });
  const output = getAuxPromptValues('worldbookSelect', request);
  assert.deepEqual(JSON.parse(output.qqj_entries), JSON.parse(request.taskMessages[0].content).entries);
  assert.deepEqual(JSON.parse(output.qqj_recent), JSON.parse(request.taskMessages[1].content).recent);
  assert.equal(output.qqj_input, request.taskMessages.map(message => message.content).join('\n\n'));
  assert.equal(output.qqj_remaining, '');
  const malformed = getAuxPromptValues('summary', { taskMessages: [{ role: 'user', content: ' 纯文本\n' }] });
  assert.equal(malformed.qqj_floor_body, '');
  assert.equal(malformed.qqj_remaining, ' 纯文本\n');
  const noUsers = values('summary', { payload: { canonicalContent: '开场白', precedingUserInput: [] } });
  assert.equal(noUsers.qqj_user_input, '');
  assert.deepEqual(JSON.parse(noUsers.qqj_remaining).payload, { precedingUserInput: [] });
});

test('every task has a synthetic preview with native message boundaries and fresh options', () => {
  assert.equal(getAuxDemoTaskOptions('unknown'), null);
  for (const { id, macros } of AUX_TASKS) {
    const options = getAuxDemoTaskOptions(id), parts = getAuxPromptValues(id, options, '示例前缀');
    assert.equal(options.promptTask, id);
    assert.equal(options.promptOwnerId, undefined);
    assert.equal(options.systemPrompt, getAuxOriginalInstructions(id));
    assert.ok(options.taskMessages.every(message => message.role === 'user' && JSON.parse(message.content)));
    assert.equal(options.taskMessages.length, id === 'worldbookSelect' ? 2 : 1);
    for (const { name } of macros) {
      if (name === 'qqj_remaining' || name === 'qqj_selection_retry' || id === 'profile' && name === 'qqj_recent') continue;
      assert.ok(parts[name], id + ' ' + name);
    }
    assert.equal(parts.qqj_input, options.taskMessages.map(message => message.content).join('\n\n'));
    options.taskMessages[0].content = '改动本地预览';
    assert.notEqual(getAuxDemoTaskOptions(id).taskMessages[0].content, options.taskMessages[0].content);
  }
});

test('documented extractor, annual and selection examples pass the real result readers', async () => {
  const example = id => JSON.parse(AUX_TASKS.find(task => task.id === id).outputExample);
  const chatId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', narrativeGeneration = '22222222-2222-4222-8222-222222222222';
  const bodies = JSON.parse(getAuxDemoTaskOptions('summaryBatch').taskMessages[0].content).payload.sourceFloors;
  const sourceFloors = bodies.map(({ canonicalContent, assistantSeq, messageIndex }) => ({ floor: {
    id: assistantSeq + '1111111-1111-4111-8111-111111111111', chatId, narrativeGeneration, assistantSeq,
    hostLocator: { messageIndex }, content: { canonicalContent, rawFingerprint: 'sha256:' + createHash('sha256').update(canonicalContent).digest('hex') },
  } }));
  for (const id of ['summary', 'summaryBatch']) {
    const floor = sourceFloors.at(-1).floor, envelope = await createExtractorEnvelope({
      batchId: '36363636-3636-4636-8636-363636363636', chatId, narrativeGeneration, floor,
      ...(id === 'summaryBatch' ? { sourceFloors } : {}),
    });
    const compiled = await normalizeExtractorResponse({ envelope, floor, expectedScope: envelope.scope, response: example(id),
      now: '2026-01-01T00:00:00.000Z', finishReason: 'stop' });
    assert.equal(compiled.memory.summary.aiText, example(id).summary);
    assert.equal(compiled.memory.qianshiDelta.events[0].title, example(id).qianshi.events[0].title);
    assert.equal(compiled.memory.qianshiDelta.events[0].sourceFloorId, floor.id);
  }
  const annual = compileAnnualSettingResponse(example('annualSetting'), { sources: [{ id: 'S1', sourceKey: 'demo-source' }] });
  assert.equal(annual.succeeded[0].items[0].originalDate, '六月初六');
  const input = JSON.parse(getAuxDemoTaskOptions('worldbookUpdate').taskMessages[0].content);
  assert.deepEqual(validateWorldbookDecision(example('worldbookUpdate'), input, input.entries), example('worldbookUpdate'));
  const [catalog, story] = getAuxDemoTaskOptions('worldbookSelect').taskMessages.map(message => JSON.parse(message.content));
  assert.deepEqual(buildWorldbookSelectionRequest({ ...catalog, ...story }).decode(example('worldbookSelect')), ['entry-1']);
});
