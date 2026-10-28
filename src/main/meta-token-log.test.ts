import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MetaTokenLog, type MetaTokenLogEntry } from './meta-token-log';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function file() {
  const directory = await mkdtemp(join(tmpdir(), 'meta-token-log-'));
  directories.push(directory);
  return join(directory, 'nested', 'meta-token-checks.log');
}
const entry = (fields: Partial<MetaTokenLogEntry> = {}): MetaTokenLogEntry => ({
  at: '2026-10-28T00:00:00.000Z',
  ownerId: 'owner',
  operation: 'register',
  localId: 'row',
  accountId: null,
  appName: '앱',
  label: '계정',
  result: 'invalid_token',
  expiresAt: null,
  detail: null,
  httpStatus: 400,
  metaCode: 190,
  metaSubcode: 463,
  metaType: 'OAuthException',
  metaMessage: 'Session has expired',
  fbtraceId: 'trace',
  networkCode: null,
  ...fields,
});

it('returns the newest check per row of one employee and writes known fields only', async () => {
  const path = await file();
  const log = new MetaTokenLog(path);
  expect(await log.latest('owner')).toEqual(new Map());
  await log.append(entry({ localId: 'a' }));
  await log.append(entry({ localId: 'a', result: 'success', httpStatus: null }));
  await log.append(entry({ localId: 'b', ownerId: 'other' }));
  await log.append({ ...entry({ localId: 'c' }), token: 'secret-token' } as MetaTokenLogEntry);
  const latest = await log.latest('owner');
  expect([...latest.keys()]).toEqual(['a', 'c']);
  expect(latest.get('a')).toEqual({
    at: '2026-10-28T00:00:00.000Z',
    operation: 'register',
    result: 'success',
    expiresAt: null,
    detail: null,
    httpStatus: null,
    metaCode: 190,
    metaSubcode: 463,
    metaType: 'OAuthException',
    metaMessage: 'Session has expired',
    fbtraceId: 'trace',
    networkCode: null,
  });
  const content = await readFile(path, 'utf8');
  expect(content.trim().split('\n')).toHaveLength(4);
  expect(content).not.toContain('secret-token');
});

it('drops the oldest whole lines beyond the size limit and skips damaged lines', async () => {
  const path = await file();
  const log = new MetaTokenLog(path, 1600);
  for (let index = 0; index < 12; index += 1) await log.append(entry({ localId: `row-${index}` }));
  const content = await readFile(path, 'utf8');
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1600);
  expect(content.endsWith('\n')).toBe(true);
  expect(content).toContain('"row-11"');
  expect(content).not.toContain('"row-0"');
  for (const line of content.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  await appendFile(path, '{"at":"2026-10-28T00:00:00.000Z","ownerId":"owner","localId":"torn"');
  await appendFile(
    path,
    `\n${JSON.stringify({ ...entry({ localId: 'bad' }), result: 'other' })}\n`,
  );
  const latest = await log.latest('owner');
  expect(latest.has('row-11')).toBe(true);
  expect(latest.has('torn')).toBe(false);
  expect(latest.has('bad')).toBe(false);
});
