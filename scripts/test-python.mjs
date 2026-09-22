import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const venv = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const selected = process.env.TMM_PYTHON || (existsSync(venv) ? venv : null);
const command = selected || (process.platform === 'win32' ? 'py' : 'python3');
const prefix = process.platform === 'win32' && !selected ? ['-3'] : [];
const result = spawnSync(command, [...prefix, '-B', '-m', 'unittest', 'discover', '-s', 'tests'], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error)
  console.error('Python 실행 환경을 확인하세요. TMM_PYTHON으로 실행 파일을 지정할 수 있습니다.');
process.exit(result.status ?? 1);
