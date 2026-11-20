import { DefinePlugin, type Configuration } from 'webpack';
import { bundleValues } from './scripts/variants.mjs';
import { createPlugins } from './webpack.plugins';
import { typescriptRule } from './webpack.rules';
export const rendererConfig = (_env: unknown, args: Record<string, unknown>): Configuration => ({
  devtool: 'source-map',
  module: { rules: [typescriptRule, { test: /\.css$/, use: ['style-loader', 'css-loader'] }] },
  plugins: [
    ...createPlugins(),
    new DefinePlugin({
      TMM_DISPLAY_NAME: JSON.stringify(
        bundleValues(args.mode === 'production', process.env).displayName,
      ),
    }),
  ],
  resolve: { extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'] },
});
