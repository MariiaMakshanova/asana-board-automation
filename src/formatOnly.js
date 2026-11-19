// Dry run: shows task titles (with CRM brand/geo) without opening a browser or touching Asana.
const fs = require('fs');
const { getTaskConfig } = require('./taskConfigs');
const { loadTaskItemsWithCrm } = require('./crmCheck');

async function main() {
  const key = process.argv[2] || 'link-plan';
  const config = getTaskConfig(key);
  if (!config) throw new Error(`Сценарий "${key}" не найден.`);
  const input = fs.existsSync(config.inputFile) ? fs.readFileSync(config.inputFile, 'utf-8') : '';
  const items = await loadTaskItemsWithCrm(config, input);
  console.log('\nНазвания карточек:');
  items.forEach((item) => console.log(item.title));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
