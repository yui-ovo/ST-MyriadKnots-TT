const invalid = () => Object.assign(new Error('本楼文字记忆的分栏或字段格式不完整，请使用配套提示词后重读。'), { code: 'V3_INLINE_MEMORY_INVALID' });
const incomplete = () => Object.assign(new Error('本楼文字记忆缺少栏目，请使用配套提示词；没有内容的栏目需明确填写“无”。'), { code: 'V3_INLINE_MEMORY_INCOMPLETE' });
const SECTIONS = Object.freeze(['摘要', '人物', '时间', '地点变化', '行动', '观察', '信息传递', '内心', '约定', '关键原句', '未决事项', '状态线索', '空间地点', '地点包含', '人物位置', '地点路径', '事件', '事件顺序']);
const empty = value => ['', '无', '（无）'].includes(value.trim());

// Preserve escapes until the final value is read: a quoted list/path separator
// must survive the outer column split. Nothing here interprets prose as facts.
function split(value, separator) {
  const parts = []; let part = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '\\' && i + 1 < value.length) { part += char + value[++i]; continue; }
    if (char === separator) { parts.push(part.trim()); part = ''; } else part += char;
  }
  parts.push(part.trim()); return parts;
}
const text = value => value.replace(/\\([\\｜、→n【】无])/gu, (_match, char) => char === 'n' ? '\n' : char);
const nullable = value => empty(value) ? null : text(value);
const list = value => empty(value) ? [] : split(value, '、').map(text).filter(Boolean);
function boolean(value) {
  if (['是', 'true'].includes(value)) return true;
  if (['否', 'false'].includes(value)) return false;
  throw invalid();
}
const sourced = (source, exactQuote) => ({ source: text(source), sourceFloorKey: 'current', exactQuote: text(exactQuote) });
const reference = (key, value) => empty(value ?? '') ? {} : { [key]: text(value) };

export function parseInlineMemoryText(body) {
  const sections = new Map(); let current = null;
  for (const rawLine of body.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim();
    const heading = /^【([^】]+)】$/u.exec(line);
    if (heading) {
      current = heading[1];
      if (!SECTIONS.includes(current) || sections.has(current)) throw invalid();
      sections.set(current, []);
    } else if (current) sections.get(current).push(rawLine);
    else if (line) throw invalid();
  }
  if (SECTIONS.some(name => !sections.has(name) || !sections.get(name).join('').trim())) throw incomplete();
  const rows = (section, required, maximum, read) => {
    const lines = sections.get(section).map(line => line.trim()).filter(Boolean);
    if (lines.length === 1 && empty(lines[0])) return [];
    return lines.map(line => {
      if (empty(line)) throw invalid();
      const fields = split(line, '｜');
      if (fields.length < required || fields.length > maximum) throw invalid();
      return read(fields);
    });
  };
  const places = rows('空间地点', 5, 7, ([key, name, identity, source, quote, sameAsPlaceKey, aliases = '无']) => ({
    key: text(key), name: text(name), identity: text(identity), ...sourced(source, quote),
    ...reference('sameAsPlaceKey', sameAsPlaceKey), ...(empty(aliases) ? {} : { aliases: list(aliases) }),
  }));
  const path = value => split(value, '→').map(segment => {
    const name = text(segment);
    if (!name) throw invalid();
    if (!/^place-mention-/u.test(name)) return { name };
    const matches = places.filter(place => place.key === name);
    if (matches.length !== 1) throw invalid();
    const place = matches[0];
    return { name: place.name, placeKey: place.key, ...reference('sameAsPlaceKey', place.sameAsPlaceKey) };
  });
  return {
    version: 1,
    summary: text(sections.get('摘要').join('\n').trim()),
    people: rows('人物', 4, 5, ([name, aliases, role, presence, sameAsEntityKey]) => ({ name: text(name), aliases: list(aliases), role: text(role), presence: text(presence), ...reference('sameAsEntityKey', sameAsEntityKey) })),
    time: rows('时间', 5, 5, ([sourceText, description, kind, normalized, precision]) => ({ sourceText: text(sourceText), description: text(description), kind: text(kind), normalized: nullable(normalized), precision: text(precision) })),
    locations: rows('地点变化', 3, 3, ([name, change, people]) => ({ name: text(name), change: text(change), people: list(people) })),
    actions: rows('行动', 5, 5, ([actor, targets, action, completion, result]) => ({ actor: text(actor), targets: list(targets), action: text(action), completion: text(completion), result: nullable(result) })),
    knowledge: rows('观察', 3, 3, ([subject, kind, description]) => ({ subject: nullable(subject), kind: text(kind), description: text(description) })),
    informationTransfers: rows('信息传递', 4, 4, ([from, to, claimText, channel]) => ({ from: nullable(from), to: list(to), claimText: text(claimText), channel: text(channel) })),
    privateThoughts: rows('内心', 3, 3, ([holder, thought, kind]) => ({ holder: text(holder), thought: text(thought), kind: text(kind) })),
    commitments: rows('约定', 5, 5, ([issuer, recipient, content, kind, status]) => ({ issuer: text(issuer), recipient: list(recipient), content: text(content), kind: text(kind), status: text(status) })),
    exactQuotes: rows('关键原句', 4, 4, ([exactText, speaker, whyPreserve, source]) => ({ exactText: text(exactText), speaker: nullable(speaker), whyPreserve: text(whyPreserve), source: text(source) })),
    openLoops: rows('未决事项', 2, 2, ([description, owners]) => ({ description: text(description), owners: list(owners) })),
    cseSignals: rows('状态线索', 4, 4, ([subject, object, signalType, description]) => ({ subject: text(subject), object: nullable(object), signalType: text(signalType), description: text(description) })),
    spatialFacts: { places,
      containments: rows('地点包含', 4, 4, ([placeKey, parentPlaceKey, source, quote]) => ({ placeKey: text(placeKey), parentPlaceKey: nullable(parentPlaceKey), ...sourced(source, quote) })),
      positions: rows('人物位置', 5, 5, ([subject, placeKey, status, source, quote]) => ({ subject: text(subject), placeKey: nullable(placeKey), status: text(status), ...sourced(source, quote) })),
    },
    placePaths: rows('地点路径', 4, 4, ([segments, placeKey, source, quote]) => ({ path: path(segments), placeKey: text(placeKey), ...sourced(source, quote) })),
    qianshi: {
      events: rows('事件', 10, 12, ([key, title, description, status, actionStatus, storyTime, scheduledTime, people, object, matter, candidateKey = '无', kind = '无']) => {
        if (empty(candidateKey) !== empty(kind)) throw invalid();
        return { key: text(key), sourceFloorKey: 'current', title: text(title), description: text(description), status: text(status), actionStatus: text(actionStatus), storyTime: nullable(storyTime), scheduledTime: nullable(scheduledTime), people: list(people), object: nullable(object), matter: boolean(matter), links: empty(candidateKey) ? [] : [{ candidateKey: text(candidateKey), kind: text(kind) }] };
      }),
      order: rows('事件顺序', 3, 3, ([before, after, certainty]) => ({ before: text(before), after: text(after), certainty: text(certainty) })),
    },
  };
}
