// Shape only: never retain provider text, reasoning, refusals, or arbitrary keys.
const TYPES = new Set(['missing', 'null', 'string', 'array', 'object', 'number', 'boolean', 'other']);
export function sanitizeCompletionDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['choiceCount', 'contentCharacters', 'contentParts', 'eventCount']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (TYPES.has(value.contentType)) result.contentType = value.contentType;
  for (const key of ['reasoningPresent', 'refusalPresent', 'toolCallsPresent', 'providerErrorPresent']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return result;
}

export function describeCompletionResponse(data) {
  const choice = data?.choices?.[0], message = choice?.delta ?? choice?.message;
  const content = message?.content ?? choice?.text ?? data?.content
    ?? (message?.content === null || choice?.text === null || data?.content === null ? null : undefined);
  const present = value => value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
  return {
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
    contentType: content === undefined ? 'missing' : content === null ? 'null' : Array.isArray(content) ? 'array' : TYPES.has(typeof content) ? typeof content : 'other',
    contentCharacters: typeof content === 'string' ? content.length : 0,
    contentParts: Array.isArray(content) ? content.length : 0,
    reasoningPresent: present(message?.reasoning_content) || present(message?.reasoning),
    refusalPresent: present(message?.refusal),
    toolCallsPresent: present(message?.tool_calls),
    providerErrorPresent: present(data?.error),
  };
}
