const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { taskConfigs, getTaskConfig } = require('./taskConfigs');
const { appConfig } = require('./appConfig');
const { assignTask } = require('./taskAssignee');
const { selectTaskTemplate, openTaskTemplateMenu } = require('./taskTemplate');
const { loadTaskItemsWithCrm } = require('./crmCheck');

const ASANA_HOME_URL = 'https://app.asana.com/';
const DEFAULT_USER_DATA_DIR = './user-data';
const DEFAULT_OPEN_TASK_AFTER_CREATE_DELAY_MS = 1500;
const DEFAULT_BETWEEN_TASKS_DELAY_MS = 3000;
const DEFAULT_NAVIGATION_DELAY_MS = 5000;

function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseDefaultInput(input, config) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      source: line,
      title: config.createTitle ? config.createTitle(line) : line
    }));
}

async function waitForPageReady(page, timeout = 30000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function openProject(page, config) {
  if (config.projectUrl) {
    await page.goto(config.projectUrl);
    await waitForPageReady(page);
    await page.waitForTimeout(DEFAULT_NAVIGATION_DELAY_MS);
    return;
  }

  await page.goto(ASANA_HOME_URL);
  await waitForPageReady(page);
  await page.waitForTimeout(8000);

  const projectLink = page.getByRole('link', { name: config.projectName }).first();
  await projectLink.waitFor({ timeout: 20000 });
  await projectLink.click();
  await waitForPageReady(page);
  await page.waitForTimeout(DEFAULT_NAVIGATION_DELAY_MS);
}

async function findColumn(page, columnName) {
  const columnHeader = page.getByRole('heading', { name: columnName }).first();
  await columnHeader.waitFor({ timeout: 15000 });

  const columnCandidates = [
    page.locator('div[role="button"]', {
      has: page.locator('h2', { hasText: columnName })
    }).first(),
    columnHeader.locator(
      'xpath=ancestor::*[self::div or self::section][.//button or .//*[@role="button"]][1]'
    ).first(),
    columnHeader.locator(
      'xpath=ancestor::*[self::div or self::section][contains(@class, "BoardColumn")][1]'
    ).first()
  ];

  for (const candidate of columnCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  throw new Error(`Не удалось найти контейнер колонки "${columnName}".`);
}

async function findColumnWithRecovery(page, config) {
  try {
    return await findColumn(page, config.columnName);
  } catch (error) {
    if (!config.projectUrl) {
      throw error;
    }

    await page.goto(config.projectUrl);
    await waitForPageReady(page);
    await page.waitForTimeout(DEFAULT_NAVIGATION_DELAY_MS);
    return findColumn(page, config.columnName);
  }
}

async function clickAddTaskButton(column, columnName, requireTemplate = false) {
  if (requireTemplate) {
    await openTaskTemplateMenu(column);
    return;
  }
  const directAddButton = await findVisibleColumnAddTaskButton(column);

  if (directAddButton) {
    await directAddButton.click();
    return;
  }

  const addButtonCandidates = [
    column.getByRole('button', { name: 'Добавить задачу' }).first(),
    column.getByRole('button', { name: 'Добавить' }).first(),
    column.getByRole('button', { name: 'Add task' }).first(),
    column.getByRole('button', { name: 'Create task' }).first(),
    column.locator('button[aria-label*="Добавить"]').first(),
    column.locator('button[aria-label*="Add"]').first(),
    column.locator('[role="button"][aria-label*="Добавить"]').first(),
    column.locator('[role="button"][aria-label*="Add"]').first(),
    column.locator('button').filter({ hasText: /^\+$/ }).first(),
    column.locator('[role="button"]').filter({ hasText: /^\+$/ }).first()
  ];

  for (const candidate of addButtonCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      return;
    }
  }

  const fallbackAddButton = column.locator('button, [role="button"]').evaluateAll((nodes) => {
    const match = nodes.find((node) => {
      const text = (node.textContent || '').trim();
      const ariaLabel = (node.getAttribute('aria-label') || '').trim();
      const title = (node.getAttribute('title') || '').trim();
      const label = `${text} ${ariaLabel} ${title}`.toLowerCase();

      if (label.includes('правил') || label.includes('rule') || label.includes('автомат')) {
        return false;
      }

      return text === '+' || ariaLabel === '+' || title === '+';
    });

    if (!match) {
      return null;
    }

    match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }).catch(() => null);

  if (fallbackAddButton) {
    return;
  }

  throw new Error(`Не удалось найти кнопку добавления задачи в колонке "${columnName}".`);
}

async function findVisibleColumnAddTaskButton(column) {
  const candidates = await column.locator('button, [role="button"]').evaluateAll((nodes) => {
    const visibleButtons = [];

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const rect = node.getBoundingClientRect();
      const text = (node.textContent || '').trim();
      const ariaLabel = (node.getAttribute('aria-label') || '').trim();
      const title = (node.getAttribute('title') || '').trim();
      const label = `${text} ${ariaLabel} ${title}`.toLowerCase();

      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      if (label.includes('правил') || label.includes('rule') || label.includes('автомат')) {
        continue;
      }

      if (!label.includes('добавить задачу') && !label.includes('add task')) {
        continue;
      }

      visibleButtons.push({
        index,
        y: rect.y,
        x: rect.x,
        text,
        ariaLabel
      });
    }

    return visibleButtons;
  }).catch(() => []);

  if (!candidates.length) {
    return null;
  }

  const bestCandidate = candidates.sort((a, b) => b.y - a.y || a.x - b.x)[0];
  return column.locator('button, [role="button"]').nth(bestCandidate.index);
}

async function applyTemplateIfNeeded(page, templateName) {
  await selectTaskTemplate(page, templateName);
}

function extractProjectId(projectUrl) {
  const match = String(projectUrl || '').match(/\/project\/(\d+)/);
  return match ? match[1] : '';
}

function pageUrlIncludesProject(pageUrl, projectId) {
  return (
    pageUrl.includes(`/project/${projectId}/`) ||
    pageUrl.includes(`/0/${projectId}/`) ||
    pageUrl.endsWith(`/project/${projectId}`)
  );
}

function pageUrlIncludesTask(pageUrl) {
  return /\/task\/\d+/.test(pageUrl);
}

async function assertStillInProject(page, config, actionLabel) {
  const projectId = extractProjectId(config.projectUrl);
  if (!projectId) {
    return;
  }

  const currentUrl = page.url();
  if (pageUrlIncludesProject(currentUrl, projectId)) {
    return;
  }

  throw new Error(
    `Asana увела страницу из нужного проекта после шага "${actionLabel}". ` +
    `Ожидался project ${projectId}, текущий URL: ${currentUrl}`
  );
}

async function openCreatedTaskIfNeeded(page, column, templateName) {
  if (!templateName) {
    return;
  }

  const addedTaskCandidates = [
    page.locator('div[data-task-id]', { hasText: templateName }).first(),
    page.getByText(templateName, { exact: false }).first(),
    page.locator('[data-task-id] [role="link"]', { hasText: templateName }).first()
  ];

  for (const candidate of addedTaskCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click().catch(() => {});
      await page.waitForTimeout(1500);
      await closeFieldEditorDialogIfOpen(page);
      return;
    }
  }
}

async function closeFieldEditorDialogIfOpen(page) {
  const fieldEditor = page.getByRole('dialog').filter({
    has: page.getByText(/^(Изменить поле|Edit field)$/)
  }).last();

  if (!await fieldEditor.isVisible().catch(() => false)) {
    return false;
  }

  const closeButtonCandidates = [
    fieldEditor.getByRole('button', { name: /Закрыть|Close/i }).first(),
    fieldEditor.locator('button[aria-label*="Закрыть"]').first(),
    fieldEditor.locator('button[aria-label*="Close"]').first(),
    fieldEditor.getByRole('button').last()
  ];

  for (const candidate of closeButtonCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click().catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function closeTransientMenus(page) {
  const openMenu = page.locator('[role="menu"], [role="listbox"]').last();

  if (!await openMenu.isVisible().catch(() => false)) {
    return false;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

async function setDropdownCustomField(page, fieldName, fieldValue) {
  await closeFieldEditorDialogIfOpen(page);
  const fieldLabel = await findVisibleCustomFieldLabel(page, fieldName);
  // In the task detail pane Asana renders the value control as a button next
  // to the label. Clicking a guessed x-coordinate can hit the board behind it.
  const fieldRow = fieldLabel.locator(
    'xpath=ancestor::*[self::div or self::section or self::article][.//button or .//*[@role="button"]][1]'
  );
  const valueControl = fieldRow.getByRole('button').last();
  if (await valueControl.isVisible().catch(() => false)) {
    await valueControl.click();
  } else {
    const labelBox = await fieldLabel.boundingBox().catch(() => null);
    if (!labelBox) {
      throw new Error(`Не удалось найти поле "${fieldName}" в карточке задачи.`);
    }
    await page.mouse.click(labelBox.x + labelBox.width + 280, labelBox.y + labelBox.height / 2);
  }
  await page.waitForTimeout(700);
  await closeFieldEditorDialogIfOpen(page);

  const clickVisibleFieldOption = async () => {
    const candidates = [
      page.getByRole('option', { name: fieldValue, exact: true }).last(),
      page.getByRole('button', { name: fieldValue, exact: true }).last(),
      page.getByText(fieldValue, { exact: true }).last()
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click();
        await page.waitForTimeout(700);
        return true;
      }
    }
    return false;
  };

  // Asana often shows category choices directly in the dropdown without a search box.
  let selected = await clickVisibleFieldOption();

  if (!selected) {
    const editorCandidates = [
      page.locator('input[role="combobox"]').last(),
      page.locator('input[aria-autocomplete="list"]').last(),
      page.locator('[role="listbox"] input').last()
    ];

    for (const candidate of editorCandidates) {
      if (!await candidate.isVisible().catch(() => false)) continue;
      await candidate.fill('');
      await candidate.type(fieldValue, { delay: 50 });
      await page.waitForTimeout(500);
      selected = await clickVisibleFieldOption();
      if (selected) break;
    }
  }

  if (!selected) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`В поле "${fieldName}" не удалось выбрать значение "${fieldValue}".`);
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  const appliedValueCandidates = [
    page.getByText(fieldValue, { exact: true }).first()
  ];

  for (const candidate of appliedValueCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return;
    }
  }

  throw new Error(`Поле "${fieldName}" не сохранило значение "${fieldValue}".`);
}

async function findVisibleCustomFieldLabel(page, fieldName) {
  const exactLabels = await page.getByText(fieldName, { exact: true }).all();
  const viewport = page.viewportSize();
  const visibleLabels = [];

  for (const label of exactLabels) {
    const box = await label.boundingBox().catch(() => null);
    if (!box || !await label.isVisible().catch(() => false)) {
      continue;
    }

    visibleLabels.push({ label, box });
  }

  if (!visibleLabels.length) {
    throw new Error(`Не удалось найти поле "${fieldName}".`);
  }

  if (viewport) {
    const taskPaneLabels = visibleLabels.filter(({ box }) => box.x > viewport.width * 0.35);
    if (taskPaneLabels.length) {
      return taskPaneLabels.sort((a, b) => b.box.x - a.box.x)[0].label;
    }
  }

  return visibleLabels[0].label;
}

async function applyCustomFields(page, config, item = {}) {
  const fields = [
    ...(Array.isArray(config.customFields) ? config.customFields : []),
    ...(Array.isArray(item.customFields) ? item.customFields : [])
  ].filter((field) => field.name !== 'Тип');

  if (fields.length === 0) {
    return;
  }

  for (const field of fields) {
    await setDropdownCustomField(page, field.name, field.value);
  }
}

async function clickTaskDescriptionArea(page) {
  const clickableCandidates = [
    page.locator('[aria-label="Описание"]').last(),
    page.locator('[aria-label="Description"]').last(),
    page.locator('[data-testid*="description"]').last(),
    page.getByText('Добавить описание', { exact: false }).last(),
    page.getByText('Add description', { exact: false }).last(),
    page.getByText('Описание', { exact: true }).last(),
    page.getByText('Description', { exact: true }).last()
  ];

  for (const candidate of clickableCandidates) {
    if (!await candidate.isVisible().catch(() => false)) {
      continue;
    }

    await candidate.click().catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }

  return false;
}

async function findTaskDescriptionEditor(page) {
  await clickTaskDescriptionArea(page);

  const descriptionEditorCandidates = [
    page.locator('[aria-label="Описание"][contenteditable="true"]').last(),
    page.locator('[aria-label="Description"][contenteditable="true"]').last(),
    page.locator('[data-testid*="description"] [contenteditable="true"]').last(),
    page.locator('[contenteditable="true"]').filter({
      has: page.getByText(/Add description|Добавить описание/i)
    }).last()
  ];

  for (const candidate of descriptionEditorCandidates) {
    if (
      await candidate.isVisible().catch(() => false) &&
      await isEditableInput(candidate) &&
      !await isInsideFieldEditorDialog(candidate)
    ) {
      return candidate;
    }
  }

  const editableAreas = await page.locator('[contenteditable="true"]').all();

  for (const candidate of editableAreas.reverse()) {
    if (
      await candidate.isVisible().catch(() => false) &&
      !await isInsideFieldEditorDialog(candidate)
    ) {
      const text = await candidate.innerText().catch(() => '');
      const ariaLabel = await candidate.getAttribute('aria-label').catch(() => '');

      if (/описание|description/i.test(ariaLabel || '')) {
        return candidate;
      }
    }
  }

  return null;
}

async function applyDescriptionText(page, config, item = {}) {
  const descriptionText = item.descriptionText || config.descriptionText;

  if (!descriptionText) {
    return;
  }

  const editor = await findTaskDescriptionEditor(page);

  if (!editor) {
    throw new Error('Не удалось найти поле описания задачи.');
  }

  const currentText = (await editor.innerText().catch(() => '')).trim();

  if (currentText.includes(descriptionText)) {
    return;
  }

  await editor.click();

  if (currentText) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End').catch(() => {});
    await page.keyboard.press('Enter');
  }

  await page.keyboard.type(descriptionText, { delay: 20 });
  await page.keyboard.press('Tab').catch(() => {});
  await page.waitForTimeout(700);
}

async function isEditableInput(locator) {
  return locator.evaluate((node) => {
    if (!node) {
      return false;
    }

    const tagName = (node.tagName || '').toLowerCase();
    const role = (node.getAttribute('role') || '').toLowerCase();
    const contentEditable = node.getAttribute('contenteditable');

    if (contentEditable === 'true') {
      return true;
    }

    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
      return true;
    }

    return role === 'textbox' || role === 'combobox';
  }).catch(() => false);
}

async function isInsideFieldEditorDialog(locator) {
  return locator.evaluate((node) => {
    const dialog = node.closest('[role="dialog"], [aria-modal="true"]');
    if (!dialog) {
      return false;
    }

    const text = (dialog.textContent || '').trim();
    return /^(Изменить поле|Edit field)\b/.test(text);
  }).catch(() => false);
}

async function findTaskTitleInput(page, column) {
  await closeFieldEditorDialogIfOpen(page);

  const taskTitleCandidates = [
    page.locator('textarea[aria-label="Название задачи"][placeholder="Напишите название задачи"]').last(),
    page.locator('textarea[aria-label="Task name"][placeholder="Task name"]').last(),
    page.locator('input[aria-label="Название задачи"]').last(),
    page.locator('input[aria-label="Task name"]').last(),
    page.getByPlaceholder('Напишите название задачи').last(),
    page.getByPlaceholder('Task name').last(),
    page.locator('[data-testid*="task-name"] input').last(),
    page.locator('[data-testid*="task-name"] textarea').last(),
    page.locator('[data-testid*="task-name"] [contenteditable="true"]').last()
  ];

  for (const candidate of taskTitleCandidates) {
    if (
      await candidate.isVisible().catch(() => false) &&
      await isEditableInput(candidate) &&
      !await isInsideFieldEditorDialog(candidate)
    ) {
      return candidate;
    }
  }

  const pageLevelCandidates = [
    page.locator('input[placeholder*="название"]').first(),
    page.locator('input[placeholder*="name"]').first(),
    page.locator('textarea[placeholder*="name"]').last(),
    page.locator('textarea[placeholder*="название"]').last()
  ];

  for (const candidate of pageLevelCandidates) {
    if (
      await candidate.isVisible().catch(() => false) &&
      await isEditableInput(candidate) &&
      !await isInsideFieldEditorDialog(candidate)
    ) {
      return candidate;
    }
  }

  const columnLevelCandidates = [
    column.locator('textarea').last(),
    column.locator('input[type="text"]').last(),
    column.locator('input[aria-label*="назв"]').last(),
    column.locator('input[aria-label*="name"]').last(),
    column.locator('input[placeholder*="название"]').last(),
    column.locator('input[placeholder*="name"]').last()
  ];

  for (const candidate of columnLevelCandidates) {
    if (
      await candidate.isVisible().catch(() => false) &&
      await isEditableInput(candidate) &&
      !await isInsideFieldEditorDialog(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

async function resetTaskCreationState(page, column) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await closeFieldEditorDialogIfOpen(page);
  await page.waitForTimeout(700);
}

async function activateTaskTitleEditor(page, currentTitle) {
  const escapedTitle = currentTitle.replace(/["\\]/g, '\\$&');
  const activationCandidates = [
    page.getByText(currentTitle, { exact: true }).first(),
    page.locator(`text="${escapedTitle}"`).first(),
    page.locator('h1, h2').filter({ hasText: currentTitle }).first(),
    page.locator('[data-testid*="task-name"]').filter({ hasText: currentTitle }).first(),
    page.locator('[contenteditable="false"]').filter({ hasText: currentTitle }).first()
  ];

  for (const candidate of activationCandidates) {
    if (!await candidate.isVisible().catch(() => false)) {
      continue;
    }

    await candidate.click({ clickCount: 2, delay: 50 }).catch(() => {});
    await page.waitForTimeout(500);

    const input = await findTaskTitleInput(page, page.locator('body'));
    if (input) {
      return input;
    }
  }

  return null;
}

async function resolveTaskTitleInput(page, column, templateName) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const taskTitle = await findTaskTitleInput(page, column);

    if (taskTitle) {
      return taskTitle;
    }

    if (attempt === 1) {
      await openCreatedTaskIfNeeded(page, column, templateName);
    }

    if (attempt === 2) {
      const activatedTitle = await activateTaskTitleEditor(page, templateName);
      if (activatedTitle) {
        return activatedTitle;
      }

      const addTaskRow = column.getByText('Добавить задачу', { exact: false }).first();
      if (await addTaskRow.isVisible().catch(() => false)) {
        await addTaskRow.click().catch(() => {});
      }
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

async function createTaskInColumn(page, config, title, item = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let column = null;
    let templateApplied = false;

    try {
      column = await findColumnWithRecovery(page, config);
      await column.hover().catch(() => {});
      await resetTaskCreationState(page, column);
      await clickAddTaskButton(column, config.columnName, Boolean(config.templateName));
      await closeFieldEditorDialogIfOpen(page);
      await applyTemplateIfNeeded(page, config.templateName);
      templateApplied = true;
      await closeFieldEditorDialogIfOpen(page);
      await closeTransientMenus(page);
      await assertStillInProject(page, config, 'выбор шаблона');

      if (!await findTaskTitleInput(page, column)) {
        await openCreatedTaskIfNeeded(page, column, config.templateName);
        await closeFieldEditorDialogIfOpen(page);
        await closeTransientMenus(page);
      }

      const taskTitle = await resolveTaskTitleInput(page, column, config.templateName);

      if (!taskTitle) {
        throw new Error('Не удалось найти поле для названия задачи после выбора шаблона.');
      }

      await taskTitle.click();

      if (await taskTitle.evaluate((node) => node.getAttribute('contenteditable') === 'true').catch(() => false)) {
        await taskTitle.fill('').catch(() => {});
        await taskTitle.type(title, { delay: 20 });
        await page.keyboard.press('Tab');
      } else {
        await taskTitle.fill(title);
        await taskTitle.press('Tab');
      }

      // fastCreate: commit the title and move on; no waiting on the card's fields.
      await page.waitForTimeout(config.fastCreate ? 300 : DEFAULT_OPEN_TASK_AFTER_CREATE_DELAY_MS);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(config.fastCreate ? 200 : 500);
      await applyDescriptionText(page, config, item);

      return taskTitle;
    } catch (error) {
      if (templateApplied || error.templateSelectionFailed) throw error;
      lastError = error;
      if (column) {
        await resetTaskCreationState(page, column).catch(() => {});
      }
      await page.waitForTimeout(1000);
    }
  }

  throw lastError || new Error('Не удалось создать задачу.');
}

async function createSimpleTaskInColumn(page, config, title) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let column = null;
    let templateApplied = false;

    try {
      column = await findColumnWithRecovery(page, config);
      await column.hover().catch(() => {});
      await clickAddTaskButton(column, config.columnName, Boolean(config.templateName));
      await applyTemplateIfNeeded(page, config.templateName);
      templateApplied = true;

      const taskTitle = await findTaskTitleInput(page, column);

      if (!taskTitle) {
        throw new Error('Не удалось найти поле для названия задачи.');
      }

      await taskTitle.click();

      if (await taskTitle.evaluate((node) => node.getAttribute('contenteditable') === 'true').catch(() => false)) {
        await taskTitle.fill('').catch(() => {});
        await taskTitle.type(title, { delay: 20 });
        await page.keyboard.press('Enter').catch(() => {});
      } else {
        await taskTitle.fill(title);
        await taskTitle.press('Enter').catch(() => {});
      }

      await page.waitForTimeout(1000);
      return taskTitle;
    } catch (error) {
      if (templateApplied || error.templateSelectionFailed) throw error;
      lastError = error;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(700);
    }
  }

  throw lastError || new Error('Не удалось создать задачу.');
}

// Link from the board card's data-task-id, without opening the card (fastCreate).
async function readCreatedTaskUrlFromBoard(page, config, title) {
  if (pageUrlIncludesTask(page.url())) {
    return page.url();
  }
  const taskId = await page.locator('[data-task-id]', { hasText: title }).last()
    .getAttribute('data-task-id', { timeout: 3000 }).catch(() => null);
  const base = String(config.projectUrl || '').match(/^(https:\/\/app\.asana\.com\/\d+\/\d+\/project\/\d+)/);
  return taskId && base ? `${base[1]}/task/${taskId}` : page.url();
}

async function resolveCreatedTaskUrl(page, title) {
  if (pageUrlIncludesTask(page.url())) {
    return page.url();
  }

  await closeFieldEditorDialogIfOpen(page);
  await closeTransientMenus(page);

  const titleCandidates = [
    page.locator('div[data-task-id]', { hasText: title }).first(),
    page.locator('[data-testid*="task"]', { hasText: title }).first(),
    page.getByText(title, { exact: true }).first()
  ];

  for (const candidate of titleCandidates) {
    if (!await candidate.isVisible().catch(() => false)) {
      continue;
    }

    await candidate.click().catch(() => {});
    await page.waitForTimeout(1500);

    if (pageUrlIncludesTask(page.url())) {
      return page.url();
    }
  }

  return page.url();
}

function loadTaskItems(config) {
  if (config.dynamicInput || !config.inputFile) {
    return [];
  }

  const input = readTaskInput(config);
  const parseInput = config.parseInput || ((value) => parseDefaultInput(value, config));
  return parseInput(input);
}

function readTaskInput(config) {
  fs.mkdirSync(appConfig.paths.inputDir, { recursive: true });
  const inputPath = getTaskInputPath(config);
  return fs.existsSync(inputPath) ? fs.readFileSync(inputPath, 'utf-8') : '';
}

function getTaskInputPath(config) {
  const inputFiles = [config.inputFile, ...(config.fallbackInputFiles || [])].filter(Boolean);
  const existingInputFile = inputFiles.find((inputFile) => fs.existsSync(path.resolve(inputFile)));
  return path.resolve(existingInputFile || config.inputFile);
}

function writeCsvHeader(config) {
  fs.mkdirSync(appConfig.paths.reportsDir, { recursive: true });
  fs.writeFileSync(config.outputFile, `${config.outputColumnName || 'title'},url\n`);
}

function appendCsvRow(config, source, url) {
  fs.appendFileSync(config.outputFile, `${csvEscape(source)},${url}\n`);
}

function writeMissingBrandCsvHeader(config) {
  if (!config.missingBrandOutputFile) {
    return;
  }

  fs.mkdirSync(appConfig.paths.reportsDir, { recursive: true });
  fs.writeFileSync(config.missingBrandOutputFile, 'source,formatted,url,missing\n');
}

function appendMissingBrandCsvRow(config, item, url) {
  if (!config.missingBrandOutputFile || !item.missingBrand) {
    return;
  }

  fs.appendFileSync(
    config.missingBrandOutputFile,
    `${csvEscape(item.source || '')},${csvEscape(item.title)},${url},${csvEscape(item.missingNote || '')}\n`
  );
}

async function runTask(taskKey) {
  const config = getTaskConfig(taskKey);

  if (!config) {
    throw new Error(`Сценарий "${taskKey}" не найден.`);
  }

  if (typeof config.run === 'function') {
    await config.run();
    return;
  }

  // CRM brand/geo are fetched before the browser starts; unresolved domains stop the run here.
  const items = config.crmLookup
    ? await loadTaskItemsWithCrm(config, readTaskInput(config), { blockOnUnresolved: true })
    : loadTaskItems(config);
  if (config.writeReport !== false) {
    writeCsvHeader(config);
    writeMissingBrandCsvHeader(config);
  }

  const browser = await chromium.launchPersistentContext(
    config.userDataDir || DEFAULT_USER_DATA_DIR,
    {
      headless: false,
      slowMo: 200
    }
  );

  try {
    const page = await browser.newPage();
    await openProject(page, config);

    const missingItems = [];
    for (const item of items) {
      try {
        if (config.simpleCreate) {
          await createSimpleTaskInColumn(page, config, item.title);
        } else {
          await createTaskInColumn(page, config, item.title, item);
        }

        const url = config.skipResolveCreatedTaskUrl
          ? page.url()
          : config.fastCreate
            ? await readCreatedTaskUrlFromBoard(page, config, item.title)
            : await resolveCreatedTaskUrl(page, item.title);

        if ((config.customFields?.length || item.customFields?.length) && !pageUrlIncludesTask(page.url())) {
          throw new Error('Задача создана, но карточка не открылась. Не удалось заполнить её пользовательские поля. Повторно запускать весь список не нужно.');
        }
        await applyCustomFields(page, config, item);

        if (config.writeReport !== false) {
          appendCsvRow(config, item.title, url);
          appendMissingBrandCsvRow(config, item, url);
        }
        // Assignment errors must stop the run without retrying task creation.
        if (config.assigneeName && !pageUrlIncludesTask(page.url())) {
          throw new Error('Задача создана, но не удалось открыть её для назначения исполнителя. Сценарий остановлен; повторно запускать весь список не нужно.');
        }
        await assignTask(page, config.assigneeName, config.assigneeEmail);
        console.log(item.title);
        console.log(url);
        if (item.missingBrand) missingItems.push({ title: item.title, url, note: item.missingNote });
        await page.waitForTimeout(config.fastCreate ? 500 : DEFAULT_BETWEEN_TASKS_DELAY_MS);
      } catch (error) {
        console.log('Error occurred. Выполнение остановлено.');
        console.log(error.message);
        return;
      }
    }

    console.log('Finished.');
    if (config.missingBrandOutputFile && missingItems.length > 0) {
      console.log(`\nНе хватает данных в ${missingItems.length} карточк(ах), заполнить вручную:`);
      missingItems.forEach(({ title, url, note }) => console.log(`${note ? `[${note}] ` : ''}${title}\n${url}`));
      console.log(`Список: ${config.missingBrandOutputFile}`);
    }
  } finally {
    await browser.close();
  }
}

module.exports = {
  taskConfigs,
  runTask,
  loadTaskItems,
  getTaskInputPath
};
