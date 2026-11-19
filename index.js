const readline = require('readline');
const path = require('path');
const { taskConfigs, runTask, loadTaskItems, getTaskInputPath } = require('./src/asanaTaskManager');

function printTaskList() {
  console.log('Доступные сценарии:\n');

  taskConfigs.forEach((task, index) => {
    const itemCount = loadTaskItems(task).length;
    const inputLabel = task.dynamicInput
      ? 'спрашивается при запуске'
      : `${path.basename(getTaskInputPath(task))} | Сейчас строк: ${itemCount}`;
    console.log(`${index + 1}. ${task.label}`);
    console.log(`   ${task.description}`);
    console.log(`   Вход: ${inputLabel}`);
    console.log('');
  });
}

function promptSelection() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  printTaskList();

  rl.question('Выберите номер сценария для запуска: ', async (answer) => {
    rl.close();

    const selectedIndex = Number(answer) - 1;
    const task = taskConfigs[selectedIndex];

    if (!task) {
      console.error('Неверный номер сценария.');
      process.exit(1);
    }

    try {
      console.log(`\nЗапускаю: ${task.label}\n`);
      await runTask(task.key);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  });
}

async function main() {
  const taskKey = process.argv[2];

  if (taskKey === '--list') {
    printTaskList();
    return;
  }

  if (taskKey) {
    await runTask(taskKey);
    return;
  }

  promptSelection();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
