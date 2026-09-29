import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import runtimeManifest from '../../scripts/windows-runtime.json';

let bundledRoot: string | null = null;
let codexExecutable: string | null = null;

/** Packaged workers run outside ASAR using only the app's own runtime. */
export function configureRuntime(
  packaged: boolean,
  appPath: string,
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  bundledRoot = null;
  codexExecutable = null;
  if (!packaged) {
    if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
      codexExecutable = join(appPath, 'build', 'codex', `darwin-${arch}`, 'bin', 'codex');
    else if (platform === 'win32')
      codexExecutable = join(appPath, 'build', 'runtime', 'codex', 'bin', 'codex.exe');
    return appPath;
  }
  if (platform !== 'win32') throw new Error('설치 패키지는 Windows x64 전용입니다.');
  const root = join(resourcesPath, 'runtime');
  for (const relative of [
    'python/python.exe',
    'bin/ffmpeg.exe',
    'bin/ffprobe.exe',
    'local-runtime/collection_view.py',
    'plugins/threads-collector/scripts/threads_source/excel_input.py',
    ...runtimeManifest.codexRequiredFiles.map((file) => `codex/${file}`),
  ]) {
    if (!existsSync(join(root, relative)))
      throw new Error('앱 실행 파일이 누락되었습니다. 설치 프로그램으로 다시 설치하세요.');
  }
  bundledRoot = root;
  codexExecutable = join(root, 'codex', 'bin', 'codex.exe');
  process.env.PATH = [join(root, 'bin'), process.env.PATH ?? ''].join(delimiter);
  return root;
}

export function bundledPython(): string | null {
  return bundledRoot ? join(bundledRoot, 'python', 'python.exe') : null;
}

export function bundledCodex(): string | null {
  return codexExecutable;
}

export function mediaCommand(name: 'ffmpeg' | 'ffprobe'): string {
  return bundledRoot ? join(bundledRoot, 'bin', `${name}.exe`) : name;
}
