import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { escapeAuxPromptLiteral, getAuxOriginalInstructions, getAuxSelectionRetry, getAuxTaskTemplateRows,
  hasLegacyAuxPromptOverrides, materializeLegacyTemplate } from '../src/aux-prompt-defaults.js';
import { AUX_TASKS, getAuxDemoTaskOptions } from '../src/aux-prompt-tasks.js';
import { editAuxPromptLibrary, normalizeAuxPromptLibrary, resolveAuxPromptPreset } from '../src/aux-prompt-library.js';
import { renderAuxPrompt } from '../src/aux-prompt-runtime.js';
import { BASE_PROCESSING_PROMPT, prependProcessingPrompt } from '../src/shared-processing-prompt.js';
import { buildExtractorSystemPrompt, buildHighFloorExtractorSystemPrompt, DEFAULT_EXTRACTOR_GUIDANCE } from '../src/v3/extractor.js';
import { buildCseSystemPrompt } from '../src/v3/cse-engine.js';
import { buildPeopleProfileSystemPrompt } from '../src/v3/people-workspace.js';
import { buildWorldbookUpdatePrompt } from '../src/dynamic-worldbook-update.js';
import { buildWorldbookSelectionRequest, WORLDBOOK_SELECTION_PROMPT } from '../src/dynamic-worldbook-selection.js';

// Hashes of the full first system message from f134ca0's production builders,
// including its prefix, message boundaries, Unicode and exact JSON escaping.
const originals = {
  summary: 'c0bd8e5c348ece882b140667486ab56dd8969e5af30e97710f955c5ce1c61932',
  summaryBatch: '17f1e1066fb5f38a9f8b1b7a0c639bdf7ecfbf44334c9a2aefbbf100a4a647db',
  cse: 'ec16094fe33697183aa18032204114bfe91ff3ae52bd11e1a1e55ccccb67ade3',
  recall: '8d6edea85f4a3255f5ede504bd96c4bdce2976df602b4902d9c40733774c1043',
  profile: '6cb473ee652a80317da11016ccb7eb6ba9f4727f13379b8242ff0b43163a6991',
  time: '8ef597fe62cacd519ef315e092bb98f39ff10430cb790dcd706209b70e3c1cfc',
  timeReview: '1d99cbd16a891c477df70871b6025a255f4b63ff47863b9c4241bd0e21596b2e',
  annualSetting: 'bd7e55b3c0f4de0da1d179fd3ef66e66b2e60a953cf5fca6a53f7433ce10d5fe',
  placeInit: '79696b7aacdff0a49cb5adb5275aaa87ca35aa80cfb9ff23f72b01a00423d993',
  places: 'f739deb1586d6e01d21885d9d52a466628fac28ca9399b9e052851dcb281586a',
  qianshiHistory: '588351107782242784c4857a636959c4877800b0894c7654c61f25e8cc04e70f',
  qianshiRejudge: 'f0a32daddda1deb5925b821ef46fce93a79efc01b579fc739f995bf77cb6c647',
  qianshiFollowup: '66db1e9ee4cb5794e0487385966d779069559377a548107abfd55543d1d7c430',
  worldbookClassify: '6009bbf08c7ba7348c58a6f7d8b91ea9648f743f1a5139966bbee3d14c6330e0',
  worldbookUpdate: '166b5abe637ac9337b7ac76a6c801c2eeaa26834b1f27dcf87fd180f330c35e9',
  worldbookSelect: '484816e0618c852bd4d5d4c0c0813dffd0ad01c70877ded75591040173547d22',
};
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const custom = { processingPrompt: '自用前缀 {{qqj_input}}。', summaryPrompt: '  我的逐楼偏好 {{qqj_instructions}}。  ',
  profilePrompt: '我的人物指导。', csePrompt: '\n人物成长只写已确认的变化。\n', worldbookPrompt: '保留既有文字格式。' };
const legacyBuilders = {
  summary: [buildExtractorSystemPrompt, 'summaryPrompt'], summaryBatch: [buildHighFloorExtractorSystemPrompt, 'summaryPrompt'],
  cse: [buildCseSystemPrompt, 'csePrompt'], profile: [buildPeopleProfileSystemPrompt, 'profilePrompt'],
  worldbookUpdate: [buildWorldbookUpdatePrompt, 'worldbookPrompt'],
};

test('all built-ins and their untouched suite copies reproduce the actual previous requests byte for byte', () => {
  const clean = normalizeAuxPromptLibrary(), copy = editAuxPromptLibrary(clean, { type: 'copySuite', suiteId: 'builtin', name: '副本' }).library;
  assert.deepEqual(AUX_TASKS.map(task => task.id).sort(), Object.keys(originals).sort());
  for (const { id } of AUX_TASKS) {
    const options = getAuxDemoTaskOptions(id);
    const expected = [{ role: 'system', content: prependProcessingPrompt(getAuxOriginalInstructions(id)) }, ...options.taskMessages];
    assert.equal(hash(expected[0].content), originals[id], id);
    for (const lib of [clean, copy]) {
      const preset = resolveAuxPromptPreset(lib, id);
      assert.ok(preset.rows.every(row => row.content.length && row.content !== '{{qqj_instructions}}'));
      const result = renderAuxPrompt(id, preset, { ...options, systemPrompt: '上个版本残留的个人指导' }, '旧前缀');
      assert.deepEqual(result.messages, expected, id);
    }
  }
});

test('materializing legacy settings preserves the request for each task, including ordered guidance sections and literal macros', () => {
  assert.equal(hasLegacyAuxPromptOverrides({ summaryPrompt: DEFAULT_EXTRACTOR_GUIDANCE, processingPrompt: BASE_PROCESSING_PROMPT }), false);
  assert.equal(hasLegacyAuxPromptOverrides(custom), true);
  for (const { id } of AUX_TASKS) {
    const args = getAuxDemoTaskOptions(id), pair = legacyBuilders[id];
    const instructions = pair ? pair[0](custom[pair[1]]).trim() : getAuxOriginalInstructions(id);
    const expected = [{ role: 'system', content: prependProcessingPrompt(instructions, custom.processingPrompt) }, ...args.taskMessages];
    const rows = getAuxTaskTemplateRows(id, custom);
    assert.deepEqual(renderAuxPrompt(id, { taskId: id, rows }, args, '').messages, expected, id);
    assert.equal(rows.some(row => row.key === 'guidance'), Boolean(pair), id);
    assert.ok(rows.filter(row => row.role === 'system').every(row => row.messageGroup === 'systemPrompt' && row.source));
    const unified = materializeLegacyTemplate(id, '{{qqj_prefix}}\n\n{{qqj_instructions}}', custom);
    assert.equal(renderAuxPrompt(id, { taskId: id, rows: [{ role: 'system', content: unified, enabled: true }] }, args, '').messages[0].content, expected[0].content);
  }
  assert.deepEqual(getAuxTaskTemplateRows('cse').map(row => row.key), ['prefix', 'instructions', 'guidance', 'input']);
  assert.deepEqual(getAuxTaskTemplateRows('summary').map(row => row.key), ['prefix', 'guidance', 'instructions', 'input']);
  assert.deepEqual(getAuxTaskTemplateRows('unknown'), []);
});

test('selection retries append only the live correction to built-in or edited rules and preserve catalog/message boundaries', () => {
  const uid = '{{qqj_input}}';
  const original = buildWorldbookSelectionRequest({ entries: [{ uid, content: '借阅须知' }], recent: [{ role: 'user', content: '去图书馆。' }] });
  const correction = '\n上次回复校验未通过。允许的 uid：' + JSON.stringify([uid]) + '。';
  const retry = { ...original, systemPrompt: original.systemPrompt + correction };
  const taskId = 'worldbookSelect', rows = getAuxTaskTemplateRows(taskId);
  assert.equal(getAuxSelectionRetry(original), '');
  assert.equal(getAuxSelectionRetry(retry), correction);
  assert.equal(getAuxOriginalInstructions(taskId, retry), original.systemPrompt + correction);
  for (const options of [original, retry]) {
    const out = renderAuxPrompt(taskId, { taskId, rows }, options, '');
    assert.deepEqual(out.messages, [{ role: 'system', content: prependProcessingPrompt(options.systemPrompt) }, ...original.taskMessages]);
  }
  const edited = rows.map(row => row.key === 'instructions' ? { ...row, content: row.content.replace(WORLDBOOK_SELECTION_PROMPT, '我的规则') } : row);
  assert.equal(renderAuxPrompt(taskId, { taskId, rows: edited }, retry, '').messages[0].content, prependProcessingPrompt('我的规则' + correction));
  assert.doesNotMatch(JSON.stringify(edited), /允许的 uid/u);
});

test('v1 migration quotes literals once, retains variable placement, and keeps current modes and candidates in input', () => {
  const taskId = 'profile', args = getAuxDemoTaskOptions(taskId);
  const old = '{{!!qqj_input}} · {{ !qqj_other }} · {{ qqj_input }}';
  const tpl = materializeLegacyTemplate(taskId, old, custom);
  const one = payload => [{ role: 'user', content: JSON.stringify(payload) }];
  for (const messages of [args.taskMessages, one({ task: '自动粗扫', people: [{ personKey: 'person-1' }], recentFloors: [{ content: '最新楼' }] })]) {
    const result = renderAuxPrompt(taskId, { taskId, rows: [{ role: 'user', content: tpl, enabled: true }] }, { ...args, taskMessages: messages }, '');
    assert.equal(result.messages[0].content, '{{!!qqj_input}} · {{ !qqj_other }} · ' + messages[0].content);
  }
  assert.equal(escapeAuxPromptLiteral('\\{{  qqj_prefix\t}}'), '\\{{  !qqj_prefix\t}}');
});
