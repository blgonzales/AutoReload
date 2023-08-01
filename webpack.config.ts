import path from 'path';
import * as webpack from 'webpack';
import * as webpackDevServer from 'webpack-dev-server';
import { CleanWebpackPlugin } from 'clean-webpack-plugin';
import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const isProduction = process.env.NODE_ENV === 'production';

const config: webpack.Configuration = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    app: './src/app.ts',
    popup: './src/App.tsx',
  },
  output: {
    filename: '[name].js',
    path: `${__dirname}/dist`,
    assetModuleFilename: 'images/[hash][ext][query]',
  },
  plugins: [
    new CleanWebpackPlugin(),
    new CopyPlugin({
      patterns: [
        { from: './manifest.json', to: './' },
        { from: './src/index.html', to: './' },
        { from: './public', to: './' },
      ],
    }),
    // new HtmlWebpackPlugin({
    //   template: './src/index.html',
    //   chunks: ['popup'],
    // }),
  ],
  devtool: isProduction ? 'source-map' : 'eval-cheap-module-source-map',
  devServer: {
    open: 'index.html',
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    hot: true,
    port: 9000,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json'],
    fallback: {
      fs: false,
    },
  },
  module: {
    rules: [
      //   {
      //     test: /\.html$/,
      //     loader: 'html-loader',
      //   },
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        enforce: 'pre',
        test: /\.js$/,
        loader: 'source-map-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.s[ac]ss$/i,
        use: ['style-loader', 'css-loader', 'sass-loader'],
      },
      {
        test: /\.(png|jp(e*)g|svg|gif)$/,
        type: 'asset/resource',
      },
    ],
  },

  // When importing a module whose path matches one of the following, just
  // assume a corresponding global variable exists and use that instead.
  // This is important because it allows us to avoid bundling all of our
  // dependencies, which allows browsers to cache those libraries between builds.
  externals: {},
  performance: {
    hints: false,
    maxEntrypointSize: 512000,
    maxAssetSize: 512000,
  },
  optimization: {
    // runtimeChunk: 'single',
    // splitChunks: {
    //   cacheGroups: {
    //     vendor: {
    //       test: /[\\/]node_modules[\\/]/,
    //       name: 'vendor',
    //       chunks: 'all',
    //       maxSize: 2500000,
    //     },
    //   },
    // },
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          format: {
            comments: false,
          },
        },
      }),
    ],
  },
};

export default config;
