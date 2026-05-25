import { defineConfig } from 'vite';
import { infernoNext } from 'inferno-next/compiler';

export default defineConfig({
  plugins: [infernoNext()],
  build: {
    target: 'es2022',
    minify: 'terser',
    terserOptions: {
      compress: {
        inline: 0,
        reduce_vars: false,
        passes: 5,
        booleans: false,
        comparisons: false,
        keep_infinity: true,
      },
      toplevel: true,
      mangle: true,
      module: true,
    },
  },
});
