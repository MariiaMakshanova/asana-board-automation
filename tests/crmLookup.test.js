const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBrandKey, normalizeGeoCode, resolveCrmGeo, resolveCrmRecords, resolveDomain
} = require('../src/crmLookup');

const record = (brand, geo, section = 'website') => ({ section, sectionLabel: section, brand, geo, rawGeo: geo, team: '' });

test('гео: GB → UK, названия стран → коды', () => {
  assert.equal(normalizeGeoCode('gb'), 'UK');
  assert.equal(normalizeGeoCode('Германия'), 'DE');
  assert.equal(normalizeGeoCode('Spain'), 'ES');
});

test('гео: коды языков отбрасываются, 1–2 страны → первая, больше двух → WW', () => {
  assert.equal(resolveCrmGeo(['EN', 'DE']), 'DE');
  assert.equal(resolveCrmGeo(['DE', 'FR']), 'DE');
  assert.equal(resolveCrmGeo(['DE', 'FR', 'IT']), 'WW');
  assert.equal(resolveCrmGeo('DE, DE; FR'), 'DE');
  assert.equal(resolveCrmGeo([]), '');
  assert.equal(resolveCrmGeo(['EN']), '');
});

test('бренды сравниваются без регистра, пробелов и знаков', () => {
  assert.equal(normalizeBrandKey('Alpha Shop'), normalizeBrandKey('ALPHA-shop'));
  assert.notEqual(normalizeBrandKey('Alpha'), normalizeBrandKey('Beta'));
});

test('resolveCrmRecords: ok / not_found / conflict / incomplete', () => {
  assert.equal(resolveCrmRecords([]).status, 'not_found');
  assert.deepEqual(
    resolveCrmRecords([record('Alpha Shop', 'DE'), record('ALPHA shop', 'DE', 'partner')]),
    { status: 'ok', brand: 'Alpha Shop', geo: 'DE', problems: [] }
  );
  const conflict = resolveCrmRecords([record('Gamma', 'ES'), record('Delta', 'ES')]);
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.problems[0], /разные бренды/);
  assert.equal(resolveCrmRecords([record('Epsilon', '')]).status, 'incomplete');
});

test('resolveDomain: CRM главнее справочника, справочник — только fallback', () => {
  const fromCrm = resolveDomain('a.example', [record('Alpha', 'DE')], { brand: 'Other', geo: 'FR' });
  assert.equal(fromCrm.source, 'crm');
  assert.equal(fromCrm.brand, 'Alpha');
  assert.deepEqual(fromCrm.diffs, ['brand_diff', 'geo_diff']);

  const fallback = resolveDomain('z.example', [], { brand: 'Zeta', geo: 'PL' });
  assert.equal(fallback.source, 'fallback_lookup');
  assert.equal(fallback.blocking, false);

  const missing = resolveDomain('x.example', [], null);
  assert.equal(missing.blocking, true);

  const conflict = resolveDomain('c.example', [record('Gamma', 'ES'), record('Delta', 'ES')], { brand: 'Gamma', geo: 'ES' });
  assert.equal(conflict.blocking, true, 'конфликт в CRM не перекрывается справочником');
});
