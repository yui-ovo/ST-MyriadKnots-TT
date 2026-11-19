// Section definitions project only the messages that the task already prepared.
// An unchanged task can continue to send its original messages verbatim.
const macro = (key, label, description) => ({ name: `qqj_${key}`, label, description });
const field = (key, label, description, property) => ({ ...macro(key, label, description), property });
const rows = (key, label, description, table, property, ids, includeTop = false) =>
  ({ ...field(key, label, description, property), table, ids, includeTop });
const source = (key, label, description, kind) => ({ ...field(key, label, description, 'sources'), kind });

const base = [
  macro('prefix', '通用前缀', '当前请求使用的通用处理提示词，可放在任意条目。'),
  macro('instructions', '任务指令', '本次任务的内置指令、已生效的内容指导和输出格式。'),
  macro('input', '完整任务材料', '包含下面各项材料。需要分别安排位置时，可用各项材料和其余材料组合。'),
];
const remaining = macro('remaining', '其余材料', '提取各项独立材料后余下的字段和来源标识。与各项独立材料搭配使用。');

const floorIds = ['floorKey', 'assistantSeq', 'messageIndex'];
const summaryFields = [
  rows('floor_body', 'AI 楼层正文', '本次摘要使用的 AI 正文。多楼时按来源楼编号排列，保留锚点楼和成员楼的对应关系。',
    'sourceFloors', 'canonicalContent', floorIds, true),
  rows('user_input', '前置用户输入', '这些 AI 回复前已捕获的用户原文及快照序号。多楼时按来源楼编号排列。',
    'sourceFloors', 'precedingUserInput', floorIds, true),
];
const timeFields = [
  field('clock', '故事时间', '本批截止位置的有效故事时间。', 'currentTime'),
  field('tracked_items', '已登记事项', '本批选中的事项、标识和可用的上一轮观察。', 'trackedItems'),
  field('people', '相关人物', '本次选中的人物身份和别名。', 'people'),
];
const knownPlaces = field('places', '已有地点', '此次请求中的地点目录、身份键和已登记信息。', 'knownPlaces');
const placeSources = field('setting_sources', '设定来源', '本次任务可用的书中地点原文及其来源编号。', 'placeWorldbookSources');
const qianshiCandidates = field('candidates', '千事候选', '各楼共同使用的候选池。每楼可用的候选编号见其余材料。', 'qianshiCandidates');
const entries = field('entries', '本批条目', '此次模型可处理的条目及其输入编号。', 'entries');

// These short fictional examples are entirely local. Keep the task envelopes and
// evidence keys recognizable while leaving the real prompt and chat out of the demo.
const demoInput = [{ sourceSnapshotIndex: 0, content: '请在闭馆前把钥匙带过来。' }];
const demoBody = '林遥在图书馆门口把借来的钥匙交还给程一。';
const demoSummary = '林遥按约定在闭馆前把钥匙还给程一。';
const demoFloors = [
  { floorKey: 'floor-1', assistantSeq: 1, messageIndex: 2, canonicalContent: '程一正在图书馆门口等待。', precedingUserInput: demoInput },
  { floorKey: 'floor-2', assistantSeq: 2, messageIndex: 4, canonicalContent: demoBody, precedingUserInput: [{ sourceSnapshotIndex: 0, content: '我到了。' }] },
];
const demoSummaryPayload = {
  canonicalContent: demoBody, precedingUserInput: demoInput, previousFloorContext: { time: null, summaryTail: '程一在图书馆等候。' },
  userIdentity: { displayName: '林遥' }, knownPeople: [], qianshiCandidates: [], sourceFloorKey: 'floor-1',
};
const demoPlace = { entityKey: 'place-1', displayName: '白桦图书馆', aliases: ['图书馆'] };
const demoPlaceText = '白桦图书馆设有阅览室。';
const demoBookSource = { sourceKey: 'worldbook-1', kind: 'worldbook', sourceName: '图书馆', content: demoPlaceText };
const demoEvidence = { columns: ['sourceKey', 'sourceType', 'content', 'placeKeys', 'requiresExactQuote'],
  rows: [['evidence-1', 'assistant', demoBody, ['place-1'], true]] };
const demoSubject = { entityId: 'demo-person', name: '程一', aliases: [] };
const demoTime = { chatId: 'demo-chat', cutoffFloorId: 'demo-floor', currentTime: { raw: '2026-05-10 17:30', date: '2026-05-10', clock: '17:30', minute: 1050 },
  people: [demoSubject], trackedItems: [{ id: 'demo-item-1', type: 'deadline', subjectEntityId: 'demo-person', label: '归还钥匙', status: 'active', observation: '两人约定闭馆前还钥匙。' }],
  observations: [], context: [], currentStates: [] };
const demoCandidate = { key: 'candidate-1', title: '闭馆前归还钥匙', status: 'planned' };
const demoRecord = { key: 'record-1', title: '约定还钥匙', description: '两人约定闭馆前归还钥匙。', status: 'planned', matter: true };
const demoEntry = { uid: 'entry-1', label: '白桦图书馆', content: demoPlaceText };

// Examples illustrate the protocol. Every referenced key must come from the live request.
const summaryEvent = { key: 'event-1', title: '归还钥匙', description: '林遥已把借来的钥匙交还给程一。', status: 'occurred', matter: false };
const registry = [
  {
    id: 'summary', label: '逐楼摘要', payload: true, sections: summaryFields,
    demo: { task: 'extractFloorSemantics', locale: 'zh-CN', payload: demoSummaryPayload },
    example: { summary: '林遥把借来的钥匙交还给程一，两人随后道别。', qianshi: { events: [summaryEvent], order: [] } },
    hint: '返回一份楼层记忆。summary 和 qianshi 为必填字段，其他有依据的结构字段按任务指令填写。',
  }, {
    id: 'summaryBatch', label: '合并摘要', payload: true, sections: summaryFields,
    demo: { task: 'extractFloorSemantics', locale: 'zh-CN', payload: { ...demoSummaryPayload,
      sourceFloorKey: 'floor-2', precedingUserInput: demoFloors[1].precedingUserInput, sourceFloors: demoFloors } },
    example: { summary: '林遥先提出归还钥匙，随后与程一见面并交还。', qianshi: { events: [{ ...summaryEvent, sourceFloorKey: 'floor-2' }], order: [] } },
    hint: '整批返回一份摘要。千事事件和引用成员楼的证据需填写该楼的 sourceFloorKey。',
  }, {
    id: 'cse', label: 'CSE 人物状态', payload: true, sections: [
      field('floor_body', '本楼 AI 正文', '目标楼清理后的 AI 正文。', 'canonicalContent'),
      field('user_input', '前置用户输入', '与目标楼对应的用户输入和来源信息。', 'currentUserInput'),
      field('memory', '本楼记忆', '本楼摘要和已编译的结构化记忆。', 'floorMemory'),
      field('previous_state', '人物前态', '本楼之前已保存并选入请求的人物状态。', 'previousState'),
      field('baseline', '相关设定', '已许可并选入本次请求的人设、角色卡、设定原文和作者注。', 'relevantBaseline'),
    ], demo: { task: 'understandCharacterStateAfterFloor', locale: 'zh-CN', payload: {
      canonicalContent: demoBody, currentUserInput: { source: 'currentUserInput', messages: demoInput },
      floorMemory: { summary: demoSummary }, previousState: [{ subject: '程一', ownState: { core: [], adaptive: [], situational: [] } }],
      relevantBaseline: { characterCard: { name: '程一', description: '负责图书馆借阅。', visibility: 'authorial' } },
      trackedSubjects: [{ name: '程一', aliases: [] }], evidenceSourceCatalog: [{ source: 'canonicalContent', kind: 'story' }],
    } }, example: { subjects: [] },
    hint: 'subjects 按人物记录有依据的状态变化。示例为无变化。若输入要求核验用户长期特质，另需给出 userCoreExtraction 结果。',
  }, {
    id: 'recall', label: '记忆召回选材', sections: [
      field('query', '当前对话', '最新用户输入、最近 AI 回复、前一条用户输入及当前故事时间。', 'query'),
      field('already_provided', '已有上下文', '已提供的连续摘要与状态覆盖范围。', 'alreadyProvided'),
      field('candidates', '历史候选', '本次的历史材料及可返回的编号。', 'candidates'),
      field('cse', 'CSE 候选', '按组排列的人物状态候选及编号。', 'cseContextGroups'),
      field('qianshi', '千事候选', '本次召回涉及的千事候选及编号。', 'qianshiCandidates'),
      field('annual', '年度候选', '本次召回涉及的年度提醒及编号。', 'annualCandidates'),
    ], demo: {
      query: { latestUser: '图书馆什么时候关门？', recentAssistant: demoBody, previousUser: '我到了。', currentStoryTime: '2026-05-10' },
      alreadyProvided: { recentContinuation: [{ key: 'P1', assistantSeq: 2, summary: demoSummary }] },
      candidates: [{ key: 'H1', fact: '图书馆下午六点闭馆。' }], annualCandidates: [{ key: 'A1', fact: '六月初六是程一的生日。' }],
      qianshiCandidates: [{ key: 'Q1', kind: 'event', fact: '钥匙已归还。' }],
      cseContextGroups: [{ subject: '程一', specialRole: 'none', items: [{ key: 'C1', kind: 'current', layer: 'situational',
        text: '程一在门口等待。', visibility: 'observable', toward: null, sourceAssistantSeq: 2 }] }],
    }, example: { history_exclude_keys: [], state_exclude_keys: [], qianshi_exclude_keys: [], annual_retain_keys: [], artifact_select_keys: [] },
    hint: '历史、状态和千事按排除键筛选，年度提醒和手动资料使用选中键。编号须来自对应候选池。',
  }, {
    id: 'profile', label: '人物基础资料', sections: [
      field('people', '目标人物', '本次整理的人物键、已有资料及按任务选入的个人历史。', 'people'),
      field('recent', '近期楼层', '自动整理模式提供的近期正文和冻结的前置用户输入。', 'recentFloors'),
      field('character_card', '角色卡', '已选入本次人物任务的角色卡材料。', 'characterCard'),
      field('setting_sources', '许可的设定', '本次选入的世界书材料。长资料分批时，片段也可能随目标人物提供。', 'allowedWorldInfo'),
    ], demo: { task: '整理选中人物的静态基础资料', people: [{ personKey: 'person-1', currentName: '程一', aliases: [],
      history: [{ summary: demoSummary }], existingProfile: {}, manualProfile: {}, manualFields: [] }],
      characterCard: { name: '程一', description: '图书馆管理员。' }, allowedWorldInfo: [{ source: '图书馆', label: '借阅', content: '程一负责借阅。' }] },
    example: { profiles: [{ personKey: 'person-1', name: '程一' }] },
    hint: '每个输入 personKey 对应一个 profiles 条目。其余资料字段依照本次任务指令和可定位的事实填写。',
  }, {
    id: 'time', label: '时间事项提取', sections: [...timeFields,
      field('observations', '本批楼层材料', '本批已准备的正文片段，含来源编号、角色和可用时间。', 'observations'),
      field('context', '相关摘要', '本次已选入的辅助摘要。', 'context'),
    ], demo: { ...demoTime, observations: [{ sourceKey: 'S1', floorId: 'demo-floor', description: '程一仍在图书馆门口等待。' }],
      context: [{ floorId: 'demo-floor', summary: '林遥和程一约定闭馆前交接钥匙。' }] },
    example: { changes: [] },
    hint: 'changes 填写本次应登记或更新的事项。新增事项引用 observations 的 sourceKeys，无变化可返回空数组。',
  }, {
    id: 'timeReview', label: '时间事项现状评估', sections: timeFields,
    demo: demoTime, example: { changes: [{ itemId: 'demo-item-1', progression: '', assessmentReason: '尚缺是否完成交接的证据。', retirementReason: '' }] },
    hint: '逐项使用 trackedItems 中的 itemId。对每个待评估事项给出当前估计、有依据的退出理由或材料不足的具体原因。',
  }, {
    id: 'annualSetting', label: '年度日期设定', sections: [
      field('setting_sources', '年度设定来源', '本次抽取的人物资料或用户人设片段及 sourceId。', 'sources'),
    ], demo: { task: 'annual-settings', sources: [{ sourceId: 'S1', person: '程一', field: 'birthday', content: '生日是六月初六。' }] },
    example: { sources: [{ sourceId: 'S1', items: [{ category: 'birthday', label: '程一生日', originalDate: '六月初六', note: '程一的生日' }] }] },
    hint: '每个 sourceId 必须返回一次。原样保留给定日期，缺少合格年度设定的来源填写空 items。',
  }, {
    id: 'placeInit', label: '地点初始化', payload: true, sections: [knownPlaces, placeSources],
    demo: { task: 'organizePlaces', payload: { mode: 'initialize', knownPlaces: [demoPlace], placeWorldbookSources: [demoBookSource],
      storedPlaceEvidence: { columns: demoEvidence.columns, rows: [] }, characterCardSources: [] } },
    example: { placePaths: [] },
    hint: 'placePaths 中的路径按从大到小排列，新记录使用输入中的设定来源编号及可定位引文。',
  }, {
    id: 'places', label: '地点整理', payload: true, sections: [
      knownPlaces, field('evidence', '已存地点证据', '已有引文、来源角色与对应的地点编号。', 'storedPlaceEvidence'),
      placeSources, field('card_sources', '角色卡引文', '本次选入的已存角色卡引文及其来源编号。', 'characterCardSources'),
    ], demo: { task: 'organizePlaces', payload: { mode: 'organize', knownPlaces: [demoPlace], storedPlaceEvidence: demoEvidence,
      placeWorldbookSources: [demoBookSource], characterCardSources: [{ sourceKey: 'character-card-1', field: 'description', content: '程一在白桦图书馆工作。' }] } },
    example: { placePaths: [], placeMerges: [] },
    hint: 'placePaths 可校对归属和地点资料。确认是同一地点时，placeMerges 用 sourceKey、targetKey 引用已有地点。',
  }, {
    id: 'qianshiHistory', label: '千事历史补齐', sections: [
      rows('floor_body', '各楼 AI 正文', '本批原文及对应楼号。', 'floors', 'sourceCanonicalContent', floorIds),
      rows('user_input', '各楼前置用户输入', '与每楼配对的用户输入快照。', 'floors', 'sourceUserInputSnapshot', floorIds),
      rows('memory', '各楼有效摘要', '各楼实际生效的摘要及对应楼号。', 'floors', 'effectiveSummary', floorIds), qianshiCandidates,
    ], demo: { task: 'extractQianshiHistoryV1', floors: [{ floorKey: 'floor-3', assistantSeq: 3, sourceCanonicalContent: demoBody,
      sourceUserInputSnapshot: { messages: demoInput }, effectiveSummary: demoSummary, existingStatus: 'unprocessed', qianshiCandidateKeys: ['candidate-1'] }],
      qianshiCandidates: [demoCandidate] },
    example: { floors: [{ floorKey: 'floor-3', qianshi: { events: [summaryEvent], order: [] } }] },
    hint: '每个输入 floorKey 恰好返回一次。无事件增量的楼也填写空 events 和 order。',
  }, {
    id: 'qianshiRejudge', label: '千事记录重判', sections: [
      rows('floor_body', '各楼 AI 正文', '本次重判使用的正文及其楼号。', 'floors', 'source', floorIds),
      rows('user_input', '各楼前置用户输入', '与每楼配对的用户输入快照。', 'floors', 'precedingUserInput', floorIds),
      rows('memory', '各楼有效摘要', '作为重判依据的已保存摘要。', 'floors', 'summary', floorIds),
      rows('records', '已存千事', '本次需逐条复核的旧记录及其编号。', 'floors', 'records', floorIds), qianshiCandidates,
    ], demo: { task: 'rejudgeStoredQianshiV1', floors: [{ floorKey: 'floor-3', source: demoBody, precedingUserInput: { messages: demoInput }, summary: demoSummary,
      records: [demoRecord], requiredRecordKeys: ['record-1'], qianshiCandidateKeys: ['candidate-1'] }], qianshiCandidates: [demoCandidate] },
    example: { floors: [{ floorKey: 'floor-3', qianshi: { recordDecisions: [{ key: 'record-1', status: 'completed', actionStatus: 'completed', matter: true, following: false, links: [] }] } }] },
    hint: '每楼的 recordDecisions 与该楼 requiredRecordKeys 一一对应，保留原记录的事实。',
  }, {
    id: 'qianshiFollowup', label: '千事跟进复核', sections: [
      field('matters', '待复核事项', '选入本次复核的持续事项及其已有记录。', 'matters'),
      field('memory', '摘要时间线', '按楼序提供的有效摘要和用户输入引用。', 'timeline'),
      field('user_input', '对应用户输入', '时间线引用的用户材料及编号。', 'users'),
    ], demo: { task: 'reviewQianshiFollowingV1', throughFloorKey: 'floor-3', matters: [{ key: 'matter-1', status: 'planned', following: true,
      records: [{ floorKey: 'floor-3', title: demoRecord.title, description: demoRecord.description, isCurrent: true }] }],
      users: [{ key: 'user-1', content: demoInput[0].content }], timeline: [{ floorKey: 'floor-3', summary: '两人约定闭馆前还钥匙。', userRefs: ['user-1'] }],
      requiredMatterKeys: ['matter-1'], previousDecisions: [], finalWindow: true },
    example: { decisions: [{ key: 'matter-1', status: 'inProgress', following: true, reason: '约定仍待履行。', evidenceFloorKeys: ['floor-3'] }] },
    hint: '每个 requiredMatterKeys 中的键返回一条 decisions 记录，引用实际提供的楼号。',
  }, {
    id: 'worldbookClassify', label: '资料条目分类', sections: [entries],
    demo: { entries: [demoEntry] }, example: { entries: [{ uid: 'entry-1', kind: 'fact', needsReview: false, segments: [{ id: 's1', writable: true }] }] },
    hint: '每个本批输入编号填写一次，混合条目按原文顺序标记可维护片段。',
  }, {
    id: 'worldbookUpdate', label: '资料条目更新', sections: [
      entries, source('memory', '本批摘要', '本批记忆及可用于修订的证据编号。', 'memory'),
      source('background', '历史背景', '本批以前已选入的背景摘要及来源楼号。', 'background'),
      source('cse', '人物状态', '截至本批末楼的人物状态及证据编号。', 'cse'),
      source('visible_chat', '对话材料', '本次选入的对话原文、角色和证据编号。', 'dialogue'),
    ], demo: { entries: [{ uid: 'entry-1', label: '白桦图书馆', segments: [{ id: 's1', text: demoPlaceText }] }],
      scope: { previousCheckedIndex: 1, fromIndex: 2, toIndex: 4 }, cseSnapshot: { floorIndex: 4, status: 'ready', subjectCount: 1 },
      sources: [{ id: 'memory:4', kind: 'memory', floors: [4], text: demoSummary },
        { id: 'memory:0', kind: 'background', floors: [0], text: '林遥向图书馆借了钥匙。' },
        { id: 'cse:0:situational:0', kind: 'cse', floors: [4], subject: '程一', category: 'situational', text: '在馆门口等候。', visibility: 'observable' },
        { id: 'dialogue:4', kind: 'dialogue', floors: [4], role: 'assistant', text: demoBody }] },
    example: { changes: [], unchangedReason: '本批材料未显示原有设定发生变化。', reviewNeeded: [] },
    hint: '修改时，每项 changes 引用本批 uid、segmentId 和 evidenceRefs，并用 replacements 给出逐字原文及替换文本。',
  }, {
    id: 'worldbookSelect', label: '资料条目选材', sections: [
      entries, field('recent', '最近对话', '本次选材使用的最近对话及角色。', 'recent'),
    ], demo: [{ entries: [demoEntry] }, { recent: [{ role: 'user', content: '我能去哪里阅览这些书？' }] }],
    example: { selected: ['entry-1'] },
    hint: 'selected 只填写本批 entries 中的 uid。没有相关条目时返回空数组。',
  },
];

export const AUX_TASKS = Object.freeze(registry.map(({ id, label, sections, example, hint }) => Object.freeze({
  id, label,
  macros: Object.freeze([...base, ...sections, remaining].map(({ name, label, description }) => Object.freeze({ name, label, description }))),
  outputExample: JSON.stringify(example, null, 2), outputHint: hint,
})));

export function getAuxDemoTaskOptions(taskId) {
  const task = registry.find(item => item.id === taskId);
  if (!task) return null;
  const packets = Array.isArray(task.demo) ? task.demo : [task.demo];
  return {
    promptTask: task.id,
    systemPrompt: `${task.label}的示例指令。\n${task.hint}`,
    taskMessages: packets.map(packet => ({ role: 'user', content: JSON.stringify(packet) })),
  };
}

const asText = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function take(object, property) {
  if (!Object.hasOwn(object, property)) return undefined;
  const value = object[property];
  // Keep absent evidence explicit in the remainder; an empty standalone macro
  // then lets the editor explain why that message would be skipped.
  if (value == null || value === '' || Array.isArray(value) && !value.length || record(value) && !Object.keys(value).length) return undefined;
  delete object[property];
  return value;
}

function takeSection(target, section) {
  const { property, table, ids, kind } = section;
  if (kind) {
    if (!Array.isArray(target[property])) return undefined;
    const matched = target[property].filter(item => item?.kind === kind);
    if (!matched.length) return undefined;
    const unused = target[property].filter(item => item?.kind !== kind);
    if (unused.length) target[property] = unused;
    else delete target[property];
    return matched;
  }
  if (!table) return take(target, property);
  const anchor = section.includeTop ? take(target, property) : undefined;
  const members = [];
  for (const row of Array.isArray(target[table]) ? target[table] : []) {
    if (!record(row)) continue;
    const material = take(row, property);
    if (material === undefined) continue;
    const rowIds = Object.fromEntries(ids.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    members.push({ ...rowIds, [property]: material });
  }
  if (!members.length) return anchor;
  if (!section.includeTop) return members;
  return { ...(anchor === undefined ? {} : { [property]: anchor }), [table]: members };
}

export function getAuxPromptValues(taskId, options, prefix = '') {
  const task = registry.find(item => item.id === taskId);
  const contents = (Array.isArray(options?.taskMessages) ? options.taskMessages : []).map(message => asText(message?.content));
  const values = {
    qqj_prefix: typeof prefix === 'string' ? prefix : '',
    qqj_instructions: typeof options?.systemPrompt === 'string' ? options.systemPrompt : '',
    qqj_input: contents.join('\n\n'),
  };
  if (!task) return values;
  const parts = Object.fromEntries(task.sections.map(({ name }) => [name, []]));
  const rest = [];
  for (const content of contents) {
    let packet;
    try { packet = JSON.parse(content); } catch { rest.push(content); continue; }
    const target = task.payload ? packet?.payload : packet;
    if (!record(target)) { rest.push(content); continue; }
    let changed = false;
    for (const section of task.sections) {
      const value = takeSection(target, section);
      if (value !== undefined) {
        parts[section.name].push(asText(value));
        changed = true;
      }
    }
    if (!changed) rest.push(content);
    else if (Object.keys(packet).length) rest.push(asText(packet));
  }
  for (const [name, texts] of Object.entries(parts)) values[name] = texts.join('\n\n');
  values.qqj_remaining = rest.join('\n\n');
  return values;
}
