function normalizeDomain(rawDomain) {
  return String(rawDomain || '')
    .trim()
    .replace(/[)\]]+$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function getDomainLookupCandidates(rawDomain) {
  const normalizedDomain = normalizeDomain(rawDomain);

  if (!normalizedDomain) {
    return [];
  }

  const candidates = [normalizedDomain];
  const wwwDomain = `www.${normalizedDomain}`;

  if (!candidates.includes(wwwDomain)) {
    candidates.push(wwwDomain);
  }

  return candidates;
}

function findDomainLookupEntry(lookup, rawDomain) {
  if (!lookup || typeof lookup !== 'object') {
    return null;
  }

  for (const candidate of getDomainLookupCandidates(rawDomain)) {
    if (Object.prototype.hasOwnProperty.call(lookup, candidate)) {
      return lookup[candidate];
    }
  }

  return null;
}

module.exports = {
  findDomainLookupEntry,
  getDomainLookupCandidates,
  normalizeDomain
};
