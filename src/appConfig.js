const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const appConfig = {
  rootDir: ROOT_DIR,
  paths: {
    inputDir: process.env.INPUT_DIR || path.resolve(ROOT_DIR, 'input'),
    reportsDir: process.env.REPORTS_DIR || path.resolve(ROOT_DIR, 'reports'),
    lookupFile: process.env.LOOKUP_FILE || path.resolve(ROOT_DIR, 'data', 'lookup.json')
  }
};

function resolveInputPath(fileName) {
  return path.resolve(appConfig.paths.inputDir, fileName);
}

function resolveReportPath(fileName) {
  return path.resolve(appConfig.paths.reportsDir, fileName);
}

module.exports = { appConfig, resolveInputPath, resolveReportPath };
