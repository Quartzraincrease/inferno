# Inferno-Next • Hacker News

A Hacker News clone built on **inferno-next**, modelled after
[solidjs/solid-hackernews](https://github.com/solidjs/solid-hackernews).

Exercises the runtime's React-shape primitives end-to-end:

| Feature | Where it shows up |
| --- | --- |
| **`use(promise)` + `try / pending / catch`** | every page that fetches HN data |
| **Promise memoisation (React `cache()` shape)** | [`src/api.js`](src/api.js) — `cached(key, factory)` tags `.status` so `use()` resolves synchronously on cache hits |
| **`useDeferredValue`** | [`StoryList.tsrx`](src/components/StoryList.tsrx) — old list stays visible with `.stale` class while a new page loads |
| **Hook state preserved across replay** | recursive `<Comment>` keeps its `useState` `open` flag even when the body suspends elsewhere |
| **`{html …}`** | comment bodies + user "about" sections render raw HN HTML |
| **Keyed `for-of`** | story lists and comment children |
| **Routing** | tiny pathname-based router in [`src/router.js`](src/router.js) — no dependency |
| **In-app link interception** | a single delegated click handler in `App.tsrx` turns internal `<a href>`s into `pushState` navigations |

## Routes

| Path | Component |
| --- | --- |
| `/`, `/news` | top stories |
| `/newest` | newest stories |
| `/show` | Show HN |
| `/ask` | Ask HN |
| `/jobs` | jobs |
| `/stories/:id` | story detail + comment tree |
| `/users/:id` | user profile |

Pagination via `?page=N` (1-based, capped to 10).

## API

Uses the official [Firebase HN API](https://github.com/HackerNews/API):

- `https://hacker-news.firebaseio.com/v0/{topstories,newstories,showstories,askstories,jobstories}.json` — id lists
- `https://hacker-news.firebaseio.com/v0/item/{id}.json` — single item
- `https://hacker-news.firebaseio.com/v0/user/{id}.json` — user record

`api.js` reshapes the Firebase records into the same `{ id, title, url, domain, points, user, time_ago, comments_count, type, comments }` shape that solid-hackernews's `node-hnapi.herokuapp.com` produces, so the components are API-agnostic.

Comment fetches are capped (`depth = 3`, `KIDS_PER_LEVEL = 20`, total ≤ 150 nodes) to keep the wall-clock under ~2s even on the front-page mega-thread.

## Running

```sh
# from this directory:
pnpm dev
```

Then open <http://localhost:5180>.

## Layout

```
hacker-news/
├── index.html                — single root <div id="app">
├── vite.config.js            — uses inferno-next/compiler vite plugin
├── package.json
└── src/
    ├── main.js               — createRoot + render
    ├── App.tsrx              — router switch + link interception
    ├── api.js                — Firebase HN client + memo cache
    ├── router.js             — pathname router + useRoute hook
    ├── styles.css            — Vue-HN-style blue (#335d92)
    └── components/
        ├── Nav.tsrx
        ├── Story.tsrx        — one row in the story list
        ├── StoryList.tsrx    — listing + pagination + useDeferredValue
        ├── StoryDetail.tsrx  — story header + comments
        ├── Comment.tsrx      — recursive, collapsible
        └── UserView.tsrx
```

Total: ~250 lines of `.tsrx` + ~150 lines of `.js` + 250 lines of CSS.
