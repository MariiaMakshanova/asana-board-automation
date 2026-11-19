const fs = require('fs');
const path = require('path');
const { normalizeDomain } = require('./domainUtils');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const CRM_SECTIONS = [
  { key: 'website', label: 'Sites', endpoint: '/v1/website' },
  { key: 'partner', label: 'Partners', endpoint: '/v1/partner' }
].filter((section) => !section.disabled);
const DOMAIN_CHUNK_SIZE = 100;
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60000;

// Language codes that sometimes end up in CRM geo; they are not countries for task titles.
const LANGUAGE_GEO_CODES = new Set(['EN', 'EL', 'SL', 'CS', 'SV', 'DA', 'JA', 'KO', 'ZH', 'HE', 'NB', 'NN']);
const COUNTRY_NAME_CODES = new Map([
  ['казахстан', 'KZ'], ['kazakhstan', 'KZ'],
  ['уругвай', 'UY'], ['uruguay', 'UY'],
  ['узбекистан', 'UZ'], ['uzbekistan', 'UZ'],
  ['азербайджан', 'AZ'], ['azerbaijan', 'AZ'],
  ['индия', 'IN'], ['india', 'IN'],
  ['германия', 'DE'], ['germany', 'DE'],
  ['нидерланды', 'NL'], ['netherlands', 'NL'],
  ['испания', 'ES'], ['spain', 'ES'],
  ['италия', 'IT'], ['italy', 'IT'],
  ['франция', 'FR'], ['france', 'FR'],
  ['польша', 'PL'], ['poland', 'PL'],
  ['португалия', 'PT'], ['portugal', 'PT'],
  ['греция', 'GR'], ['greece', 'GR'],
  ['великобритания', 'UK'], ['united kingdom', 'UK'], ['англия', 'UK'],
  ['канада', 'CA'], ['canada', 'CA'],
  ['австралия', 'AU'], ['australia', 'AU'],
  ['бразилия', 'BR'], ['brazil', 'BR'],
  ['мексика', 'MX'], ['mexico', 'MX']
]);

function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) {
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  return values;
}

function getCrmConfig() {
  const env = { ...readEnvFile(), ...process.env };
  const apiKey = env.CRM_API_KEY || env.CRM_API_TOKEN || '';

  if (!apiKey || !env.CRM_API_URL) {
    throw new Error('Не заданы CRM_API_URL и CRM_API_KEY: скопируйте .env.example в .env.');
  }

  return {
    apiKey,
    apiUrl: String(env.CRM_API_URL).replace(/\/+$/, '')
  };
}

async function postCrm(config, endpoint, body) {
  let response;
  try {
    response = await fetch(`${config.apiUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
        // CRM rejects requests without a User-Agent.
        'User-Agent': 'asana-ui'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    // Node's fetch hides the real reason (DNS, refused, TLS…) in error.cause.
    const cause = error && error.cause;
    const code = cause && (cause.code || cause.name);
    const hints = {
      ENOTFOUND: 'адрес CRM не находится (DNS) — проверьте интернет/VPN',
      EAI_AGAIN: 'временная ошибка DNS — проверьте интернет/VPN',
      ECONNREFUSED: 'CRM отклонил подключение',
      ECONNRESET: 'соединение с CRM оборвалось',
      ETIMEDOUT: 'CRM не отвечает (таймаут)',
      UND_ERR_CONNECT_TIMEOUT: 'CRM не отвечает (таймаут подключения)',
      TimeoutError: `CRM не ответил за ${REQUEST_TIMEOUT_MS / 1000} с`
    };
    const reason = hints[code] || hints[error && error.name] || (cause && cause.message) || (error && error.message);
    throw new Error(`CRM ${endpoint}: сеть недоступна — ${reason}${code ? ` [${code}]` : ''} (${config.apiUrl})`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CRM ${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  return response.json();
}

// CRM pages are 1-based.
async function searchAllPages(config, endpoint, filters, onPage) {
  const records = [];

  for (let page = 1; ; page += 1) {
    const result = await postCrm(config, endpoint, { filters, page, pageSize: PAGE_SIZE });
    const data = Array.isArray(result.data) ? result.data : [];
    records.push(...data);

    if (onPage) {
      onPage(page, records.length, result.total);
    }

    if (data.length === 0 || records.length >= Number(result.total || 0)) {
      return records;
    }
  }
}

function normalizeGeoCode(value) {
  const raw = String(value || '').trim();
  const byName = COUNTRY_NAME_CODES.get(raw.toLowerCase());
  if (byName) {
    return byName;
  }

  const code = raw.toUpperCase();
  return code === 'GB' ? 'UK' : code;
}

// 1–2 countries → the first one in CRM order, more than two → WW.
function resolveCrmGeo(geoList) {
  const values = Array.isArray(geoList) ? geoList : String(geoList || '').split(/[,;]/);
  const countries = [];

  for (const value of values) {
    const code = normalizeGeoCode(value);
    if (code && !LANGUAGE_GEO_CODES.has(code) && !countries.includes(code)) {
      countries.push(code);
    }
  }

  if (countries.length === 0) {
    return '';
  }

  return countries.length > 2 ? 'WW' : countries[0];
}

// "Acme Shop" = "acme-shop" = "ACME shop" when comparing brands.
function normalizeBrandKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function toCrmRecord(section, record) {
  return {
    section: section.key,
    sectionLabel: section.label,
    domain: normalizeDomain(record.domain),
    brand: String(record.brand || '').trim(),
    geo: resolveCrmGeo(record.geo),
    rawGeo: Array.isArray(record.geo) ? record.geo.join(',') : String(record.geo || ''),
    team: record.team || ''
  };
}

async function fetchCrmRecordsByDomain(domains) {
  const config = getCrmConfig();
  const wanted = new Set(domains.map(normalizeDomain).filter(Boolean));
  const recordsByDomain = new Map([...wanted].map((domain) => [domain, []]));
  const domainList = [...wanted];

  for (const section of CRM_SECTIONS) {
    for (let index = 0; index < domainList.length; index += DOMAIN_CHUNK_SIZE) {
      const chunk = domainList.slice(index, index + DOMAIN_CHUNK_SIZE);
      const records = await searchAllPages(config, section.endpoint, { domain: chunk });

      // The domain filter may match substrings, so keep exact matches only.
      for (const record of records) {
        const crmRecord = toCrmRecord(section, record);
        if (recordsByDomain.has(crmRecord.domain)) {
          recordsByDomain.get(crmRecord.domain).push(crmRecord);
        }
      }
    }
  }

  return recordsByDomain;
}

async function fetchAllCrmRecords(onProgress) {
  const config = getCrmConfig();
  const recordsByDomain = new Map();

  for (const section of CRM_SECTIONS) {
    const records = await searchAllPages(config, section.endpoint, {}, (page, loaded, total) => {
      if (onProgress) {
        onProgress(section, page, loaded, total);
      }
    });

    for (const record of records) {
      const crmRecord = toCrmRecord(section, record);
      if (!crmRecord.domain) {
        continue;
      }
      if (!recordsByDomain.has(crmRecord.domain)) {
        recordsByDomain.set(crmRecord.domain, []);
      }
      recordsByDomain.get(crmRecord.domain).push(crmRecord);
    }
  }

  return recordsByDomain;
}

function uniqueBy(values, keyOf) {
  const seen = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (key && !seen.has(key)) {
      seen.set(key, value);
    }
  }
  return [...seen.values()];
}

// Sections are ordered website → partner, so the brand spelling comes from the first one.
function resolveCrmRecords(records) {
  if (!records || records.length === 0) {
    return { status: 'not_found', brand: '', geo: '', problems: ['нет в CRM'] };
  }

  const brands = uniqueBy(records.map((record) => record.brand), normalizeBrandKey);
  const geos = uniqueBy(records.map((record) => record.geo), (geo) => geo);
  const problems = [];

  if (brands.length > 1) {
    problems.push(`разные бренды: ${brands.join(' / ')}`);
  }
  if (geos.length > 1) {
    problems.push(`разные гео: ${geos.join(' / ')}`);
  }
  if (problems.length > 0) {
    return { status: 'conflict', brand: '', geo: '', problems };
  }

  if (brands.length === 0) {
    problems.push('в CRM нет бренда');
  }
  if (geos.length === 0) {
    problems.push('в CRM нет гео');
  }

  return {
    status: problems.length > 0 ? 'incomplete' : 'ok',
    brand: brands[0] || '',
    geo: geos[0] || '',
    problems
  };
}

function normalizeLookupGeo(value) {
  return normalizeGeoCode(value);
}

function compareWithLookup(resolution, lookupEntry) {
  const lookupBrand = lookupEntry ? lookupEntry.brand || '' : '';
  const lookupGeo = lookupEntry ? normalizeLookupGeo(lookupEntry.geo) : '';
  const diffs = [];

  if (!lookupEntry || (!lookupBrand && !lookupGeo)) {
    diffs.push('not_in_lookup');
  } else if (resolution.status !== 'not_found') {
    if (resolution.brand && lookupBrand && normalizeBrandKey(resolution.brand) !== normalizeBrandKey(lookupBrand)) {
      diffs.push('brand_diff');
    }
    if (resolution.geo && lookupGeo && resolution.geo !== lookupGeo) {
      diffs.push('geo_diff');
    }
  }

  return { lookupBrand, lookupGeo, diffs };
}

// Final brand/geo for one domain: CRM first, local lookup only as a marked fallback.
function resolveDomain(domain, records, lookupEntry) {
  const crm = resolveCrmRecords(records);
  const comparison = compareWithLookup(crm, lookupEntry);
  let brand = crm.brand;
  let geo = crm.geo;
  let source = 'crm';
  let blocking = false;

  if (crm.status === 'conflict') {
    blocking = true;
    source = '';
  } else if (crm.status !== 'ok') {
    const fallbackBrand = brand ? '' : comparison.lookupBrand;
    const fallbackGeo = geo ? '' : comparison.lookupGeo;
    brand = brand || fallbackBrand;
    geo = geo || fallbackGeo;
    source = fallbackBrand || fallbackGeo ? 'fallback_lookup' : '';
    blocking = !brand || !geo;
  }

  return {
    domain,
    status: crm.status,
    brand,
    geo,
    source,
    blocking,
    problems: crm.problems,
    crmBrand: crm.brand,
    crmGeo: crm.geo,
    crmSources: (records || []).map((record) =>
      `${record.sectionLabel}${record.team ? `/${record.team}` : ''}: ${record.brand || '—'} [${record.rawGeo || '—'}]`
    ).join('; '),
    lookupBrand: comparison.lookupBrand,
    lookupGeo: comparison.lookupGeo,
    diffs: comparison.diffs
  };
}

module.exports = {
  CRM_SECTIONS,
  LANGUAGE_GEO_CODES,
  compareWithLookup,
  fetchAllCrmRecords,
  fetchCrmRecordsByDomain,
  getCrmConfig,
  normalizeBrandKey,
  normalizeGeoCode,
  resolveCrmGeo,
  resolveCrmRecords,
  resolveDomain
};
