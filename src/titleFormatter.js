const { normalizeDomain } = require('./domainUtils');

// One input line: "<url> [quantity]". Accepts plain URLs, [url] and markdown links [text](url).
function parseLine(line, options = {}) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  const rawTarget = tokens[0];
  const markdownLink = rawTarget.match(/^\[[^\]]*\]\(([^)]+)\)$/);
  const target = markdownLink ? markdownLink[1] : rawTarget.replace(/^\[/, '').replace(/\]$/, '');
  const domain = normalizeDomain(target);
  const quantity = tokens.slice(1).find((token) => /^\d+$/.test(token)) || options.defaultQuantity || '';

  if (!domain || !quantity) return null;

  // Geo in the URL path (https://site.com/pt/) is more specific than the domain's geo in CRM.
  const pathGeo = target.replace(/^https?:\/\//i, '').match(/^[^/]+\/([a-z]{2})(?:\/|[?#]|$)/i)?.[1];
  const geo = pathGeo ? pathGeo.toUpperCase() : (options.findGeoByDomain ? options.findGeoByDomain(domain) : '');
  const brand = options.findBrandByDomain ? String(options.findBrandByDomain(domain) || '').trim() : '';

  return {
    domain,
    website: target,
    brand,
    geo,
    quantity,
    missingBrand: !brand,
    missingGeo: !geo,
    formatted: `[${target}] | ${brand} | ${geo} | ${quantity}`
  };
}

function formatInput(input, options = {}) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => parseLine(line, options))
    .filter(Boolean);
}

function describeMissing(task) {
  return [task.missingBrand && 'нет бренда', task.missingGeo && 'нет гео'].filter(Boolean).join(', ');
}

module.exports = { describeMissing, formatInput, parseLine };
