import { getAuxHostPrompt } from './aux-prompt-library.js';
import { normalizeSummarySource } from './inline-memory-format.js';
import { INLINE_MEMORY_MACRO_NAME } from './inline-memory-prompt.js';

export function registerInlineMemoryMacro(host, settings) {
  const description = '使用当前千千结预设的主回复文末摘要提示词，随摘要来源切换。';
  const handler = () => {
    const current = settings.get();
    if (current.pluginEnabled === false || normalizeSummarySource(current.summarySource) === 'api') return '';
    return getAuxHostPrompt(current.auxPromptLibrary, 'inlineMemoryPrompt', { display: true });
  };
  // Hosts with both registries dispatch through the engine selected in their settings.
  if (typeof host.macros?.register === 'function'
      && (host.powerUserSettings?.experimental_macro_engine || typeof host.registerMacro !== 'function')) {
    host.macros.register(INLINE_MEMORY_MACRO_NAME, { description, handler });
  } else if (typeof host.registerMacro === 'function') {
    host.registerMacro(INLINE_MEMORY_MACRO_NAME, handler, description);
  }
}
