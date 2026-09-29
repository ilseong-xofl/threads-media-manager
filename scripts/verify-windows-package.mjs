import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

assert.equal(process.platform, 'win32', 'Run this verification on Windows.');
const packages = (await readdir('out')).filter((name) => name.endsWith('-win32-x64'));
assert.equal(packages.length, 1, 'Expected one Windows app package.');
const app = resolve('out', packages[0]);
const runtime = join(app, 'resources/runtime');
for (const relative of [
  'ThreadsMediaManager.exe',
  'resources/app.asar',
  'resources/runtime/runtime-manifest.json',
  'resources/runtime/python/LICENSE.txt',
  'resources/runtime/bin/ffmpeg.LICENSE',
  'resources/runtime/bin/ffmpeg.README',
])
  await access(join(app, relative));
// Exclude the runner's Node/Python/ffmpeg from PATH while checking the shipped copies.
const env = {
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PATH: `${join(runtime, 'bin')};${join(process.env.SystemRoot, 'System32')}`,
};
const result = execFileSync(
  join(runtime, 'python/python.exe'),
  ['-I', '-X', 'utf8', '-B', resolve('scripts/check-packaged-runtime.py'), runtime],
  { env, encoding: 'utf8', timeout: 90_000, windowsHide: true },
);
console.log(result.trim());
const manifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'));
const codexRoot = join(runtime, 'codex');
const codexFiles = JSON.parse(await readFile(join(codexRoot, 'runtime-files.json'), 'utf8'));
for (const relative of manifest.codexRequiredFiles) {
  assert(
    codexFiles.some((file) => file.path === relative),
    `Missing Codex inventory entry: ${relative}`,
  );
}
// Check every shipped helper, DLL and license against the verified source package inventory.
for (const file of codexFiles) {
  assert(!isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'));
  const data = await readFile(join(codexRoot, file.path));
  assert.equal(data.length, file.size, `Codex file size: ${file.path}`);
  assert.equal(
    createHash('sha256').update(data).digest('hex'),
    file.sha256,
    `Codex checksum: ${file.path}`,
  );
  if (/\.(exe|dll)$/i.test(file.path)) assert.equal(data.subarray(0, 2).toString(), 'MZ');
}
const codexMetadata = JSON.parse(await readFile(join(codexRoot, 'codex-package.json'), 'utf8'));
assert.equal(codexMetadata.version, manifest.codexVersion);
assert.equal(codexMetadata.target, 'x86_64-pc-windows-msvc');
assert.equal(codexMetadata.entrypoint, 'bin/codex.exe');
const codexExecutable = join(codexRoot, 'bin/codex.exe');
const isolatedRoot = await mkdtemp(join(tmpdir(), 'tmm-codex-한글-'));
let codexVerification;
try {
  const codexHome = join(isolatedRoot, 'codex-home');
  const appData = join(isolatedRoot, 'AppData/Roaming');
  const localAppData = join(isolatedRoot, 'AppData/Local');
  for (const directory of [codexHome, appData, localAppData])
    await mkdir(directory, { recursive: true });
  // Never inherit the runner's Codex auth, API keys, home, config or package-manager PATH.
  const codexEnv = {
    ...env,
    CODEX_HOME: codexHome,
    USERPROFILE: isolatedRoot,
    HOME: isolatedRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  const version = execFileSync(codexExecutable, ['--version'], {
    env: codexEnv,
    cwd: isolatedRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim();
  assert.equal(version, `codex-cli ${manifest.codexVersion}`);
  const status = spawnSync(
    codexExecutable,
    ['-c', 'cli_auth_credentials_store="keyring"', 'login', 'status'],
    {
      env: codexEnv,
      cwd: isolatedRoot,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  );
  assert.ifError(status.error);
  assert.equal(status.status, 1, 'Fresh application Codex home must be signed out.');
  assert.match(`${status.stdout}\n${status.stderr}`, /not logged in/i);
  codexVerification = {
    version,
    filesChecked: codexFiles.length,
    isolatedLoginStatus: 'signed_out',
    modelRequests: 0,
  };
  console.log(JSON.stringify({ codex: codexVerification }));
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}
const output = resolve('out/make/squirrel.windows/x64');
for (const name of ['ThreadsMediaManager-win32-x64-Setup.exe', 'RELEASES'])
  await access(join(output, name));
const files = (await readdir(output)).filter(
  (name) => name !== 'SHA256SUMS.txt' && name !== 'verification.json',
);
assert.equal(files.filter((name) => name.endsWith('-full.nupkg')).length, 1);
const sums = [];
for (const name of files.sort()) {
  const hash = createHash('sha256')
    .update(await readFile(join(output, name)))
    .digest('hex');
  sums.push(`${hash}  ${name}`);
}
await writeFile(join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
await writeFile(
  join(output, 'verification.json'),
  JSON.stringify(
    {
      commit: process.env.GITHUB_SHA ?? null,
      runtime: JSON.parse(result),
      codex: codexVerification,
      installerCreated: true,
      installerExecuted: false,
      automaticUpdateTested: false,
    },
    null,
    2,
  ) + '\n',
);
console.log('Windows installer outputs and bundled runtime verified.');
