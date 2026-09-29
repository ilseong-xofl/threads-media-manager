import { execFile, spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// This launches the packaged app, not the Squirrel Setup installer.
// Electron supports --remote-debugging-port; its --user-data-dir handling is in
// shell/app/electron_main_delegate.cc. Our app subsequently overrides userData,
// so isolation also requires a fresh, disposable Windows CI account below.
const runFile = promisify(execFile);
const deadline = Date.now() + 60_000;
let stage = 'ci_environment';
let child;
let exited = false;
let client;
let temporaryRoot;
let userData;
let ownsUserData = false;
let success;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

function remaining(maximum = 10_000) {
  if (interrupted || Date.now() >= deadline) throw new Error('verification_timeout');
  if (child && exited) throw new Error('app_exited');
  return Math.max(1, Math.min(maximum, deadline - Date.now()));
}

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const port = server.address().port;
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  let rendererError = false;
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('debugger_closed'));
    }
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      rejectPending();
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') rendererError = true;
    if (
      message.method === 'Log.entryAdded' &&
      /unable to load preload script|preload.*error/i.test(message.params?.entry?.text ?? '')
    )
      rendererError = true;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error('debugger_command_failed'));
    else request.resolve(message.result);
  });
  try {
    await new Promise((accept, reject) => {
      const timer = setTimeout(
        () => reject(new Error('debugger_connect_timeout')),
        remaining(5_000),
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          accept();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('debugger_connect_failed'));
        },
        { once: true },
      );
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    get rendererError() {
      return rendererError;
    },
    send(method, params = {}) {
      const requestId = ++id;
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('debugger_command_timeout'));
        }, remaining());
        pending.set(requestId, { resolve: accept, reject, timer });
        try {
          socket.send(JSON.stringify({ id: requestId, method, params }));
        } catch {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error('debugger_send_failed'));
        }
      });
    },
    close() {
      rejectPending();
      socket.close();
    },
  };
}

async function evaluate(expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error('renderer_evaluation_failed');
  return response.result?.value;
}

try {
  if (
    process.platform !== 'win32' ||
    process.env.CI !== 'true' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_OS !== 'Windows' ||
    !isAbsolute(process.env.RUNNER_TEMP ?? '') ||
    !isAbsolute(process.env.APPDATA ?? '') ||
    !isAbsolute(process.env.SystemRoot ?? '')
  )
    throw new Error('disposable_windows_ci_required');
  stage = 'package';
  const packages = (await readdir('out', { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('-win32-x64'),
  );
  if (packages.length !== 1) throw new Error('one_windows_package_required');
  const executable = resolve('out', packages[0].name, 'ThreadsMediaManager.exe');
  await access(executable);

  stage = 'fresh_user_data';
  userData = join(process.env.APPDATA, 'ThreadsMediaManager');
  try {
    await lstat(userData);
    throw new Error('existing_app_data');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Non-recursive creation also refuses races with an existing app/data folder.
  await mkdir(userData);
  ownsUserData = true;
  temporaryRoot = await mkdtemp(join(process.env.RUNNER_TEMP, 'tmm-ui-'));
  const sessionData = join(temporaryRoot, 'chromium');
  await mkdir(sessionData);
  const port = await unusedPort();
  const env = Object.fromEntries(
    [
      'SystemRoot',
      'SystemDrive',
      'ComSpec',
      'WINDIR',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  env.PATH = join(process.env.SystemRoot, 'System32');
  stage = 'launch';
  child = spawn(
    executable,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${sessionData}`,
    ],
    { cwd: temporaryRoot, env, stdio: 'ignore', windowsHide: true },
  );
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });

  stage = 'debugger';
  let target;
  while (!target) {
    remaining();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(remaining(1_000)),
      });
      if (response.ok) {
        const entries = await response.json();
        target = entries.find(
          (entry) =>
            entry.type === 'page' &&
            entry.url.startsWith('file:') &&
            new URL(entry.url).pathname.endsWith('/main_window/index.html'),
        );
      }
    } catch {
      /* The debugging listener may not be ready yet. */
    }
    if (!target) await delay(150);
  }
  const debuggerUrl = new URL(target.webSocketDebuggerUrl);
  if (
    debuggerUrl.protocol !== 'ws:' ||
    debuggerUrl.hostname !== '127.0.0.1' ||
    debuggerUrl.port !== String(port) ||
    !debuggerUrl.pathname.startsWith('/devtools/page/')
  )
    throw new Error('nonlocal_debugger');
  client = await connect(debuggerUrl.href);
  await client.send('Runtime.enable');
  await client.send('Log.enable');

  stage = 'renderer';
  let ready;
  while (!ready) {
    remaining();
    if (client.rendererError) throw new Error('renderer_error');
    ready = await evaluate(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility === 'visible' && Number(style.opacity) > 0;
      };
      const root = document.querySelector('#root');
      const heading = root?.querySelector('header h1');
      const settings = root?.querySelector('button.settings-button[aria-label="설정"]');
      return visible(root) && visible(heading) && visible(settings) &&
        heading.textContent.trim() === 'Threads Media Manager' && root.childElementCount > 0;
    })()`);
    if (!ready) await delay(150);
  }
  stage = 'preload';
  if (
    !(await evaluate(`['capabilities', 'current', 'chooseFolder', 'reportUpdateBlocked']
    .every((name) => typeof window.threadsMedia?.[name] === 'function')`))
  )
    throw new Error('missing_preload_api');

  stage = 'ipc';
  // First launch opens the native folder picker. Do not select a folder or click
  // disabled controls: independent read-only IPC remains usable while it is open.
  if (
    !(await evaluate(`(async () => {
    const capabilities = await window.threadsMedia.capabilities();
    const current = await window.threadsMedia.current();
    return capabilities?.aiContent === false && current !== null &&
      typeof current === 'object' && current.snapshot === null && current.error === null;
  })()`))
  )
    throw new Error('unexpected_ipc_state');
  if (client.rendererError) throw new Error('renderer_error');

  stage = 'screenshot';
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  const png = Buffer.from(screenshot.data, 'base64');
  if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('invalid_screenshot');
  await writeFile(resolve('out/windows-ui-smoke.png'), png);
  success = { packagedAppLaunched: true, rendererReady: true, preloadReady: true, ipcReady: true };
} catch {
  // Never emit raw CDP errors, paths, page contents, auth data or process output.
} finally {
  client?.close();
  try {
    if (child?.pid) {
      await runFile(
        join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { timeout: 10_000, windowsHide: true },
      );
    }
  } catch {
    if (!exited) {
      success = undefined;
      stage = 'process_cleanup';
    }
  }
  try {
    if (ownsUserData)
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    success = undefined;
    stage = 'data_cleanup';
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
if (success) console.log(JSON.stringify(success));
else {
  console.error(JSON.stringify({ windowsUiFailed: stage }));
  process.exitCode = 1;
}
