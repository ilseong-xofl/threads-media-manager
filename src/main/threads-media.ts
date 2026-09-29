import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MediaRegistry } from './media';
import { ViewError } from './collection';

export interface ThreadsUploadFile {
  path: string;
  size: number;
  contentType: string;
  extension: string;
  kind: 'image' | 'video';
  mediaId: string;
  sha256: string;
}
async function checkVideo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov',
        '-enable_drefs',
        '0',
        '-use_absolute_path',
        '0',
        '-i',
        path,
        '-show_entries',
        'stream=codec_type,codec_name:format=duration',
        '-of',
        'json',
      ],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
      (error, stdout) => {
        try {
          if (error) throw error;
          const value = JSON.parse(stdout);
          const streams = value.streams as { codec_type: string; codec_name: string }[];
          const duration = Number(value.format?.duration);
          if (
            !Array.isArray(streams) ||
            !streams.some((s) => s.codec_type === 'video') ||
            !Number.isFinite(duration) ||
            duration <= 0 ||
            duration > 300 ||
            streams.some(
              (s) => s.codec_type === 'video' && !['h264', 'hevc'].includes(s.codec_name),
            ) ||
            streams.some((s) => s.codec_type === 'audio' && s.codec_name !== 'aac')
          )
            throw new Error();
          resolve();
        } catch {
          reject(
            new ViewError(
              'threads_video',
              '영상은 5분 이하 MP4/MOV(H.264 또는 HEVC, AAC 음성)여야 합니다. ffprobe 실행 환경도 확인하세요.',
            ),
          );
        }
      },
    );
  });
}

/** Freeze verified local bytes before sending anything to the file server or Threads. */
export async function prepareThreadsMedia(
  registry: MediaRegistry,
  root: string,
  mediaIds: string[],
  directory: string,
  toPng: (input: Buffer) => Buffer,
): Promise<ThreadsUploadFile[]> {
  if (!mediaIds.length || mediaIds.length > 20 || new Set(mediaIds).size !== mediaIds.length)
    throw new ViewError('threads_media_limit', 'Threads에는 첨부를 1~20개 선택해 업로드하세요.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result: ThreadsUploadFile[] = [];
  for (const [index, id] of mediaIds.entries()) {
    const temporary = join(directory, `${index + 1}.source`);
    const file = await registry.copyForUpload(root, id, temporary);
    let extension = extname(file.relativePath).slice(1).toLowerCase();
    let path = join(directory, `${index + 1}.${extension}`);
    await rename(temporary, path);
    if (file.kind === 'image') {
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension) || file.size > 32 * 1024 * 1024)
        throw new ViewError('threads_image', '업로드 이미지는 JPEG·PNG·WebP 형식이어야 합니다.');
      if (extension === 'webp') {
        const png = toPng(await readFile(path));
        if (!png.length || png.length > 8 * 1024 * 1024)
          throw new ViewError('threads_image', 'PNG 변환 후 이미지가 8MB를 초과합니다.');
        extension = 'png';
        path = join(directory, `${index + 1}.png`);
        await writeFile(path, png, { flag: 'wx', mode: 0o600 });
      }
      if ((await stat(path)).size > 8 * 1024 * 1024)
        throw new ViewError('threads_image', 'Threads 업로드 이미지는 파일당 8MB 이하여야 합니다.');
    } else {
      if (!['mp4', 'mov'].includes(extension) || file.size > 1024 ** 3)
        throw new ViewError(
          'threads_video',
          'Threads 업로드 영상은 MP4·MOV, 파일당 1GB 이하여야 합니다.',
        );
      await checkVideo(path);
    }
    result.push({
      path,
      size: (await stat(path)).size,
      extension,
      kind: file.kind,
      contentType:
        file.kind === 'image'
          ? extension === 'png'
            ? 'image/png'
            : 'image/jpeg'
          : extension === 'mov'
            ? 'video/quicktime'
            : 'video/mp4',
      mediaId: id,
      sha256: file.sha256,
    });
  }
  return result;
}
