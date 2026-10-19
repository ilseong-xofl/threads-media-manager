import { DirectProbe } from './probe.mjs';

const $ = (id) => document.getElementById(id);
const stageNames = {
  preparing: '준비 중',
  ready: '게시 준비 완료',
  publishing: '응답 대기',
  published: '게시 완료',
  failed: '실패 · 확인 필요',
  unknown: '결과 불명 · 재게시 금지',
};
let busy = false;
let toastTimer;
let probe;
let rootInputsFrozen = false;
let replyInputFrozen = false;

function environmentProblem() {
  if (location.protocol !== 'https:')
    return '실제 호출은 HTTPS 주소에서만 실행할 수 있습니다. 지금은 화면 미리보기입니다.';
  if (!/Android/i.test(navigator.userAgent))
    return '실제 호출은 안드로이드 휴대폰에서 진행합니다. 이 환경에서는 요청을 보내지 않습니다.';
  if (!globalThis.isSecureContext || !navigator.locks || !crypto.subtle)
    return '안전한 저장·단일 탭 실행에 필요한 브라우저 기능이 없습니다. 최신 Android Chrome에서 다시 접속하세요.';
  if (!$('cellular').checked) return '휴대폰 계정과 모바일 데이터 연결을 확인해 주세요.';
  if (!$('app-confirmed').checked) return '개발자센터의 앱·테스터·토큰 연결을 확인해 주세요.';
  return '';
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').dataset.error = String(error);
  $('toast').hidden = false;
  toastTimer = setTimeout(
    () => {
      $('toast').hidden = true;
    },
    error ? 16000 : 5000,
  );
}
$('toast').addEventListener('click', () => {
  $('toast').hidden = true;
});

function mediaInputs() {
  return Array.from($('media-list').children).map((row) => ({
    type: row.querySelector('select').value,
    url: row.querySelector('input').value.trim(),
  }));
}

function renderOperation(kind, operation) {
  const badge = $(`${kind}-badge`);
  badge.textContent =
    stageNames[operation?.stage] ?? (kind === 'root' ? '준비 전' : '원글 게시 후');
  badge.dataset.state = operation?.stage ?? '';
  if (!operation) {
    $(`${kind}-summary`).textContent =
      kind === 'root'
        ? '본문과 미디어를 준비한 뒤 컨테이너를 생성하세요.'
        : '원글의 게시 ID가 확인돼야 댓글을 시작할 수 있습니다.';
    return;
  }
  const lines = [stageNames[operation.stage] ?? operation.stage];
  if (operation.containerId) lines.push(`컨테이너 ID: ${operation.containerId}`);
  if (operation.postId) lines.push(`게시 ID: ${operation.postId}`);
  if (operation.observedStatus) lines.push(`최근 컨테이너 응답: ${operation.observedStatus}`);
  if (operation.stage === 'unknown')
    lines.push('성공 여부가 확인되기 전에는 같은 요청을 다시 보내지 않습니다.');
  $(`${kind}-summary`).textContent = lines.join('\n');
  if (operation.permalink) {
    try {
      const url = new URL(operation.permalink);
      if (
        url.protocol === 'https:' &&
        ['www.threads.net', 'threads.net', 'www.threads.com', 'threads.com'].includes(
          url.hostname,
        ) &&
        !url.username &&
        !url.password
      ) {
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Threads에서 게시물 보기';
        $(`${kind}-summary`).append(document.createElement('br'), link);
      }
    } catch {
      /* Never render untrusted links. */
    }
  }
}

function render() {
  if (!probe) return;
  const state = probe.snapshot();
  rootInputsFrozen = state.root?.contentRestored === true;
  replyInputFrozen = state.reply?.contentRestored === true;
  const problem = environmentProblem();
  $('environment-detail').textContent =
    problem ||
    '직접 호출을 실행할 수 있는 브라우저 환경입니다. 실제 통신망은 휴대폰 설정에서 확인하세요.';
  $('environment-badge').textContent = problem ? '확인 필요' : '준비됨';
  $('environment-badge').dataset.state = problem ? '' : 'ready';
  document.querySelectorAll('[data-live]').forEach((button) => {
    button.disabled = busy || Boolean(problem);
  });
  const verified = state.account?.verified === true;
  const rootApproved = $('approve-root').checked;
  const replyApproved = $('approve-reply').checked;
  const disallow = (id, condition) => {
    $(id).disabled ||= condition;
  };
  disallow(
    'verify',
    !$('token').value.trim() || !$('app-id').value.trim() || !$('username').value.trim(),
  );
  disallow(
    'refresh',
    !verified || !state.hasToken || state.refreshStage === 'unknown' || state.refreshed,
  );
  disallow(
    'prepare-root',
    !verified ||
      !rootApproved ||
      !state.hasToken ||
      ['unknown', 'published', 'publishing'].includes(state.root?.stage) ||
      (state.root?.stage === 'ready' && rootInputsFrozen),
  );
  disallow('check-root', !verified || !state.hasToken || !state.root);
  disallow(
    'publish-root',
    !verified ||
      !rootApproved ||
      !rootInputsFrozen ||
      !state.hasToken ||
      state.root?.stage !== 'ready',
  );
  disallow(
    'prepare-reply',
    !verified ||
      !replyApproved ||
      !state.hasToken ||
      state.root?.stage !== 'published' ||
      ['unknown', 'publishing', 'published'].includes(state.reply?.stage) ||
      (['ready', 'preparing'].includes(state.reply?.stage) && replyInputFrozen),
  );
  disallow('check-reply', !verified || !state.hasToken || !state.reply);
  disallow(
    'publish-reply',
    !verified ||
      !replyApproved ||
      !replyInputFrozen ||
      !state.hasToken ||
      state.reply?.stage !== 'ready',
  );
  disallow('reconcile', !verified || !state.hasToken || !$('reconcile-id').value.trim());
  $('copy-token').disabled = busy || !state.refreshed || !state.hasToken;
  $('clear-token').disabled = busy;
  $('new-test').disabled =
    busy ||
    [state.root?.stage, state.reply?.stage, state.refreshStage].some((stage) =>
      ['unknown', 'publishing', 'preparing', 'requesting'].includes(stage),
    );
  $('export-report').disabled = busy;
  $('add-media').disabled = busy || mediaInputs().length >= 20 || rootInputsFrozen;
  document.querySelectorAll('input,textarea,select,.remove-media').forEach((input) => {
    input.disabled = busy;
  });
  // Prepared content is frozen. After reload, the same content can be entered for fingerprint verification.
  $('caption').disabled ||= rootInputsFrozen;
  $('reply-text').disabled ||= replyInputFrozen;
  $('media-list')
    .querySelectorAll('input,select,.remove-media')
    .forEach((input) => {
      input.disabled ||= rootInputsFrozen;
    });
  if (state.account) {
    const info = [
      `@${state.account.username} · ID ${state.account.id}`,
      `앱 ID: ${state.account.appId}`,
    ];
    info.push(
      state.account.appIdVerified
        ? '앱 ID 응답 일치 확인'
        : '앱 ID는 입력값입니다. API 응답으로 확인되지 않은 경우 개발자센터에서 확인해야 합니다.',
    );
    if (state.account.expiresAt) {
      const raw = state.account.expiresAt;
      const parsed = typeof raw === 'number' && raw < 1e12 ? raw * 1000 : raw;
      const date = new Date(parsed);
      if (!Number.isNaN(date.getTime())) info.push(`만료: ${date.toLocaleString('ko-KR')}`);
    }
    info.push(
      verified ? '이번 세션에서 계정·토큰 확인됨' : '토큰을 입력하고 이 계정을 다시 확인하세요.',
    );
    if (state.refreshStage === 'unknown')
      info.push('갱신 결과 불명: 자동 재시도하지 않습니다. 개발자센터에서 토큰 상태를 확인하세요.');
    if (state.refreshed)
      info.push('갱신 응답 수신 · 서버 저장은 아직 없음. 필요하면 토큰을 직접 복사하세요.');
    $('account-summary').textContent = info.join('\n');
  } else $('account-summary').textContent = '아직 확인한 계정이 없습니다.';
  renderOperation('root', state.root);
  renderOperation('reply', state.reply);
  $('events').replaceChildren();
  const events = (state.events ?? []).slice(-30).reverse();
  if (!events.length) {
    const li = document.createElement('li');
    li.textContent = '아직 실행한 검증이 없습니다.';
    $('events').append(li);
  }
  for (const event of events) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    const date = new Date(event.at ?? event.time ?? event.timestamp);
    time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
    li.append(
      time,
      document.createTextNode(
        [event.action ?? event.type ?? event.name, event.stage ?? event.status, event.code]
          .filter(Boolean)
          .join(' · ') || '상태 기록',
      ),
    );
    $('events').append(li);
  }
  if (state.storageError)
    $('environment-detail').textContent =
      '기기 기록 저장소를 사용할 수 없어 요청을 차단했습니다. 사이트 데이터 저장을 허용한 뒤 다시 접속하세요.';
}

async function run(action, success, live = true) {
  if (busy) return;
  if (live && environmentProblem()) {
    toast(environmentProblem(), true);
    return;
  }
  busy = true;
  render();
  try {
    if (!navigator.locks)
      throw new Error('이 브라우저에서는 안전한 단일 탭 실행을 지원하지 않습니다.');
    await navigator.locks.request(
      'tmm-mobile-direct-operation',
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error('다른 탭에서 작업 중입니다. 해당 탭에서 진행해 주세요.');
        await action();
      },
    );
    toast(success);
  } catch (error) {
    // Only our safe errors are displayed; never stringify a raw API/fetch response.
    toast(
      error?.code
        ? `${error.message} (${error.code})`
        : '요청을 완료하지 못했습니다. 환경과 검증 기록을 확인하세요.',
      true,
    );
  } finally {
    busy = false;
    render();
  }
}

let storage;
try {
  storage = localStorage;
} catch {
  storage = {
    getItem() {
      throw new Error('storage');
    },
    setItem() {
      throw new Error('storage');
    },
  };
}
probe = new DirectProbe({
  storage,
  canRequest: () => !environmentProblem(),
  onChange: () => render(),
});
const initial = probe.snapshot();
if (initial.account) {
  $('app-id').value = initial.account.appId ?? '';
  $('username').value = initial.account.username ?? '';
}

$('verify').addEventListener('click', () =>
  run(async () => {
    probe.setCredentials({
      token: $('token').value.trim(),
      appId: $('app-id').value.trim(),
      expectedUsername: $('username').value.trim().replace(/^@/, ''),
    });
    await probe.verify();
    $('token').value = '';
  }, '계정과 토큰 확인을 마쳤습니다.'),
);
$('clear-token').addEventListener('click', () => {
  probe.clearToken();
  $('token').value = '';
  rootInputsFrozen = false;
  replyInputFrozen = false;
  toast('메모리의 토큰을 지웠습니다. 게시 기록은 유지합니다.');
  render();
});
$('refresh').addEventListener('click', () =>
  run(() => probe.refresh(), '토큰 갱신 응답을 받았습니다. 필요하면 직접 복사해 보관하세요.'),
);
$('copy-token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(probe.tokenForManualCopy());
    toast('갱신된 토큰을 클립보드에 복사했습니다. 안전한 곳에 보관한 뒤 클립보드를 비워주세요.');
  } catch {
    toast('토큰을 복사하지 못했습니다. 페이지를 닫기 전에 브라우저 권한을 확인하세요.', true);
  }
});
$('prepare-root').addEventListener('click', () =>
  run(async () => {
    await probe.prepareRoot({ text: $('caption').value, media: mediaInputs() });
    rootInputsFrozen = true;
  }, '원글 컨테이너 상태를 갱신했습니다. 게시 완료 여부는 별도 확인하세요.'),
);
$('check-root').addEventListener('click', () =>
  run(() => probe.checkRoot(), '원글 처리 상태를 확인했습니다.'),
);
$('publish-root').addEventListener('click', () =>
  run(() => probe.publishRoot(), '원글 게시 요청을 마쳤습니다. 아래 결과를 확인하세요.'),
);
$('prepare-reply').addEventListener('click', () =>
  run(async () => {
    await probe.prepareReply($('reply-text').value);
    replyInputFrozen = true;
  }, '댓글 컨테이너를 준비했습니다.'),
);
$('check-reply').addEventListener('click', () =>
  run(() => probe.checkReply(), '댓글 처리 상태를 확인했습니다.'),
);
$('publish-reply').addEventListener('click', () =>
  run(() => probe.publishReply(), '댓글 게시 요청을 마쳤습니다. 아래 결과를 확인하세요.'),
);
$('reconcile').addEventListener('click', () =>
  run(
    () => probe.reconcile($('reconcile-kind').value, $('reconcile-id').value.trim()),
    '게시물 확인 결과를 반영했습니다.',
  ),
);
$('new-test').addEventListener('click', () =>
  run(
    () => {
      probe.newTest();
      rootInputsFrozen = false;
      replyInputFrozen = false;
      $('caption').value = '';
      $('reply-text').value = '';
      $('media-list').replaceChildren();
      $('approve-root').checked = false;
      $('approve-reply').checked = false;
    },
    '이전 기록을 보존하고 다음 테스트를 준비했습니다.',
    false,
  ),
);
$('export-report').addEventListener('click', () => {
  const state = probe.snapshot();
  const report = {
    schema: 'threads-mobile-direct-probe-report-v1',
    generatedAt: new Date().toISOString(),
    environment: {
      https: location.protocol === 'https:',
      androidBrowser: /Android/i.test(navigator.userAgent),
      cellularUserConfirmed: $('cellular').checked,
      appUserConfirmed: $('app-confirmed').checked,
    },
    note: '브라우저의 진단 기록입니다. 실제 물리 기기·통신망·Meta 성공을 독립적으로 입증하지 않습니다.',
    probe: state,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `threads-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('add-media').addEventListener('click', () => {
  if ($('media-list').children.length >= 20) return;
  const row = $('media-template').content.cloneNode(true);
  row.querySelector('button').addEventListener('click', (event) => {
    event.currentTarget.closest('.media-row').remove();
    render();
  });
  $('media-list').append(row);
  render();
});
document
  .querySelectorAll('input,textarea,select')
  .forEach((input) => input.addEventListener('input', () => render()));
window.addEventListener('storage', () => {
  toast('다른 탭에서 기록이 변경됐습니다. 이 페이지를 새로고침하고 계정을 다시 확인하세요.', true);
});
window.addEventListener('pagehide', () => {
  probe.clearToken({ force: true });
  $('token').value = '';
  rootInputsFrozen = false;
  replyInputFrozen = false;
});
render();
