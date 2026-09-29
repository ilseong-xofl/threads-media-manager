import { expect, it } from 'vitest';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
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

it.each(['Test', 'Test User', '테스트 #100%'])(
  'loads only the packaged renderer tree for Windows user %s',
  (user) => {
    const packagedEntry = pathToFileURL(
      win32.join(
        'C:',
        'Users',
        user,
        'AppData',
        'Local',
        'threads_media_manager',
        'app-0.1.1',
        'resources',
        'app.asar',
        '.webpack',
        'renderer',
        'main_window',
        'index.html',
      ),
      { windows: true },
    ).href;
    expect(isLocalRequest(packagedEntry, packagedEntry)).toBe(true);
    expect(isLocalRequest(new URL('index.js', packagedEntry).href, packagedEntry)).toBe(true);
    expect(isLocalRequest(new URL('assets/font.woff2', packagedEntry).href, packagedEntry)).toBe(
      true,
    );
    expect(isTrustedFrame(1, 1, true, packagedEntry, packagedEntry)).toBe(true);
    expect(isTrustedFrame(2, 1, true, packagedEntry, packagedEntry)).toBe(false);
    expect(isTrustedFrame(1, 1, false, packagedEntry, packagedEntry)).toBe(false);
    expect(isLocalRequest(packagedEntry.replace('/C:/', '/D:/'), packagedEntry)).toBe(false);
    expect(
      isLocalRequest(new URL('../main_window-other/index.js', packagedEntry).href, packagedEntry),
    ).toBe(false);
    expect(isLocalRequest(new URL('../../main/index.js', packagedEntry).href, packagedEntry)).toBe(
      false,
    );
  },
);

const packagedEntry =
  'file:///C:/Users/%ED%85%8C%EC%8A%A4%ED%8A%B8%20%23100%25/AppData/Local/threads_media_manager/app-0.1.1/resources/app.asar/.webpack/renderer/main_window/index.html';
const rendererDirectory = packagedEntry.slice(0, packagedEntry.lastIndexOf('/') + 1);
it.each([
  'file:///C:/Users/Test/AppData/Roaming/ThreadsMediaManager/view-settings.json',
  'file:///C:/Windows/System32/config/SAM',
  'file://server/share/index.js',
  'https://cdn.example.test/index.js',
  'http://localhost:3120/main_window/index.js',
  'ws://localhost:3120/ws',
  'data:text/javascript,alert(1)',
  `${rendererDirectory}../main_window/index.js`,
  `${rendererDirectory}assets/%2e%2e/index.js`,
  `${rendererDirectory}assets/%2E./index.js`,
  `${rendererDirectory}%2e%2e/main_window/index.js`,
  `${rendererDirectory}assets%2f../index.js`,
  `${rendererDirectory}assets%5c..%5cindex.js`,
  `${rendererDirectory}index.js%00`,
  `${rendererDirectory}bad%XX.js`,
  `${rendererDirectory}index.js?file=outside`,
  `${rendererDirectory}index.js#outside`,
])('blocks outside resources and ambiguous file paths in the installed app: %s', (url) => {
  expect(isLocalRequest(url, packagedEntry)).toBe(false);
});

it('preserves filename hash and percent characters rather than interpreting them as URL syntax', () => {
  const encoded = pathToFileURL('C:\\Users\\테스트 #100%\\app.asar\\renderer\\index.html', {
    windows: true,
  }).href;
  expect(encoded).toBe(
    'file:///C:/Users/%ED%85%8C%EC%8A%A4%ED%8A%B8%20%23100%25/app.asar/renderer/index.html',
  );
  expect(isLocalRequest(new URL('index.js', encoded).href, encoded)).toBe(true);
  expect(isTrustedFrame(1, 1, true, encoded, encoded)).toBe(true);
});

it('compares canonical frame URLs while still rejecting other pages, fragments and malformed input', () => {
  const forgeEntry = 'file://C:\\Users\\Test User\\app.asar\\renderer\\index.html';
  const canonical = 'file:///C:/Users/Test%20User/app.asar/renderer/index.html';
  expect(isTrustedFrame(1, 1, true, canonical, forgeEntry)).toBe(true);
  expect(
    isTrustedFrame(1, 1, true, canonical.replace('index.html', 'other.html'), forgeEntry),
  ).toBe(false);
  expect(isTrustedFrame(1, 1, true, `${canonical}#other`, forgeEntry)).toBe(false);
  expect(isTrustedFrame(1, 1, true, 'not a URL', forgeEntry)).toBe(false);
  expect(isTrustedFrame(1, 1, true, canonical, 'not a URL')).toBe(false);
});
