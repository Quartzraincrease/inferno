import { createRoot } from 'inferno-next';
import { App } from './App.tsrx';

// `delegateEvents([...])` is auto-emitted by the compiler at the top of every
// .tsrx module that uses delegated events — no manual registration needed.

const container = document.getElementById('app');
const root = createRoot(container);
root.render(App);
