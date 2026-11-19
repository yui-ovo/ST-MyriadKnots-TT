import { createSettingsKit } from './kit.js';
import { createBodyReadSettings } from './prompts-settings.js';
import { createInlineSelect } from '../inline-select.js';
import { publicErrorMessage } from '../../public-error.js';
import { AUX_TASKS } from '../../aux-prompt-tasks.js';
import {
  AUX_BUILTIN_ID, normalizeAuxPromptLibrary, listAuxSuites, listAuxPresets, getAuxHostPrompt,
  resolveAuxPromptPreset, getAuxPromptBinding, getAuxEntryUses, editAuxPromptLibrary,
} from '../../aux-prompt-library.js';

const roleNames = { system: '系统', user: '用户', assistant: '助手' };
const roleOptions = Object.entries(roleNames).map(([value, label]) => ({ value, label }));
const hostTasks = [
  { id: 'storyClockPrompt', label: '正文时间戳', source: '正文生成时使用的 QQJ 时间戳提示词。' },
  { id: 'avatarPrompt', label: '头像生图', source: '头像生成时使用的人物绘图提示词。' },
];
const tasks = [...AUX_TASKS, ...hostTasks];
const taskNames = new Map(tasks.map(task => [task.id, task.label]));
const optionsFor = items => items.map(item => ({ value: item.id, label: item.label ?? item.name }));

export function createPromptPresetsView({ settings, documentRef = globalThis.document, promptPreview, onStoryClockChange, subscribeSettingsChange }) {
  const { element, button, field } = createSettingsKit(documentRef);
  const globalControls = createBodyReadSettings({ settings, documentRef, onStoryClockChange });
  const stored = () => settings.get().auxPromptLibrary;
  let observed = stored(), base = normalizeAuxPromptLibrary(observed), library = base;
  let task = tasks[0], editingRoute = '', sorting = false, draggedRow = '';
  let previewVersion = 0, viewName = 'list', disposed = false, saving = false, lastRoute = '', listScroll = 0;
  const root = element('section', 'settings-page qqj-preset-manager');
  const card = element('section', 'settings-block qqj-aux-editor');
  const page = element('div', 'qqj-aux-page');
  const feedback = element('p', 'settings-result qqj-aux-feedback');
  feedback.setAttribute('role', 'status');
  const saveBar = element('div', 'qqj-aux-tools qqj-aux-save');
  card.append(page, saveBar, feedback);
  root.append(card, globalControls.node);

  const suite = () => listAuxSuites(library).find(item => item.id === library.activeSuiteId);
  const locked = () => library.activeSuiteId === AUX_BUILTIN_ID;
  const hostTask = () => hostTasks.includes(task);
  const currentPreset = () => resolveAuxPromptPreset(library, task.id, editingRoute);
  const currentRoute = () => promptPreview?.activeRoute?.(task.id) ?? null;
  const routes = () => promptPreview?.routes?.() ?? [];
  const routeName = key => routes().find(item => item.id === key)?.label ?? key;
  const pending = () => library !== base;
  const note = text => element('p', 'settings-hint qqj-aux-note', text);
  const group = (...children) => {
    const box = element('div', 'qqj-aux-tools');
    box.append(...children); return box;
  };
  function report(error) {
    feedback.className = 'settings-result error qqj-aux-feedback';
    feedback.textContent = publicErrorMessage(error, { fallback: '操作未完成，请重试。' });
  }
  async function perform(callback, ...args) {
    if (saving || disposed) return;
    feedback.textContent = '';
    try { return await callback(...args); }
    catch (error) { report(error); }
  }
  const action = (label, callback, css = 'secondary-action') => button(label, css, () => perform(callback));
  const picker = (label, options, value, onChange, searchable = false) => createInlineSelect({
    documentRef, ariaLabel: label, options, value, onChange: onChange ? next => perform(onChange, next) : null, searchable,
  });
  function namedPicker(label, control) {
    const wrapper = element('div', 'qqj-aux-field');
    wrapper.append(element('span', '', label), control.node);
    return wrapper;
  }
  function startPage(kind, title = '', backText = '返回列表') {
    if (kind !== viewName) {
      const scroll = root.closest?.('.body');
      if (scroll) {
        if (viewName === 'list') listScroll = scroll.scrollTop;
        queueMicrotask(() => { if (!disposed && viewName === kind && scroll.contains(root)) scroll.scrollTop = kind === 'list' ? listScroll : 0; });
      }
    }
    previewVersion++; viewName = kind; draggedRow = '';
    feedback.textContent = ''; saveBar.replaceChildren(); page.replaceChildren();
    globalControls.node.hidden = kind !== 'list';
    if (title) {
      const heading = element('div', 'qqj-aux-page-head');
      heading.append(element('h3', '', title), action(backText, showList, 'qqj-aux-text-button'));
      page.append(heading);
    }
  }
  function change(data) {
    const result = editAuxPromptLibrary(library, data);
    library = result.library;
    return result;
  }
  function uses(entryId) {
    return getAuxEntryUses(library, entryId).map(use => [use.suiteName, taskNames.get(use.taskId), use.name].filter(Boolean).join(' / '));
  }
  function resetRoute() {
    const route = hostTask() ? null : currentRoute();
    lastRoute = JSON.stringify(route); editingRoute = route?.id ?? '';
  }
  function loadSaved() {
    observed = stored(); base = normalizeAuxPromptLibrary(observed); library = base;
  }

  async function commit(next = library) {
    if (JSON.stringify(next) === JSON.stringify(base)) { library = base; return; }
    if (JSON.stringify(normalizeAuxPromptLibrary(stored())) !== JSON.stringify(base)) {
      observed = null;
      throw new Error('预设已在其他位置更改。请取消本次编辑或放弃更改，重新载入后编辑。');
    }
    saving = true; card.inert = true;
    try {
      await settings.update({ auxPromptLibrary: next }, { observeSaveFailure: true });
      loadSaved();
    } finally { saving = false; card.inert = false; }
  }
  function discard() { loadSaved(); resetRoute(); sorting = false; showList(); }
  function addSaveBar() {
    if (!pending()) return;
    saveBar.append(note('尚有未保存的条目更改'), action('保存预设', async () => { await commit(); showList(); }), action('放弃更改', discard));
  }
  function switchWithEdits(title, run) {
    if (!pending()) return run(base);
    startPage('switch', title, '继续编辑');
    page.append(note('当前预设有未保存的条目更改。'), group(
      action('保存更改后继续', () => run(library)), action('放弃更改后继续', () => run(base))));
  }
  async function selectSuite(id) {
    return switchWithEdits('切换预设', async source => {
      try {
        await commit(editAuxPromptLibrary(source, { type: 'selectSuite', suiteId: id }).library);
      } catch (error) { showList(); throw error; }
      sorting = false; resetRoute(); showList(); onStoryClockChange?.();
    });
  }
  function chooseTask(id) {
    task = tasks.find(item => item.id === id);
    resetRoute(); sorting = false; showList();
  }
  function nextName() {
    const used = new Set(listAuxSuites(library).map(item => item.name));
    const start = suite().name + '（副本）';
    let name = start, number = 2;
    while (used.has(name)) name = start + ' ' + number++;
    return name;
  }

  function showList(focusRow = '') {
    if (!pending() && stored() !== observed) { loadSaved(); resetRoute(); sorting = false; }
    startPage('list');
    const sets = listAuxSuites(library);
    const active = picker('当前使用的预设', optionsFor(sets), library.activeSuiteId, selectSuite, sets.length > 7);
    page.append(namedPicker('当前使用的预设', active));
    const suiteActions = [action('复制整套', () => showSuiteForm('copySuite')), action('新建', () => showSuiteForm('createSuite'))];
    if (!locked()) suiteActions.push(action('重命名', () => showSuiteForm('renameSuite')), action('删除', showDeleteSuite));
    page.append(group(...suiteActions));
    const choices = picker('任务', optionsFor(tasks), task.id, chooseTask, tasks.length > 7);
    page.append(namedPicker('任务', choices));
    if (hostTask()) {
      page.append(action(task.label + '提示词', showHostPrompt, 'qqj-aux-host-row'));
      addSaveBar();
      return;
    }
    const preset = currentPreset(), route = currentRoute();
    const editable = !locked() && preset.id !== AUX_BUILTIN_ID;
    const routeBinding = editingRoute && getAuxPromptBinding(library, task.id, editingRoute);
    if (route) {
      const effective = resolveAuxPromptPreset(library, task.id, route.id);
      page.append(note('当前 API · ' + route.label + ' · ' + effective.name + (getAuxPromptBinding(library, task.id, route.id) ? '（连接指定）' : '（跟随任务）')));
    }
    const scope = element('div', 'qqj-aux-page-head');
    const title = routeBinding ? routeName(editingRoute) + '使用的条目' : '任务默认条目';
    const overrides = library.bindings.filter(binding => binding.suiteId === library.activeSuiteId && binding.taskId === task.id && binding.routeKey);
    scope.append(element('h3', '', title), action('连接配置', showBindings, 'qqj-aux-text-button'));
    page.append(scope);
    if (overrides.length) page.append(note('已指定的连接 · ' + overrides.map(binding => routeName(binding.routeKey)).join('、')));
    if (locked()) page.append(note('千千结默认 · 只读。点条目可查看原文与来源。'));
    else page.append(note('正在编辑 · ' + preset.name));
    const presetId = preset.id;
    if (editable && preset.rows.length > 1) {
      const sort = action(sorting ? '完成排序' : '排序', () => { sorting = !sorting; showList(); }, 'qqj-aux-text-button');
      sort.setAttribute('aria-pressed', String(sorting));
      scope.append(sort);
    }
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
        const toggle = element('label', 'qqj-aux-switch');
        const included = element('input', 'qqj-aux-toggle');
        included.type = 'checkbox';
        included.setAttribute('role', 'switch');
        included.checked = row.enabled;
        included.disabled = !editable;
        included.setAttribute('aria-label', '启用' + row.name);
        included.addEventListener('change', () => {
          change({ type: 'updateRow', presetId, rowId: row.id, enabled: included.checked });
          item.setAttribute('data-enabled', String(included.checked));
          saveBar.replaceChildren(); addSaveBar();
        });
        const track = element('span', 'qqj-aux-switch-track');
        track.setAttribute('aria-hidden', 'true');
        toggle.append(included, track);
        item.append(toggle);
      }
      list.append(item);
    }
    if (!preset.rows.length) list.append(note('此预设暂无条目。'));
    page.append(list);
    const tools = editable
      ? [action('新增条目', () => showEntry()), action('从已有条目添加', showExisting)]
      : [action(locked() ? '复制后编辑' : '复制此配置', () => locked() ? showSuiteForm('copySuite') : cloneRecipe())];
    page.append(group(...tools, action('宏与格式', showHelp)));
    page.append(action('预览请求', showPreview, 'qqj-aux-text-button'));
    addSaveBar();
    toFocus?.focus?.({ preventScroll: true });
  }

  function showSuiteForm(type, afterCopy) {
    const titles = { createSuite: '新建预设', copySuite: '复制整套预设', renameSuite: '重命名预设' };
    if (pending()) return switchWithEdits(titles[type], async source => { await commit(source); showSuiteForm(type, afterCopy); });
    startPage('suite-form', titles[type], '取消');
    const name = element('input', 'settings-input'); name.type = 'text';
    name.value = type === 'copySuite' ? nextName() : type === 'renameSuite' ? suite().name : '';
    page.append(field('预设名称', name));
    const label = type === 'copySuite' ? '复制并启用' : type === 'createSuite' ? '创建并启用' : '保存名称';
    page.append(group(action(label, async () => {
      if (!name.value.trim()) throw new Error('请填写预设名称。');
      const next = editAuxPromptLibrary(library, { type, suiteId: library.activeSuiteId, name: name.value.trim() });
      await commit(next.library);
      sorting = false;
      if (type !== 'renameSuite') onStoryClockChange?.();
      if (afterCopy) afterCopy(); else showList();
    }, 'primary-action')));
    name.focus?.();
  }

  function showDeleteSuite() {
    startPage('delete', '删除预设');
    page.append(note('删除「' + suite().name + '」及本套的连接配置？删除后将启用千千结默认。'),
      group(action('确认删除', async () => {
        await commit(editAuxPromptLibrary(base, { type: 'deleteSuite', suiteId: library.activeSuiteId }).library);
        resetRoute(); sorting = false; showList(); onStoryClockChange?.();
      })));
  }

  function showHostPrompt() {
    startPage('host-entry', task.label + '提示词', locked() ? '返回列表' : '取消');
    const input = element('textarea', 'settings-input qqj-aux-content');
    input.rows = 12; input.readOnly = locked(); input.value = getAuxHostPrompt(library, task.id, { display: true });
    page.append(note('来源 · ' + task.source), field('提示词内容', input));
    if (locked()) {
      page.append(group(action('复制整套后编辑本条', () => showSuiteForm('copySuite', showHostPrompt))));
      return;
    }
    const original = input.value;
    let reset = false;
    input.addEventListener('input', () => { reset = false; });
    page.append(group(action('恢复此项默认', () => {
      reset = true;
      const factory = editAuxPromptLibrary(library, { type: 'selectSuite', suiteId: AUX_BUILTIN_ID }).library;
      input.value = getAuxHostPrompt(factory, task.id, { display: true });
    }), action('保存提示词', async () => {
      const next = reset || input.value !== original
        ? editAuxPromptLibrary(library, { type: 'updateHostPrompt', key: task.id, content: reset ? '' : input.value }).library : library;
      await commit(next);
      if (task.id === 'storyClockPrompt') onStoryClockChange?.();
      showList();
    }, 'primary-action')));
  }

  async function bindRecipe(routeKey, id) {
    const next = editAuxPromptLibrary(library, { type: 'bind', taskId: task.id, routeKey, presetId: id || null });
    await commit(next.library);
    showBindings();
  }

  async function cloneRecipe() {
    const preset = currentPreset();
    const name = (editingRoute ? routeName(editingRoute) : task.label) + ' · 条目副本';
    const copied = editAuxPromptLibrary(library, { type: 'copyPreset', taskId: task.id, presetId: preset.id, name });
    const bound = editAuxPromptLibrary(copied.library, { type: 'bind', taskId: task.id, routeKey: editingRoute, presetId: copied.presetId });
    await commit(bound.library);
    sorting = false; showList();
  }

  function showBindings() {
    if (pending()) return switchWithEdits('进入连接配置', async source => { await commit(source); showBindings(); });
    startPage('bindings', '连接配置');
    const connected = currentRoute(), available = routes().slice();
    if (connected && !available.some(route => route.id === connected.id)) available.unshift(connected);
    const configs = listAuxPresets(library, task.id);
    const items = [{ id: '', label: '任务默认' }, ...available];
    const selected = items.find(item => item.id === editingRoute) ?? items[0]; editingRoute = selected.id;
    const labels = items.map(item => {
      const bound = getAuxPromptBinding(library, task.id, item.id);
      const effective = resolveAuxPromptPreset(library, task.id, item.id);
      return { value: item.id, label: item.label + (item.id === connected?.id ? '（当前 API）' : '') + ' · ' + (item.id && !bound ? '跟随任务 · ' : '') + effective.name };
    });
    if (connected) page.append(note('当前任务使用 ' + connected.label + '。'));
    page.append(namedPicker('查看或编辑的范围', picker('查看或编辑的范围', labels, selected.id, id => { editingRoute = id; showBindings(); }, labels.length > 7)));
    const effective = currentPreset(), binding = getAuxPromptBinding(library, task.id, selected.id);
    const options = selected.id ? [{ value: '', label: '跟随任务默认' }, ...optionsFor(configs)] : optionsFor(configs);
    const control = picker('使用的条目配置', options, selected.id ? binding ?? '' : effective.id, id => bindRecipe(selected.id, id));
    control.setDisabled(locked());
    page.append(namedPicker('使用的条目配置', control));
    if (locked()) { page.append(group(action('复制整套后编辑', () => showSuiteForm('copySuite', showBindings)))); return; }
    const edit = action('编辑此配置的条目', showList);
    const make = action(selected.id ? '为此连接复制独立配置' : '复制为任务默认配置', cloneRecipe);
    page.append(group(edit, make));
    const usesConfig = items.filter(item => resolveAuxPromptPreset(library, task.id, item.id).id === effective.id);
    page.append(note('使用这份条目 · ' + usesConfig.map(item => item.label).join('、')));
  }

  function showEntry(row = null) {
    const preset = currentPreset(), presetId = preset.id;
    const readOnly = locked() || presetId === AUX_BUILTIN_ID;
    startPage('entry', row ? (readOnly ? '查看条目' : '编辑条目') : '新增条目', readOnly ? '返回列表' : '取消');
    const name = element('input', 'settings-input');
    name.type = 'text'; name.value = row?.name ?? ''; name.readOnly = readOnly;
    const role = picker('消息角色', roleOptions, row?.role ?? 'system');
    role.setDisabled(readOnly);
    const content = element('textarea', 'settings-input qqj-aux-content');
    content.rows = 8; content.value = row?.content ?? ''; content.readOnly = readOnly;
    const pair = element('div', 'qqj-aux-pair');
    pair.append(field('条目名称', name), namedPicker('消息角色', role));
    page.append(pair);
    if (row) page.append(note('来源 · ' + (row.source ?? '自定义条目')));
    page.append(field('提示词内容', content));
    if (readOnly) {
      const index = preset.rows.findIndex(item => item.id === row.id);
      const openCopy = () => showEntry(currentPreset().rows[index]);
      const copy = locked() ? () => showSuiteForm('copySuite', openCopy) : async () => { await cloneRecipe(); openCopy(); };
      page.append(group(action(locked() ? '复制整套后编辑本条' : '复制此配置后编辑', copy), action('宏与格式', showHelp)));
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
    const saveEntry = async () => {
      let next = library;
      const apply = data => { next = editAuxPromptLibrary(next, data).library; };
      if (!name.value.trim()) throw new Error('请填写条目名称。');
      if (!row) {
        apply({ type: 'addEntry', presetId, name: name.value.trim(), content: content.value, role: role.value });
      } else {
        const changedText = name.value.trim() !== row.name || content.value !== row.content;
        if (changedText || scope?.value === 'local') {
          if (scope && !scope.value) throw new Error('此条目有多处引用，请选择内容修改范围。');
          apply({ type: 'updateEntry', presetId, rowId: row.id, name: name.value.trim(), content: content.value, mode: builtinEntry ? 'local' : scope?.value });
        }
        if (row.role !== role.value) apply({ type: 'updateRow', presetId, rowId: row.id, role: role.value });
      }
      await commit(next); showList();
    };
    const actions = [action('保存条目', saveEntry, 'primary-action')];
    if (row) actions.push(action('移除此条目', () => {
      change({ type: 'removeRow', presetId, rowId: row.id });
      showList();
    }));
    page.append(group(...actions));
  }

  function showExisting() {
    const presetId = currentPreset().id;
    startPage('existing', '从已有条目添加');
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
      const placement = library.presets.flatMap(preset => preset.rows).find(row => row.entryId === id);
      role.setValue(placement?.role ?? 'system');
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
    target.append(element('h4', '', '可用宏'), note('写入 {{宏名}} 可在请求时插入材料。使用 {{!qqj_input}} 会保留宏名原文。'));
    const description = element('dl', 'qqj-aux-macros');
    for (const macro of task.macros) {
      description.append(element('dt', '', '{{' + macro.name + '}} · ' + macro.label), element('dd', '', macro.description));
    }
    target.append(description, element('h4', '', '输出格式示例'));
    if (task.outputHint) target.append(note(task.outputHint));
    target.append(element('pre', 'qqj-aux-sample', task.outputExample));
  }
  function showHelp() {
    startPage('help', task.label + ' · 宏与格式');
    fillHelp(page);
  }

  function showPreview() {
    startPage('preview', '请求预览');
    page.append(note(task.label + ' / ' + currentPreset().name + ' · 本地预览'));
    const sources = promptPreview?.sources?.(task.id) ?? [];
    if (!sources.length) {
      page.append(note('当前聊天暂无可预览的材料。'));
      return;
    }
    if (sources.every(source => source.id === 'demo')) page.append(note('当前聊天暂无此任务的实际材料。'));
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

  resetRoute(); showList();
  let unsubscribe;
  function settingsChanged() {
    globalControls.refresh();
    if (disposed || saving || viewName !== 'list' || pending()) return;
    if (stored() === observed && JSON.stringify(hostTask() ? null : currentRoute()) === lastRoute) return;
    resetRoute(); showList();
  }
  const listen = () => { unsubscribe ??= subscribeSettingsChange?.(settingsChanged); };
  listen();
  function activate() {
    if (disposed) return;
    listen();
    if (viewName === 'list' && !pending()) {
      if (lastRoute !== JSON.stringify(hostTask() ? null : currentRoute())) resetRoute();
      showList();
    }
    globalControls.refresh();
  }
  function deactivate() {
    unsubscribe?.(); unsubscribe = undefined;
    previewVersion++;
    if (viewName === 'preview') showList();
  }
  return { node: root, activate, deactivate, dispose() {
    disposed = true; deactivate(); globalControls.dispose(); root.replaceChildren();
  } };
}
