// Runs inside the existing tab. Keep this function self-contained for both browser APIs.
function readBlobSources({ account, targets, player }) {
  if (
    location.protocol !== 'https:' ||
    !['www.threads.com', 'threads.com'].includes(location.hostname) ||
    location.pathname.replace(/\/$/, '').toLowerCase() !== '/@' + account
  )
    return null;

  const results = targets.map(() => []);
  if (!player) {
    const byCode = new Map();
    targets.forEach(({ code, order }, index) => {
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push({ order, index });
    });
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || depth > 80) return;
      const needed = byCode.get(node.code);
      if (
        needed &&
        (!node.user?.username || String(node.user.username).toLowerCase() === account)
      ) {
        let attachments = node.carousel_media;
        if (!Array.isArray(attachments)) {
          const missingCarousel = node.media_type === 8 || node.carousel_media_count > 1;
          attachments = missingCarousel ? [] : [node];
        }
        for (const { order, index } of needed) {
          // order is the position among ALL attachments, including images.
          const media = attachments[order - 1];
          if (!Array.isArray(media?.video_versions)) continue;
          for (const version of media.video_versions) {
            if (typeof version?.url === 'string')
              results[index].push({ url: version.url, source: 'json.video_versions' });
          }
        }
      }
      for (const child of Object.values(node)) visit(child, depth + 1);
    }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent || '';
      if (!text.includes('"video_versions"')) continue;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      visit(data, 0);
    }
    return results;
  }

  const container = '[data-pressable-container="true"]';
  const matches = targets.map(() => []);
  for (const video of document.querySelectorAll('video')) {
    const blob = video.currentSrc || video.src;
    if (!targets.some((target) => target.blob === blob)) continue;
    const card = video.closest(container);
    if (!card || card.parentElement?.closest(container)) continue;
    const links = Array.from(card.querySelectorAll('a[href*="/post/"]')).filter(
      (a) => a.closest(container) === card,
    );
    const timed = links.filter((a) => a.querySelector('time'));
    const codes = new Set();
    for (const link of timed.length ? timed : links) {
      const post = /^\/(?:@([^/]+)\/)?post\/([\w-]+)\/?$/.exec(link.pathname);
      if (link.origin === location.origin && post)
        codes.add(!post[1] || post[1].toLowerCase() === account ? post[2] : null);
    }
    if (codes.size !== 1) continue;
    const indices = targets.flatMap((target, index) =>
      target.blob === blob && codes.has(target.code) ? [index] : [],
    );
    if (indices.length === 1) matches[indices[0]].push({ video, card });
  }
  matches.forEach((nodes, index) => {
    if (nodes.length !== 1) return;
    const { video, card } = nodes[0];
    const key = Object.keys(video).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key && video[key];
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
      const element = fiber.stateNode;
      if (
        element === card ||
        (element?.nodeType === 1 && element.querySelectorAll('video').length > 1)
      )
        break;
      const implementations = fiber.memoizedProps?.implementations;
      if (!Array.isArray(implementations)) continue;
      for (const impl of implementations) {
        for (const field of ['hdSrc', 'sdSrc']) {
          const url = impl?.data?.[field];
          if (typeof url === 'string' && url)
            results[index].push({ url, source: 'player.' + field });
        }
      }
      if (results[index].length) break;
    }
  });
  return results;
}

function mp4Address(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('https://') ||
    value.length > 32767 ||
    /[^\x21-\x7e]|[\\#]/.test(value) ||
    !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*(?:cdninstagram\.com|fbcdn\.net)(?::443)?\/(?!\/)[^?#]*\.mp4(?:\?|$)/i.test(
      value,
    )
  )
    return null;
  const address = new URL(value);
  if (address.hostname.length > 253) return null;
  for (const name of address.searchParams.keys()) {
    if (/^byte(?:start|end)$/i.test(name)) return null;
  }
  return address;
}

function kst(milliseconds) {
  return new Date(milliseconds + 9 * 3600_000).toISOString().replace('Z', '+09:00');
}

function expiry(address) {
  const values = address.searchParams.getAll('oe');
  if (values.length === 1 && /^[\da-f]+$/i.test(values[0])) {
    const ms = Number.parseInt(values[0], 16) * 1000;
    if (ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2101, 0, 1)) {
      return { '만료추정시각(KST)': kst(ms), 만료근거: 'oe_hex_unverified' };
    }
  }
  return { '만료추정시각(KST)': null, 만료근거: 'unknown' };
}

// Create one resolver per account run. Only its status is safe to print; the signed
// URLs belong in the existing private batch.media -> journal -> commit-source flow.
export function createBlobVideoResolver(tab, agent, accountName) {
  const account = accountName.trim().replace(/^@/, '').toLowerCase();
  const observations = new Map();
  let cdp;
  let cdpStatus = 'unused';

  async function playerSources(targets) {
    if (cdpStatus === 'unavailable' || cdpStatus === 'denied') return;
    try {
      if (!cdp) {
        if (!(await tab.capabilities.list()).some((item) => item.id === 'cdp')) {
          cdpStatus = 'unavailable';
          return;
        }
        await agent.documentation.get('capabilities/tab/cdp');
        cdp = await tab.capabilities.get('cdp');
        await cdp.documentation();
      }
      const args = JSON.stringify({ account, targets, player: true });
      const reply = await cdp.send('Runtime.evaluate', {
        expression: '(' + readBlobSources.toString() + ')(' + args + ')',
        returnByValue: true,
      });
      if (reply.exceptionDetails || !reply.result || !('value' in reply.result))
        throw Error('Incomplete CDP result');
      cdpStatus = 'available';
      return reply.result.value;
    } catch (error) {
      if (
        !/denied|not (?:authorized|permitted|approved)|declined|user rejected|권한.*거부|승인.*거절/i.test(
          String(error?.message),
        )
      )
        throw error;
      cdpStatus = 'denied';
    }
  }

  return async function resolve(mediaRows) {
    const batch = [];
    for (const row of mediaRows) {
      if (
        row['종류'] !== 'video' ||
        row['계정명']?.trim().replace(/^@/, '').toLowerCase() !== account
      )
        continue;
      const direct = mp4Address(row['다운로드URL']);
      if (direct && row['주소상태'] === 'http_candidate') {
        if (!row['만료근거'] || ['unknown', 'oe_hex_unverified'].includes(row['만료근거'])) {
          Object.assign(row, expiry(direct));
        }
        continue;
      }
      const target = { code: row['게시글ID'], order: row['순서'], blob: row['관찰주소'] };
      if (
        !target.blob?.startsWith('blob:') ||
        !target.code ||
        !Number.isInteger(target.order) ||
        target.order < 1
      )
        continue;
      const key = JSON.stringify(target);
      if (observations.has(key)) Object.assign(row, observations.get(key));
      else batch.push({ row, target, key });
    }
    if (!batch.length) return { cdpStatus };

    function apply(entries, results) {
      if (!Array.isArray(results) || results.length !== entries.length)
        throw Error('프로필 또는 영상 관찰 결과가 바뀌었습니다.');
      const missing = [];
      const acquired = kst(Date.now());
      entries.forEach((entry, index) => {
        for (const { url, source } of results[index]) {
          const address = mp4Address(url);
          if (!address) continue;
          const patch = {
            다운로드URL: url,
            주소상태: 'http_candidate',
            추출위치: source,
            'URL확보시각(KST)': acquired,
            ...expiry(address),
          };
          observations.set(entry.key, patch);
          Object.assign(entry.row, patch);
          return;
        }
        missing.push(entry);
      });
      return missing;
    }

    const targets = batch.map((entry) => entry.target);
    const json = await tab.playwright.evaluate(readBlobSources, {
      account,
      targets,
      player: false,
    });
    let missing = apply(batch, json);
    if (missing.length) {
      const players = await playerSources(missing.map((entry) => entry.target));
      if (players !== undefined) missing = apply(missing, players);
      for (const { row, key } of missing) {
        const patch = {
          다운로드URL: '',
          주소상태: 'blob_unresolved',
          'URL확보시각(KST)': null,
          '만료추정시각(KST)': null,
          만료근거: 'unknown',
        };
        observations.set(key, patch);
        Object.assign(row, patch);
      }
    }
    return { cdpStatus };
  };
}
