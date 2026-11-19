import { createSettingsKit } from './kit.js';
import { INLINE_MEMORY_MACRO } from '../../inline-memory-prompt.js';

function createInlineMemoryMacroField({ documentRef, navigatorRef = documentRef.defaultView?.navigator ?? globalThis.navigator }) {
  const { element, button } = createSettingsKit(documentRef);
  const box = element('div', 'qqj-inline-memory-macro');
  const macro = element('input', 'settings-input');
  macro.type = 'text'; macro.readOnly = true; macro.value = INLINE_MEMORY_MACRO;
  macro.setAttribute('aria-label', '酒馆文末摘要宏');
  const status = element('span', 'settings-hint');
  status.setAttribute('role', 'status');
  const copy = button('复制宏', 'secondary-action', async () => {
    try {
      await navigatorRef.clipboard.writeText(INLINE_MEMORY_MACRO);
      status.textContent = '已复制宏。';
    } catch {
      macro.focus(); macro.select();
      status.textContent = '请长按选中的宏复制。';
    }
  });
  box.append(macro, copy, status);
  return box;
}

export function createPresetPageSettings({ settings, documentRef = globalThis.document, navigatorRef, subscribeSettingsChange, onStoryClockChange }) {
  const { element, field, appendOption, subDrawer } = createSettingsKit(documentRef);
  const node = element('div', 'settings-page');
  const sourceSection = element('section', 'settings-block');
  const source = element('select', 'settings-input');
  source.setAttribute('aria-label', '摘要来源');
  appendOption(source, 'api', '千千结 API');
  appendOption(source, 'inline', '只读主回复记忆区块');
  appendOption(source, 'auto', '主回复优先，没有区块才调用摘要 API');
  source.addEventListener('change', () => settings.update({ summarySource: source.value }));
  const macro = subDrawer({ title: '主回复文末摘要 · 酒馆宏' });
  macro.body.append(
    element('p', 'settings-hint', '用这行宏替换酒馆预设「文末摘要」条目的全部内容，并启用该条目。选择「千千结 API」时，宏会展开为空文本。在本页「任务」中选择「主回复文末摘要」可查看或修改提示词。'),
    createInlineMemoryMacroField({ documentRef, navigatorRef }),
  );
  sourceSection.append(field('摘要来源', source),
    element('p', 'settings-hint', '所有预设共用此选择，下次处理摘要时生效。主回复记忆区块残缺时会提示修正。CSE 单独分析，整段历史压缩使用摘要 API。'),
    macro.drawer);

  const { drawer, body } = subDrawer({ title: '正文读取与时间戳', id: 'qqj-settings-wrappers' });
  const tags = settings.wrappers();
  const keep = element('input', 'settings-input');
  keep.value = tags.keepTags; keep.placeholder = 'content';
  const extra = element('input', 'settings-input');
  extra.value = tags.extraTags; extra.placeholder = '如 think, reasoning, [[...]]';
  keep.addEventListener('change', () => settings.updateWrappers({ keepTags: keep.value }));
  extra.addEventListener('change', () => settings.updateWrappers({ extraTags: extra.value }));

  const clock = element('input');
  clock.type = 'checkbox';
  const toggle = element('label', 'setting-switch');
  toggle.append(clock, element('span', '', '启用正文时间戳'));
  const reference = element('input', 'settings-input');
  reference.placeholder = '可选，用逗号或换行分隔';
  const status = element('p', 'settings-result');
  status.id = 'qqj-story-clock-status';
  const refreshClock = () => {
    status.textContent = onStoryClockChange?.()?.label ?? '时间戳状态将在下次正文生成前刷新。';
  };
  clock.addEventListener('change', () => { settings.update({ storyClockEnabled: clock.checked }); refreshClock(); });
  reference.addEventListener('change', () => { settings.update({ storyClockReferenceTags: reference.value }); refreshClock(); });
  const refresh = () => {
    const latest = settings.wrappers(), saved = settings.get();
    source.value = saved.summarySource ?? 'api';
    for (const [control, value] of [[keep, latest.keepTags], [extra, latest.extraTags], [reference, saved.storyClockReferenceTags ?? '']]) {
      if (documentRef.activeElement !== control && !control.matches?.(':focus')) control.value = value;
    }
    clock.checked = saved.storyClockEnabled !== false;
  };
  keep.addEventListener('blur', refresh); extra.addEventListener('blur', refresh); reference.addEventListener('blur', refresh);
  refresh();
  status.textContent = onStoryClockChange?.({ readOnly: true })?.label ?? '时间戳状态将在下次正文生成前刷新。';
  const unsubscribe = subscribeSettingsChange?.(refresh);
  body.append(element('p', 'settings-hint', '这些设置对所有预设生效。正文包裹符由白鳥系列插件共享。'),
    field('保留包裹符', keep), field('清洗包裹符', extra), toggle, field('正文时间参考标签', reference), status);
  node.append(sourceSection, drawer);
  return { node, macroDrawer: macro.drawer, refresh, dispose: () => unsubscribe?.() };
}
