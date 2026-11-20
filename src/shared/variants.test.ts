import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { serviceBaseUrl } from '../main/service-api';
import {
  bundleValues,
  otherVariants,
  selectVariant,
  variantNames,
} from '../../scripts/variants.mjs';

// Never change these: installed dev copies find their updates, their install folder and their
// data through them. appName names the macOS keychain entry that decrypts an unpackaged run's
// stored files.
const releasedDevIdentity = {
  appName: 'Threads Media Manager',
  packageName: 'Threads Media Manager',
  executableName: 'ThreadsMediaManager',
  squirrelName: 'threads_media_manager',
  setupExe: 'ThreadsMediaManager-win32-x64-Setup.exe',
  appUserModelId: 'com.squirrel.threads_media_manager.ThreadsMediaManager',
  userDataDir: 'ThreadsMediaManager',
  serviceUrl: 'https://threads-admin-dev.ilscp.net',
  updateRepository: 'ilseong-xofl/threads-media-manager',
};
// Free to change: what people see. A changed productName or companyName moves the shortcuts, so
// the names it replaces go into formerShortcuts.
const devPresentation = {
  displayName: '(개발) ILS 소셜(T) 관리',
  productName: '(개발) ILS 소셜(T) 관리',
  companyName: 'ILS 소셜(T) 관리',
  icon: 'app-icon-dev',
  formerShortcuts: [{ companyName: 'Threads Media Manager', productName: 'Threads Media Manager' }],
};

it('keeps the dev variant on the released install identity', () => {
  expect(selectVariant('dev')).toMatchObject(releasedDevIdentity);
});

it('shows the dev variant under its own name and icon', () => {
  expect(selectVariant('dev')).toEqual({ name: 'dev', ...releasedDevIdentity, ...devPresentation });
});

it('gives the prod variant its own install identity, service and update repository', () => {
  expect(selectVariant('prod')).toEqual({
    name: 'prod',
    displayName: 'ILS 소셜(T) 관리',
    productName: 'ILS 소셜(T) 관리',
    companyName: 'ILS 소셜(T) 관리',
    icon: 'app-icon',
    formerShortcuts: [],
    appName: 'ILS 소셜(T) 관리',
    packageName: 'IlsSocialManager',
    executableName: 'IlsSocialManager',
    squirrelName: 'ils_social_manager',
    setupExe: 'IlsSocialManager-win32-x64-Setup.exe',
    appUserModelId: 'com.squirrel.ils_social_manager.IlsSocialManager',
    userDataDir: 'IlsSocialManager',
    serviceUrl: 'https://threads-admin.ilscp.net',
    updateRepository: 'ilseong-xofl/threads-media-manager-prod',
  });
});

it('has exactly the dev and prod variants, each listing the other', () => {
  expect(variantNames).toEqual(['dev', 'prod']);
  expect(otherVariants('dev').map((variant) => variant.name)).toEqual(['prod']);
  expect(otherVariants('prod').map((variant) => variant.name)).toEqual(['dev']);
});

it.each(['dev', 'prod'])('derives the %s names the way Squirrel and the packager do', (name) => {
  const variant = selectVariant(name);
  expect(variant.appUserModelId).toBe(
    `com.squirrel.${variant.squirrelName}.${variant.executableName}`,
  );
  expect(variant.setupExe).toBe(`${variant.executableName}-win32-x64-Setup.exe`);
  // These become file and folder names; the Korean name is display only.
  for (const value of [variant.packageName, variant.executableName, variant.userDataDir])
    expect(value).toMatch(/^[A-Za-z][A-Za-z ]*$/);
  expect(variant.squirrelName).toMatch(/^[a-z_]+$/);
  // A packaged app stays locked unless it accepts its own service origin unchanged.
  expect(serviceBaseUrl(variant.serviceUrl, true)).toBe(variant.serviceUrl);
  expect(variant.updateRepository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
});

it('shares no install identity, service or update repository between variants', () => {
  const [dev, prod] = [selectVariant('dev'), selectVariant('prod')];
  for (const key of [
    'displayName',
    'productName',
    'icon',
    'packageName',
    'executableName',
    'squirrelName',
    'setupExe',
    'appUserModelId',
    'userDataDir',
    'serviceUrl',
    'updateRepository',
  ] as const)
    expect(dev[key]).not.toBe(prod[key]);
});

it.each(['dev', 'prod'])('ships both icon files of the %s variant', (name) => {
  for (const extension of ['ico', 'png'])
    expect(existsSync(join('assets', `${selectVariant(name).icon}.${extension}`))).toBe(true);
});

it('removes no shortcut that a current variant installs', () => {
  // Squirrel names the shortcuts from the company and product names.
  const current = variantNames
    .map(selectVariant)
    .map(({ companyName, productName }) => ({ companyName, productName }));
  for (const variant of variantNames.map(selectVariant))
    for (const former of variant.formerShortcuts) {
      expect(current).not.toContainEqual(former);
      expect(current.map(({ productName }) => productName)).not.toContain(former.productName);
    }
});

it.each([undefined, '', 'DEV', 'production', 'toString'])('rejects the variant %j', (name) => {
  expect(() => selectVariant(name)).toThrow('TMM_VARIANT');
});

it('never packages without an explicit variant', () => {
  expect(() => bundleValues(true, {})).toThrow('TMM_VARIANT');
  expect(() => bundleValues(true, { TMM_VARIANT: '' })).toThrow('TMM_VARIANT');
  expect(() => bundleValues(true, { TMM_VARIANT: 'staging' })).toThrow('TMM_VARIANT');
});

it('compiles the chosen variant into a packaged build, ignoring the local service override', () => {
  const env = { THREADS_ADMIN_API_URL: 'https://other.example.test' };
  expect(bundleValues(true, { ...env, TMM_VARIANT: 'dev' })).toEqual({
    displayName: '(개발) ILS 소셜(T) 관리',
    appName: 'Threads Media Manager',
    icon: 'app-icon-dev',
    formerShortcuts: devPresentation.formerShortcuts,
    appUserModelId: 'com.squirrel.threads_media_manager.ThreadsMediaManager',
    userDataDir: 'ThreadsMediaManager',
    serviceUrl: 'https://threads-admin-dev.ilscp.net',
    updateRepository: 'ilseong-xofl/threads-media-manager',
  });
  expect(bundleValues(true, { ...env, TMM_VARIANT: 'prod' })).toEqual({
    displayName: 'ILS 소셜(T) 관리',
    appName: 'ILS 소셜(T) 관리',
    icon: 'app-icon',
    formerShortcuts: [],
    appUserModelId: 'com.squirrel.ils_social_manager.IlsSocialManager',
    userDataDir: 'IlsSocialManager',
    serviceUrl: 'https://threads-admin.ilscp.net',
    updateRepository: 'ilseong-xofl/threads-media-manager-prod',
  });
});

it('keeps an unpackaged run local: dev names and icon, no variant service or update repository', () => {
  const local = {
    displayName: '(개발) ILS 소셜(T) 관리',
    appName: 'Threads Media Manager',
    icon: 'app-icon-dev',
    formerShortcuts: devPresentation.formerShortcuts,
    appUserModelId: 'com.squirrel.threads_media_manager.ThreadsMediaManager',
    userDataDir: 'ThreadsMediaManager',
    serviceUrl: '',
    updateRepository: '',
  };
  expect(bundleValues(false, {})).toEqual(local);
  expect(bundleValues(false, { TMM_VARIANT: 'prod' })).toEqual(local);
  expect(bundleValues(false, { THREADS_ADMIN_API_URL: 'http://127.0.0.1:4999' })).toEqual({
    ...local,
    serviceUrl: 'http://127.0.0.1:4999',
  });
});

it('compiles each value into the constant the app reads it from', async () => {
  // A service URL and an update repository swapped here would lock the app and stop updates,
  // and the shipped bundle would still contain both strings.
  const { DefinePlugin } = await import('webpack');
  const { mainConfig } = await import('../../webpack.main.config');
  const env = { ...process.env };
  try {
    process.env.TMM_VARIANT = 'prod';
    const plugin = mainConfig({}, { mode: 'production' }).plugins?.find(
      (candidate): candidate is InstanceType<typeof DefinePlugin> =>
        candidate instanceof DefinePlugin,
    );
    const prod = selectVariant('prod');
    expect(plugin?.definitions).toEqual({
      TMM_DISPLAY_NAME: JSON.stringify(prod.displayName),
      TMM_APP_NAME: JSON.stringify(prod.appName),
      TMM_ICON: JSON.stringify(prod.icon),
      TMM_FORMER_SHORTCUTS: JSON.stringify(prod.formerShortcuts),
      TMM_APP_USER_MODEL_ID: JSON.stringify(prod.appUserModelId),
      TMM_USER_DATA_DIR: JSON.stringify(prod.userDataDir),
      TMM_SERVICE_URL: JSON.stringify(prod.serviceUrl),
      TMM_GITHUB_REPOSITORY: JSON.stringify(prod.updateRepository),
    });
  } finally {
    process.env = env;
  }
});
