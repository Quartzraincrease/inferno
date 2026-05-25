/**
 * Vite plugin for compiling .tsrx files via @tsrx/inferno-next compiler.
 */
import { compile } from './compile.js';

export function infernoNext() {
  return {
    name: 'inferno-next',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.tsrx')) return null;
      const out = compile(code, id);
      return { code: out.code, map: out.map };
    },
  };
}
