import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createConnection } from 'node:net';
import type { ChatGptResult, ChatGptState, Problem } from '../shared/contracts';
import { ViewError } from './collection';
import { bundledCodex } from './runtime';

const AUTH_ARGS = [
  '-c',
  'cli_auth_credentials_store="keyring"',
  '-c',
  'forced_login_method="chatgpt"',
];
const LOGIN_TIMEOUT = 5 * 60_000;
const COMMAND_TIMEOUT = 20_000;
const OUTPUT_LIMIT = 64 * 1024;

export interface CodexExecution {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function managedCodexCommand(): string {
  const bundled = bundledCodex();
  if (bundled && existsSync(bundled)) return bundled;
  throw issue(
    'chatgpt_unavailable',
    '앱의 AI 연결 프로그램이 누락되었습니다. 앱을 다시 설치하세요.',
  );
}

// Never inherit API keys, alternate auth servers, or another application's Codex home.
export function managedCodexEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

type Exit = { code: number | null; output: string };
type Job = { result: Promise<Exit>; cancel(): void };

function issue(code: string, message: string): ViewError {
  return new ViewError(code, message);
}

// Output contains OAuth URLs and sometimes credential details. It stays in main memory only.
function launch(execution: CodexExecution, args: string[], cwd: string, timeout: number): Job {
  let cancel = () => {};
  const result = new Promise<Exit>((resolve, reject) => {
    let child: ChildProcess;
    let finished = false;
    let failure: ViewError | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const output = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      if (failure) reject(failure);
      else resolve({ code, output });
    };
    const kill = (hard: boolean) => {
      if (finished) return;
      // OAuth opens the user's browser. Never kill the process tree: it may include that browser.
      child.kill(hard ? 'SIGKILL' : 'SIGTERM');
    };
    const stop = (error: ViewError) => {
      if (finished || failure) return;
      failure = error;
      chunks.length = 0;
      kill(false);
      killTimer = setTimeout(() => kill(true), 2000);
    };
    try {
      child = spawn(execution.command, [...execution.args, ...args], {
        cwd,
        env: execution.env,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(
        issue(
          'chatgpt_unavailable',
          'AI 연결 프로그램을 실행하지 못했습니다. 앱을 다시 설치하세요.',
        ),
      );
      return;
    }
    cancel = () => stop(issue('chatgpt_cancelled', '로그인을 취소했습니다.'));
    const collect = (chunk: Buffer) => {
      if (finished || failure) return;
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        stop(issue('chatgpt_output_limit', '로그인 응답을 확인하지 못했습니다. 다시 시도하세요.'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', () => {
      failure ??= issue(
        'chatgpt_unavailable',
        'AI 연결 프로그램을 실행하지 못했습니다. 앱을 다시 설치하세요.',
      );
      finish(null);
    });
    child.once('close', finish);
    const timer = setTimeout(
      () => stop(issue('chatgpt_timeout', '로그인 확인 시간이 지났습니다. 다시 시도하세요.')),
      timeout,
    );
  });
  return { result, cancel: () => cancel() };
}

function publicProblem(error: unknown): Problem {
  if (error instanceof ViewError) return { code: error.code, message: error.message };
  return {
    code: 'chatgpt_connection',
    message: 'ChatGPT 연결을 확인하지 못했습니다. 다시 시도하세요.',
  };
}

// Codex's fixed callback port can otherwise cancel another application's ongoing login.
export function checkLoginPort(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 1455 });
    const finish = (error?: ViewError) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once('connect', () =>
      finish(
        issue(
          'chatgpt_login_busy',
          '다른 ChatGPT 로그인이 진행 중입니다. 해당 로그인을 마친 뒤 다시 시도하세요.',
        ),
      ),
    );
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(
        error.code === 'ECONNREFUSED'
          ? undefined
          : issue(
              'chatgpt_callback',
              '로그인 연결을 준비하지 못했습니다. 잠시 후 다시 시도하세요.',
            ),
      ),
    );
    socket.setTimeout(1000, () =>
      finish(
        issue('chatgpt_callback', '로그인 연결을 준비하지 못했습니다. 잠시 후 다시 시도하세요.'),
      ),
    );
  });
}

export class CodexConnection {
  private pending: Promise<ChatGptResult> | null = null;
  private checking: Promise<ChatGptState> | null = null;
  private job: Job | null = null;
  private operation: 'login' | 'logout' | null = null;
  private cancelled = false;
  private closing = false;
  private current: ChatGptState = { status: 'signed_out' };

  constructor(
    readonly home: string,
    private command: () => string = managedCodexCommand,
    private blocked: () => boolean = () => false,
    private loginPort: () => Promise<void> = checkLoginPort,
  ) {
    if (!isAbsolute(home)) throw new Error('Codex home must be absolute.');
  }

  get active(): boolean {
    return this.pending !== null || this.checking !== null;
  }

  private async prepare(): Promise<CodexExecution> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const info = await lstat(this.home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid Codex home.');
    return {
      command: this.command(),
      args: [...AUTH_ARGS],
      env: managedCodexEnvironment(this.home),
    };
  }

  private async invoke(args: string[], timeout = COMMAND_TIMEOUT): Promise<Exit> {
    const execution = await this.prepare();
    if (this.closing || this.cancelled) throw issue('chatgpt_cancelled', '로그인을 취소했습니다.');
    const job = launch(execution, args, this.home, timeout);
    this.job = job;
    try {
      return await job.result;
    } finally {
      if (this.job === job) this.job = null;
    }
  }

  private async inspect(): Promise<ChatGptState> {
    try {
      const { code, output } = await this.invoke(['login', 'status']);
      if (
        code === 0 &&
        output.split(/\r?\n/).some((line) => line.trim() === 'Logged in using ChatGPT')
      )
        return { status: 'signed_in' };
      if (code === 1 && output.split(/\r?\n/).some((line) => line.trim() === 'Not logged in'))
        return { status: 'signed_out' };
      return {
        status: 'unavailable',
        problem: {
          code: 'chatgpt_auth_storage',
          message:
            'ChatGPT 로그인 정보를 확인하지 못했습니다. 앱을 다시 열고 연결 상태를 확인하세요.',
        },
      };
    } catch (error) {
      return { status: 'unavailable', problem: publicProblem(error) };
    }
  }

  state(): Promise<ChatGptState> {
    if (this.operation === 'login') return Promise.resolve({ status: 'signing_in' });
    if (this.pending || this.closing) return Promise.resolve(this.current);
    if (!this.checking) {
      this.cancelled = false;
      this.checking = this.inspect()
        .then((state) => (this.current = state))
        .finally(() => {
          this.checking = null;
        });
    }
    return this.checking;
  }

  private busy(): ChatGptResult {
    return {
      status: 'error',
      state: this.current,
      problem: {
        code: 'chatgpt_busy',
        message: '진행 중인 작업이 끝난 뒤 ChatGPT 연결을 변경하세요.',
      },
    };
  }

  login(): Promise<ChatGptResult> {
    if (this.operation === 'login' && this.pending) return this.pending;
    if (this.pending || this.closing || this.blocked()) return Promise.resolve(this.busy());
    return this.start('login');
  }

  logout(): Promise<ChatGptResult> {
    if (this.pending || this.closing || this.blocked()) return Promise.resolve(this.busy());
    return this.start('logout');
  }

  private start(operation: 'login' | 'logout'): Promise<ChatGptResult> {
    this.cancelled = false;
    this.operation = operation;
    this.pending = this.run(operation).finally(() => {
      this.pending = null;
      this.operation = null;
      this.cancelled = false;
    });
    return this.pending;
  }

  private async run(operation: 'login' | 'logout'): Promise<ChatGptResult> {
    try {
      if (this.checking) await this.checking;
      if (this.cancelled || this.closing)
        throw issue('chatgpt_cancelled', '로그인을 취소했습니다.');
      // login revokes previous credentials; don't invalidate an existing session accidentally.
      if (operation === 'login') {
        this.current = await this.inspect();
        if (this.cancelled || this.closing)
          throw issue('chatgpt_cancelled', '로그인을 취소했습니다.');
        if (this.current.status === 'signed_in') return { status: 'ok', state: this.current };
        if (this.current.status === 'unavailable')
          return { status: 'error', state: this.current, problem: this.current.problem! };
      }
      if (operation === 'login') await this.loginPort();
      const result = await this.invoke(
        [operation],
        operation === 'login' ? LOGIN_TIMEOUT : COMMAND_TIMEOUT,
      );
      if (result.code !== 0)
        throw issue(
          'chatgpt_login',
          operation === 'login'
            ? 'ChatGPT 로그인을 완료하지 못했습니다. 브라우저에서 로그인을 마친 뒤 다시 시도하세요.'
            : '로그아웃을 완료하지 못했습니다. 연결 상태를 다시 확인하세요.',
        );
      this.current = await this.inspect();
      if (this.cancelled || this.closing)
        throw issue('chatgpt_cancelled', '로그인을 취소했습니다.');
      const expected = operation === 'login' ? 'signed_in' : 'signed_out';
      if (this.current.status !== expected)
        throw issue('chatgpt_connection', 'ChatGPT 연결 상태를 다시 확인하세요.');
      return { status: 'ok', state: this.current };
    } catch (error) {
      const failure = publicProblem(error);
      // After cancellation, reflect any credentials saved just before the process exited.
      if (!this.closing) {
        this.cancelled = false;
        this.current = await this.inspect();
      }
      if (failure.code === 'chatgpt_cancelled') return { status: 'cancelled', state: this.current };
      return { status: 'error', state: this.current, problem: failure };
    }
  }

  async cancelLogin(): Promise<ChatGptResult> {
    if (this.operation !== 'login' || !this.pending) return { status: 'ok', state: this.current };
    this.cancelled = true;
    this.job?.cancel();
    return this.pending;
  }

  async execution(): Promise<CodexExecution> {
    if (this.pending || this.closing)
      throw issue('chatgpt_busy', 'ChatGPT 연결 작업이 끝난 뒤 캡션을 생성하세요.');
    const state = await this.state();
    if (state.status !== 'signed_in')
      throw issue(
        state.problem?.code ?? 'codex_login',
        state.problem?.message ?? '설정에서 ChatGPT에 로그인한 뒤 캡션을 생성하세요.',
      );
    return this.prepare();
  }

  async cancelAndWait(): Promise<void> {
    this.cancelled = true;
    this.job?.cancel();
    await Promise.all([this.pending, this.checking]);
    if (!this.closing) this.cancelled = false;
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.cancelAndWait();
  }
}
