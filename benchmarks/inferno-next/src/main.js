import { createRoot, flushSync } from 'inferno-next';
import Main from './Main.tsrx';

// `delegateEvents([...])` is auto-emitted by the compiler at the top of every
// .tsrx module that uses delegated events — no manual registration needed.

const container = document.getElementById('main');
const root = createRoot(container);
root.render(Main);

// Timing rig (matches benchmarks/run.mjs). flushSync drains the queue
// synchronously so we measure render+commit, not microtask delay.
window.__time = async function (op) {
  const t0 = performance.now();
  flushSync(op);
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 0));
  return performance.now() - t0;
};
window.__rowCount = () => document.querySelectorAll('tbody tr').length;
