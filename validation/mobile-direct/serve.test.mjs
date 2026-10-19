import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from './serve.mjs';

test('file-only host cannot proxy, accept tokens, or expose source beyond the public allowlist', async (t) => {
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(
    page.headers.get('content-security-policy'),
    /connect-src https:\/\/graph\.threads\.com;/,
  );
  assert.match(await page.text(), /모바일 직접 호출 검증/);
  for (const path of [
    '/api/threads',
    '/.env',
    '/serve.mjs',
    '/probe.test.mjs',
    '/README.md',
    '/index.html?access_token=synthetic',
    '/%2e%2e/package.json',
  ]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base, { method: 'POST', body: 'access_token=synthetic' })).status, 405);
  assert.equal(
    (await fetch(base + '/app.mjs')).headers.get('content-type'),
    'text/javascript; charset=utf-8',
  );
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
