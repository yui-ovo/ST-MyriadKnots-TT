import { createSettingsKit } from './kit.js';
import { createInlineSelect } from '../inline-select.js';
import { publicErrorMessage } from '../../public-error.js';
import { AUX_TASKS } from '../../aux-prompt-tasks.js';
import {
  AUX_BUILTIN_ID, normalizeAuxPromptLibrary, listAuxPresets, getAuxPromptPreset,
  resolveAuxPromptPreset, getAuxPromptBinding, getAuxEntryUses, editAuxPromptLibrary,
} from '../../aux-prompt-library.js';

const roleNames = { system: '系统', user: '用户', assistant: '助手' };
const roleOptions = Object.entries(roleNames).map(([value, label]) => ({ value, label }));
const taskNames = new Map(AUX_TASKS.map(task => [task.id, task.label]));
const optionsFor = items => items.map(item => ({ value: item.id, label: item.label ?? item.name }));

export function openAuxPromptPresets({ settings, promptPreview, customImpl, documentRef = globalThis.document }) {
  const { element, button, field } = createSettingsKit(documentRef);
  const initial = normalizeAuxPromptLibrary(settings.get().auxPromptLibrary);
  let library = initial;
  let task = AUX_TASKS[0];
  let presetId = resolveAuxPromptPreset(library, task.id).id;
  let applyCurrentForm = null;
  let previewVersion = 0;
  let sorting = false;
  let draggedRow = '';
  const dialog = element('section', 'qqj-editor-dialog qqj-aux-editor');
  const page = element('div', 'qqj-aux-page');
  const feedback = element('p', 'qqj-aux-feedback');
  feedback.setAttribute('role', 'alert');
  const dirty = element('p', 'qqj-aux-dirty');
  dirty.setAttribute('role', 'status');
  dialog.append(page, feedback, dirty);

  const currentPreset = () => getAuxPromptPreset(library, task.id, presetId);
  const note = text => element('p', 'qqj-aux-note', text);
  const group = (...children) => {
    const box = element('div', 'qqj-aux-tools');
    box.append(...children);
    return box;
  };
  const action = (label, callback, css = 'secondary-action') => button(label, css, () => {
    feedback.textContent = '';
    try { callback(); }
    catch (error) { feedback.textContent = publicErrorMessage(error, { fallback: '操作未完成，请检查输入。' }); }
  });
  const picker = (label, options, value, onChange, searchable = false) => createInlineSelect({
    documentRef, ariaLabel: label, options, value, onChange, searchable,
  });
  function namedPicker(label, control) {
    const wrapper = element('div', 'qqj-aux-field');
    wrapper.append(element('span', '', label), control.node);
    return wrapper;
  }
  function switchField(label, checked) {
    const control = element('input');
    control.type = 'checkbox';
    control.checked = checked;
    control.setAttribute('aria-label', label);
    const node = element('label', 'qqj-aux-check');
    node.append(control, element('span', '', label));
    return { node, control };
  }
  function startPage(title = '', backText = '返回列表') {
    previewVersion++;
    applyCurrentForm = null;
    draggedRow = '';
    feedback.textContent = '';
    page.replaceChildren();
    if (title) {
      const heading = element('div', 'qqj-aux-page-head');
      heading.append(element('h3', '', title), action(backText, showList, 'qqj-aux-text-button'));
      page.append(heading);
    }
    const scrollArea = dialog.closest?.('.sp-dialog-custom');
    if (scrollArea) scrollArea.scrollTop = 0;
  }
  function change(actionData) {
    const result = editAuxPromptLibrary(library, actionData);
    library = result.library;
    dirty.textContent = '有待保存的更改';
    return result;
  }
  function uses(entryId) {
    return getAuxEntryUses(library, entryId).map(use => (taskNames.get(use.taskId) ?? use.taskId) + ' / ' + use.name);
  }
  function presetForTask(next) {
    task = AUX_TASKS.find(item => item.id === next);
    presetId = resolveAuxPromptPreset(library, task.id).id;
    sorting = false;
    showList();
  }

  function showList(focusRow = '') {
    startPage();
    const preset = currentPreset();
    const editable = presetId !== AUX_BUILTIN_ID;
    const tasks = picker('任务', optionsFor(AUX_TASKS), task.id, presetForTask);
    const presets = listAuxPresets(library, task.id);
    const choices = picker('预设', optionsFor(presets), preset.id, id => {
      presetId = id; sorting = false; showList();
    }, presets.length > 7);
    const header = element('div', 'qqj-aux-pair');
    header.append(namedPicker('任务', tasks), namedPicker('预设', choices));
    page.append(header, group(action('管理预设', showPresetMenu), action('应用范围', showBindings), action('预览请求', showPreview)));

    const title = element('div', 'qqj-aux-page-head');
    title.append(element('h3', '', '提示词条目'));
    if (editable && preset.rows.length > 1) {
      const sort = action(sorting ? '完成排序' : '排序', () => { sorting = !sorting; showList(); }, 'qqj-aux-text-button');
      sort.setAttribute('aria-pressed', String(sorting));
      title.append(sort);
    }
    page.append(title);
    const list = element('div', 'qqj-aux-rows');
    list.setAttribute('role', 'list');
    const move = (rowId, index) => {
      change({ type: 'moveRow', presetId, rowId, index });
      showList(rowId);
    };
    let toFocus;
    for (const [index, row] of preset.rows.entries()) {
      const item = element('div', 'qqj-aux-row');
      item.setAttribute('role', 'listitem');
      item.setAttribute('data-enabled', String(row.enabled));
      if (editable) {
        const handle = element('span', 'qqj-aux-grip', '⠿');
        handle.draggable = true;
        handle.title = '拖动排序';
        handle.setAttribute('aria-hidden', 'true');
        handle.addEventListener('dragstart', event => {
          draggedRow = row.id;
          event.dataTransfer?.setData('text/plain', row.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        handle.addEventListener('dragend', () => { draggedRow = ''; });
        item.addEventListener('dragover', event => { if (draggedRow) event.preventDefault(); });
        item.addEventListener('drop', event => {
          if (!draggedRow) return;
          event.preventDefault();
          if (draggedRow !== row.id) move(draggedRow, index);
          draggedRow = '';
        });
        item.append(handle);
      }
      const edit = action(row.name, () => showEntry(row), 'qqj-aux-row-name');
      if (row.id === focusRow) toFocus = edit;
      item.append(edit, element('span', 'qqj-aux-row-role', roleNames[row.role]));
      if (sorting && editable) {
        for (const [label, delta, glyph] of [['上移', -1, '↑'], ['下移', 1, '↓']]) {
          const arrow = action(glyph, () => move(row.id, index + delta), 'qqj-aux-arrow');
          arrow.setAttribute('aria-label', label + row.name);
          arrow.disabled = index + delta < 0 || index + delta >= preset.rows.length;
          item.append(arrow);
        }
      } else {
        const included = element('input', 'qqj-aux-toggle');
        included.type = 'checkbox';
        included.checked = row.enabled;
        included.disabled = !editable;
        included.setAttribute('aria-label', '启用' + row.name);
        included.addEventListener('change', () => {
          change({ type: 'updateRow', presetId, rowId: row.id, enabled: included.checked });
          item.setAttribute('data-enabled', String(included.checked));
        });
        item.append(included);
      }
      list.append(item);
    }
    if (!preset.rows.length) list.append(note('此预设暂无条目。'));
    page.append(list);
    const tools = editable
      ? [action('新增条目', () => showEntry()), action('从已有条目添加', showExisting)]
      : [action('复制后编辑', () => showPresetName('copyPreset'))];
    page.append(group(...tools, action('宏与格式', showHelp)));
    const active = resolveAuxPromptPreset(library, task.id);
    page.append(note('任务默认预设 · ' + active.name));
    toFocus?.focus?.({ preventScroll: true });
  }

  function showPresetMenu() {
    startPage('管理预设');
    page.append(note(task.label + ' / ' + currentPreset().name));
    const actions = [action('新建预设', () => showPresetName('createPreset')), action('复制预设', () => showPresetName('copyPreset'))];
    if (presetId !== AUX_BUILTIN_ID) {
      actions.push(action('重命名', () => showPresetName('renamePreset')), action('删除预设', showDeletePreset));
    }
    page.append(group(...actions));
  }

  function showPresetName(type) {
    const names = { createPreset: '新建预设', copyPreset: '复制预设', renamePreset: '重命名预设' };
    startPage(names[type], '放弃编辑');
    const name = element('input', 'settings-input');
    name.type = 'text';
    name.value = type === 'createPreset' ? '' : currentPreset().name + (type === 'copyPreset' ? '（副本）' : '');
    const makeDefault = switchField('设为此任务的默认预设', false);
    page.append(field('预设名称', name));
    let destination;
    if (type === 'copyPreset') {
      destination = picker('复制到任务', optionsFor(AUX_TASKS), task.id);
      page.append(namedPicker('复制到任务', destination));
    }
    if (type !== 'renamePreset') page.append(makeDefault.node);
    applyCurrentForm = () => {
      if (!name.value.trim()) throw new Error('请填写预设名称。');
      const result = change({ type, taskId: task.id, targetTaskId: destination?.value, presetId, name: name.value.trim() });
      if (destination) task = AUX_TASKS.find(item => item.id === destination.value);
      presetId = result.presetId ?? presetId;
      if (makeDefault.control.checked) change({ type: 'bind', taskId: task.id, presetId });
      sorting = false;
      showList();
    };
    page.append(group(action('应用', applyCurrentForm)));
    name.focus?.();
  }

  function showDeletePreset() {
    startPage('删除预设');
    const count = library.bindings.filter(binding => binding.taskId === task.id && binding.presetId === presetId).length;
    page.append(note('删除「' + currentPreset().name + '」？此预设有 ' + count + ' 处绑定，将一起解除。'),
      group(action('确认删除预设', () => {
        change({ type: 'deletePreset', presetId });
        presetId = resolveAuxPromptPreset(library, task.id).id;
        sorting = false;
        showList();
      })));
  }

  function showBindings() {
    startPage('应用范围');
    const routes = promptPreview?.routes?.() ?? [];
    const presets = listAuxPresets(library, task.id);
    page.append(namedPicker('任务默认预设', picker('任务默认预设', optionsFor(presets),
      resolveAuxPromptPreset(library, task.id).id, id => { change({ type: 'bind', taskId: task.id, presetId: id }); })));
    if (!routes.length) {
      page.append(note('暂无可单独指定预设的 API 连接。'));
      return;
    }
    const binding = element('div', 'qqj-aux-field');
    const renderBinding = routeKey => {
      const choices = [{ value: '', label: '跟随任务默认预设' }, ...optionsFor(presets)];
      const control = picker('此连接使用', choices, getAuxPromptBinding(library, task.id, routeKey) ?? '',
        id => { change({ type: 'bind', taskId: task.id, routeKey, presetId: id || null }); });
      binding.replaceChildren(namedPicker('此连接使用', control));
    };
    const routesPicker = picker('API 连接', optionsFor(routes), routes[0].id, renderBinding, routes.length > 7);
    page.append(namedPicker('API 连接', routesPicker), binding);
    renderBinding(routes[0].id);
  }

  function showEntry(row = null) {
    const readOnly = presetId === AUX_BUILTIN_ID;
    startPage(row ? (readOnly ? '查看条目' : '编辑条目') : '新增条目', readOnly ? '返回列表' : '放弃编辑');
    const name = element('input', 'settings-input');
    name.type = 'text'; name.value = row?.name ?? ''; name.readOnly = readOnly;
    const role = picker('消息角色', roleOptions, row?.role ?? 'system');
    role.setDisabled(readOnly);
    const content = element('textarea', 'settings-input');
    content.rows = 8; content.value = row?.content ?? ''; content.readOnly = readOnly;
    const pair = element('div', 'qqj-aux-pair');
    pair.append(field('条目名称', name), namedPicker('消息角色', role));
    page.append(pair, field('提示词内容', content));
    if (readOnly) {
      page.append(group(action('复制预设后编辑', () => showPresetName('copyPreset'))));
      return;
    }

    const macroOptions = task.macros.map(macro => ({ value: macro.name, label: macro.label + ' · {{' + macro.name + '}}' }));
    const macro = picker('插入宏', macroOptions, macroOptions[0]?.value ?? '');
    const macroRow = element('div', 'qqj-aux-insert');
    const insert = action('插入', () => {
      const token = '{{' + macro.value + '}}';
      const from = content.selectionStart ?? content.value.length;
      const to = content.selectionEnd ?? from;
      content.value = content.value.slice(0, from) + token + content.value.slice(to);
      content.focus?.();
      content.setSelectionRange?.(from + token.length, from + token.length);
    });
    insert.disabled = !macroOptions.length;
    macroRow.append(macro.node, insert);
    page.append(macroRow);
    const help = element('div', 'qqj-aux-reference');
    help.hidden = true;
    const helpButton = action('宏与输出格式说明', () => {
      help.hidden = !help.hidden;
      helpButton.setAttribute('aria-expanded', String(!help.hidden));
      if (!help.hidden && !help.children.length) fillHelp(help);
    }, 'qqj-aux-text-button');
    helpButton.setAttribute('aria-expanded', 'false');
    page.append(helpButton, help);
    const referenceCount = row ? library.presets.reduce((n, preset) => n + preset.rows.filter(item => item.entryId === row.entryId).length, 0) : 0;
    const builtinEntry = row?.entryId.startsWith('builtin:');
    let scope;
    if (builtinEntry) page.append(note('编辑此内置条目时，会为本处创建独立副本。'));
    else if (referenceCount > 1) {
      page.append(note('共有 ' + referenceCount + ' 处引用 · ' + uses(row.entryId).join('、')));
      scope = picker('内容修改范围', [
        { value: '', label: '选择修改范围' }, { value: 'local', label: '仅本处（生成独立副本）' },
        { value: 'shared', label: '所有引用此条目的预设' },
      ], '');
      page.append(namedPicker('内容修改范围', scope));
    }
    applyCurrentForm = () => {
      if (!name.value.trim()) throw new Error('请填写条目名称。');
      if (!row) {
        change({ type: 'addEntry', presetId, name: name.value.trim(), content: content.value, role: role.value });
      } else {
        const changedText = name.value.trim() !== row.name || content.value !== row.content;
        if (changedText || scope?.value === 'local') {
          if (scope && !scope.value) throw new Error('此条目有多处引用，请选择内容修改范围。');
          change({ type: 'updateEntry', presetId, rowId: row.id, name: name.value.trim(), content: content.value, mode: builtinEntry ? 'local' : scope?.value });
        }
        if (row.role !== role.value) change({ type: 'updateRow', presetId, rowId: row.id, role: role.value });
      }
      showList();
    };
    const actions = [action('应用条目', applyCurrentForm)];
    if (row) actions.push(action('移除此条目', () => {
      change({ type: 'removeRow', presetId, rowId: row.id });
      showList();
    }));
    page.append(group(...actions));
  }

  function showExisting() {
    startPage('从已有条目添加');
    const entries = library.entries;
    if (!entries.length) {
      page.append(note('自定义预设中暂无可用条目。'));
      return;
    }
    const context = note('');
    const source = picker('已有条目', entries.map(entry => ({ value: entry.id, label: entry.name + ' · ' + uses(entry.id).join('、') })),
      entries[0].id, render, true);
    const role = picker('消息角色', roleOptions, 'system');
    const excerpt = element('pre', 'qqj-aux-sample');
    function render(id) {
      const entry = entries.find(item => item.id === id);
      context.textContent = '引用位置 · ' + uses(entry.id).join('、');
      excerpt.textContent = entry.content;
    }
    render(source.value);
    function add(type) {
      change({ type, presetId, entryId: source.value, role: role.value });
      showList();
    }
    page.append(namedPicker('已有条目', source), context, excerpt, namedPicker('消息角色', role),
      note('引用时共用内容。复制会为当前预设创建独立条目。'),
      group(action('引用条目', () => add('referenceEntry')), action('复制条目', () => add('copyEntry'))));
  }

  function fillHelp(target) {
    target.append(element('h4', '', '可用宏'));
    const description = element('dl', 'qqj-aux-macros');
    for (const macro of task.macros) {
      description.append(element('dt', '', '{{' + macro.name + '}} · ' + macro.label), element('dd', '', macro.description));
    }
    target.append(description, element('h4', '', '输出格式示例'));
    if (task.outputHint) target.append(note(task.outputHint));
    target.append(element('pre', 'qqj-aux-sample', task.outputExample));
  }
  function showHelp() {
    startPage(task.label + ' · 宏与格式');
    fillHelp(page);
  }

  function showPreview() {
    startPage('请求预览');
    page.append(note(task.label + ' / ' + currentPreset().name + ' · 本地预览'));
    const sources = promptPreview?.sources?.(task.id) ?? [];
    if (!sources.length) {
      page.append(note('当前聊天暂无可预览的材料。'));
      return;
    }
    const output = element('div', 'qqj-aux-preview');
    output.setAttribute('aria-live', 'polite');
    async function render(sourceId) {
      const version = ++previewVersion;
      output.replaceChildren(note('正在读取预览材料…'));
      try {
        const result = await promptPreview.preview({ taskId: task.id, sourceId, preset: currentPreset(), library });
        if (version !== previewVersion) return;
        output.replaceChildren();
        for (const warning of result.warnings ?? []) output.append(note(warning));
        for (const [index, message] of result.messages.entries()) {
          const section = element('section', 'qqj-aux-message');
          section.append(element('h4', '', (index + 1) + ' · ' + (roleNames[message.role] ?? message.role)),
            element('pre', 'qqj-aux-sample', message.content));
          output.append(section);
        }
        if (!result.messages.length) output.append(note('此预设未生成可发送的消息。'));
      } catch (error) {
        if (version === previewVersion) output.replaceChildren(note(publicErrorMessage(error, { fallback: '无法读取本次预览材料。' })));
      }
    }
    const source = picker('预览材料', optionsFor(sources), sources[0].id, render, sources.length > 7);
    page.append(namedPicker('预览材料', source), output);
    void render(sources[0].id);
  }

  showList();
  return customImpl({
    title: '副 API 提示词预设', content: dialog, confirmText: '保存设置', cancelText: '取消',
    submit: async () => {
      applyCurrentForm?.();
      if (JSON.stringify(library) === JSON.stringify(initial)) return true;
      if (JSON.stringify(normalizeAuxPromptLibrary(settings.get().auxPromptLibrary)) !== JSON.stringify(initial)) {
        throw new Error('预设已在其他位置更改。请重新打开管理窗口后再编辑。');
      }
      await settings.update({ auxPromptLibrary: library }, { observeSaveFailure: true });
      return true;
    },
    onClose: () => { previewVersion++; },
  });
}
