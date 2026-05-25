import { defineConfig } from 'vitest/config';
import { infernoNext } from './compiler/index.js';

export default defineConfig({
  plugins: [infernoNext()],
  test: {
    environment: 'jsdom',
    include: ['__tests__/**/*.test.tsrx', '__tests__/**/*.test.ts'],
    globals: false,
  },
});
