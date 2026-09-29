import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { bundledPython, configureRuntime, mediaCommand } from './runtime';
import { pythonCommand } from './python';

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
const oldPath = process.env.PATH;
beforeEach(() => vi.mocked(existsSync).mockReturnValue(true));
afterEach(() => {
  configureRuntime(false, '/dev', '/resources');
  process.env.PATH = oldPath;
  vi.unstubAllEnvs();
});

it('uses bundled Python and media tools despite developer overrides or a different cwd', () => {
  vi.stubEnv('TMM_PYTHON', 'untrusted-system-python');
  const root = configureRuntime(true, '/app.asar', '/설치 폴더/resources', 'win32');
  expect(root).toBe(join('/설치 폴더/resources', 'runtime'));
  expect(pythonCommand(root)).toEqual({
    command: join(root, 'python/python.exe'),
    prefix: ['-X', 'utf8'],
  });
  expect(mediaCommand('ffprobe')).toBe(join(root, 'bin/ffprobe.exe'));
  expect(process.env.PATH?.startsWith(join(root, 'bin'))).toBe(true);
});

it('fails on an incomplete installation instead of falling back to user-installed Python', () => {
  vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith('python.exe'));
  expect(() => configureRuntime(true, '/app.asar', '/resources', 'win32')).toThrow('누락');
});

it('keeps development Python selection and PATH intact', () => {
  vi.stubEnv('TMM_PYTHON', 'development-python');
  expect(configureRuntime(false, '/project', '/resources')).toBe('/project');
  expect(bundledPython()).toBe(null);
  expect(mediaCommand('ffprobe')).toBe('ffprobe');
  expect(pythonCommand('/project').command).toBe('development-python');
  expect(process.env.PATH).toBe(oldPath);
});
