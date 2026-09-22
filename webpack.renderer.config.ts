import type { Configuration } from 'webpack';
import { createPlugins } from './webpack.plugins';
import { typescriptRule } from './webpack.rules';
export const rendererConfig: Configuration = {
  devtool: 'source-map',
  module: { rules: [typescriptRule, { test: /\.css$/, use: ['style-loader', 'css-loader'] }] },
  plugins: createPlugins(),
  resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'] },
};
