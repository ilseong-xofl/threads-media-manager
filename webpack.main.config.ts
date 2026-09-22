import type { Configuration } from 'webpack';
import { createPlugins } from './webpack.plugins';
import { typescriptRule } from './webpack.rules';
export const mainConfig: Configuration = {
  entry: './src/main/index.ts',
  module: { rules: [typescriptRule] },
  plugins: createPlugins(),
  resolve: { extensions: ['.js', '.ts', '.json'] },
};
