import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConnection, managedCodexEnvironment } from './codex-connection';
import { ViewError } from './collection';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
type Child = ChildProcess & { stdout: PassThrough; stderr: PassThrough };
let home: string;
let connected = false;
let login: Child | undefined;
let pauseLogin = false;
let statusError = '';
const port = vi.fn(async () => {});
const instances: CodexConnection[] = [];

function connection(blocked = () => false): CodexConnection {
  const instance = new CodexConnection(home, () => '/bundled/codex.exe', blocked, port);
  instances.push(instance);
  return instance;
}
function close(child: Child, code: number, output = '') {
  if (output) child.stderr.write(output);
  child.emit('close', code);
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tmm-codex-test-'));
  connected = false;
  pauseLogin = false;
  login = undefined;
  statusError = '';
  port.mockReset().mockResolvedValue(undefined);
  vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => close(child, 1));
        return true;
      }),
    }) as unknown as Child;
    queueMicrotask(() => {
      if (args.at(-1) === 'status') {
        if (statusError) close(child, 1, statusError);
        else
          close(
            child,
            connected ? 0 : 1,
            connected ? 'Logged in using ChatGPT\n' : 'Not logged in\n',
          );
      } else if (args.at(-1) === 'logout') {
        connected = false;
        close(child, 0, 'Successfully logged out\n');
      } else {
        login = child;
        // Deliberately sensitive output must never reach the renderer or tests' result objects.
        child.stderr.write('https://auth.openai.com/oauth/authorize?state=private-state\n');
        if (!pauseLogin) {
          connected = true;
          close(child, 0, 'Successfully logged in\n');
        }
      }
    });
    return child;
  }) as unknown as typeof spawn);
});
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.shutdown()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('managed ChatGPT connection', () => {
  it('checks local state without opening a login browser', async () => {
    expect(await connection().state()).toEqual({ status: 'signed_out' });
    expect(login).toBeUndefined();
    expect(port).not.toHaveBeenCalled();
  });
  it('uses the same isolated encrypted credentials for login and generation', async () => {
    vi.stubEnv('CODEX_HOME', '/another-app');
    vi.stubEnv('OPENAI_API_KEY', 'do-not-forward');
    vi.stubEnv('CODEX_API_KEY', 'do-not-forward');
    vi.stubEnv('CODEX_AUTH_BASE_URL', 'https://untrusted.example');
    const manager = connection();
    expect(await manager.login()).toEqual({ status: 'ok', state: { status: 'signed_in' } });
    const execution = await manager.execution();
    expect(execution.command).toBe('/bundled/codex.exe');
    expect(execution.args).toContain('cli_auth_credentials_store="keyring"');
    expect(execution.args).toContain('forced_login_method="chatgpt"');
    expect(execution.env.CODEX_HOME).toBe(home);
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_BASE_URL'])
      expect(execution.env).not.toHaveProperty(key);
    for (const call of vi.mocked(spawn).mock.calls) {
      expect(call[2]).toMatchObject({ shell: false, windowsHide: true, env: { CODEX_HOME: home } });
      expect(call[1]).toContain('cli_auth_credentials_store="keyring"');
    }
    expect(JSON.stringify(await manager.state())).not.toContain('private-state');
  });
  it('shares duplicate clicks, exposes waiting state, and cancels only the CLI', async () => {
    pauseLogin = true;
    const manager = connection();
    const first = manager.login();
    expect(manager.login()).toBe(first);
    await vi.waitFor(() => expect(login).toBeDefined());
    expect(await manager.state()).toEqual({ status: 'signing_in' });
    expect(await manager.logout()).toMatchObject({
      status: 'error',
      problem: { code: 'chatgpt_busy' },
    });
    const result = await manager.cancelLogin();
    expect(result).toEqual({ status: 'cancelled', state: { status: 'signed_out' } });
    expect(login?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(vi.mocked(spawn).mock.calls.every(([command]) => command === '/bundled/codex.exe')).toBe(
      true,
    );
    expect(await first).toEqual(result);
    pauseLogin = false;
    expect(await manager.login()).toMatchObject({ status: 'ok', state: { status: 'signed_in' } });
  });
  it('does not revoke an existing signed-in session on a duplicate login request', async () => {
    connected = true;
    expect(await connection().login()).toEqual({ status: 'ok', state: { status: 'signed_in' } });
    expect(login).toBeUndefined();
    expect(port).not.toHaveBeenCalled();
  });
  it('requires app login before handing credentials to caption execution', async () => {
    await expect(connection().execution()).rejects.toMatchObject({ code: 'codex_login' });
    expect(login).toBeUndefined();
  });
  it('coalesces state reads and serializes login after an in-progress read', async () => {
    const manager = connection();
    const first = manager.state();
    expect(manager.state()).toBe(first);
    const signedIn = manager.login();
    expect(await first).toEqual({ status: 'signed_out' });
    expect(await signedIn).toMatchObject({ status: 'ok', state: { status: 'signed_in' } });
  });
  it('supports logout and account replacement without touching any other home', async () => {
    connected = true;
    const manager = connection();
    expect(await manager.logout()).toEqual({ status: 'ok', state: { status: 'signed_out' } });
    expect(await manager.login()).toMatchObject({ status: 'ok' });
    expect(vi.mocked(spawn).mock.calls.every((call) => call[2]?.env?.CODEX_HOME === home)).toBe(
      true,
    );
  });
  it('does not confuse credential-store failure containing a login phrase with signed out', async () => {
    statusError = 'Error checking login status: Not logged in private-token';
    const state = await connection().state();
    expect(state).toMatchObject({
      status: 'unavailable',
      problem: { code: 'chatgpt_auth_storage' },
    });
    expect(JSON.stringify(state)).not.toContain('private-token');
  });
  it('does not accept API-key authentication as a ChatGPT connection', async () => {
    vi.mocked(spawn).mockImplementation((() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as Child;
      queueMicrotask(() => close(child, 0, 'Logged in using an API key - private-key'));
      return child;
    }) as unknown as typeof spawn);
    const state = await connection().state();
    expect(state.status).toBe('unavailable');
    expect(JSON.stringify(state)).not.toContain('private-key');
  });
  it('reports missing binaries without exposing raw process errors', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('sensitive-local-path');
    });
    const state = await connection().state();
    expect(state).toMatchObject({
      status: 'unavailable',
      problem: { code: 'chatgpt_unavailable' },
    });
    expect(JSON.stringify(state)).not.toContain('sensitive-local-path');
  });
  it('does not launch login if another application owns the callback port', async () => {
    port.mockRejectedValue(new ViewError('chatgpt_login_busy', '다른 로그인을 마치세요.'));
    expect(await connection().login()).toMatchObject({
      status: 'error',
      problem: { code: 'chatgpt_login_busy' },
    });
    expect(login).toBeUndefined();
  });
  it('blocks auth changes while a caption or image request is using credentials', async () => {
    const manager = connection(() => true);
    expect(await manager.login()).toMatchObject({
      status: 'error',
      problem: { code: 'chatgpt_busy' },
    });
    expect(await manager.logout()).toMatchObject({
      status: 'error',
      problem: { code: 'chatgpt_busy' },
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('cancels before process launch and does not strand a browser wait on shutdown', async () => {
    const manager = connection();
    const operation = manager.login();
    await manager.shutdown();
    expect(await operation).toMatchObject({ status: 'cancelled' });
    expect(login).toBeUndefined();
    expect(await manager.login()).toMatchObject({ status: 'error' });
  });
  it('shuts down an active login without opening a new status process', async () => {
    pauseLogin = true;
    const manager = connection();
    const operation = manager.login();
    await vi.waitFor(() => expect(login).toBeDefined());
    const count = vi.mocked(spawn).mock.calls.length;
    await manager.shutdown();
    expect(await operation).toMatchObject({ status: 'cancelled' });
    expect(vi.mocked(spawn).mock.calls).toHaveLength(count);
  });
  it('can reopen after window close cancels a pending login', async () => {
    pauseLogin = true;
    const manager = connection();
    const first = manager.login();
    await vi.waitFor(() => expect(login).toBeDefined());
    await manager.cancelAndWait();
    expect(await first).toMatchObject({ status: 'cancelled' });
    pauseLogin = false;
    expect(await manager.login()).toMatchObject({ status: 'ok', state: { status: 'signed_in' } });
  });
  it('bounds output, redacts it, and recovers for the next attempt', async () => {
    pauseLogin = true;
    const manager = connection();
    const operation = manager.login();
    await vi.waitFor(() => expect(login).toBeDefined());
    login!.stdout.write('sensitive'.repeat(10_000));
    const result = await operation;
    expect(result).toMatchObject({ status: 'error', problem: { code: 'chatgpt_output_limit' } });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    pauseLogin = false;
    expect(await manager.login()).toMatchObject({ status: 'ok' });
  });
  it('returns a timeout and releases the login callback process', async () => {
    vi.useFakeTimers();
    pauseLogin = true;
    const manager = connection();
    const operation = manager.login();
    await vi.waitFor(() => expect(login).toBeDefined());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await operation).toMatchObject({
      status: 'error',
      problem: { code: 'chatgpt_timeout' },
    });
    expect(login?.kill).toHaveBeenCalled();
  });
  it('retains proxy/OS runtime settings while overriding only the application auth scope', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://localhost:8899');
    vi.stubEnv('HOME', '/home/example');
    expect(managedCodexEnvironment(home)).toMatchObject({
      CODEX_HOME: home,
      HOME: '/home/example',
      HTTPS_PROXY: 'http://localhost:8899',
    });
  });
});
