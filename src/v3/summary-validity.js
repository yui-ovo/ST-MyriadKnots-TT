// Some gateways deliver provider rejection notices as ordinary completion text.
const googlePolicyNotice = /^(?:the prompt could not be submitted\.\s*the prompt contains|the model output could not be generated\.\s*this output contains) sensitive words that violate google['’]s\b/iu;
const blockedReason = /^(?:prohibited_content|safety|content_filter|blocklist|spii|image_safety|image_prohibited_content)$/iu;

export function isBlockedFinishReason(reason) {
  return typeof reason === 'string' && blockedReason.test(reason.trim());
}

export function isProviderBlockNotice(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  const reason = /^finishReason\s*:\s*(\w+)(?:\s+finishMessage\s*:|\s*$)/iu.exec(text);
  return isBlockedFinishReason(reason?.[1]) || googlePolicyNotice.test(text);
}

export function hasBlockedSummary(memory) {
  return memory?.summary?.effectiveSource !== 'user' && isProviderBlockNotice(memory?.summary?.aiText);
}

export function isUsableFloorMemory(memory) {
  return memory?.recordStatus === 'active' && !hasBlockedSummary(memory);
}
