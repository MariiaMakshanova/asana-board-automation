// Minimal fake of the CRM API: POST /v1/<section> with { filters: { domain: [...] }, page, pageSize }.
// Checks the X-API-Key header and paginates, so the client is tested against the same contract as production.
const http = require('http');
const path = require('path');

const DEFAULT_DATA = require(path.resolve(__dirname, 'crm-data.json'));
const API_KEY = 'test-key';

function createCrmMockServer(data = DEFAULT_DATA, { apiKey = API_KEY } = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const section = (req.url.match(/^\/v1\/([a-z]+)$/) || [])[1];
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method !== 'POST' || !section) return send(404, { error: 'not found' });
      if (req.headers['x-api-key'] !== apiKey) return send(403, { error: 'forbidden' });
      if (!req.headers['user-agent']) return send(400, { error: 'user-agent required' });

      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }

      const { filters = {}, page = 1, pageSize = 1000 } = parsed;
      const wanted = Array.isArray(filters.domain) ? filters.domain : null;
      const all = (data[section] || []).filter((record) => !wanted || wanted.some((d) => record.domain.includes(d)));
      const start = (page - 1) * pageSize;
      send(200, { data: all.slice(start, start + pageSize), total: all.length, page });
    });
  });

  return {
    requests,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4010);
  createCrmMockServer().start(port).then((url) => {
    console.log(`CRM mock: ${url} (X-API-Key: ${API_KEY})`);
  });
}

module.exports = { API_KEY, createCrmMockServer };
