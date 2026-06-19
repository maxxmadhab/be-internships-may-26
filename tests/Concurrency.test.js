import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

test('concurrency: 50 simultaneous requests with same Idempotency-Key produce exactly one row', async () => {
  const proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, API_KEY: 'k', PORT: '9093', RATE_LIMIT_PER_MIN: '1000', DB_FAIL_RATE: '0.2' }
  });
  await wait(300);

  const base = 'http://localhost:9093';
  const idem = 'concurrent-key';

  const requests = Array.from({ length: 50 }, (_, i) =>
    postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'u-concurrent', type: 'note', payload: String(i) }
    })
  );

  const results = await Promise.all(requests);
  const ids = new Set(results.map((r) => r.id).filter((id) => id !== undefined));

  assert.equal(ids.size, 1, `expected exactly 1 unique id, got ${ids.size}`);
  proc.kill();
});

async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks || '{}'));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}