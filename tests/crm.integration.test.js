// Integration: real HTTP client against a local CRM mock (no network, no real data).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-board-'));
process.env.REPORTS_DIR = tmp;
process.env.LOOKUP_FILE = path.resolve(__dirname, '..', 'data', 'lookup.example.json');

const { createCrmMockServer, API_KEY } = require('../mock/crmMockServer');
const { fetchAllCrmRecords, fetchCrmRecordsByDomain } = require('../src/crmLookup');
const { loadTaskItemsWithCrm } = require('../src/crmCheck');
const { getTaskConfig } = require('../src/taskConfigs');

let mock;
const quiet = () => test.mock.method(console, 'log', () => {});

test.before(async () => {
  mock = createCrmMockServer();
  process.env.CRM_API_URL = await mock.start();
  process.env.CRM_API_KEY = API_KEY;
});
test.after(async () => {
  await mock.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('клиент отправляет X-API-Key, User-Agent и фильтр по доменам', async () => {
  mock.requests.length = 0;
  await fetchCrmRecordsByDomain(['alpha-shop.example']);
  const request = mock.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], API_KEY);
  assert.ok(request.headers['user-agent']);
  assert.deepEqual(JSON.parse(request.body).filters, { domain: ['alpha-shop.example'] });
  assert.equal(JSON.parse(request.body).page, 1, 'страницы CRM начинаются с 1');
});

test('из ответа берутся только точные совпадения домена', async () => {
  const records = await fetchCrmRecordsByDomain(['shop.example']);
  assert.deepEqual(records.get('shop.example'), [], 'alpha-shop.example не должен попасть в shop.example');
});

test('неверный ключ → понятная ошибка с HTTP 403', async () => {
  process.env.CRM_API_KEY = 'wrong';
  try {
    await assert.rejects(fetchCrmRecordsByDomain(['alpha-shop.example']), /HTTP 403/);
  } finally {
    process.env.CRM_API_KEY = API_KEY;
  }
});

test('пагинация: читаются все страницы', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ domain: `site-${i}.example`, brand: `B${i}`, geo: ['DE'] }));
  const big = createCrmMockServer({ website: many, partner: [] });
  const previousUrl = process.env.CRM_API_URL;
  process.env.CRM_API_URL = await big.start();
  try {
    const all = await fetchAllCrmRecords();
    assert.equal(all.size, 2500);
    assert.equal(big.requests.filter((r) => r.url === '/v1/website').length, 3);
  } finally {
    process.env.CRM_API_URL = previousUrl;
    await big.stop();
  }
});

test('сценарий link-plan: названия карточек + CSV-отчёт', async () => {
  quiet();
  const config = getTaskConfig('link-plan');
  const input = fs.readFileSync(path.resolve(__dirname, '..', 'input', 'Link plan.txt'), 'utf-8');
  const items = await loadTaskItemsWithCrm(config, input, { blockOnUnresolved: true });

  assert.deepEqual(items.map((item) => item.title), [
    '[https://alpha-shop.example] | Alpha Shop | DE | 3000',
    '[https://beta-store.example/pt/] | Beta Store | PT | 1500',
    '[https://multi-geo.example] | Multi | WW | 500',
    '[fallback-only.example] | Zeta | PL | 200',
    '[unknown.example] |  |  | 100'
  ]);
  assert.equal(items.at(-1).missingBrand, true);

  const report = fs.readFileSync(path.join(tmp, 'crm_check_link-plan.csv'), 'utf-8');
  assert.match(report, /"fallback-only.example","not_found","","fallback_lookup"/);
});

test('конфликт брендов в CRM останавливает запуск до открытия браузера', async () => {
  quiet();
  await assert.rejects(
    loadTaskItemsWithCrm(getTaskConfig('link-plan'), 'conflict.example 10', { blockOnUnresolved: true }),
    /Браузер не запущен/
  );
});
