// Offline browser fixture used by test_collection_source.py. Only synthetic rows leave this process.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBlobVideoResolver } from '../plugins/threads-collector/scripts/blob-video-urls.mjs';

const origin = 'https://www.threads.com';
const cdn = 'https://fixture.fbcdn.net/';
const expiryHex = (Date.UTC(2026, 10, 10, 0, 30) / 1000).toString(16);
const signed = cdn + 'first.mp4?sig=a%2Fb+Z&oe=' + expiryHex + '&other=%26';
const sd = cdn + 'second.mp4?oe=invalid';
const hd = cdn + 'later.mp4?oe=' + expiryHex + '&sig=%2F+keep';
const post = 'AbC_01',
  later = 'Later_02';

function row(code, order, kind = 'video') {
  return {
    계정명: 'Example',
    게시글ID: code,
    순서: order,
    종류: kind,
    확인실행ID: 'RunA',
    관찰주소: kind === 'video' ? 'blob:' + origin + '/' + code + '-' + order : '',
    다운로드URL: kind === 'image' ? cdn + 'fixture.jpg' : '',
    주소상태: kind === 'image' ? 'http_candidate' : 'blob_unresolved',
    'URL확보시각(KST)': kind === 'image' ? '2026-11-09T12:00:00+09:00' : null,
    추출위치: kind === 'image' ? 'img.src' : 'video.currentSrc',
    만료근거: 'unknown',
  };
}

function fixture({ objects = [], enabled = true, denied = false, path = '/@example' } = {}) {
  const calls = [],
    reads = [],
    videos = [];
  const document = {
    querySelectorAll(selector) {
      if (selector === 'video') return videos;
      assert.equal(selector, 'script[type="application/json"]');
      return [{ textContent: '{"video_versions":' }, { textContent: JSON.stringify(objects) }];
    },
  };
  const location = { hostname: 'www.threads.com', protocol: 'https:', origin, pathname: path };
  const page = { document, location }; // No network, cookie, navigation or media playback APIs.
  const agent = {
    documentation: {
      get: async (name) => {
        assert.equal(name, 'capabilities/tab/cdp');
        calls.push('guide');
      },
    },
  };
  const cdp = {
    documentation: async () => calls.push('tab guide'),
    send: async (method, args) => {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(args.returnByValue, true);
      assert.deepEqual(calls.slice(0, 5), ['json', 'list', 'guide', 'get', 'tab guide']);
      calls.push('cdp');
      if (denied) throw Error('Permission denied');
      return { result: { value: vm.runInNewContext(args.expression, page) } };
    },
  };
  const tab = {
    playwright: {
      evaluate: async (fn, args) => {
        calls.push('json');
        return vm.runInNewContext('(' + fn.toString() + ')(args)', { ...page, args });
      },
    },
    capabilities: {
      list: async () => {
        calls.push('list');
        return enabled ? [{ id: 'cdp' }] : [];
      },
      get: async (name) => {
        assert.equal(name, 'cdp');
        calls.push('get');
        return cdp;
      },
    },
  };
  function video(media, data, { cardCode = media['게시글ID'], nested = false } = {}) {
    const card = {
      parentElement: { closest: () => (nested ? {} : null) },
      querySelectorAll: () => [link],
    };
    const link = {
      origin,
      pathname: '/@example/post/' + cardCode,
      closest: () => card,
      querySelector: () => ({}),
    };
    const element = { currentSrc: media['관찰주소'], closest: () => card };
    Object.defineProperty(element, '__reactFiber$fixture', {
      enumerable: true,
      get() {
        reads.push(media['관찰주소']);
        return { return: { memoizedProps: { implementations: [{ data }] } } };
      },
    });
    videos.push(element);
  }
  return { resolve: createBlobVideoResolver(tab, agent, 'Example'), video, calls, reads };
}

const objects = [
  {
    code: post,
    carousel_media: [
      { media_type: 1 },
      { video_versions: [{ url: cdn + 'range.mp4?bytestart=0' }, { url: signed }] },
      { video_versions: [{ url: 'https://notfbcdn.net/wrong.mp4' }] },
    ],
  },
];
const media = [row(post, 1, 'image'), row(post, 2), row(post, 3), row(later, 1)];
const prior = structuredClone(media);
const live = fixture({ objects });
live.video(media[1], { hdSrc: cdn + 'must-not-read.mp4' });
live.video(media[2], { hdSrc: cdn + 'partial.mp4?byteend=55', sdSrc: sd });
live.video(media[3], { hdSrc: hd });
await live.resolve(media);
assert.deepEqual(live.reads, [media[2]['관찰주소'], media[3]['관찰주소']]);
assert.deepEqual(
  media.map((r) => r['다운로드URL']),
  [prior[0]['다운로드URL'], signed, sd, hd],
);
assert.deepEqual(
  media.map((r) => r['추출위치']),
  ['img.src', 'json.video_versions', 'player.sdSrc', 'player.hdSrc'],
);
assert.deepEqual(media[0], prior[0]);
assert.equal(media[1]['만료추정시각(KST)'], '2026-11-10T09:30:00.000+09:00');
assert.equal(media[1]['만료근거'], 'oe_hex_unverified');
assert.equal(media[2]['만료추정시각(KST)'], null);
assert.equal(media[2]['만료근거'], 'unknown');
assert.equal(media[3]['만료추정시각(KST)'], media[1]['만료추정시각(KST)']);
assert.equal(media[3]['만료근거'], 'oe_hex_unverified');
await live.resolve(prior);
assert.deepEqual(prior, media);
assert.equal(live.calls.filter((c) => c === 'cdp').length, 1);
assert.equal(live.calls.filter((c) => c === 'json').length, 1);

const jsonOnly = fixture({ objects });
await jsonOnly.resolve([row(post, 2)]);
assert.deepEqual(jsonOnly.calls, ['json']);
const direct = fixture();
for (const query of ['', '?oe=abc&oe=' + expiryHex, '?oe=not-hex', '?oe=1']) {
  const r = {
    ...row('Direct', 1),
    주소상태: 'http_candidate',
    다운로드URL: cdn + 'direct.mp4' + query,
  };
  await direct.resolve([r]);
  assert.equal(r['만료근거'], 'unknown');
  assert.equal(r['만료추정시각(KST)'], null);
}
assert.deepEqual(direct.calls, []);
for (const access of [{ enabled: false }, { denied: true }]) {
  const page = fixture({ objects, ...access });
  const candidates = [row(post, 2), row(later, 1)];
  const status = await page.resolve(candidates);
  assert.equal(candidates[0]['다운로드URL'], signed);
  assert.equal(candidates[1]['주소상태'], 'blob_unresolved');
  assert.equal(status.cdpStatus, access.denied ? 'denied' : 'unavailable');
  await page.resolve([row('Another', 1)]);
  assert.equal(page.calls.filter((c) => c === 'list').length, 1);
  assert.equal(page.calls.filter((c) => c === 'cdp').length, access.denied ? 1 : 0);
}
const uncertain = fixture(),
  stale = row('Stale', 1),
  ambiguous = row('Twice', 1),
  quote = row('Quote', 1);
uncertain.video(stale, { hdSrc: hd }, { cardCode: 'Recycled' });
uncertain.video(quote, { hdSrc: hd }, { nested: true });
uncertain.video(ambiguous, { hdSrc: hd });
uncertain.video(ambiguous, { hdSrc: sd });
await uncertain.resolve([stale, ambiguous, quote]);
assert.equal(uncertain.reads.length, 0);
assert.ok(
  [stale, ambiguous, quote].every(
    (r) => r['다운로드URL'] === '' && r['주소상태'] === 'blob_unresolved',
  ),
);
const redirected = fixture({ path: '/login' });
await assert.rejects(redirected.resolve([row(post, 1)]), /프로필/);
assert.deepEqual(redirected.calls, ['json']);

process.stdout.write(JSON.stringify(media));
