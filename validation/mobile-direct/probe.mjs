/** Standalone Android experiment. No server proxy, scheduler, or automatic retry. */
export const JOURNAL_KEY = 'tmm.mobile-direct-probe.v1';
const ORIGIN = 'https://graph.threads.com';
const DAY = 86_400_000;
const ID = /^\d{1,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const STAGES = new Set(['preparing', 'ready', 'publishing', 'published', 'failed', 'unknown']);
const CONTAINER_STATES = new Set(['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED']);
const MESSAGES = Object.freeze({
  input: '입력한 계정·본문·미디어 정보를 확인하세요.',
  no_token: '이 화면에 토큰을 다시 입력하세요.',
  not_verified: '입력한 토큰과 계정을 먼저 확인하세요.',
  identity_mismatch: '입력한 계정·앱과 API 응답 또는 저장된 시험 계정이 다릅니다.',
  expired: '유효한 토큰과 만료 시각을 확인하세요.',
  gate: '허용된 Android HTTPS 환경과 실행 확인 항목을 확인하세요.',
  busy: '현재 작업이 끝난 뒤 다시 시도하세요.',
  storage: '시험 기록을 안전하게 저장하지 못해 요청을 중단했습니다.',
  journal_corrupt: '저장된 시험 기록을 읽을 수 없습니다. 기존 기록을 보존했습니다.',
  stale_journal: '다른 탭에서 시험 기록이 변경되었습니다. 페이지를 새로 여세요.',
  input_changed: '저장된 시험과 입력 내용이 다릅니다. 같은 내용을 다시 입력하세요.',
  blocked: '현재 단계에서는 실행할 수 없습니다. 기존 결과를 먼저 확인하세요.',
  unknown: '요청 결과가 불명확합니다. 자동 재전송하지 않습니다.',
  auth: 'Meta 인증이 유효하지 않습니다. 토큰을 확인하세요.',
  permission: '이 요청에 필요한 Meta 권한을 확인하세요.',
  rate_limit: 'Meta 요청 제한이 발생했습니다. 자동 재시도하지 않습니다.',
  rejected: 'Meta가 요청을 거절했습니다. 입력과 권한을 확인하세요.',
  network: '응답을 확인하지 못했습니다. 변경 요청은 결과 불명으로 보존합니다.',
  timeout: '응답 시간이 초과되었습니다. 변경 요청은 재전송하지 않습니다.',
  response: 'API 응답의 필수 정보를 확인하지 못했습니다.',
  container_failed: '미디어 컨테이너가 실패하거나 만료되었습니다.',
  reconcile_mismatch: '입력한 게시 ID의 계정·본문·종류·시각·답글 연결이 일치하지 않습니다.',
  media_reconcile: '미디어 원본 일치를 API 응답만으로 입증할 수 없어 결과 불명을 유지합니다.',
  refresh_wait: '토큰 발급·갱신 시각 또는 만료 시각 때문에 지금은 갱신하지 않습니다.',
  copy_unavailable: '이 화면에서 갱신해 받은 토큰만 명시적으로 복사할 수 있습니다.',
  internal: '시험을 완료하지 못했습니다. 저장된 상태를 확인하세요.',
});
const EVENT_CODES = new Set([
  ...Object.keys(MESSAGES),
  'verified',
  'root_prepared',
  'reply_prepared',
  'status_checked',
  'intent_saved',
  'child_created',
  'container_created',
  'published',
  'refreshed',
  'reconciled',
  'new_test',
  'reload_unknown',
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const numericId = (value) => typeof value === 'string' && ID.test(value);
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
const nullableId = (value) => value === null || numericId(value);
const allowed = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const username = (value) => typeof value === 'string' && /^[A-Za-z0-9._]{1,100}$/.test(value);
const validToken = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(value);

export class ProbeError extends Error {
  constructor(code, ambiguous = false) {
    super(MESSAGES[code] ?? MESSAGES.internal);
    this.name = 'ProbeError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'internal';
    this.ambiguous = ambiguous;
  }
}
const fail = (code, ambiguous = false) => {
  throw new ProbeError(code, ambiguous);
};
const safeError = (error) => (error instanceof ProbeError ? error : new ProbeError('internal'));
async function sha(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function freshJournal() {
  return {
    version: 1,
    revision: 0,
    identity: null,
    root: null,
    reply: null,
    refresh: { stage: 'idle', at: null },
    pending: null,
    history: [],
    events: [],
  };
}
function validRecord(record) {
  if (record === null) return true;
  return (
    allowed(record, [
      'kind',
      'stage',
      'fingerprint',
      'textFingerprint',
      'mediaTypes',
      'children',
      'containerId',
      'postId',
      'parentId',
      'createdAt',
      'updatedAt',
      'publishIntentAt',
      'unknownOperation',
    ]) &&
    ['root', 'reply'].includes(record.kind) &&
    STAGES.has(record.stage) &&
    HASH.test(record.fingerprint) &&
    HASH.test(record.textFingerprint) &&
    Array.isArray(record.mediaTypes) &&
    record.mediaTypes.length <= 20 &&
    record.mediaTypes.every((type) => ['IMAGE', 'VIDEO'].includes(type)) &&
    Array.isArray(record.children) &&
    record.children.length <= 20 &&
    record.children.every(
      (child) =>
        allowed(child, ['id', 'status']) &&
        nullableId(child.id) &&
        [
          'new',
          'creating',
          'unknown',
          'IN_PROGRESS',
          'FINISHED',
          'PUBLISHED',
          'ERROR',
          'EXPIRED',
        ].includes(child.status),
    ) &&
    nullableId(record.containerId) &&
    nullableId(record.postId) &&
    nullableId(record.parentId) &&
    iso(record.createdAt) &&
    iso(record.updatedAt) &&
    (record.publishIntentAt === null || iso(record.publishIntentAt)) &&
    (record.unknownOperation === null ||
      ['child', 'container', 'publish'].includes(record.unknownOperation)) &&
    (record.stage !== 'published' || !!record.postId) &&
    (record.kind !== 'reply' || !!record.parentId)
  );
}
function validJournal(journal) {
  return (
    allowed(journal, [
      'version',
      'revision',
      'identity',
      'root',
      'reply',
      'refresh',
      'pending',
      'history',
      'events',
    ]) &&
    journal.version === 1 &&
    Number.isSafeInteger(journal.revision) &&
    journal.revision >= 0 &&
    (journal.identity === null ||
      (allowed(journal.identity, [
        'id',
        'appId',
        'usernameFingerprint',
        'expiresAt',
        'appIdVerified',
      ]) &&
        numericId(journal.identity.id) &&
        numericId(journal.identity.appId) &&
        HASH.test(journal.identity.usernameFingerprint) &&
        iso(journal.identity.expiresAt) &&
        typeof journal.identity.appIdVerified === 'boolean')) &&
    validRecord(journal.root) &&
    validRecord(journal.reply) &&
    allowed(journal.refresh, ['stage', 'at']) &&
    ['idle', 'requesting', 'refreshed', 'failed', 'unknown'].includes(journal.refresh.stage) &&
    (journal.refresh.at === null || iso(journal.refresh.at)) &&
    (journal.pending === null ||
      (allowed(journal.pending, ['kind', 'action', 'index', 'at']) &&
        ['root', 'reply', 'refresh'].includes(journal.pending.kind) &&
        ['child', 'container', 'publish', 'refresh'].includes(journal.pending.action) &&
        (journal.pending.index === null ||
          (Number.isInteger(journal.pending.index) &&
            journal.pending.index >= 0 &&
            journal.pending.index < 20)) &&
        iso(journal.pending.at))) &&
    Array.isArray(journal.history) &&
    journal.history.every(
      (entry) =>
        allowed(entry, ['root', 'reply', 'at']) &&
        validRecord(entry.root) &&
        validRecord(entry.reply) &&
        iso(entry.at),
    ) &&
    Array.isArray(journal.events) &&
    journal.events.length <= 200 &&
    journal.events.every(
      (event) =>
        allowed(event, ['at', 'code', 'kind']) &&
        iso(event.at) &&
        EVENT_CODES.has(event.code) &&
        ['account', 'root', 'reply', 'test'].includes(event.kind),
    ) &&
    (!journal.reply || (journal.root?.postId && journal.reply.parentId === journal.root.postId)) &&
    (!(journal.root || journal.reply || journal.history.length) || journal.identity !== null)
  );
}
function validMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}
function permalink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'].includes(
        url.hostname,
      ) ||
      !/^\/(?:@[A-Za-z0-9._]+\/post|t)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export class DirectProbe {
  constructor({
    fetchImpl = globalThis.fetch,
    storage,
    onChange = () => {},
    now = () => Date.now(),
    canRequest = () => false,
    timeoutMs = 30000,
  } = {}) {
    this._fetch = fetchImpl.bind(globalThis);
    this._storage = storage;
    this._onChange = onChange;
    this._now = now;
    this._canRequest = canRequest;
    this._timeoutMs = timeoutMs;
    this._token = '';
    this._account = null;
    this._expected = null;
    this._verifiedToken = '';
    this._secretGeneration = 0;
    this._issuedAt = null;
    this._refreshed = false;
    this._busy = false;
    this._inputs = { root: null, reply: null };
    this._links = { root: null, reply: null };
    this._statuses = { root: null, reply: null };
    this._storageError = null;
    this._raw = null;
    this._data = freshJournal();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('input');
    try {
      if (
        !storage ||
        typeof storage.getItem !== 'function' ||
        typeof storage.setItem !== 'function'
      )
        fail('storage');
      const raw = storage.getItem(JOURNAL_KEY);
      if (raw !== null && typeof raw !== 'string') fail('journal_corrupt');
      if (raw !== null) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          fail('journal_corrupt');
        }
        if (!validJournal(parsed)) fail('journal_corrupt');
        this._data = parsed;
      }
      this._raw = raw;
      if (this._data.pending) {
        const next = clone(this._data);
        const pending = next.pending;
        if (pending.kind === 'refresh') next.refresh.stage = 'unknown';
        else if (next[pending.kind]) {
          next[pending.kind].stage = 'unknown';
          next[pending.kind].unknownOperation = pending.action;
          if (pending.index !== null) next[pending.kind].children[pending.index].status = 'unknown';
        }
        next.pending = null;
        this._addEvent(
          next,
          'reload_unknown',
          pending.kind === 'refresh' ? 'account' : pending.kind,
        );
        // Opening another tab must never rewrite a live tab's durable intent.
        // A subsequent locked action persists this conservative recovery state.
        this._data = next;
      }
    } catch (error) {
      this._storageError = error instanceof ProbeError ? error.code : 'storage';
    }
  }

  snapshot() {
    const saved = this._data.identity;
    const account = this._account
      ? { ...this._account }
      : saved
        ? {
            id: saved.id,
            username: '',
            appId: saved.appId,
            expiresAt: saved.expiresAt,
            appIdVerified: saved.appIdVerified,
            verified: false,
          }
        : null;
    return {
      account,
      hasToken: !!this._token,
      refreshed: this._refreshed,
      refreshStage: this._data.refresh.stage,
      busy: this._busy,
      root: this._data.root
        ? {
            ...clone(this._data.root),
            permalink: this._links.root,
            contentRestored: !!this._inputs.root,
            observedStatus: this._statuses.root,
          }
        : null,
      reply: this._data.reply
        ? {
            ...clone(this._data.reply),
            permalink: this._links.reply,
            contentRestored: !!this._inputs.reply,
            observedStatus: this._statuses.reply,
          }
        : null,
      events: clone(this._data.events),
      history: clone(this._data.history),
      ...(this._storageError ? { storageError: this._storageError } : {}),
    };
  }
  _date() {
    return new Date(this._now()).toISOString();
  }
  _notify() {
    try {
      this._onChange(this.snapshot());
    } catch {
      /* UI cannot change receipt handling. */
    }
  }
  _addEvent(next, code, kind = 'test') {
    next.events.push({ at: this._date(), code, kind });
    next.events = next.events.slice(-200);
  }
  _assertCurrent() {
    if (this._storageError) fail(this._storageError);
    try {
      if (this._storage.getItem(JOURNAL_KEY) !== this._raw) fail('stale_journal');
    } catch (error) {
      this._storageError = error instanceof ProbeError ? error.code : 'storage';
      fail(this._storageError);
    }
  }
  _commit(next) {
    this._assertCurrent();
    next.revision = this._data.revision + 1;
    if (!validJournal(next)) fail('internal');
    const raw = JSON.stringify(next);
    try {
      this._storage.setItem(JOURNAL_KEY, raw);
      if (this._storage.getItem(JOURNAL_KEY) !== raw) fail('storage');
    } catch {
      this._storageError = 'storage';
      fail('storage');
    }
    this._raw = raw;
    this._data = next;
    this._notify();
  }
  async _run(action) {
    if (this._busy) fail('busy');
    this._busy = true;
    this._notify();
    try {
      this._assertCurrent();
      await action();
    } catch (error) {
      const safe = safeError(error);
      if (!this._storageError) {
        try {
          const next = clone(this._data);
          this._addEvent(next, safe.code);
          this._commit(next);
        } catch {
          /* Keep the original safe failure and durable intent. */
        }
      }
      throw safe;
    } finally {
      this._busy = false;
      this._notify();
    }
    return this.snapshot();
  }
  async _gate() {
    let permitted = false;
    try {
      permitted = await this._canRequest();
    } catch {
      /* Fail closed. */
    }
    if (permitted !== true) fail('gate');
  }
  _requireVerified() {
    if (!this._token) fail('no_token');
    if (!this._account?.verified || this._verifiedToken !== this._token) fail('not_verified');
    if (Date.parse(this._account.expiresAt) <= this._now()) fail('expired');
  }
  setCredentials({ token, appId, expectedUsername } = {}) {
    if (this._busy) fail('busy');
    this._assertCurrent();
    const normalized =
      typeof expectedUsername === 'string'
        ? expectedUsername.trim().replace(/^@/, '').toLowerCase()
        : '';
    if (!validToken(token) || !numericId(appId) || !username(normalized)) fail('input');
    if (this._data.identity && this._data.identity.appId !== appId) fail('identity_mismatch');
    this._token = token;
    this._secretGeneration++;
    this._expected = { appId, username: normalized };
    this._account = null;
    this._verifiedToken = '';
    this._issuedAt = null;
    this._refreshed = false;
    this._notify();
    return this.snapshot();
  }
  clearToken({ force = false } = {}) {
    if (this._busy && !force) fail('busy');
    this._secretGeneration++;
    this._token = '';
    this._verifiedToken = '';
    this._account = null;
    this._refreshed = false;
    this._inputs = { root: null, reply: null };
    this._notify();
    return this.snapshot();
  }
  tokenForManualCopy() {
    if (!this._refreshed || !this._token) fail('copy_unavailable');
    return this._token;
  }

  async _request(path, parameters, { mutation = false, unversioned = false } = {}) {
    await this._gate();
    this._assertCurrent();
    if (!this._token) fail('no_token');
    if (
      !/^\/(?:me|debug_token|refresh_access_token|\d{1,40}(?:\/threads(?:_publish)?)?)$/.test(path)
    )
      fail('input');
    if (unversioned !== (path === '/refresh_access_token')) fail('input');
    const form = new URLSearchParams({ ...parameters, access_token: this._token });
    const url = new URL((unversioned ? '' : '/v1.0') + path, ORIGIN);
    if (!mutation || unversioned) url.search = form.toString();
    const controller = new AbortController();
    let timer;
    const work = async () => {
      try {
        const response = await this._fetch(url.href, {
          method: mutation && !unversioned ? 'POST' : 'GET',
          mode: 'cors',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          signal: controller.signal,
          headers:
            mutation && !unversioned
              ? { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
              : { Accept: 'application/json' },
          ...(mutation && !unversioned ? { body: form.toString() } : {}),
        });
        const text = await response.text();
        let payload;
        try {
          if (text.length > 1_048_576) fail('response', mutation);
          payload = JSON.parse(text);
        } catch {
          fail('response', mutation);
        }
        if (!object(payload)) fail('response', mutation);
        if (!response.ok || object(payload.error)) {
          const code = Number(payload.error?.code);
          const transient = response.status >= 500 || payload.error?.is_transient === true;
          const reason =
            response.status === 401 || [190, 102].includes(code)
              ? 'auth'
              : response.status === 429 || [4, 17, 32, 613].includes(code)
                ? 'rate_limit'
                : response.status === 403 || [10, 200].includes(code)
                  ? 'permission'
                  : 'rejected';
          fail(reason, mutation && transient);
        }
        return payload;
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        fail('network', mutation);
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new ProbeError('timeout', mutation));
            controller.abort();
          }, this._timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async verify() {
    return this._run(async () => {
      if (!this._token || !this._expected) fail('no_token');
      const generation = this._secretGeneration;
      this._verifiedToken = '';
      this._account = null;
      const me = await this._request('/me', { fields: 'id,username' });
      const response = await this._request('/debug_token', { input_token: this._token });
      const debug = response.data;
      if (
        !numericId(me.id) ||
        !username(me.username) ||
        !object(debug) ||
        debug.is_valid !== true ||
        debug.type !== 'USER' ||
        !numericId(debug.user_id) ||
        !Number.isSafeInteger(debug.expires_at)
      )
        fail('response');
      if (debug.expires_at * 1000 <= this._now()) fail('expired');
      if (
        me.id !== debug.user_id ||
        me.username.toLowerCase() !== this._expected.username ||
        (debug.app_id !== undefined && debug.app_id !== this._expected.appId)
      )
        fail('identity_mismatch');
      const usernameFingerprint = await sha(me.username.toLowerCase());
      if (generation !== this._secretGeneration || !this._token) fail('no_token');
      const previous = this._data.identity;
      if (
        previous &&
        (previous.id !== me.id ||
          previous.appId !== this._expected.appId ||
          previous.usernameFingerprint !== usernameFingerprint)
      )
        fail('identity_mismatch');
      const expiresAt = new Date(debug.expires_at * 1000).toISOString();
      const identity = {
        id: me.id,
        appId: this._expected.appId,
        usernameFingerprint,
        expiresAt,
        appIdVerified: debug.app_id === this._expected.appId,
      };
      const next = clone(this._data);
      next.identity = identity;
      this._addEvent(next, 'verified', 'account');
      this._commit(next);
      this._issuedAt =
        Number.isSafeInteger(debug.issued_at) && debug.issued_at > 0
          ? debug.issued_at * 1000
          : null;
      this._account = {
        id: me.id,
        username: me.username,
        appId: identity.appId,
        expiresAt,
        appIdVerified: identity.appIdVerified,
        applicationReported: typeof debug.application === 'string',
        verified: true,
      };
      this._verifiedToken = this._token;
    });
  }
  async refresh() {
    return this._run(async () => {
      this._requireVerified();
      if (['requesting', 'unknown'].includes(this._data.refresh.stage)) fail('unknown');
      const now = this._now();
      if (
        this._issuedAt === null ||
        now - this._issuedAt < DAY ||
        (this._data.refresh.at && now - Date.parse(this._data.refresh.at) < DAY)
      )
        fail('refresh_wait');
      const generation = this._secretGeneration;
      await this._mutate(
        'refresh',
        'refresh',
        null,
        '/refresh_access_token',
        { grant_type: 'th_refresh_token' },
        (response, next) => {
          if (generation !== this._secretGeneration || !this._token) fail('unknown', true);
          if (
            !validToken(response.access_token) ||
            !Number.isSafeInteger(response.expires_in) ||
            response.expires_in <= 0 ||
            response.expires_in > (61 * DAY) / 1000
          )
            fail('response', true);
          const expiresAt = new Date(this._now() + response.expires_in * 1000).toISOString();
          // Keep the replacement in memory even if the nonsecret receipt cannot be saved.
          this._token = response.access_token;
          this._verifiedToken = this._token;
          this._account = { ...this._account, expiresAt };
          this._issuedAt = this._now();
          this._refreshed = true;
          next.identity.expiresAt = expiresAt;
          next.refresh = { stage: 'refreshed', at: this._date() };
        },
        true,
      );
    });
  }

  async _mutate(kind, action, index, path, parameters, accept, unversioned = false) {
    this._requireVerified();
    await this._gate();
    const next = clone(this._data);
    next.pending = { kind, action, index, at: this._date() };
    if (kind === 'refresh') next.refresh = { stage: 'requesting', at: this._date() };
    else {
      next[kind].stage = action === 'publish' ? 'publishing' : 'preparing';
      next[kind].updatedAt = this._date();
      if (action === 'publish') next[kind].publishIntentAt = this._date();
      if (index !== null) next[kind].children[index].status = 'creating';
    }
    this._addEvent(next, 'intent_saved', kind === 'refresh' ? 'account' : kind);
    this._commit(next); // The mutation cannot be sent before this durable write and read-back.
    try {
      const response = await this._request(path, parameters, { mutation: true, unversioned });
      const complete = clone(this._data);
      await accept(response, complete);
      complete.pending = null;
      this._addEvent(
        complete,
        kind === 'refresh'
          ? 'refreshed'
          : action === 'publish'
            ? 'published'
            : action === 'child'
              ? 'child_created'
              : 'container_created',
        kind === 'refresh' ? 'account' : kind,
      );
      this._commit(complete);
    } catch (error) {
      const safe = safeError(error);
      const unknown = safe.ambiguous || !!this._storageError;
      const failed = clone(this._data);
      failed.pending = null;
      if (kind === 'refresh') failed.refresh.stage = unknown ? 'unknown' : 'failed';
      else {
        failed[kind].stage = unknown ? 'unknown' : 'failed';
        failed[kind].unknownOperation = unknown ? action : null;
        failed[kind].updatedAt = this._date();
        if (index !== null && unknown) failed[kind].children[index].status = 'unknown';
      }
      if (this._storageError) this._data = failed;
      else this._commit(failed);
      throw safe;
    }
  }
  async _newRecord(kind, text, media = []) {
    const input = { text, media };
    const fingerprint = await sha(JSON.stringify(input));
    const textFingerprint = await sha(text);
    return {
      kind,
      stage: 'preparing',
      fingerprint,
      textFingerprint,
      mediaTypes: media.map((item) => item.type),
      children: media.length > 1 ? media.map(() => ({ id: null, status: 'new' })) : [],
      containerId: null,
      postId: null,
      parentId: kind === 'reply' ? this._data.root.postId : null,
      createdAt: this._date(),
      updatedAt: this._date(),
      publishIntentAt: null,
      unknownOperation: null,
    };
  }
  async _bindInput(kind, text, media) {
    const generation = this._secretGeneration;
    const record = await this._newRecord(kind, text, media);
    if (generation !== this._secretGeneration || !this._token) fail('no_token');
    const current = this._data[kind];
    if (current) {
      if (current.fingerprint !== record.fingerprint) fail('input_changed');
      if (['unknown', 'publishing', 'published'].includes(current.stage)) fail('blocked');
      if (current.stage === 'failed' && !current.containerId) {
        const next = clone(this._data);
        next[kind].stage = 'preparing';
        this._commit(next);
      }
    } else {
      const next = clone(this._data);
      next[kind] = record;
      this._addEvent(next, kind === 'root' ? 'root_prepared' : 'reply_prepared', kind);
      this._commit(next);
    }
    this._inputs[kind] = { text, media };
  }
  async prepareRoot({ text, media = [] } = {}) {
    return this._run(async () => {
      this._requireVerified();
      if (
        typeof text !== 'string' ||
        [...text].length > 500 ||
        !Array.isArray(media) ||
        media.length > 20 ||
        (!text.trim() && !media.length) ||
        media.some(
          (item) =>
            !object(item) || !['IMAGE', 'VIDEO'].includes(item.type) || !validMediaUrl(item.url),
        )
      )
        fail('input');
      const inputMedia = media.map(({ type, url }) => ({ type, url }));
      await this._bindInput('root', text, inputMedia);
      if (this._data.root.containerId) return;
      if (inputMedia.length > 1) {
        for (let index = 0; index < inputMedia.length; index++) {
          if (this._data.root.children[index].id) continue;
          const item = inputMedia[index];
          await this._create(
            'root',
            {
              media_type: item.type,
              [item.type === 'IMAGE' ? 'image_url' : 'video_url']: item.url,
              is_carousel_item: 'true',
            },
            index,
          );
        }
        await this._checkChildren();
        if (!this._data.root.children.every((child) => child.status === 'FINISHED')) return;
      }
      const fields =
        inputMedia.length > 1
          ? {
              media_type: 'CAROUSEL',
              text,
              children: this._data.root.children.map((child) => child.id).join(','),
            }
          : inputMedia.length === 1
            ? {
                media_type: inputMedia[0].type,
                text,
                [inputMedia[0].type === 'IMAGE' ? 'image_url' : 'video_url']: inputMedia[0].url,
              }
            : { media_type: 'TEXT', text };
      await this._create('root', fields);
    });
  }
  async _create(kind, parameters, index = null) {
    this._requireVerified();
    await this._mutate(
      kind,
      index === null ? 'container' : 'child',
      index,
      `/${this._account.id}/threads`,
      parameters,
      (response, next) => {
        if (!numericId(response.id)) fail('response', true);
        if (index === null) next[kind].containerId = response.id;
        else next[kind].children[index] = { id: response.id, status: 'IN_PROGRESS' };
        next[kind].stage = 'preparing';
        next[kind].updatedAt = this._date();
      },
    );
  }
  async _status(id) {
    const response = await this._request(`/${id}`, { fields: 'id,status' });
    if (response.id !== id || !CONTAINER_STATES.has(response.status)) fail('response');
    return response.status;
  }
  async _checkChildren() {
    for (let index = 0; index < this._data.root.children.length; index++) {
      const child = this._data.root.children[index];
      if (!child.id || child.status === 'FINISHED') continue;
      const status = await this._status(child.id);
      const next = clone(this._data);
      next.root.children[index].status = status;
      if (['ERROR', 'EXPIRED', 'PUBLISHED'].includes(status)) next.root.stage = 'failed';
      this._addEvent(next, 'status_checked', 'root');
      this._commit(next);
      if (next.root.stage === 'failed') fail('container_failed');
    }
  }
  async _check(kind) {
    this._requireVerified();
    const current = this._data[kind];
    if (!current) fail('blocked');
    if (current.stage === 'published') return this._retrieve(kind, current.postId, false);
    if (current.stage === 'unknown') {
      if (!current.containerId) fail('unknown');
      this._statuses[kind] = await this._status(current.containerId);
      const next = clone(this._data);
      this._addEvent(next, 'status_checked', kind);
      this._commit(next);
      return; // A readable status alone never makes an uncertain publish safe to resend.
    }
    if (!current.containerId) {
      if (kind === 'root' && current.children.length) return this._checkChildren();
      fail('blocked');
    }
    const status = await this._status(current.containerId);
    this._statuses[kind] = status;
    const next = clone(this._data);
    next[kind].stage =
      status === 'FINISHED'
        ? 'ready'
        : status === 'IN_PROGRESS'
          ? 'preparing'
          : status === 'PUBLISHED'
            ? 'unknown'
            : 'failed';
    if (status === 'PUBLISHED') next[kind].unknownOperation = 'publish';
    next[kind].updatedAt = this._date();
    this._addEvent(next, 'status_checked', kind);
    this._commit(next);
  }
  checkRoot() {
    return this._run(() => this._check('root'));
  }
  checkReply() {
    return this._run(() => this._check('reply'));
  }
  async _publish(kind) {
    this._requireVerified();
    const record = this._data[kind];
    if (!record || record.stage !== 'ready' || !record.containerId || !this._inputs[kind])
      fail('blocked');
    if (
      kind === 'reply' &&
      (this._data.root?.stage !== 'published' || record.parentId !== this._data.root.postId)
    )
      fail('blocked');
    await this._mutate(
      kind,
      'publish',
      null,
      `/${this._account.id}/threads_publish`,
      { creation_id: record.containerId },
      (response, next) => {
        if (!numericId(response.id)) fail('response', true);
        if (this._existingPostId(response.id)) fail('response', true);
        next[kind].postId = response.id;
        next[kind].stage = 'published';
        next[kind].updatedAt = this._date();
      },
    );
  }
  publishRoot() {
    return this._run(() => this._publish('root'));
  }
  publishReply() {
    return this._run(() => this._publish('reply'));
  }
  async prepareReply(text) {
    return this._run(async () => {
      this._requireVerified();
      if (this._data.root?.stage !== 'published' || !this._data.root.postId) fail('blocked');
      if (typeof text !== 'string' || !text.trim() || [...text].length > 500) fail('input');
      await this._bindInput('reply', text, []);
      if (!this._data.reply.containerId)
        await this._create('reply', {
          media_type: 'TEXT',
          text,
          reply_to_id: this._data.root.postId,
        });
    });
  }
  _existingPostId(id, exceptKind = null) {
    return (
      ['root', 'reply'].some((kind) => kind !== exceptKind && this._data[kind]?.postId === id) ||
      this._data.history.some((entry) => entry.root?.postId === id || entry.reply?.postId === id)
    );
  }
  async _retrieve(kind, postId, attaching) {
    const record = this._data[kind];
    const media = await this._request(`/${postId}`, {
      fields:
        'id,text,permalink,username,timestamp,media_type,owner,is_reply,is_reply_owned_by_me,replied_to',
    });
    const type =
      kind === 'reply' || !record.mediaTypes.length
        ? 'TEXT_POST'
        : record.mediaTypes.length > 1
          ? 'CAROUSEL_ALBUM'
          : record.mediaTypes[0];
    const publishedAt = Date.parse(media.timestamp ?? '');
    const lowerBound =
      Math.floor(Date.parse(record.publishIntentAt ?? record.createdAt) / 1000) * 1000;
    const remoteText = media.text == null ? '' : media.text;
    if (
      media.id !== postId ||
      media.username?.toLowerCase() !== this._account.username.toLowerCase() ||
      (kind === 'root'
        ? media.owner?.id !== this._account.id
        : media.is_reply_owned_by_me !== true ||
          (media.owner != null && media.owner?.id !== this._account.id)) ||
      typeof remoteText !== 'string' ||
      (await sha(remoteText)) !== record.textFingerprint ||
      media.media_type !== type ||
      !Number.isFinite(publishedAt) ||
      publishedAt < lowerBound ||
      publishedAt > this._now() + 300_000 ||
      (kind === 'reply'
        ? media.is_reply !== true || media.replied_to?.id !== record.parentId
        : media.is_reply !== false) ||
      this._existingPostId(postId, kind)
    )
      fail('reconcile_mismatch');
    if (attaching) {
      const next = clone(this._data);
      next[kind].stage = 'published';
      next[kind].postId = postId;
      next[kind].unknownOperation = null;
      next[kind].updatedAt = this._date();
      this._addEvent(next, 'reconciled', kind);
      this._commit(next);
    }
    this._links[kind] = permalink(media.permalink);
  }
  async reconcile(kind, postId) {
    return this._run(async () => {
      this._requireVerified();
      if (!['root', 'reply'].includes(kind) || !numericId(postId)) fail('input');
      const record = this._data[kind];
      if (
        record?.stage !== 'unknown' ||
        record.unknownOperation !== 'publish' ||
        !record.containerId ||
        !record.publishIntentAt
      )
        fail('blocked');
      if (record.mediaTypes.length) fail('media_reconcile');
      if ((await this._status(record.containerId)) !== 'PUBLISHED') fail('reconcile_mismatch');
      await this._retrieve(kind, postId, true);
    });
  }
  newTest() {
    if (this._busy) fail('busy');
    this._assertCurrent();
    if (
      this._data.pending ||
      ['requesting', 'unknown'].includes(this._data.refresh.stage) ||
      ['root', 'reply'].some((kind) =>
        ['unknown', 'publishing', 'preparing'].includes(this._data[kind]?.stage),
      )
    )
      fail('blocked');
    const next = clone(this._data);
    if (next.root || next.reply)
      next.history.push({ root: next.root, reply: next.reply, at: this._date() });
    next.root = null;
    next.reply = null;
    this._addEvent(next, 'new_test');
    this._commit(next);
    this._inputs = { root: null, reply: null };
    this._links = { root: null, reply: null };
    this._statuses = { root: null, reply: null };
    return this.snapshot();
  }
}
