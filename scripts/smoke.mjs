// Run against the development app started with --remote-debugging-port=9337.
// Uses loopback CDP to verify the gallery, carousel, modal, and local playback.
// This never starts a download or changes collection data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.env.TMM_DEBUG_PORT || 9337);
const output = process.env.TMM_SMOKE_OUTPUT;
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(
  (t) => t.type === 'page' && t.url === 'http://localhost:3120/main_window/index.html',
);
assert.ok(tab, 'Threads Media Manager development page is required');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
let seq = 0;
const pending = new Map();
const remoteRequests = [];
const exceptions = [];
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.id) {
    const callback = pending.get(data.id);
    pending.delete(data.id);
    callback?.(data);
  }
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.text);
  if (data.method === 'Network.requestWillBeSent') {
    const url = new URL(data.params.request.url);
    if (
      ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    )
      remoteRequests.push(url.hostname);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, (data) => {
      clearTimeout(timeout);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.ok(!result.exceptionDetails, 'Renderer evaluation failed');
  return result.result.value;
}
async function until(expression) {
  for (let count = 0; count < 60; count++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('App did not reach the expected UI state');
}
async function screenshot(name) {
  if (!output) return;
  await mkdir(output, { recursive: true });
  const capture = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, `${name}.png`), Buffer.from(capture.data, 'base64'));
}
async function click(selector) {
  await evaluate(
    `(()=>{
      const el=document.querySelector(${JSON.stringify(selector)});
      if (!el?.matches('.refresh-button, .search-clear, .carousel-next, .carousel-prev, .carousel-dots button, .media-open, .post-card-copy, .modal-close'))
        throw new Error('Smoke clicks are restricted to read-only gallery controls');
      el.focus();el.click();
    })()`,
  );
}
async function key(name) {
  const windowsVirtualKeyCode = { Escape: 27, Tab: 9, ArrowLeft: 37, ArrowRight: 39 }[name];
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: name,
    code: name,
    windowsVirtualKeyCode,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: name,
    code: name,
    windowsVirtualKeyCode,
  });
}
async function closeModal() {
  await key('Escape');
  await until('!document.querySelector("dialog[open]")');
}
try {
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.enable');
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', onLoad);
      reject(new Error('Page load timed out'));
    }, 15000);
    function onLoad(event) {
      if (JSON.parse(event.data).method === 'Page.loadEventFired') {
        clearTimeout(timeout);
        ws.removeEventListener('message', onLoad);
        resolve();
      }
    }
    ws.addEventListener('message', onLoad);
  });
  await send('Page.reload', { ignoreCache: true });
  await loaded;
  await until(
    '!!window.threadsMedia && !!document.querySelector(".library-heading") && !document.querySelector(".refresh-button").disabled',
  );
  const summary = await evaluate(`(async () => {
    const v = await window.threadsMedia.current();
    const posts = v.snapshot?.posts ?? [];
    const completedPosts = posts.filter(p => p.attachments.length > 0 && p.attachments.every(a => a.status === 'saved' && !!a.localUrl && !!a.mediaId)).length;
    return { error: v.error, posts: posts.length, completedPosts, pendingPosts: posts.length - completedPosts, attachments: posts.reduce((n,p)=>n+p.attachments.length,0), saved: posts.reduce((n,p)=>n+p.attachments.filter(a=>a.status==='saved').length,0), state: v.snapshot?.stateStatus, sourceCount: v.snapshot?.sourceCount, node: typeof require, process: typeof process, preload: Object.keys(window.threadsMedia), visible: document.querySelectorAll('.post-card').length };
  })()`);
  assert.equal(summary.error, null);
  assert.equal(summary.node, 'undefined');
  assert.equal(summary.process, 'undefined');
  assert.deepEqual(
    summary.preload.sort(),
    [
      'chooseFolder',
      'current',
      'downloadStatus',
      'exportPost',
      'prepareDownload',
      'recoverDownloads',
      'refresh',
      'saveMediaEdit',
      'deleteMedia',
      'recoverDeletions',
      'savePostComment',
      'openPostLink',
      'startDownload',
      'stopDownload',
    ].sort(),
  );
  assert.equal(summary.visible, summary.completedPosts);
  assert.equal(await evaluate('!!document.querySelector("dialog[open]")'), false);
  if (summary.completedPosts > 0)
    assert.equal(
      await evaluate('getComputedStyle(document.querySelector(".post-grid")).display'),
      'grid',
    );
  const downloadButton = await evaluate(`(() => {
    const button = document.querySelector('.download-button');
    return button && { text: button.textContent.trim(), disabled: button.disabled };
  })()`);
  assert.ok(downloadButton, 'Collection download button is required');
  assert.equal(
    downloadButton.text,
    summary.pendingPosts > 0 ? `다운로드 (${summary.pendingPosts})` : '다운로드',
  );
  assert.equal(downloadButton.disabled, summary.pendingPosts === 0);
  const before = await evaluate(
    '(async()=>JSON.stringify((await window.threadsMedia.current()).snapshot.posts))()',
  );
  await click('.refresh-button');
  await until('!document.querySelector(".refresh-button").disabled');
  const after = await evaluate(
    '(async()=>JSON.stringify((await window.threadsMedia.current()).snapshot.posts))()',
  );
  assert.equal(before, after, 'Refresh must not duplicate or mutate posts');
  // The header button now starts a real batch. Inspect its state above only;
  // never click it, a ZIP export, recovery, or any download API in this smoke.
  await evaluate(
    `(()=>{const el=document.querySelector('input[aria-label="게시글 검색"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'__tmm_no_matching_post__'); el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await until('document.querySelectorAll(".post-card").length === 0');
  await click('.search-clear');
  await until(`document.querySelectorAll('.post-card').length === ${summary.completedPosts}`);
  await until(
    '[...document.querySelectorAll(".post-card img")].filter(i=>i.getBoundingClientRect().top < innerHeight).every(i=>i.complete && i.naturalWidth>0)',
  );
  await screenshot('grid');
  const fixture = await evaluate(
    `(async()=>{
      const posts=(await window.threadsMedia.current()).snapshot.posts.filter(p=>p.attachments.length>0&&p.attachments.every(a=>a.status==='saved'&&!!a.localUrl&&!!a.mediaId));
      return posts.map(p=>{
        const media=[...p.attachments,...(p.edits??[])];
        return {count:media.length,kinds:media.map(a=>a.kind),saved:media.map(a=>a.status==='saved'&&!!a.localUrl&&!!a.mediaId),editTypes:media.map(a=>a.editType??null),originalKinds:p.attachments.map(a=>a.kind)};
      });
    })()`,
  );
  assert.equal(fixture.length, summary.completedPosts);
  const mediaType = (post) =>
    post.originalKinds.includes('video')
      ? post.originalKinds.includes('image')
        ? '영상 & 이미지'
        : '영상'
      : '이미지';
  const multi = fixture.findIndex((p) => p.count > 1);
  let carouselChecked = false;
  if (multi >= 0) {
    const card = `.post-card:nth-child(${multi + 1})`;
    await evaluate(
      `document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'center'})`,
    );
    const label = mediaType(fixture[multi]);
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(card + ' .media-type')}).textContent.trim()`,
      ),
      label,
    );
    await click(`${card} .carousel-next`);
    await until(
      `document.querySelector(${JSON.stringify(card + ' .media-counter')}).textContent === '2 / ${fixture[multi].count}'`,
    );
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(card + ' .media-type')}).textContent.trim()`,
      ),
      label,
      'The post media type must remain fixed when the card carousel moves',
    );
    assert.equal(
      await evaluate('!!document.querySelector("dialog[open]")'),
      false,
      'Carousel arrows must not open the modal',
    );
    await click(`${card} .media-open`);
    await until('!!document.querySelector("dialog[open]")');
    assert.equal(
      await evaluate('document.querySelector("dialog .media-counter").textContent'),
      `2 / ${fixture[multi].count}`,
    );
    assert.equal(await evaluate('document.activeElement.classList.contains("modal-close")'), true);
    await click('dialog .carousel-prev');
    await until(
      `document.querySelector('dialog .media-counter').textContent === '1 / ${fixture[multi].count}'`,
    );
    await click('dialog .carousel-prev');
    await until(
      `document.querySelector('dialog .media-counter').textContent === '${fixture[multi].count} / ${fixture[multi].count}'`,
    );
    await key('ArrowRight');
    await until(
      `document.querySelector('dialog .media-counter').textContent === '1 / ${fixture[multi].count}'`,
    );
    await screenshot('detail');
    await evaluate(`document.querySelector('dialog .collection-details summary').focus()`);
    await key('Tab');
    assert.equal(
      await evaluate('document.querySelector("dialog").contains(document.activeElement)'),
      true,
      'Focus must stay in the modal',
    );
    await closeModal();
    assert.equal(
      await evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(card + ' .media-open')})`,
      ),
      true,
      'Closing restores the card focus',
    );
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(card + ' .media-counter')}).textContent`,
      ),
      `1 / ${fixture[multi].count}`,
    );
    await click(`${card} .post-card-copy`);
    await until('!!document.querySelector("dialog[open]")');
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 5,
      y: 5,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 5,
      y: 5,
      button: 'left',
      clickCount: 1,
    });
    await until('!document.querySelector("dialog[open]")');
    carouselChecked = true;
  }
  let verifiedImages = 0;
  let playedVideos = 0;
  let verifiedEdits = 0;
  for (let i = 0; i < fixture.length; i++) {
    await click(`.post-card:nth-child(${i + 1}) .media-open`);
    await until('!!document.querySelector("dialog[open]")');
    const post = fixture[i];
    if (post.count <= 1)
      assert.equal(
        await evaluate(
          'document.querySelectorAll("dialog .carousel-arrow, dialog .carousel-dots").length',
        ),
        0,
      );
    for (let j = 0; j < post.count; j++) {
      if (post.count > 1) {
        await click(`dialog .carousel-dots button:nth-child(${j + 1})`);
        await until(
          `document.querySelector('dialog .media-counter').textContent === '${j + 1} / ${post.count}'`,
        );
      }
      assert.equal(
        await evaluate('document.querySelector("dialog .media-type").textContent.trim()'),
        mediaType(post),
        'The post media type must remain fixed on every detail attachment',
      );
      const editType = post.editTypes[j];
      assert.equal(
        await evaluate('!!document.querySelector("dialog .media-edit-badge")'),
        !!editType,
      );
      assert.equal(
        await evaluate('document.querySelector("dialog .attachment-status h3").textContent'),
        `${j + 1}번째 ${post.kinds[j] === 'image' ? '이미지' : '영상'}${editType ? ` · 편집본 (${editType === 'crop' ? '크롭' : '영상 캡처'})` : ''}`,
      );
      if (!post.saved[j]) continue;
      if (post.kinds[j] === 'image') {
        await until(
          '(()=>{const img=document.querySelector("dialog img");return img?.complete && img.naturalWidth>0;})()',
        );
        verifiedImages++;
      } else {
        await until('document.querySelector("dialog video")?.readyState >= 2');
        assert.equal(
          await evaluate('document.querySelector("dialog video").paused'),
          true,
          'Never autoplay',
        );
        await evaluate(
          '(async()=>{const v=document.querySelector("dialog video");v.muted=true;await v.play();})()',
        );
        await until('document.querySelector("dialog video").currentTime > 0');
        await evaluate('document.querySelector("dialog video").pause()');
        await screenshot('video');
        playedVideos++;
      }
      if (editType) verifiedEdits++;
    }
    await click('dialog .modal-close');
    await until('!document.querySelector("dialog[open]")');
    assert.equal(
      await evaluate('[...document.querySelectorAll("video")].every(v=>v.paused)'),
      true,
    );
  }
  const sizes = [];
  for (const width of [940, 1320]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await evaluate(
      '(()=>{const grid=document.querySelector(".post-grid");return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,columns:grid?getComputedStyle(grid).gridTemplateColumns.split(" ").length:0};})()',
    );
    assert.ok(layout.scrollWidth <= layout.width);
    if (summary.completedPosts > 0) assert.ok(layout.columns >= 3);
    sizes.push(layout);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate('window.scrollTo(0,0)');
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(exceptions, []);
  const report = {
    ...summary,
    verifiedImages,
    playedVideos,
    verifiedEdits,
    carouselChecked,
    mixedMediaPostsChecked: fixture.filter(
      (post) => post.originalKinds.includes('image') && post.originalKinds.includes('video'),
    ).length,
    downloadButton,
    modalFocusAndEscape: carouselChecked,
    backdropClose: carouselChecked,
    noAutoplay: true,
    refreshStable: true,
    sizes,
    remoteRequests: remoteRequests.length,
    exceptions,
    downloadsStarted: 0,
  };
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'smoke.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  ws.close();
}
