const fs = require('fs');
const path = require('path');
const { appConfig, resolveInputPath, resolveReportPath } = require('./appConfig');
const { describeMissing, formatInput } = require('./titleFormatter');

// Asana project URLs are private: they come from .env, never from the code.
function readEnv() {
  const envPath = path.resolve(appConfig.rootDir, '.env');
  const values = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...values, ...process.env };
}

const env = readEnv();

// Scenario = Asana project + board column + task template + input parser.
function linkPlanConfig({ key, columnName, templateName }) {
  const slug = key.replace(/-/g, '_');
  return {
    key,
    label: `Demo board | ${columnName}`,
    description: `Создаёт задачи в колонке «${columnName}»: [url] | бренд | гео | количество; бренд/гео из CRM.`,
    projectUrl: env.ASANA_PROJECT_URL || '',
    columnName,
    templateName,
    inputFile: resolveInputPath(`${columnName}.txt`),
    outputFile: resolveReportPath(`created_${slug}.csv`),
    missingBrandOutputFile: resolveReportPath(`created_${slug}_missing_data.csv`),
    outputColumnName: 'formatted',
    crmLookup: true,
    allowMissingBrandGeo: true,
    parseInput(input, crm = {}) {
      return formatInput(input, crm).map((task) => ({
        source: task.website,
        domain: task.domain,
        title: task.formatted,
        missingBrand: task.missingBrand || task.missingGeo,
        missingNote: describeMissing(task)
      }));
    }
  };
}

const taskConfigs = [
  linkPlanConfig({ key: 'link-plan', columnName: 'Link plan', templateName: '[website] | brand | geo | qty' }),
  {
    key: 'simple-list',
    label: 'Demo board | Backlog',
    description: 'Создаёт обычные задачи: одна строка входного файла = одна карточка.',
    projectUrl: env.ASANA_PROJECT_URL || '',
    columnName: 'Backlog',
    simpleCreate: true,
    inputFile: resolveInputPath('Backlog.txt'),
    outputFile: resolveReportPath('created_simple_list.csv')
  }
];

function getTaskConfig(key) {
  return taskConfigs.find((config) => config.key === key) || null;
}

module.exports = { getTaskConfig, linkPlanConfig, taskConfigs };
