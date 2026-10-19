/** Optional UI smoke test. All URLs are intercepted; no real Meta/S3 requests are permitted. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PROBE_PLAYWRIGHT_PATH || 'playwright');
const root = dirname(fileURLToPath(import.meta.url));
const files = new Set(['index.html', 'app.mjs', 'probe.mjs', 'styles.css']);
const output = join(root, 'test-output');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PROBE_BROWSER_CHANNEL ? { channel: process.env.PROBE_BROWSER_CHANNEL } : {}),
});
let sequence = 1000;
let loseNextPublish = false;
let rejectFirstReply = true;
let lostPostId;
let publishCount = 0;
let metaRequests = 0;
const containers = new Map();
const posts = new Map();
const errors = [];
const token = 'SYNTHETIC_TEST_TOKEN';
const renewedToken = 'SYNTHETIC_RENEWED_TOKEN';
const expected = { appId: '100', userId: '200', username: 'probe_test' };

async function routeOnlyMocks(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === 'https://probe.invalid') {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!files.has(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      contentType: file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/javascript',
      body: await readFile(join(root, file), 'utf8'),
    });
  }
  if (url.origin !== 'https://graph.threads.com') {
    errors.push('unexpected-network-origin');
    return route.abort();
  }
  metaRequests++;
  const params =
    request.method() === 'POST' ? new URLSearchParams(request.postData()) : url.searchParams;
  assert.ok([token, renewedToken].includes(params.get('access_token')));
  const json = (value) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': 'https://probe.invalid' },
      body: JSON.stringify(value),
    });
  if (url.pathname === '/v1.0/me')
    return json({ id: expected.userId, username: expected.username });
  if (url.pathname === '/v1.0/debug_token')
    return json({
      data: {
        type: 'USER',
        is_valid: true,
        user_id: expected.userId,
        application: 'Synthetic test app',
        issued_at: Math.floor(Date.now() / 1000) - 172800,
        expires_at: Math.floor(Date.now() / 1000) + 604800,
        scopes: ['threads_basic', 'threads_content_publish'],
      },
    });
  if (url.pathname === '/refresh_access_token')
    return json({ access_token: renewedToken, expires_in: 5184000, token_type: 'bearer' });
  if (url.pathname === `/v1.0/${expected.userId}/threads`) {
    if (params.get('reply_to_id') && rejectFirstReply) {
      rejectFirstReply = false;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': 'https://probe.invalid' },
        body: JSON.stringify({ error: { code: 200, message: 'Synthetic rejection' } }),
      });
    }
    const id = String(++sequence);
    containers.set(id, {
      status: 'FINISHED',
      text: params.get('text') || '',
      type: params.get('media_type'),
      parentId: params.get('reply_to_id'),
    });
    return json({ id });
  }
  if (url.pathname === `/v1.0/${expected.userId}/threads_publish`) {
    publishCount++;
    const container = containers.get(params.get('creation_id'));
    assert.ok(container);
    assert.equal(container.status, 'FINISHED');
    container.status = 'PUBLISHED';
    const id = String(++sequence);
    posts.set(id, {
      id,
      username: expected.username,
      owner: { id: expected.userId },
      text: container.text,
      timestamp: new Date().toISOString(),
      media_type:
        container.type === 'TEXT'
          ? 'TEXT_POST'
          : container.type === 'CAROUSEL'
            ? 'CAROUSEL_ALBUM'
            : container.type,
      is_reply: Boolean(container.parentId),
      is_reply_owned_by_me: Boolean(container.parentId),
      replied_to: container.parentId ? { id: container.parentId } : null,
      permalink: `https://www.threads.com/@${expected.username}/post/SYNTHETIC${id}`,
    });
    if (loseNextPublish) {
      loseNextPublish = false;
      lostPostId = id;
      return route.abort('failed');
    }
    return json({ id });
  }
  const id = url.pathname.split('/').at(-1);
  if (containers.has(id)) return json({ id, status: containers.get(id).status });
  if (posts.has(id)) return json(posts.get(id));
  errors.push('unexpected-meta-path');
  return route.abort();
}

async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('#clear-token').disabled);
}
async function verify(page) {
  await page.locator('#cellular').check();
  await page.locator('#app-confirmed').check();
  await page.locator('#app-id').fill(expected.appId);
  await page.locator('#username').fill(expected.username);
  await page.locator('#token').fill(token);
  await page.locator('#verify').click();
  await idle(page);
  assert.match(
    await page.locator('#account-summary').innerText(),
    /이번 세션에서 계정·토큰 확인됨/,
    `Mock requests: ${metaRequests}; UI: ${await page.locator('#toast').textContent()}`,
  );
}
async function media(page, type, url) {
  await page.locator('#add-media').click();
  const row = page.locator('.media-row').last();
  await row.locator('select').selectOption(type);
  await row.locator('input').fill(url);
}
const images = [
  'https://media.invalid/test-image.jpg?signature=synthetic',
  'https://media.invalid/test-video.mp4?signature=synthetic',
];
const caption = 'Synthetic carousel caption only';

try {
  const desktop = await browser.newContext();
  await desktop.route('**/*', routeOnlyMocks);
  const preview = await desktop.newPage();
  await preview.goto('https://probe.invalid');
  await preview.waitForSelector('#environment-detail');
  assert.equal(await preview.locator('#verify').isDisabled(), true);
  assert.equal(metaRequests, 0);
  assert.match(await preview.locator('#environment-detail').innerText(), /안드로이드/);
  await desktop.close();

  // An emulated Android browser exercises UI gates only. This is not real-device proof.
  const context = await browser.newContext({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  });
  await context.route('**/*', routeOnlyMocks);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('https://probe.invalid');
  await verify(page);
  await page.locator('#refresh').click();
  await idle(page);
  assert.match(await page.locator('#account-summary').innerText(), /갱신 응답 수신/);
  await page.locator('#caption').fill(caption);
  await media(page, 'IMAGE', images[0]);
  await media(page, 'VIDEO', images[1]);
  await page.locator('#approve-root').check();
  await page.locator('#prepare-root').click();
  await idle(page);
  await page.locator('#check-root').click();
  await idle(page);
  assert.equal(await page.locator('#root-badge').innerText(), '게시 준비 완료');
  assert.equal(await page.locator('#caption').isDisabled(), true);
  await page.locator('#clear-token').click();
  await verify(page);
  assert.equal(await page.locator('#publish-root').isDisabled(), true);
  assert.equal(await page.locator('#prepare-root').isDisabled(), false);
  await page.locator('#prepare-root').click();
  await idle(page);
  assert.equal(await page.locator('#publish-root').isDisabled(), false);
  await page.reload();
  await verify(page);
  assert.equal(await page.locator('#publish-root').isDisabled(), true);
  await page.locator('#caption').fill(caption);
  await media(page, 'IMAGE', images[0]);
  await media(page, 'VIDEO', images[1]);
  await page.locator('#approve-root').check();
  const beforeRestore = metaRequests;
  await page.locator('#prepare-root').click();
  await idle(page);
  assert.equal(
    metaRequests,
    beforeRestore,
    'restoring the same prepared draft must not create containers again',
  );
  await page.locator('#publish-root').click();
  await idle(page);
  assert.equal(await page.locator('#root-badge').innerText(), '게시 완료');
  assert.equal(publishCount, 1);
  assert.equal(await page.locator('#publish-root').isDisabled(), true);
  await page.locator('#reply-text').fill('Synthetic independent reply');
  await page.locator('#approve-reply').check();
  await page.locator('#prepare-reply').click();
  await idle(page);
  assert.match(await page.locator('#reply-badge').innerText(), /실패/);
  assert.equal(await page.locator('#prepare-reply').isDisabled(), false);
  await page.locator('#prepare-reply').click();
  await idle(page);
  await page.locator('#check-reply').click();
  await idle(page);
  await page.locator('#publish-reply').click();
  await idle(page);
  assert.equal(await page.locator('#reply-badge').innerText(), '게시 완료');
  assert.equal(publishCount, 2);
  await page.screenshot({ path: join(output, 'mobile-mock-completed.png'), fullPage: true });
  await page.locator('#new-test').click();
  await idle(page);
  await page.locator('#caption').fill('Synthetic interrupted text');
  await page.locator('#approve-root').check();
  await page.locator('#prepare-root').click();
  await idle(page);
  await page.locator('#check-root').click();
  await idle(page);
  loseNextPublish = true;
  await page.locator('#publish-root').click();
  await idle(page);
  assert.match(await page.locator('#root-badge').innerText(), /결과 불명/);
  await page.locator('#check-root').click();
  await idle(page);
  assert.match(await page.locator('#root-badge').innerText(), /결과 불명/);
  await page.reload();
  await verify(page);
  assert.equal(await page.locator('#publish-root').isDisabled(), true);
  assert.equal(await page.locator('#new-test').isDisabled(), true);
  await page.locator('#reconcile-id').fill(lostPostId);
  await page.locator('#reconcile').click();
  await idle(page);
  assert.equal(await page.locator('#root-badge').innerText(), '게시 완료');
  assert.equal(publishCount, 3, 'reconciliation must not publish again');
  const journal = await page.evaluate(() => localStorage.getItem('tmm.mobile-direct-probe.v1'));
  for (const secret of [
    token,
    renewedToken,
    caption,
    ...images,
    'Synthetic independent reply',
    'Synthetic interrupted text',
  ])
    assert.ok(!journal.includes(secret));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'mobile-mock-recovered.png'), fullPage: true });
  await context.close();
  process.stdout.write(
    'UI smoke PASS: desktop blocked, mock Android carousel + refresh + separate reply, ready reload guard, unknown text recovery, no repeated publish, nonsecret journal, mobile layout. Real Meta requests: 0.\n',
  );
} finally {
  await browser.close();
}
