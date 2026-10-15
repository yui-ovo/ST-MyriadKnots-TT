// Shape only: never retain provider text, reasoning, refusals, or arbitrary keys.
const TYPES = new Set(['missing', 'null', 'string', 'array', 'object', 'number', 'boolean', 'other']);
const PROVIDER_MESSAGES = new Set([
  '上游不接受当前 JSON 响应格式', '上游拒绝了请求参数', '上游认为请求内容超过限制',
  '上游请求频率受限', '上游认证或权限检查失败', '上游未找到请求的资源',
  '上游处理请求超时', '上游错误详情已隐藏', '上游返回了无法安全解析的错误 JSON',
]);
export function sanitizeProviderDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['code', 'status', 'type']) {
    const field = value[key];
    if (field == null) continue;
    result[key] = (typeof field === 'string' || typeof field === 'number') && /^[a-z0-9_.:-]{1,120}$/iu.test(String(field))
      && !/(?:sk-|bearer|authorization|cookie|secret|api[_-]?key)/iu.test(String(field)) ? String(field) : '[REDACTED]';
  }
  if (value.message != null) result.message = PROVIDER_MESSAGES.has(value.message) ? value.message : '上游错误详情已隐藏';
  return result;
}
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
    providerErrorPresent: data?.error !== false && present(data?.error),
  };
}
