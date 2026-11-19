import { createSettingsKit } from './kit.js';
import { INLINE_MEMORY_MACRO } from '../../inline-memory-prompt.js';

export function createInlineMemoryMacroField({ documentRef, navigatorRef = documentRef.defaultView?.navigator ?? globalThis.navigator }) {
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

export function createBodyReadSettings({ settings, documentRef = globalThis.document, subscribeSettingsChange, onStoryClockChange }) {
  const { element, field, subDrawer } = createSettingsKit(documentRef);
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
  return { node: drawer, refresh, dispose: () => unsubscribe?.() };
}
