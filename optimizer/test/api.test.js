import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { getStatus, publishPool, rollback, verifyProbe, RevisionConflictError } from '../src/api.js';

async function server(handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  return instance;
}

function config(instance, token = 'super-secret-machine-token') {
  return { workerBaseUrl: `http://127.0.0.1:${instance.address().port}`, token, timeoutMs: 1500 };
}

test('status uses bearer auth and no-store', async (t) => {
  let auth = null;
  let cache = null;
  const instance = await server((req, res) => {
    auth = req.headers.authorization;
    cache = req.headers['cache-control'];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ current: 'r1', previous: null }));
  });
  t.after(() => instance.close());
  const status = await getStatus(config(instance));
  assert.equal(auth, 'Bearer super-secret-machine-token');
  assert.equal(cache, 'no-store');
  assert.equal(status.current, 'r1');
});

test('publish sends expected revision and structured entries', async (t) => {
  let body;
  const instance = await server(async (req, res) => {
    body = JSON.parse(await new Promise((resolve) => {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => resolve(text));
    }));
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/ops/optimizer/v1/pool');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revision: 'r2', previous: 'r1' }));
  });
  t.after(() => instance.close());
  const result = await publishPool(config(instance), {
    expectedRevision: 'r1',
    entries: [{ address: '104.16.0.1', port: 443, name: 'nas-1' }],
  });
  assert.equal(result.revision, 'r2');
  assert.deepEqual(body, {
    expected_current_revision: 'r1',
    entries: [{ address: '104.16.0.1', port: 443, name: 'nas-1' }],
  });
});

test('409 is surfaced as RevisionConflictError and never retried', async (t) => {
  let calls = 0;
  const token = 'token-must-not-leak';
  const instance = await server((req, res) => {
    calls += 1;
    res.statusCode = 409;
    res.end('stale revision');
  });
  t.after(() => instance.close());
  await assert.rejects(
    () => publishPool(config(instance, token), { expectedRevision: 'old', entries: [] }),
    (error) => {
      assert.ok(error instanceof RevisionConflictError);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('non-2xx error bodies are bounded and token is never exposed', async (t) => {
  const token = 'another-token-must-not-leak';
  const instance = await server((req, res) => {
    res.statusCode = 500;
    res.end(`server-error:${'x'.repeat(5000)}:${token}`);
  });
  t.after(() => instance.close());
  await assert.rejects(() => getStatus(config(instance, token)), (error) => {
    assert.ok(error.message.length < 1400);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});

test('rollback and bounded probe use exact machine endpoints', async (t) => {
  const seen = [];
  const instance = await server(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith('/probe')) {
      const body = Buffer.alloc(65536, 3);
      res.statusCode = 200;
      res.setHeader('content-length', String(body.length));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-optimizer-probe-version', '1');
      res.end(body);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revision: 'r1' }));
  });
  t.after(() => instance.close());
  await rollback(config(instance), { expectedRevision: 'r2' });
  const probe = await verifyProbe(config(instance));
  assert.equal(probe.bytes, 65536);
  assert.deepEqual(seen, [
    'POST /ops/optimizer/v1/rollback',
    'GET /ops/optimizer/v1/probe',
  ]);
});
