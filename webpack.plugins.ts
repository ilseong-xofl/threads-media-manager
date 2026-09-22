import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import type { Compiler } from 'webpack';

// Same macOS polling workaround as local-video-manager's Forge setup.
class MacOsPollingWatchPlugin {
  apply(compiler: Compiler): void {
    if (process.platform !== 'darwin') return;
    const watch = compiler.watch.bind(compiler);
    compiler.watch = (options, handler) =>
      watch({ ignored: /node_modules/, poll: 1000, ...options }, handler);
  }
}
export const createPlugins = () => [
  new MacOsPollingWatchPlugin(),
  new ForkTsCheckerWebpackPlugin({ logger: 'webpack-infrastructure' }),
];
