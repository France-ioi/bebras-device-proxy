const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

/** Shared config for both platform and task bundles. */
function makeConfig(entry, globalName, outputFilename, dev) {
  return {
    mode: dev ? 'development' : 'production',
    devtool: dev ? 'source-map' : false,
    entry,
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: outputFilename,
      library: {
        type: 'umd',
        name: globalName,
        export: 'default',
      },
      globalObject: 'this',
    },
    optimization: dev ? {} : {
      minimize: true,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: { drop_console: false },
            mangle: true,
          },
        }),
      ],
    },
  };
}

module.exports = (env) => {
  const dev = !!env.dev;
  return [
    makeConfig(
      './platform/index.ts',
      'DeviceProxyPlatform',
      'device-proxy-platform.js',
      dev,
    ),
    makeConfig(
      './task/index.ts',
      'DeviceProxyTask',
      'device-proxy-task.js',
      dev,
    ),
  ];
};
