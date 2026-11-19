async function assignTask(page, assigneeName, assigneeEmail) {
  if (!assigneeName) return;

  const controls = [
    page.getByRole('button', { name: /^(Исполнитель|Assignee|Назначить эту задачу|Assign this task|Без исполнителя|Unassigned)/i }).last(),
    page.locator('[class*="Assignee"] [role="button"], [class*="Assignee"][role="button"]').last(),
    page.getByText(/^(Без исполнителя|Unassigned)$/, { exact: true }).last(),
    page.getByText(/^(Исполнитель|Assignee)$/, { exact: true }).last()
  ];
  let opened = false;
  for (const control of controls) {
    if (!await control.isVisible().catch(() => false)) continue;
    await control.click();
    opened = true;
    break;
  }
  if (!opened) throw new Error(`Не удалось открыть выбор исполнителя ${assigneeName}. Задача уже создана, повторно запускать весь список не нужно.`);

  const search = page.getByPlaceholder(/Имя или адрес электрон|Name or email/i)
    .or(page.locator('[class*="Assignee"] input, [role="dialog"] input[role="combobox"], input[aria-label*="исполнител" i], input[aria-label*="assignee" i]')).last();
  await search.waitFor({ state: 'visible', timeout: 10000 });
  await search.fill(assigneeName);
  // Click the matching person explicitly: Enter can select the first unrelated suggestion.
  const person = assigneeEmail
    ? page.getByText(assigneeEmail, { exact: true }).last()
    : page.getByRole('option').filter({ hasText: assigneeName }).last();
  await person.waitFor({ state: 'visible', timeout: 15000 });
  await person.click();
  await person.waitFor({ state: 'hidden', timeout: 10000 });
}

module.exports = { assignTask };
