import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

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
      installerCreated: true,
      installerExecuted: false,
      automaticUpdateTested: false,
    },
    null,
    2,
  ) + '\n',
);
console.log('Windows installer outputs and bundled runtime verified.');
