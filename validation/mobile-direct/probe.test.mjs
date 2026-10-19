import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectProbe, JOURNAL_KEY, ProbeError } from './probe.mjs';

const NOW = Date.UTC(2026, 9, 18, 3, 0, 0);
const TOKEN = 'TEST_ONLY_ACCESS_TOKEN';
const REPLACEMENT = 'TEST_ONLY_REFRESHED_TOKEN';
const USER = '123456';
const APP = '789012';
const USERNAME = 'probe_account';
const TEXT = '저장하거나 진단에 노출하면 안 되는 시험 본문';
const IMAGE = 'https://media.example.invalid/photo.jpg?signature=TEST_ONLY_SIGNATURE';
const VIDEO = 'https://media.example.invalid/movie.mp4?signature=TEST_ONLY_VIDEO_SIGNATURE';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const code = (expected) => (error) => error instanceof ProbeError && error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class MemoryStorage {
  value = null;
  writes = [];
  beforeWrite = null;
  getItem(key) {
    assert.equal(key, JOURNAL_KEY);
    return this.value;
  }
  setItem(key, value) {
    assert.equal(key, JOURNAL_KEY);
    this.beforeWrite?.(JSON.parse(value));
    this.value = value;
    this.writes.push(value);
  }
  journal() {
    return this.value === null ? null : JSON.parse(this.value);
  }
}

function harness(options = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const steps = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      url: new URL(url),
      init,
      parameters: new URLSearchParams(init.body ?? new URL(url).search),
    };
    calls.push(call);
    const step = steps.shift();
    assert.ok(
      step,
      'A mock response must be declared for every request; live fetch is never used.',
    );
    if (step.path) assert.equal(call.url.pathname, step.path);
    if (step.method) assert.equal(init.method, step.method);
    if (step.inspect) await step.inspect(call);
    if (step.error) throw step.error;
    return step.response ?? json(step.body ?? {});
  };
  const probe = new DirectProbe({
    storage,
    fetchImpl,
    now: () => NOW,
    canRequest: () => true,
    ...options,
  });
  return { probe, storage, steps, calls };
}
function credentials(probe, overrides = {}) {
  probe.setCredentials({
    token: TOKEN,
    appId: APP,
    expectedUsername: `@${USERNAME}`,
    ...overrides,
  });
}
function addVerify(h, { me = {}, debug = {}, omitAppId = false } = {}) {
  h.steps.push({ path: '/v1.0/me', method: 'GET', body: { id: USER, username: USERNAME, ...me } });
  const data = {
    type: 'USER',
    user_id: USER,
    is_valid: true,
    expires_at: NOW / 1000 + 10 * 86400,
    issued_at: NOW / 1000 - 2 * 86400,
    scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies'],
    application: 'UNTRUSTED_APPLICATION_LABEL',
    ...(!omitAppId ? { app_id: APP } : {}),
    ...debug,
  };
  h.steps.push({ path: '/v1.0/debug_token', method: 'GET', body: { data } });
}
async function verified(options = {}, verification = {}) {
  const h = harness(options);
  credentials(h.probe);
  addVerify(h, verification);
  await h.probe.verify();
  return h;
}
async function readyRoot(h, { text = TEXT, media = [], containerId = '1001' } = {}) {
  h.steps.push({ path: `/v1.0/${USER}/threads`, method: 'POST', body: { id: containerId } });
  await h.probe.prepareRoot({ text, media });
  h.steps.push({
    path: `/v1.0/${containerId}`,
    method: 'GET',
    body: { id: containerId, status: 'FINISHED' },
  });
  await h.probe.checkRoot();
}
async function publishedRoot(h, options = {}) {
  await readyRoot(h, options);
  h.steps.push({ path: `/v1.0/${USER}/threads_publish`, method: 'POST', body: { id: '2001' } });
  await h.probe.publishRoot();
}
async function unknownRoot(h, options = {}) {
  await readyRoot(h, options);
  h.steps.push({
    path: `/v1.0/${USER}/threads_publish`,
    error: new Error('PRIVATE_RAW_NETWORK_DETAIL'),
  });
  await assert.rejects(h.probe.publishRoot(), code('network'));
}
function remoteRoot(overrides = {}) {
  return {
    id: '2001',
    text: TEXT,
    username: USERNAME,
    owner: { id: USER },
    is_reply: false,
    media_type: 'TEXT_POST',
    timestamp: new Date(NOW).toISOString(),
    permalink: `https://www.threads.com/@${USERNAME}/post/TestCode`,
    ...overrides,
  };
}
function addReconcile(h, body, containerId = '1001', postId = '2001') {
  h.steps.push({ path: `/v1.0/${containerId}`, body: { id: containerId, status: 'PUBLISHED' } });
  h.steps.push({ path: `/v1.0/${postId}`, body });
}

test('verification binds declared app and real user; missing app_id stays explicitly unproved', async () => {
  const h = await verified({}, { omitAppId: true });
  assert.equal(h.probe.snapshot().account.verified, true);
  assert.equal(h.probe.snapshot().account.appIdVerified, false);
  assert.equal(h.probe.snapshot().account.applicationReported, true);
  assert.equal(h.storage.journal().identity.appId, APP);
  assert.equal(h.storage.journal().identity.id, USER);
  assert.ok(!h.storage.value.includes(USERNAME));
  assert.ok(!h.storage.value.includes('UNTRUSTED_APPLICATION_LABEL'));
  assert.equal(h.probe.snapshot().busy, false);
});

test('omitting an explicit environment gate blocks all native requests', async () => {
  let requests = 0;
  const probe = new DirectProbe({
    storage: new MemoryStorage(),
    fetchImpl: () => {
      requests++;
    },
  });
  credentials(probe);
  await assert.rejects(probe.verify(), code('gate'));
  assert.equal(requests, 0);
});

test('querying an uncertain container never restores publish eligibility', async () => {
  const h = await verified();
  await unknownRoot(h);
  h.steps.push({ path: '/v1.0/1001', body: { id: '1001', status: 'FINISHED' } });
  await h.probe.checkRoot();
  assert.equal(h.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.probe.snapshot().root.observedStatus, 'FINISHED');
  await assert.rejects(h.probe.publishRoot(), code('blocked'));
  assert.throws(() => h.probe.newTest(), code('blocked'));
});

test('verification rejects mismatched app, user, and declared username', async (t) => {
  for (const verification of [
    { debug: { app_id: '999' } },
    { debug: { user_id: '999' } },
    { me: { username: 'different_account' } },
  ]) {
    await t.test(JSON.stringify(verification), async () => {
      const h = harness();
      credentials(h.probe);
      addVerify(h, verification);
      await assert.rejects(h.probe.verify(), code('identity_mismatch'));
      assert.equal(h.probe.snapshot().account, null);
      assert.equal(h.storage.journal().identity, null);
    });
  }
});

test('a saved journal refuses a switched account even when the replacement token validates', async () => {
  const h = await verified();
  credentials(h.probe, { token: 'OTHER_TEST_TOKEN', expectedUsername: 'different_account' });
  addVerify(h, { me: { id: '999', username: 'different_account' }, debug: { user_id: '999' } });
  await assert.rejects(h.probe.verify(), code('identity_mismatch'));
  assert.equal(h.storage.journal().identity.id, USER);
  assert.throws(() => credentials(h.probe, { appId: '999' }), code('identity_mismatch'));
});

test('every network request has fixed HTTPS origin, documented auth, and no custom device headers', async () => {
  const h = await verified();
  await publishedRoot(h, { media: [{ type: 'IMAGE', url: IMAGE }] });
  h.steps.push({
    path: '/refresh_access_token',
    method: 'GET',
    body: { access_token: REPLACEMENT, expires_in: 5184000 },
  });
  await h.probe.refresh();
  for (const call of h.calls) {
    assert.equal(call.url.origin, 'https://graph.threads.com');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.mode, 'cors');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.parameters.get('access_token'), TOKEN);
    assert.deepEqual(
      Object.keys(call.init.headers).sort(),
      call.init.method === 'POST' ? ['Accept', 'Content-Type'] : ['Accept'],
    );
    if (call.init.method === 'POST') {
      assert.equal(call.url.search, '');
      assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    }
  }
  assert.equal(h.calls[1].parameters.get('input_token'), TOKEN);
  assert.equal(h.calls.at(-1).parameters.get('grant_type'), 'th_refresh_token');
});

test('durable intent with fixed identity is saved before create and publish requests', async () => {
  const h = await verified();
  h.steps.push({
    body: { id: '1001' },
    inspect: () => {
      const saved = h.storage.journal();
      assert.equal(saved.pending.action, 'container');
      assert.equal(saved.pending.kind, 'root');
      assert.equal(saved.identity.id, USER);
      assert.equal(saved.identity.appId, APP);
      assert.equal(saved.root.containerId, null);
    },
  });
  await h.probe.prepareRoot({ text: TEXT });
  h.steps.push({ body: { id: '1001', status: 'FINISHED' } });
  await h.probe.checkRoot();
  h.steps.push({
    body: { id: '2001' },
    inspect: () => {
      const saved = h.storage.journal();
      assert.equal(saved.pending.action, 'publish');
      assert.equal(saved.root.stage, 'publishing');
      assert.equal(saved.root.containerId, '1001');
      assert.equal(saved.root.postId, null);
    },
  });
  await h.probe.publishRoot();
  assert.equal(h.storage.journal().pending, null);
  assert.equal(h.storage.journal().root.postId, '2001');
});

test('storage failure prevents mutation before the HTTP request', async () => {
  const h = await verified();
  h.storage.beforeWrite = (journal) => {
    if (journal.pending) throw new Error('DISK_FULL');
  };
  await assert.rejects(h.probe.prepareRoot({ text: TEXT }), code('storage'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.probe.snapshot().storageError, 'storage');
});

test('missing or corrupt storage fails closed without making a request', async () => {
  const h = harness({ storage: {} });
  assert.throws(() => credentials(h.probe), code('storage'));
  assert.equal(h.calls.length, 0);
  const storage = new MemoryStorage();
  storage.value = '{"token":"SENSITIVE_UNTRUSTED_DATA"}';
  const bad = harness({ storage });
  await assert.rejects(bad.probe.verify(), code('journal_corrupt'));
  assert.equal(storage.writes.length, 0);
  assert.equal(bad.calls.length, 0);
  assert.ok(!JSON.stringify(bad.probe.snapshot()).includes('SENSITIVE_UNTRUSTED_DATA'));
});

test('stale tabs fail before any new request even after the UI lock is acquired', async () => {
  const h = await verified();
  const stale = harness({ storage: h.storage });
  credentials(stale.probe);
  h.probe.newTest();
  addVerify(stale);
  await assert.rejects(stale.probe.verify(), code('stale_journal'));
  assert.equal(stale.calls.length, 0);
});

test('opening a second tab during a request is read-only and does not invalidate the live receipt', async () => {
  const h = await verified();
  const inFlight = deferred();
  const sent = deferred();
  h.steps.push({ response: inFlight.promise, inspect: () => sent.resolve() });
  const preparing = h.probe.prepareRoot({ text: TEXT });
  await sent.promise;
  const before = h.storage.value;
  const writes = h.storage.writes.length;
  const other = harness({ storage: h.storage });
  assert.equal(other.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.storage.value, before);
  assert.equal(h.storage.writes.length, writes);
  inFlight.resolve(json({ id: '1001' }));
  await preparing;
  assert.equal(h.probe.snapshot().root.containerId, '1001');
  assert.equal(h.probe.snapshot().storageError, undefined);
  assert.throws(() => credentials(other.probe), code('stale_journal'));
});

test('timeout is unknown; reload and repeated clicks cannot resend or clear the uncertain operation', async () => {
  const h = await verified({ timeoutMs: 15 });
  h.steps.push({ response: new Promise(() => {}) });
  await assert.rejects(h.probe.prepareRoot({ text: TEXT }), code('timeout'));
  assert.equal(h.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.probe.snapshot().root.unknownOperation, 'container');
  const next = harness({ storage: h.storage });
  credentials(next.probe);
  addVerify(next);
  await next.probe.verify();
  await assert.rejects(next.probe.prepareRoot({ text: TEXT }), code('blocked'));
  await assert.rejects(next.probe.publishRoot(), code('blocked'));
  await assert.rejects(next.probe.checkRoot(), code('unknown'));
  assert.throws(() => next.probe.newTest(), code('blocked'));
  assert.equal(next.calls.length, 2);
});

test('HTTP 5xx and malformed success responses preserve unknown instead of permitting retry', async (t) => {
  for (const response of [
    json({ error: { message: TOKEN, code: 2 } }, 503),
    new Response('RAW_PRIVATE_BODY'),
    json({ id: 'not-an-id' }),
  ]) {
    await t.test('ambiguous result', async () => {
      const h = await verified();
      h.steps.push({ response });
      await assert.rejects(
        h.probe.prepareRoot({ text: TEXT }),
        (error) => error instanceof ProbeError && !error.message.includes(TOKEN),
      );
      assert.equal(h.probe.snapshot().root.stage, 'unknown');
      await assert.rejects(h.probe.prepareRoot({ text: TEXT }), code('blocked'));
      assert.equal(h.calls.length, 3);
    });
  }
});

test('root success survives reply rejection and explicit same-input reply retry', async () => {
  const h = await verified();
  await publishedRoot(h);
  h.steps.push({
    response: json({ error: { code: 10, message: 'RAW_PRIVATE_META_MESSAGE' } }, 403),
  });
  await assert.rejects(h.probe.prepareReply('답글 시험'), code('permission'));
  assert.equal(h.probe.snapshot().root.postId, '2001');
  assert.equal(h.probe.snapshot().root.stage, 'published');
  assert.equal(h.probe.snapshot().reply.stage, 'failed');
  h.steps.push({
    body: { id: '3001' },
    inspect: (call) => {
      assert.equal(call.parameters.get('reply_to_id'), '2001');
      assert.equal(call.parameters.get('media_type'), 'TEXT');
    },
  });
  await h.probe.prepareReply('답글 시험');
  h.steps.push({ body: { id: '3001', status: 'FINISHED' } });
  await h.probe.checkReply();
  h.steps.push({ body: { id: '4001' } });
  await h.probe.publishReply();
  assert.equal(h.probe.snapshot().root.postId, '2001');
  assert.equal(h.probe.snapshot().reply.postId, '4001');
  assert.equal(h.calls.filter((call) => call.parameters.get('creation_id') === '1001').length, 1);
  h.probe.newTest();
  assert.equal(h.probe.snapshot().history[0].root.postId, '2001');
  assert.equal(h.probe.snapshot().history[0].reply.postId, '4001');
});

test('reply creation never starts before confirmed root success', async () => {
  const h = await verified();
  await assert.rejects(h.probe.prepareReply('답글'), code('blocked'));
  await unknownRoot(h);
  const before = h.calls.length;
  await assert.rejects(h.probe.prepareReply('답글'), code('blocked'));
  assert.equal(h.calls.length, before);
});

test('the journal and snapshots never contain token, body, media URL, or raw errors', async () => {
  const h = await verified();
  await publishedRoot(h, { media: [{ type: 'IMAGE', url: IMAGE }] });
  h.steps.push({ error: new Error(`PRIVATE ${TOKEN} ${TEXT} ${VIDEO}`) });
  await assert.rejects(h.probe.prepareReply('PRIVATE_REPLY_TEXT'), code('network'));
  const serialized = h.storage.writes.join('\n') + JSON.stringify(h.probe.snapshot());
  for (const secret of [
    TOKEN,
    TEXT,
    IMAGE,
    VIDEO,
    'PRIVATE_REPLY_TEXT',
    'PRIVATE',
    'UNTRUSTED_APPLICATION_LABEL',
  ]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.match(h.storage.journal().root.fingerprint, /^[a-f0-9]{64}$/);
});

test('newly loaded ready content must be restored with the exact fingerprint before publish', async () => {
  const h = await verified();
  await readyRoot(h, { media: [{ type: 'IMAGE', url: IMAGE }] });
  const next = harness({ storage: h.storage });
  credentials(next.probe);
  addVerify(next);
  await next.probe.verify();
  assert.equal(next.probe.snapshot().root.contentRestored, false);
  await assert.rejects(next.probe.publishRoot(), code('blocked'));
  await assert.rejects(
    next.probe.prepareRoot({ text: '변경한 본문', media: [{ type: 'IMAGE', url: IMAGE }] }),
    code('input_changed'),
  );
  await next.probe.prepareRoot({ text: TEXT, media: [{ type: 'IMAGE', url: IMAGE }] });
  assert.equal(next.calls.length, 2);
  assert.equal(next.probe.snapshot().root.stage, 'ready');
  assert.equal(next.probe.snapshot().root.contentRestored, true);
  next.steps.push({ body: { id: '2001' } });
  await next.probe.publishRoot();
});

test('ready reply input can also be restored without recreating the container', async () => {
  const h = await verified();
  await publishedRoot(h);
  h.steps.push({ body: { id: '3001' } });
  await h.probe.prepareReply('답글');
  h.steps.push({ body: { id: '3001', status: 'FINISHED' } });
  await h.probe.checkReply();
  const next = harness({ storage: h.storage });
  credentials(next.probe);
  addVerify(next);
  await next.probe.verify();
  await assert.rejects(next.probe.publishReply(), code('blocked'));
  await next.probe.prepareReply('답글');
  assert.equal(next.calls.length, 2);
  next.steps.push({ body: { id: '4001' } });
  await next.probe.publishReply();
  assert.equal(next.probe.snapshot().reply.parentId, '2001');
});

test('carousel continuation retains each child and never recreates a processing child', async () => {
  const h = await verified();
  const input = {
    text: TEXT,
    media: [
      { type: 'IMAGE', url: IMAGE },
      { type: 'VIDEO', url: VIDEO },
    ],
  };
  h.steps.push(
    { body: { id: '101' } },
    { body: { id: '102' } },
    { body: { id: '101', status: 'FINISHED' } },
    { body: { id: '102', status: 'IN_PROGRESS' } },
  );
  await h.probe.prepareRoot(input);
  assert.equal(h.probe.snapshot().root.stage, 'preparing');
  assert.equal(h.probe.snapshot().root.containerId, null);
  const next = harness({ storage: h.storage });
  credentials(next.probe);
  addVerify(next);
  await next.probe.verify();
  next.steps.push(
    { path: '/v1.0/102', body: { id: '102', status: 'FINISHED' } },
    {
      path: `/v1.0/${USER}/threads`,
      body: { id: '103' },
      inspect: (call) => {
        assert.equal(call.parameters.get('media_type'), 'CAROUSEL');
        assert.equal(call.parameters.get('children'), '101,102');
      },
    },
  );
  await next.probe.prepareRoot(input);
  assert.equal(next.probe.snapshot().root.containerId, '103');
  assert.equal(next.calls.filter((call) => call.init.method === 'POST').length, 1);
  const originalPosts = h.calls.filter((call) => call.init.method === 'POST');
  assert.equal(originalPosts.length, 2);
  assert.equal(originalPosts[0].parameters.get('is_carousel_item'), 'true');
  assert.equal(originalPosts[1].parameters.get('video_url'), VIDEO);
});

test('media URL validation rejects plaintext, embedded credentials, and local URLs', async () => {
  const h = await verified();
  for (const url of [
    'http://example.invalid/a.jpg',
    'file:///a.jpg',
    'https://u:p@example.invalid/a.jpg',
    'https://example.invalid/a.jpg#fragment',
  ]) {
    await assert.rejects(
      h.probe.prepareRoot({ text: TEXT, media: [{ type: 'IMAGE', url }] }),
      code('input'),
    );
  }
  assert.equal(h.calls.length, 2);
});

test('environment gate is checked before every request and denies desktop execution', async () => {
  let permitted = false;
  const h = harness({ canRequest: () => permitted });
  credentials(h.probe);
  await assert.rejects(h.probe.verify(), code('gate'));
  assert.equal(h.calls.length, 0);
  permitted = true;
  addVerify(h);
  await h.probe.verify();
  permitted = false;
  await assert.rejects(h.probe.prepareRoot({ text: TEXT }), code('gate'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.storage.journal().pending, null);
});

test('refresh is explicitly requested, journaled before GET, and replacement stays in memory only', async () => {
  const h = await verified();
  assert.throws(() => h.probe.tokenForManualCopy(), code('copy_unavailable'));
  h.steps.push({
    path: '/refresh_access_token',
    method: 'GET',
    body: { access_token: REPLACEMENT, expires_in: 5184000 },
    inspect: () => {
      assert.equal(h.storage.journal().pending.action, 'refresh');
      assert.equal(h.storage.journal().refresh.stage, 'requesting');
    },
  });
  await h.probe.refresh();
  assert.equal(h.probe.tokenForManualCopy(), REPLACEMENT);
  assert.equal(h.probe.snapshot().refreshed, true);
  assert.equal(h.probe.snapshot().refreshStage, 'refreshed');
  assert.ok(!h.storage.value.includes(REPLACEMENT));
  assert.ok(!h.storage.value.includes(TOKEN));
  assert.equal(h.probe.snapshot().account.expiresAt, new Date(NOW + 60 * 86400_000).toISOString());
  await assert.rejects(h.probe.refresh(), code('refresh_wait'));
  h.probe.clearToken();
  assert.equal(h.probe.snapshot().hasToken, false);
  assert.throws(() => h.probe.tokenForManualCopy(), code('copy_unavailable'));
});

test('uncertain refresh cannot be retried after reload or reset through newTest', async () => {
  const h = await verified();
  h.steps.push({ error: new Error('NETWORK') });
  await assert.rejects(h.probe.refresh(), code('network'));
  const next = harness({ storage: h.storage });
  credentials(next.probe);
  addVerify(next);
  await next.probe.verify();
  await assert.rejects(next.probe.refresh(), code('unknown'));
  assert.throws(() => next.probe.newTest(), code('blocked'));
  assert.equal(next.calls.length, 2);
});

test('pagehide secret clearing prevents a late refresh result from restoring the token', async () => {
  const h = await verified();
  const inFlight = deferred();
  const sent = deferred();
  h.steps.push({ response: inFlight.promise, inspect: () => sent.resolve() });
  const refreshing = h.probe.refresh();
  await sent.promise;
  assert.throws(() => h.probe.clearToken(), code('busy'));
  h.probe.clearToken({ force: true });
  inFlight.resolve(json({ access_token: REPLACEMENT, expires_in: 5184000 }));
  await assert.rejects(refreshing, code('unknown'));
  assert.equal(h.probe.snapshot().hasToken, false);
  assert.equal(h.probe.snapshot().refreshed, false);
  assert.equal(h.probe.snapshot().refreshStage, 'unknown');
  assert.throws(() => h.probe.tokenForManualCopy(), code('copy_unavailable'));
  assert.ok(!h.storage.value.includes(REPLACEMENT));
});

test('text reconciliation checks real ownership, exact text, and time after the publish intent', async () => {
  const h = await verified();
  await unknownRoot(h);
  addReconcile(h, remoteRoot({ owner: { id: '999' } }));
  await assert.rejects(h.probe.reconcile('root', '2001'), code('reconcile_mismatch'));
  addReconcile(h, remoteRoot({ text: '다른 본문' }));
  await assert.rejects(h.probe.reconcile('root', '2001'), code('reconcile_mismatch'));
  addReconcile(h, remoteRoot({ timestamp: new Date(NOW - 1000).toISOString() }));
  await assert.rejects(h.probe.reconcile('root', '2001'), code('reconcile_mismatch'));
  addReconcile(h, remoteRoot());
  await h.probe.reconcile('root', '2001');
  assert.equal(h.probe.snapshot().root.stage, 'published');
  assert.equal(h.probe.snapshot().root.postId, '2001');
  assert.match(h.probe.snapshot().root.permalink, /^https:\/\/www.threads.com\//);
  assert.ok(!h.storage.value.includes('https://'));
  assert.equal(h.calls.filter((call) => call.parameters.get('creation_id') === '1001').length, 1);
});

test('reply reconciliation requires owned-by-me and the direct parent, without requiring owner field', async () => {
  const h = await verified();
  await publishedRoot(h);
  h.steps.push({ body: { id: '3001' } });
  await h.probe.prepareReply('답글');
  h.steps.push({ body: { id: '3001', status: 'FINISHED' } });
  await h.probe.checkReply();
  h.steps.push({ error: new Error('NETWORK') });
  await assert.rejects(h.probe.publishReply(), code('network'));
  const reply = remoteRoot({
    id: '4001',
    text: '답글',
    owner: undefined,
    is_reply: true,
    is_reply_owned_by_me: true,
    replied_to: { id: '2001' },
  });
  addReconcile(h, { ...reply, replied_to: { id: '999' } }, '3001', '4001');
  await assert.rejects(h.probe.reconcile('reply', '4001'), code('reconcile_mismatch'));
  addReconcile(h, { ...reply, is_reply_owned_by_me: false }, '3001', '4001');
  await assert.rejects(h.probe.reconcile('reply', '4001'), code('reconcile_mismatch'));
  addReconcile(h, reply, '3001', '4001');
  await h.probe.reconcile('reply', '4001');
  assert.equal(h.probe.snapshot().reply.stage, 'published');
  assert.equal(h.probe.snapshot().root.postId, '2001');
});

test('media unknown remains unknown because remote metadata cannot prove the source fingerprint', async () => {
  const h = await verified();
  await unknownRoot(h, { media: [{ type: 'IMAGE', url: IMAGE }] });
  const before = h.calls.length;
  await assert.rejects(h.probe.reconcile('root', '2001'), code('media_reconcile'));
  assert.equal(h.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.calls.length, before);
});

test('a published container status never masquerades as a published post ID', async () => {
  const h = await verified();
  h.steps.push({ body: { id: '1001' } });
  await h.probe.prepareRoot({ text: TEXT });
  h.steps.push({ body: { id: '1001', status: 'PUBLISHED' } });
  await h.probe.checkRoot();
  assert.equal(h.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.probe.snapshot().root.postId, null);
  await assert.rejects(h.probe.publishRoot(), code('blocked'));
  await assert.rejects(h.probe.reconcile('root', '2001'), code('blocked'));
});

test('failure to store a successful publish leaves durable intent and reloads as unknown', async () => {
  const h = await verified();
  await readyRoot(h);
  h.storage.beforeWrite = (journal) => {
    if (journal.root?.postId === '2001') throw new Error('DISK_FULL_AFTER_RESPONSE');
  };
  h.steps.push({ body: { id: '2001' } });
  await assert.rejects(h.probe.publishRoot(), code('storage'));
  assert.equal(h.probe.snapshot().root.stage, 'unknown');
  assert.equal(h.storage.journal().pending.action, 'publish');
  const next = harness({ storage: h.storage });
  assert.equal(next.probe.snapshot().root.stage, 'unknown');
  assert.equal(next.probe.snapshot().root.unknownOperation, 'publish');
  assert.equal(h.storage.journal().pending.action, 'publish');
});

test('forced secret clearing preserves a received child ID and stops subsequent child requests', async () => {
  const h = await verified();
  const inFlight = deferred();
  const sent = deferred();
  h.steps.push({ response: inFlight.promise, inspect: () => sent.resolve() });
  const preparing = h.probe.prepareRoot({
    text: TEXT,
    media: [
      { type: 'IMAGE', url: IMAGE },
      { type: 'VIDEO', url: VIDEO },
    ],
  });
  await sent.promise;
  h.probe.clearToken({ force: true });
  inFlight.resolve(json({ id: '101' }));
  await assert.rejects(preparing, code('no_token'));
  assert.equal(h.probe.snapshot().root.children[0].id, '101');
  assert.equal(h.probe.snapshot().root.children[1].id, null);
  assert.equal(h.probe.snapshot().root.contentRestored, false);
  assert.equal(h.probe.snapshot().hasToken, false);
  assert.equal(h.calls.length, 3);
});

test('fetch receives the browser global receiver required by native Window.fetch', async () => {
  let request = 0;
  const probe = new DirectProbe({
    storage: new MemoryStorage(),
    now: () => NOW,
    canRequest: () => true,
    fetchImpl: function () {
      assert.equal(this, globalThis);
      request++;
      return Promise.resolve(
        json(
          request === 1
            ? { id: USER, username: USERNAME }
            : {
                data: {
                  type: 'USER',
                  user_id: USER,
                  is_valid: true,
                  app_id: APP,
                  expires_at: NOW / 1000 + 86400,
                  issued_at: NOW / 1000 - 2 * 86400,
                },
              },
        ),
      );
    },
  });
  credentials(probe);
  await probe.verify();
  assert.equal(request, 2);
  assert.equal(probe.snapshot().account.verified, true);
});
