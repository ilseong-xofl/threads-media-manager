import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVideoFrame } from './capture-frame';

function setup() {
  const video = {
    readyState: 2,
    seeking: false,
    videoWidth: 640,
    videoHeight: 480,
    currentTime: 12.5,
    paused: false,
    pause: vi.fn(),
    play: vi.fn(),
  };
  const drawImage = vi.fn();
  let encoded!: BlobCallback;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: BlobCallback) => {
      encoded = callback;
    }),
  };
  const createElement = vi.fn(() => canvas);
  vi.stubGlobal('document', { createElement });
  return {
    video: video as unknown as HTMLVideoElement,
    pause: video.pause,
    play: video.play,
    canvas,
    drawImage,
    createElement,
    finish: (blob: Blob | null) => encoded(blob),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('video frame capture', () => {
  it('freezes pixels and time immediately before asynchronous PNG encoding without changing playback', async () => {
    const { video, canvas, drawImage, createElement, finish, pause, play } = setup();
    const pending = captureVideoFrame(video);
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(canvas.getContext).toHaveBeenCalledExactlyOnceWith('2d');
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 640, 480);
    expect(canvas.toBlob).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 'image/png');
    expect(drawImage.mock.invocationCallOrder[0]).toBeLessThan(
      canvas.toBlob.mock.invocationCallOrder[0],
    );
    // Playback advances while the already copied canvas is being encoded.
    video.currentTime = 18.75;
    const bytes = new Uint8Array([137, 80, 78, 71]);
    finish(new Blob([bytes], { type: 'image/png' }));
    expect(await pending).toEqual({ png: bytes, time: 12.5 });
    expect(video.currentTime).toBe(18.75);
    expect(video.paused).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('preserves paused playback as well as the selected time', async () => {
    const { video, finish, pause, play } = setup();
    Object.defineProperty(video, 'paused', { value: true });
    const pending = captureVideoFrame(video);
    finish(new Blob([new Uint8Array([1, 2, 3])]));
    expect((await pending).time).toBe(12.5);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(12.5);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('rejects a missing, unready, seeking, or dimensionless video before allocating a canvas', async () => {
    const { video, createElement } = setup();
    await expect(captureVideoFrame(null)).rejects.toThrow('영상이 준비된 뒤');
    for (const invalid of [
      { readyState: 1 },
      { seeking: true },
      { videoWidth: 0 },
      { videoHeight: 0 },
    ])
      await expect(captureVideoFrame({ ...video, ...invalid } as HTMLVideoElement)).rejects.toThrow(
        '영상이 준비된 뒤',
      );
    expect(createElement).not.toHaveBeenCalled();
  });

  it('rejects images beyond the dimension or pixel count caps before allocating a canvas', async () => {
    const { video, createElement } = setup();
    for (const size of [
      { videoWidth: 8193, videoHeight: 1 },
      { videoWidth: 1, videoHeight: 8193 },
      { videoWidth: 8192, videoHeight: 8192 },
    ])
      await expect(captureVideoFrame({ ...video, ...size } as HTMLVideoElement)).rejects.toThrow(
        '영상 크기를 초과',
      );
    expect(createElement).not.toHaveBeenCalled();
  });

  it('surfaces unavailable canvas context and drawing failures without pausing the source', async () => {
    const { video, canvas, drawImage, pause, play } = setup();
    canvas.getContext.mockReturnValueOnce(null as unknown as { drawImage: typeof drawImage });
    await expect(captureVideoFrame(video)).rejects.toThrow('이미지를 만들 수 없습니다');
    const failure = new DOMException('Canvas origin is not readable', 'SecurityError');
    drawImage.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(captureVideoFrame(video)).rejects.toBe(failure);
    expect(canvas.toBlob).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('rejects a failed PNG encoder result without changing video time', async () => {
    const { video, finish, pause, play } = setup();
    const pending = captureVideoFrame(video);
    finish(null);
    await expect(pending).rejects.toThrow('영상 캡처에 실패했습니다');
    expect(video.currentTime).toBe(12.5);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('checks the encoded byte cap before reading the blob into renderer memory', async () => {
    const { video, finish } = setup();
    const arrayBuffer = vi.fn();
    const pending = captureVideoFrame(video);
    finish({ size: 64 * 1024 * 1024 + 1, arrayBuffer } as unknown as Blob);
    await expect(pending).rejects.toThrow('용량이 너무 큽니다');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
