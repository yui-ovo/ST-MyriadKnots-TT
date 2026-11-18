export function inlinePacket(overrides = {}) {
  return { version: 1, summary: '裴晚生提醒林岚带伞。', people: [{ name: '裴晚生', presence: 'present' }, { name: '林岚', role: 'user', presence: 'present' }],
    time: [], locations: [], actions: [], knowledge: [], informationTransfers: [], privateThoughts: [], commitments: [], exactQuotes: [], openLoops: [], cseSignals: [],
    spatialFacts: { places: [], containments: [], positions: [] }, placePaths: [], qianshi: { events: [], order: [] }, ...overrides };
}
export const inlineBlock = packet => `<qqj_memory>\n${JSON.stringify(packet)}\n</qqj_memory>`;
