import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ViewError } from './collection';
import { pythonCommand } from './python';

const failed = () =>
  new ViewError(
    'threads_image',
    'WebP 이미지를 PNG로 변환하지 못했습니다. 이미지를 JPG·PNG로 바꿔 다시 선택하세요.',
  );

function parseResult(raw: string): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate the worker contract below. */
  }
  if (value && typeof value === 'object' && 'ok' in value) {
    if (value.ok === true) return;
    if (
      value.ok === false &&
      'error' in value &&
      value.error &&
      typeof value.error === 'object' &&
      'code' in value.error &&
      typeof value.error.code === 'string' &&
      /^[a-z_]{1,64}$/.test(value.error.code) &&
      'message' in value.error &&
      typeof value.error.message === 'string' &&
      value.error.message.length <= 2000
    )
      throw new ViewError(value.error.code, value.error.message);
  }
  throw failed();
}

/** Decodes with the app's bundled Pillow; Electron's nativeImage reads only PNG and JPEG. */
export function launchWebpToPng(projectRoot: string) {
  return (source: string, destination: string) =>
    new Promise<void>((resolve, reject) => {
      const { command, prefix } = pythonCommand(projectRoot);
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'convert_upload_image.py')],
        { timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          try {
            parseResult(stdout);
            if (error) throw failed();
            resolve();
          } catch (reason) {
            reject(reason);
          }
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ source, destination }));
    });
}
