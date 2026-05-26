// Minimal SPA router — pathname-based, history API. Exports a `useRoute()`
// hook that re-renders on navigation, and `navigate(url)` for programmatic
// navigation. Link-click interception sits in App so all internal links
// (e.g. <a href="/stories/123">) become pushState without server hits.

import { useState, useEffect } from 'inferno-next';

function readLocation() {
  return { pathname: window.location.pathname, search: window.location.search };
}

const listeners = new Set();
function notify() {
  for (const fn of listeners) fn();
}

window.addEventListener('popstate', notify);

export function navigate(to) {
  window.history.pushState(null, '', to);
  notify();
  // Scroll to top on route change — matches typical SPA UX.
  window.scrollTo(0, 0);
}

export function useRoute(slot) {
  const [loc, setLoc] = useState(readLocation, slot);
  useEffect((setter) => {
    const handler = () => setter(readLocation());
    listeners.add(handler);
    return () => listeners.delete(handler);
  }, [setLoc]);
  return loc;
}

/**
 * Pattern → params matcher. Patterns use `:name` segments. Returns
 * `{ kind, params }` or null if no match. The KIND name is the matched
 * route's identifier so the App can switch on it.
 */
export function matchRoute(pathname) {
  // Top-level list routes — pathname only.
  if (pathname === '/' || pathname === '/news') return { kind: 'news', params: {} };
  if (pathname === '/newest')                   return { kind: 'newest', params: {} };
  if (pathname === '/show')                     return { kind: 'show', params: {} };
  if (pathname === '/ask')                      return { kind: 'ask', params: {} };
  if (pathname === '/jobs')                     return { kind: 'jobs', params: {} };

  // /stories/:id
  const story = pathname.match(/^\/stories\/(\d+)\/?$/);
  if (story) return { kind: 'story', params: { id: story[1] } };

  // /users/:id
  const user = pathname.match(/^\/users\/([^/]+)\/?$/);
  if (user) return { kind: 'user', params: { id: decodeURIComponent(user[1]) } };

  return { kind: 'notfound', params: {} };
}

export function parsePage(search) {
  const m = search.match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}
