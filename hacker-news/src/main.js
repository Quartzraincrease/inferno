import { createRoot, delegateEvents } from 'inferno-next';
import { App } from './App.tsrx';

// Event delegation — Nav/Story/Comment all use onClick handlers, so we
// register the `click` event once at document level. The compiler also
// auto-delegates events it sees in JSX, but registering here is harmless
// and makes the dependency explicit.
delegateEvents(['click']);

const container = document.getElementById('app');
const root = createRoot(container);
root.render(App);
