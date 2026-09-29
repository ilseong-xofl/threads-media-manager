import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import runtimeManifest from './scripts/windows-runtime.json';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.threadsmediamanager.desktop',
    executableName: 'ThreadsMediaManager',
    extraResource: process.platform === 'win32' ? [join('build', 'runtime')] : [],
  },
  hooks: {
    preStart: async () => {
      if (process.platform === 'darwin')
        await promisify(execFile)('python3', [
          join(__dirname, 'scripts', 'prepare-macos-codex.py'),
          process.arch,
        ]);
    },
    prePackage: async (_config, platform, arch) => {
      if (platform !== 'win32' || arch !== 'x64')
        throw new Error('Only Windows x64 distribution is supported.');
      for (const file of [
        'runtime-manifest.json',
        ...runtimeManifest.codexRequiredFiles.map((file) => `codex/${file}`),
      ]) {
        if (!existsSync(join('build', 'runtime', file)))
          throw new Error('Run python scripts/prepare-windows-runtime.py before packaging.');
      }
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'threads_media_manager',
      setupExe: 'ThreadsMediaManager-win32-x64-Setup.exe',
    }),
  ],
  plugins: [
    new WebpackPlugin({
      port: 3120,
      loggerPort: 9120,
      devContentSecurityPolicy:
        "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src threads-media:; media-src threads-media:; connect-src 'self' ws://localhost:3120; font-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'",
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.tsx',
            name: 'main_window',
            preload: { js: './src/preload/index.ts' },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
export default config;
