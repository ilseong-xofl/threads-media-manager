import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bundledPython } from './runtime';

export function pythonCommand(projectRoot: string): { command: string; prefix: string[] } {
  const bundled = bundledPython();
  if (bundled) return { command: bundled, prefix: ['-X', 'utf8'] };
  if (process.env.TMM_PYTHON) return { command: process.env.TMM_PYTHON, prefix: ['-X', 'utf8'] };
  const venv = join(
    projectRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (existsSync(venv)) return { command: venv, prefix: ['-X', 'utf8'] };
  return process.platform === 'win32'
    ? { command: 'py', prefix: ['-3', '-X', 'utf8'] }
    : { command: 'python3', prefix: ['-X', 'utf8'] };
}
