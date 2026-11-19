const fs = require('fs');
const { appConfig, resolveReportPath } = require('./appConfig');
const { findLookupEntry } = require('./localLookup');
const { normalizeDomain } = require('./domainUtils');
const { CRM_SECTIONS, fetchCrmRecordsByDomain, resolveDomain } = require('./crmLookup');

const STATUS_LABELS = {
  ok: 'OK',
  not_found: 'НЕТ В CRM',
  conflict: 'КОНФЛИКТ',
  incomplete: 'НЕПОЛНО'
};
const DIFF_LABELS = {
  brand_diff: 'бренд ≠ справочник',
  geo_diff: 'гео ≠ справочник',
  not_in_lookup: 'нет в справочнике'
};

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeCsv(filePath, columns, rows) {
  fs.mkdirSync(appConfig.paths.reportsDir, { recursive: true });
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function getLookupEntry(domain, findEntry = findLookupEntry) {
  const entry = findEntry(domain);
  return entry.brand || entry.geo ? entry : null;
}

function describeResolution(resolution) {
  const notes = [...resolution.problems];
  if (resolution.source === 'fallback_lookup') {
    notes.push(`FALLBACK: взято из ${resolution.fallbackLabel || 'data/lookup.json'}`);
  }
  notes.push(...resolution.diffs.map((diff) => DIFF_LABELS[diff]));
  if (resolution.diffs.includes('brand_diff') || resolution.diffs.includes('geo_diff')) {
    notes.push(`справочник: ${resolution.lookupBrand || '—'} / ${resolution.lookupGeo || '—'}`);
  }
  return notes.join('; ');
}

function printResolutions(resolutions) {
  const rows = resolutions.map((resolution) => ({
    status: `${resolution.blocking ? '✖ ' : ''}${STATUS_LABELS[resolution.status]}`,
    domain: resolution.domain,
    result: `${resolution.brand || '—'} | ${resolution.geo || '—'}`,
    notes: describeResolution(resolution)
  }));
  const width = (key) => Math.max(...rows.map((row) => row[key].length), 6);

  for (const row of rows) {
    console.log([
      row.status.padEnd(width('status')),
      row.domain.padEnd(width('domain')),
      row.result.padEnd(width('result')),
      row.notes
    ].join('  ').trimEnd());
  }
}

// fallback: { findEntry(domain) → {brand, geo}, label } replaces data/lookup.json as the second source.
async function checkDomainsInCrm(domains, fallback = {}) {
  const uniqueDomains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  const recordsByDomain = await fetchCrmRecordsByDomain(uniqueDomains);

  return uniqueDomains.map((domain) => ({
    ...resolveDomain(domain, recordsByDomain.get(domain), getLookupEntry(domain, fallback.findEntry)),
    fallbackLabel: fallback.label
  }));
}

function writeCheckReport(reportPath, resolutions) {
  writeCsv(
    reportPath,
    ['domain', 'status', 'blocking', 'source', 'brand', 'geo', 'crm_brand', 'crm_geo', 'crm_sources',
      'lookup_brand', 'lookup_geo', 'diffs', 'notes'],
    resolutions.map((resolution) => ({
      domain: resolution.domain,
      status: resolution.status,
      blocking: resolution.blocking ? 'yes' : '',
      source: resolution.source,
      brand: resolution.brand,
      geo: resolution.geo,
      crm_brand: resolution.crmBrand,
      crm_geo: resolution.crmGeo,
      crm_sources: resolution.crmSources,
      lookup_brand: resolution.lookupBrand,
      lookup_geo: resolution.lookupGeo,
      diffs: resolution.diffs.join(' '),
      notes: describeResolution(resolution)
    }))
  );
}

function buildCrmResolver(resolutions) {
  const byDomain = new Map(resolutions.map((resolution) => [resolution.domain, resolution]));
  const get = (domain) => byDomain.get(normalizeDomain(domain));

  return {
    findBrandByDomain: (domain) => (get(domain) || {}).brand || '',
    findGeoByDomain: (domain) => (get(domain) || {}).geo || ''
  };
}

const EMPTY_CRM_RESOLVER = buildCrmResolver([]);

function extractTaskDomains(config, input) {
  const domains = config.extractDomains
    ? config.extractDomains(input)
    : config.parseInput(input, EMPTY_CRM_RESOLVER).map((item) => item.domain);
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))];
}

// Parses the scenario input twice: first to collect domains, then with CRM brand/geo.
async function loadTaskItemsWithCrm(config, input, options = {}) {
  const domains = extractTaskDomains(config, input);
  console.log(`CRM: проверяю ${domains.length} домен(ов) в разделах ${CRM_SECTIONS.map((section) => section.label).join(' / ')}...`);

  const resolutions = await checkDomainsInCrm(domains, config.crmFallback && {
    findEntry: config.crmFallback.findEntry,
    label: config.crmFallback.label
  });
  const reportPath = resolveReportPath(`crm_check_${config.key}.csv`);
  printResolutions(resolutions);
  writeCheckReport(reportPath, resolutions);
  console.log(`CRM: отчёт сохранён в ${reportPath}`);

  const fallbacks = resolutions.filter((resolution) => resolution.source === 'fallback_lookup');
  if (fallbacks.length > 0) {
    const fallbackLabel = (config.crmFallback || {}).label || 'data/lookup.json';
    console.log(`CRM: ВНИМАНИЕ — ${fallbacks.length} домен(ов) взято из ${fallbackLabel} (FALLBACK): ` +
      fallbacks.map((resolution) => resolution.domain).join(', '));
  }

  // allowMissingBrandGeo: not found anywhere → task gets empty brand/geo; CRM conflicts still block.
  const missing = config.allowMissingBrandGeo
    ? resolutions.filter((resolution) => resolution.blocking && resolution.status !== 'conflict')
    : [];
  if (missing.length > 0) {
    console.log(`CRM: бренд/гео не найдены ни в CRM, ни в ${(config.crmFallback || {}).label || 'справочнике'} ` +
      `для ${missing.length} домен(ов), карточки будут с пустыми полями: ` +
      missing.map((resolution) => resolution.domain).join(', '));
  }

  const blocking = resolutions.filter((resolution) => resolution.blocking && !missing.includes(resolution));
  if (blocking.length > 0) {
    const message = `CRM: не определены бренд/гео для ${blocking.length} домен(ов): ` +
      blocking.map((resolution) => resolution.domain).join(', ');
    if (options.blockOnUnresolved) {
      throw new Error(`${message}. Браузер не запущен — исправьте данные в CRM или входной файл.`);
    }
    console.log(`${message}. Создание карточек будет заблокировано.`);
  }

  const items = config.parseInput(input, buildCrmResolver(resolutions));
  for (const item of items) {
    if (item.notes && item.notes.length > 0) {
      console.log(`CRM: ${item.domain} — во входных данных другое значение (${item.notes.join('; ')}), взято из CRM.`);
    }
  }

  const itemDomains = new Set(items.map((item) => normalizeDomain(item.domain)));
  const skipped = domains.filter((domain) => !itemDomains.has(domain));
  if (skipped.length > 0) {
    console.log(`ВНИМАНИЕ: строки пропущены форматтером (нет языка/гео/бренда): ${skipped.join(', ')}`);
  }

  return items;
}

async function main() {
  const { getTaskConfig, taskConfigs } = require('./taskConfigs');
  const keys = process.argv.slice(2);
  const configs = keys.length > 0
    ? keys.map((key) => getTaskConfig(key) || (() => { throw new Error(`Сценарий "${key}" не найден.`); })())
    : taskConfigs.filter((config) => config.crmLookup);

  for (const config of configs) {
    const input = fs.existsSync(config.inputFile) ? fs.readFileSync(config.inputFile, 'utf-8') : '';
    console.log(`\n=== ${config.label} ===`);
    const items = await loadTaskItemsWithCrm(config, input);
    console.log('\nНазвания карточек:');
    items.forEach((item) => console.log(item.title));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  buildCrmResolver,
  checkDomainsInCrm,
  loadTaskItemsWithCrm,
  printResolutions,
  writeCsv
};
