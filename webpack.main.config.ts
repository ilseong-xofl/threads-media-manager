import { DefinePlugin, type Configuration } from 'webpack';
import { bundleValues } from './scripts/variants.mjs';
import { createPlugins } from './webpack.plugins';
import { typescriptRule } from './webpack.rules';
// Forge compiles in production mode only for a packaged build.
export const mainConfig = (_env: unknown, args: Record<string, unknown>): Configuration => {
  const values = bundleValues(args.mode === 'production', process.env);
  return {
    entry: './src/main/index.ts',
    module: { rules: [typescriptRule] },
    plugins: [
      ...createPlugins(),
      new DefinePlugin({
        TMM_DISPLAY_NAME: JSON.stringify(values.displayName),
        TMM_APP_NAME: JSON.stringify(values.appName),
        TMM_ICON: JSON.stringify(values.icon),
        TMM_FORMER_SHORTCUTS: JSON.stringify(values.formerShortcuts),
        TMM_APP_USER_MODEL_ID: JSON.stringify(values.appUserModelId),
        TMM_USER_DATA_DIR: JSON.stringify(values.userDataDir),
        TMM_SERVICE_URL: JSON.stringify(values.serviceUrl),
        TMM_GITHUB_REPOSITORY: JSON.stringify(values.updateRepository),
      }),
    ],
    resolve: { extensions: ['.js', '.ts', '.json'] },
  };
};
