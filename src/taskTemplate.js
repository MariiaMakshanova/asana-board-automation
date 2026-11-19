async function openTaskTemplateMenu(column) {
  // The header is itself role=button; target only its nested template trigger.
  await column.hover();
  const trigger = column.locator('.AddTaskWithTemplatesDropdownButton [role="button"][aria-haspopup="menu"]').first();
  await trigger.waitFor({ state: 'visible', timeout: 10000 });
  await trigger.click();
}

async function selectTaskTemplate(page, templateName) {
  if (!templateName) return;
  const entry = page.getByRole('menu').getByRole('menuitem', { name: templateName, exact: true });
  try {
    await entry.waitFor({ state: 'visible', timeout: 8000 });
    await entry.click();
  } catch (cause) {
    const error = new Error(`Не удалось выбрать шаблон «${templateName}». Создание остановлено; обычная задача вместо шаблона не выбирается.`, { cause });
    error.templateSelectionFailed = true;
    throw error;
  }
}

module.exports = { selectTaskTemplate, openTaskTemplateMenu };
