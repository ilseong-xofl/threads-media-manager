import { expect, it, vi } from 'vitest';
import { IPC } from '../shared/contracts';
import { handleMentRequest } from './ments-ipc';

const actions = () => ({
  list: vi.fn(async () => ({ status: 'ok' as const, catalog: { brands: [] }, problem: null })),
  save: vi.fn(async () => ({ status: 'ok' as const, catalog: { brands: [] }, problem: null })),
  delete: vi.fn(async () => ({ status: 'ok' as const, catalog: { brands: [] }, problem: null })),
});

it('runs only the three ment operations with the expected arguments', async () => {
  const ments = actions();
  await handleMentRequest(IPC.ments, [], ments);
  expect(ments.list).toHaveBeenCalledWith();
  await handleMentRequest(IPC.saveMent, [{ kind: 'brand' }], ments);
  expect(ments.save).toHaveBeenCalledWith({ kind: 'brand' });
  await handleMentRequest(IPC.deleteMent, [{ kind: 'ment' }], ments);
  expect(ments.delete).toHaveBeenCalledWith({ kind: 'ment' });
  expect(() => handleMentRequest(IPC.ments, [{}], ments)).toThrow('Unexpected arguments');
  expect(() => handleMentRequest(IPC.saveMent, [], ments)).toThrow('Unexpected arguments');
  expect(() => handleMentRequest(IPC.deleteMent, [{}, {}], ments)).toThrow('Unexpected arguments');
  expect(() => handleMentRequest('tmm:ments:purge', [{}], ments)).toThrow(
    'Unsupported ment operation',
  );
});
