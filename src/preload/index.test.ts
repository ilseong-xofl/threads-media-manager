import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type ThreadsMediaApi } from '../shared/contracts';

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), extract: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke },
  webUtils: { getPathForFile: electron.extract },
}));
import './index';
const api = electron.expose.mock.calls[0][1] as ThreadsMediaApi;
beforeEach(() => {
  electron.invoke
    .mockReset()
    .mockResolvedValue({ status: 'selected', selectionId: 'a'.repeat(32), files: [] });
  electron.extract.mockReset();
});

describe('dropped File preload boundary', () => {
  it('extracts the whole File batch inside preload and forwards only its internal path payload', async () => {
    const files = [new File(['image'], 'image.png'), new File(['video'], 'video.mp4')];
    const current = { selectionId: 'a'.repeat(32), mediaIds: ['b'.repeat(32)] };
    electron.extract
      .mockReturnValueOnce('/chosen/image.png')
      .mockReturnValueOnce('/chosen/video.mp4');
    const result = await api.addLocalPostMedia(files, current);
    expect(electron.extract.mock.calls).toEqual([[files[0]], [files[1]]]);
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(IPC.addLocalPostMedia, {
      paths: ['/chosen/image.png', '/chosen/video.mp4'],
      current,
    });
    expect(JSON.stringify(result)).not.toContain('/chosen/');
  });

  it('never invokes IPC when any File has no native path or extraction rejects a forged value', async () => {
    const native = new File(['image'], 'photo.png');
    const generated = new File(['image'], 'generated.png');
    electron.extract.mockReturnValueOnce('/chosen/photo.png').mockReturnValueOnce('');
    expect(await api.addLocalPostMedia([native, generated])).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_drop' },
    });
    expect(electron.invoke).not.toHaveBeenCalled();
    electron.extract.mockImplementation(() => {
      throw new TypeError('Not a File');
    });
    expect(await api.addLocalPostMedia(['/secret/file.png' as unknown as File])).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_drop' },
    });
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('rejects empty or oversized batches before extracting anything', async () => {
    expect((await api.addLocalPostMedia([])).status).toBe('error');
    expect(
      (await api.addLocalPostMedia(Array.from({ length: 101 }, () => new File([], 'image.png'))))
        .status,
    ).toBe('error');
    expect(electron.extract).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});
