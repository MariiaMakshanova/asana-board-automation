const test = require('node:test');
const assert = require('node:assert/strict');
const { formatInput, parseLine } = require('../src/titleFormatter');

const crm = {
  findBrandByDomain: (domain) => ({ 'alpha.example': 'Alpha' })[domain] || '',
  findGeoByDomain: (domain) => ({ 'alpha.example': 'DE' })[domain] || ''
};

test('название: [url] | бренд | гео | количество', () => {
  assert.equal(parseLine('https://alpha.example 3000', crm).formatted, '[https://alpha.example] | Alpha | DE | 3000');
});

test('разные форматы ссылки дают один и тот же результат', () => {
  for (const input of ['https://alpha.example', '[https://alpha.example]', '[https://alpha.example](https://alpha.example)']) {
    assert.equal(parseLine(`${input} 10`, crm).formatted, '[https://alpha.example] | Alpha | DE | 10');
  }
});

test('гео из пути URL важнее гео из CRM', () => {
  assert.equal(parseLine('https://alpha.example/pt/ 10', crm).geo, 'PT');
});

test('нет данных → пустые поля и пометка missing', () => {
  const task = parseLine('unknown.example 5', crm);
  assert.equal(task.formatted, '[unknown.example] |  |  | 5');
  assert.equal(task.missingBrand, true);
  assert.equal(task.missingGeo, true);
});

test('строки без количества и пустые строки пропускаются', () => {
  assert.equal(parseLine('alpha.example', crm), null);
  assert.equal(parseLine('   ', crm), null);
  assert.equal(parseLine('alpha.example', { ...crm, defaultQuantity: '3000' }).quantity, '3000');
  assert.equal(formatInput('\nalpha.example 1\n\nalpha.example\n', crm).length, 1);
});
