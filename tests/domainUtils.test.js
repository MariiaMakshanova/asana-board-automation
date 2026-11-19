const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomain, getDomainLookupCandidates, findDomainLookupEntry } = require('../src/domainUtils');

test('normalizeDomain убирает протокол, www, путь и регистр', () => {
  assert.equal(normalizeDomain('https://www.Example.COM/pt/page?x=1'), 'example.com');
  assert.equal(normalizeDomain('http://shop.example)'), 'shop.example');
  assert.equal(normalizeDomain('  example.com  '), 'example.com');
});

test('normalizeDomain: пустые значения', () => {
  for (const value of ['', null, undefined, '   ']) {
    assert.equal(normalizeDomain(value), '');
  }
  assert.deepEqual(getDomainLookupCandidates(''), []);
});

test('поиск в справочнике находит домен и с www, и без', () => {
  const lookup = { 'www.alpha.example': { brand: 'Alpha' } };
  assert.deepEqual(findDomainLookupEntry(lookup, 'https://alpha.example/'), { brand: 'Alpha' });
  assert.equal(findDomainLookupEntry(lookup, 'other.example'), null);
  assert.equal(findDomainLookupEntry(null, 'alpha.example'), null);
});
