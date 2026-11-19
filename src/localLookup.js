const fs = require('fs');
const { appConfig } = require('./appConfig');
const { findDomainLookupEntry } = require('./domainUtils');

// Secondary source of brand/geo (e.g. an export from a spreadsheet): { "domain.com": { "brand": "...", "geo": "DE" } }.
// Used only when the CRM has no data, and every such value is marked as FALLBACK in the report.
let cache = null;

function loadLookup(filePath = appConfig.paths.lookupFile) {
  if (cache && cache.filePath === filePath) return cache.data;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
  } catch {
    data = {};
  }
  cache = { filePath, data };
  return data;
}

function findLookupEntry(domain) {
  const entry = findDomainLookupEntry(loadLookup(), domain);
  return { brand: (entry && entry.brand) || '', geo: (entry && entry.geo) || '' };
}

module.exports = { findLookupEntry, loadLookup };
