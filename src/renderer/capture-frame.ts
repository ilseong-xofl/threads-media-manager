export async function captureVideoFrame(video: HTMLVideoElement | null): Promise<{
  png: Uint8Array;
  time: number;
}> {
  if (!video || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight)
    throw new Error('영상이 준비된 뒤 다시 캡처하세요.');
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width > 8192 || height > 8192 || width * height > 40_000_000)
    throw new Error('캡처할 수 있는 영상 크기를 초과했습니다.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이미지를 만들 수 없습니다. 다시 시도하세요.');
  const time = video.currentTime;
  // Freeze the visible frame before encoding; playback can continue independently.
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('영상 캡처에 실패했습니다.'))),
      'image/png',
    );
  });
  if (blob.size > 64 * 1024 * 1024) throw new Error('캡처 이미지의 용량이 너무 큽니다.');
  return { png: new Uint8Array(await blob.arrayBuffer()), time };
}
