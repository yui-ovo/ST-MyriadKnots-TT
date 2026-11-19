export const narrative = '2026年11月19日09:00，林岚与裴晚生走进钟楼的一层书房。裴晚生把钥匙交给林岚，说：“晚上八点在钟楼会合。”林岚答应了。林岚手背有一道擦伤。裴晚生心想：“希望她能按时到。”失联的向导仍未找到。两人因这次合作更信任彼此。';
const summary = '11月19日上午九点，林岚与裴晚生进入钟楼一层的书房。裴晚生交付钥匙，两人约定晚上八点在钟楼会合，林岚接受了约定；目前尚未履行晚间会合。林岚手背有擦伤，裴晚生私下希望她按时赴约。失联向导仍未找到，两人的信任因合作增加。';
const quote = '林岚与裴晚生走进钟楼的一层书房。';
const source = { source: 'canonicalContent', sourceFloorKey: 'current', exactQuote: quote };
export const packet = {
  version: 1, summary,
  people: [{ name: '林岚', aliases: [], role: 'user', presence: 'present' }, { name: '裴晚生', aliases: ['裴先生', '晚生'], role: 'character', presence: 'present' }],
  time: [{ sourceText: '2026年11月19日09:00', description: '11月19日上午九点', kind: 'explicit', normalized: '2026-11-19T09:00:00', precision: 'exact' }],
  locations: [{ name: '书房', change: 'entered', people: ['林岚', '裴晚生'] }],
  actions: [{ actor: '裴晚生', targets: ['林岚'], action: '交付钥匙', completion: 'completed', result: '林岚拿到钥匙' }],
  knowledge: [{ subject: '林岚', kind: 'injury', description: '手背有一道擦伤' }],
  informationTransfers: [{ from: '裴晚生', to: ['林岚'], claimText: '晚上八点在钟楼会合。', channel: 'told' }],
  privateThoughts: [{ holder: '裴晚生', thought: '希望她能按时到。', kind: 'thought' }],
  commitments: [{ issuer: '裴晚生', recipient: ['林岚'], content: '晚上八点在钟楼会合', kind: 'agreement', status: 'accepted' }],
  exactQuotes: [{ exactText: '晚上八点在钟楼会合。', speaker: '裴晚生', whyPreserve: '核对赴约时间与地点', source: 'canonicalContent' }],
  openLoops: [{ description: '失联的向导仍未找到', owners: ['林岚', '裴晚生'] }],
  cseSignals: [{ subject: '林岚', object: '裴晚生', signalType: 'trust', description: '两人因合作更信任彼此' }],
  spatialFacts: {
    places: [{ key: 'place-mention-1', name: '钟楼', identity: 'new', ...source }, { key: 'place-mention-2', name: '一层', identity: 'new', ...source }, { key: 'place-mention-3', name: '书房', identity: 'new', ...source }],
    containments: [{ placeKey: 'place-mention-2', parentPlaceKey: 'place-mention-1', ...source }, { placeKey: 'place-mention-3', parentPlaceKey: 'place-mention-2', ...source }],
    positions: [{ subject: '林岚', placeKey: 'place-mention-3', status: 'confirmed', ...source }, { subject: '裴晚生', placeKey: 'place-mention-3', status: 'confirmed', ...source }],
  },
  placePaths: [{ path: [{ name: '钟楼', placeKey: 'place-mention-1' }, { name: '一层', placeKey: 'place-mention-2' }, { name: '书房', placeKey: 'place-mention-3' }], placeKey: 'place-mention-3', ...source }],
  qianshi: {
    events: [
      { key: 'event-1', sourceFloorKey: 'current', title: '交接钥匙', description: '裴晚生把钥匙交给林岚', status: 'completed', actionStatus: 'completed', storyTime: '2026-11-19 09:00', scheduledTime: null, people: ['裴晚生', '林岚'], object: '钥匙', matter: false, links: [] },
      { key: 'event-2', sourceFloorKey: 'current', title: '晚间钟楼会合', description: '两人约定晚上八点在钟楼会合', status: 'planned', actionStatus: 'planned', storyTime: '2026-11-19 09:00', scheduledTime: '2026-11-19 20:00', people: ['裴晚生', '林岚'], object: null, matter: true, links: [] },
    ], order: [{ before: 'event-1', after: 'event-2', certainty: 'explicit' }],
  },
};
export const block = `<qqj_memory>
【摘要】
${summary}
【人物】
林岚｜无｜user｜present
裴晚生｜裴先生、晚生｜character｜present｜无
【时间】
2026年11月19日09:00｜11月19日上午九点｜explicit｜2026-11-19T09:00:00｜exact
【地点变化】
书房｜entered｜林岚、裴晚生
【行动】
裴晚生｜林岚｜交付钥匙｜completed｜林岚拿到钥匙
【观察】
林岚｜injury｜手背有一道擦伤
【信息传递】
裴晚生｜林岚｜晚上八点在钟楼会合。｜told
【内心】
裴晚生｜希望她能按时到。｜thought
【约定】
裴晚生｜林岚｜晚上八点在钟楼会合｜agreement｜accepted
【关键原句】
晚上八点在钟楼会合。｜裴晚生｜核对赴约时间与地点｜canonicalContent
【未决事项】
失联的向导仍未找到｜林岚、裴晚生
【状态线索】
林岚｜裴晚生｜trust｜两人因合作更信任彼此
【空间地点】
place-mention-1｜钟楼｜new｜canonicalContent｜${quote}
place-mention-2｜一层｜new｜canonicalContent｜${quote}
place-mention-3｜书房｜new｜canonicalContent｜${quote}
【地点包含】
place-mention-2｜place-mention-1｜canonicalContent｜${quote}
place-mention-3｜place-mention-2｜canonicalContent｜${quote}
【人物位置】
林岚｜place-mention-3｜confirmed｜canonicalContent｜${quote}
裴晚生｜place-mention-3｜confirmed｜canonicalContent｜${quote}
【地点路径】
place-mention-1→place-mention-2→place-mention-3｜place-mention-3｜canonicalContent｜${quote}
【事件】
event-1｜交接钥匙｜裴晚生把钥匙交给林岚｜completed｜completed｜2026-11-19 09:00｜无｜裴晚生、林岚｜钥匙｜否｜无｜无
event-2｜晚间钟楼会合｜两人约定晚上八点在钟楼会合｜planned｜planned｜2026-11-19 09:00｜2026-11-19 20:00｜裴晚生、林岚｜无｜是
【事件顺序】
event-1｜event-2｜explicit
</qqj_memory>`;
