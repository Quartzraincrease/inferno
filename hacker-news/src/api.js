// Official Firebase HN API. We do a per-item fetch for list pages because
// Firebase only exposes ID lists at the category endpoints; in exchange we
// reshape the records into the same shape solid-hackernews uses
// (`{ id, title, url, domain, points, user, time_ago, comments_count, type, comments }`)
// so the rest of the app is API-agnostic.
//
// Promises are MEMOIZED by key so `use()` resolves synchronously on cache
// hits — matches React's `cache()` semantics for stable suspense.

const HN = 'https://hacker-news.firebaseio.com/v0';
const PER_PAGE = 30;

const _cache = new Map();
function cached(key, factory) {
  let p = _cache.get(key);
  if (!p) {
    p = factory();
    // Tag for use()'s fast path; the runtime checks .status/.value to skip the
    // throw cycle when the promise is already settled by a later render.
    p.then(
      (v) => { p.status = 'fulfilled'; p.value = v; },
      (e) => { p.status = 'rejected'; p.reason = e; },
    );
    _cache.set(key, p);
  }
  return p;
}

function timeAgo(unixSec) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function hostOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

function shapeStory(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.title,
    url: item.url || null,
    domain: hostOf(item.url),
    points: item.score || 0,
    user: item.by,
    time_ago: timeAgo(item.time),
    comments_count: item.descendants || 0,
    type: item.type === 'job' ? 'job' : (item.type || 'story'),
    comments: [],
  };
}

function shapeComment(item) {
  if (!item) return null;
  return {
    id: item.id,
    user: item.by || '[deleted]',
    time_ago: timeAgo(item.time),
    content: item.text || '',
    comments: [],   // populated by caller after kids resolve
    deleted: !!(item.deleted || item.dead),
  };
}

const KIND_MAP = {
  news: 'topstories',
  newest: 'newstories',
  show: 'showstories',
  ask: 'askstories',
  jobs: 'jobstories',
};

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HN ' + r.status + ' ' + url);
  return r.json();
}

export function fetchStories(kind, page) {
  const cat = KIND_MAP[kind] || 'topstories';
  return cached(`stories:${kind}:${page}`, async () => {
    const ids = await fetchJson(`${HN}/${cat}.json`);
    const start = (page - 1) * PER_PAGE;
    const slice = ids.slice(start, start + PER_PAGE);
    const items = await Promise.all(slice.map((id) => fetchJson(`${HN}/item/${id}.json`)));
    return items.map(shapeStory).filter(Boolean);
  });
}

// Fetch one item + expand its `kids` into a comment tree. We cap depth, kids
// per level, and total nodes so a viral thread (thousands of replies) doesn't
// rack up minutes of round-trips. Parallel within each level for speed,
// shallow + truncated overall so total wall-clock stays under ~2s on a typical
// connection.
const MAX_NODES = 150;
const KIDS_PER_LEVEL = 20;

async function fetchItemWithKids(id, depth, budget) {
  const item = await fetchJson(`${HN}/item/${id}.json`);
  if (!item) return null;
  budget.count++;
  if (depth <= 0 || budget.count >= MAX_NODES || !item.kids || !item.kids.length) return item;
  const kidIds = item.kids.slice(0, KIDS_PER_LEVEL);
  const childItems = await Promise.all(kidIds.map((kid) => fetchItemWithKids(kid, depth - 1, budget)));
  item.kids_resolved = childItems.filter(Boolean);
  return item;
}

function shapeCommentTree(raw) {
  const c = shapeComment(raw);
  if (!c) return null;
  if (raw.kids_resolved) {
    c.comments = raw.kids_resolved.map(shapeCommentTree).filter(Boolean);
  }
  return c;
}

export function fetchItem(id) {
  return cached(`item:${id}`, async () => {
    const root = await fetchItemWithKids(id, 3, { count: 0 });
    if (!root) return null;
    const story = shapeStory(root);
    if (root.kids_resolved) {
      story.comments = root.kids_resolved.map(shapeCommentTree).filter(Boolean);
    }
    // The detail view also wants the post's text body (Ask HN, etc.).
    if (root.text) story.content = root.text;
    return story;
  });
}

export function fetchUser(id) {
  return cached(`user:${id}`, () => fetchJson(`${HN}/user/${id}.json`));
}

export function invalidateCache() {
  _cache.clear();
}
