import type { RuleSetRule } from 'webpack';
export const typescriptRule = {
  test: /\.tsx?$/,
  exclude: /(node_modules|\.webpack)/,
  use: { loader: 'ts-loader', options: { transpileOnly: true } },
} satisfies RuleSetRule;
