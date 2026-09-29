import { DefinePlugin, type Configuration } from 'webpack';
import { createPlugins } from './webpack.plugins';
import { typescriptRule } from './webpack.rules';
export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  module: { rules: [typescriptRule] },
  plugins: [
    ...createPlugins(),
    new DefinePlugin({
      TMM_GITHUB_REPOSITORY: JSON.stringify(process.env.GITHUB_REPOSITORY ?? ''),
    }),
  ],
  resolve: { extensions: ['.js', '.ts', '.json'] },
};
