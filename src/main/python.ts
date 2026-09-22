import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function pythonCommand(projectRoot: string): { command: string; prefix: string[] } {
  if (process.env.TMM_PYTHON) return { command: process.env.TMM_PYTHON, prefix: [] };
  const venv = join(
    projectRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (existsSync(venv)) return { command: venv, prefix: [] };
  return process.platform === 'win32'
    ? { command: 'py', prefix: ['-3'] }
    : { command: 'python3', prefix: [] };
}
