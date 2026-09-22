import { expect, it } from 'vitest';
import { isLocalRequest, isTrustedFrame } from './security';
const entry = 'http://localhost:3120/main_window';
it('allows only this Forge server and registered-shape media URLs', () => {
  expect(isLocalRequest('http://localhost:3120/main_window/index.js', entry)).toBe(true);
  expect(isLocalRequest('ws://localhost:3120/ws', entry)).toBe(true);
  expect(isLocalRequest(`threads-media://file/${'a'.repeat(32)}`, entry)).toBe(true);
  for (const url of [
    'https://cdn.example.test/a.jpg',
    'https://fonts.googleapis.com/css',
    'file:///etc/passwd',
    'http://localhost:9999/x',
    'http://localhost.evil:3120/x',
    'threads-media://file/../../etc/passwd',
  ]) {
    expect(isLocalRequest(url, entry)).toBe(false);
  }
});
it('requires the exact main frame, sender, and entry for IPC', () => {
  expect(isTrustedFrame(1, 1, true, entry, entry)).toBe(true);
  expect(isTrustedFrame(2, 1, true, entry, entry)).toBe(false);
  expect(isTrustedFrame(1, 1, false, entry, entry)).toBe(false);
  expect(isTrustedFrame(1, 1, true, entry + '/other', entry)).toBe(false);
});
