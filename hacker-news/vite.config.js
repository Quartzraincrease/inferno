import { defineConfig } from 'vite';
import { infernoNext } from 'inferno-next/compiler';

export default defineConfig({
  plugins: [infernoNext()],
  server: { port: 5180 },
});
