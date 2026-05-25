/**
 * inferno-next runtime — template-clone renderer with React-shape state model.
 *
 * Architecture: see /PLAN-TEMPLATE-RUNTIME.md.
 *
 * Block = mount/unmount boundary (Root / control-flow / dynamic / portal).
 * Scope = per-call-site hook bag inside a Block.
 * Hooks key by compile-time Symbol per call site (conditional-safe).
 * State: React-shape immutable values + setters that schedule the enclosing Block.
 * Updates: microtask-flushed queue with automatic batching.
 * Effects: three-phase pipeline (insertion sync → layout sync → passive post-paint).
 * Reconciliation: LIS-based keyed list inside forBlock (ported from Inferno's patchKeyedChildrenComplex).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComponentBody<P = any, E = any> = (scope: Scope, props: P, extra: E) => void;
export type EffectFn = () => void | (() => void);
export type Cleanup = () => void;

export interface Scope {
  block: Block;
  parent: Scope | null;
  hooks: Map<symbol, any>;
  cleanups: Cleanup[];
  /**
   * Per-call-site child scopes, stored as `[key, scope]` pairs in a flat array
   * (NOT a Map): iteration is a plain indexed for-loop, and lookups are linear
   * scans — faster than `Map.get` for the typical N ≤ 8 case (most components
   * have a handful of static sub-component calls at most).
   */
  children: ChildScope[];
  mounted: boolean;
  // Bindings (b$0, b$1, ...) are stamped directly on the scope by compiled bodies.
  [key: string]: any;
}

interface ChildScope {
  key: symbol;
  scope: Scope;
}

export type BlockKind = 'root' | 'control-flow' | 'dynamic' | 'portal';

export interface Block extends Scope {
  kind: BlockKind;
  parentBlock: Block | null;
  parentNode: Node;
  startMarker: Node | null;
  endMarker: Node | null;
  body: ComponentBody;
  props: any;
  extra: any;
  pending: boolean;
  disposed: boolean;
  /** Set on item Blocks: pointer to the enclosing for-block's slot. */
  forSlot: ForSlot | null;
}

interface EffectSlot {
  deps: any[] | undefined;
  cleanup: Cleanup | undefined;
}

interface PendingEffect {
  scope: Scope;
  slot: symbol;
  fn: EffectFn;
  args: any[];
}

// ---------------------------------------------------------------------------
// Current-scope/block stacks
// ---------------------------------------------------------------------------

let CURRENT_SCOPE: Scope | null = null;
let CURRENT_BLOCK: Block | null = null;

export function getCurrentScope(): Scope {
  return CURRENT_SCOPE!;
}
export function getCurrentBlock(): Block {
  return CURRENT_BLOCK!;
}

// ---------------------------------------------------------------------------
// Scheduler — microtask-flushed queue with React-18-shaped automatic batching
// ---------------------------------------------------------------------------

const QUEUE: Block[] = [];
let scheduled = false;
let flushDepth = 0;       // re-entrancy guard for setters fired during render
let syncFlush = false;    // flushSync sets this to drain the queue synchronously

const INSERTION = 0, LAYOUT = 1, PASSIVE = 2;
type Phase = 0 | 1 | 2;

const effectQueues: [PendingEffect[], PendingEffect[], PendingEffect[]] = [[], [], []];
let passiveScheduled = false;

export function scheduleRender(block: Block): void {
  if (block.disposed || block.pending) return;
  block.pending = true;
  QUEUE.push(block);
  if (syncFlush) return;
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

function flush(): void {
  scheduled = false;
  flushDepth++;
  try {
    // Drain the queue; setters fired during a body re-add to QUEUE and we keep draining.
    while (QUEUE.length) {
      const block = QUEUE.shift()!;
      block.pending = false;
      if (!block.disposed) renderBlock(block);
    }
    commitEffects();
  } finally {
    flushDepth--;
  }
}

/**
 * React-DOM parity. Runs `fn` and synchronously drains any renders/effects it scheduled
 * before returning. Bypasses the microtask-batched flush — used by the benchmark
 * timing rig to measure operation wall-clock without microtask coalescing.
 */
export function flushSync<T>(fn: () => T): T {
  const prevSync = syncFlush;
  syncFlush = true;
  try {
    const result = fn();
    // Drain anything scheduled by fn.
    while (QUEUE.length) {
      const block = QUEUE.shift()!;
      block.pending = false;
      if (!block.disposed) renderBlock(block);
    }
    commitEffectsSync();
    return result;
  } finally {
    syncFlush = prevSync;
  }
}

// ---------------------------------------------------------------------------
// Effect commit pipeline (insertion → layout → passive)
// ---------------------------------------------------------------------------

function commitEffects(): void {
  drainPhase(INSERTION);
  drainPhase(LAYOUT);
  if (effectQueues[PASSIVE].length && !passiveScheduled) {
    passiveScheduled = true;
    schedulePostPaint(() => {
      passiveScheduled = false;
      drainPhase(PASSIVE);
    });
  }
}

/**
 * Test/test-environment helper — synchronously drain any queued passive
 * (`useEffect`) bodies that would normally fire after paint. Idempotent.
 * Real apps should not call this; rely on the normal post-paint scheduler.
 */
export function drainPassiveEffects(): void {
  // Cancel any scheduler-side passive drain that hadn't fired yet — we're
  // about to drain inline.
  passiveScheduled = false;
  drainPhase(PASSIVE);
}

function commitEffectsSync(): void {
  // Match React semantics: flushSync drains insertion + layout synchronously,
  // but passive effects (useEffect) still fire AFTER paint via the regular scheduler.
  drainPhase(INSERTION);
  drainPhase(LAYOUT);
  if (effectQueues[PASSIVE].length > 0 && !passiveScheduled) {
    passiveScheduled = true;
    schedulePostPaint(() => {
      passiveScheduled = false;
      drainPhase(PASSIVE);
    });
  }
}

function drainPhase(phase: Phase): void {
  const q = effectQueues[phase];
  if (q.length === 0) return;
  // Cleanups first (in registration order), then bodies. React's contract.
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.scope.block.disposed) continue;
    const slot = e.scope.hooks.get(e.slot) as EffectSlot | undefined;
    if (slot && slot.cleanup) {
      try { slot.cleanup(); } catch (err) { console.error(err); }
      slot.cleanup = undefined;
    }
  }
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e.scope.block.disposed) continue;
    let cleanup: void | Cleanup;
    try {
      cleanup = e.fn.apply(null, e.args);
    } catch (err) {
      // Route effect errors to the nearest enclosing tryBlock, if any.
      const handler = findTryHandler(e.scope.block);
      if (handler) handler(err);
      else console.error(err);
      continue;
    }
    const slot = e.scope.hooks.get(e.slot) as EffectSlot | undefined;
    if (slot && typeof cleanup === 'function') {
      slot.cleanup = cleanup;
      e.scope.cleanups.push(cleanup);
    }
  }
  q.length = 0;
}

// `schedulePostPaint` — fires after the next paint (React's scheduler trick).
let _postPaintCbs: Array<() => void> = [];
let _channel: MessageChannel | null = null;
if (typeof MessageChannel !== 'undefined') {
  _channel = new MessageChannel();
  _channel.port1.onmessage = () => {
    const cbs = _postPaintCbs;
    _postPaintCbs = [];
    for (let i = 0; i < cbs.length; i++) cbs[i]();
  };
}
function schedulePostPaint(cb: () => void): void {
  _postPaintCbs.push(cb);
  if (_channel) {
    // rAF lands before paint; MessageChannel posts a macrotask after paint.
    requestAnimationFrame(() => _channel!.port2.postMessage(0));
  } else {
    requestAnimationFrame(() => setTimeout(() => {
      const cbs = _postPaintCbs;
      _postPaintCbs = [];
      for (let i = 0; i < cbs.length; i++) cbs[i]();
    }, 0));
  }
}

// ---------------------------------------------------------------------------
// Block + Scope creation
// ---------------------------------------------------------------------------

export function createBlock(
  kind: BlockKind,
  parentBlock: Block | null,
  parentNode: Node,
  startMarker: Node | null,
  endMarker: Node | null,
  body: ComponentBody,
  props: any,
  extra?: any,
): Block {
  const block: Block = {
    kind,
    parentBlock,
    parentNode,
    startMarker,
    endMarker,
    body,
    props,
    extra,
    hooks: new Map(),
    cleanups: [],
    children: [],
    mounted: false,
    pending: false,
    disposed: false,
    forSlot: null,
    parent: null,
    // `block: self` makes a Block satisfy the Scope contract.
    block: null as any,
  };
  block.block = block;
  return block;
}

export function renderBlock(block: Block): void {
  const prevScope = CURRENT_SCOPE;
  const prevBlock = CURRENT_BLOCK;
  CURRENT_SCOPE = block;
  CURRENT_BLOCK = block;
  try {
    block.body(block, block.props, block.extra);
    if (!block.mounted) block.mounted = true;
  } finally {
    CURRENT_SCOPE = prevScope;
    CURRENT_BLOCK = prevBlock;
  }
}

/**
 * Open (or reuse) a per-call-site Scope inside the current Block, then run `body` in it.
 * The compiler emits this for every static-inline component call.
 */
export function withScope<P>(
  parent: Scope,
  key: symbol,
  body: ComponentBody<P>,
  props: P,
): void {
  const children = parent.children;
  let scope: Scope | undefined;
  // Linear scan — faster than Map.get for the typical small N. Most parents
  // have ≤ 4 sub-component call sites.
  for (let i = 0, n = children.length; i < n; i++) {
    if (children[i].key === key) { scope = children[i].scope; break; }
  }
  if (scope === undefined) {
    scope = {
      block: parent.block,
      parent,
      hooks: new Map(),
      cleanups: [],
      children: [],
      mounted: false,
    };
    children.push({ key, scope });
  }
  const prevScope = CURRENT_SCOPE;
  CURRENT_SCOPE = scope;
  try {
    body(scope, props, undefined);
    if (!scope.mounted) scope.mounted = true;
  } finally {
    CURRENT_SCOPE = prevScope;
  }
}

export function unmountBlock(block: Block): void {
  if (block.disposed) return;
  block.disposed = true;
  // Depth-first cleanup of all scopes reachable from this block.
  unmountScope(block);
  // Remove DOM range.
  if (block.startMarker && block.endMarker) {
    const parent = block.startMarker.parentNode;
    if (parent) {
      let n: Node | null = block.startMarker;
      const stop = block.endMarker.nextSibling;
      while (n && n !== stop) {
        const next: Node | null = n.nextSibling;
        parent.removeChild(n);
        n = next;
      }
    }
  } else {
    // Root block — clear the whole container.
    while (block.parentNode.firstChild) {
      block.parentNode.removeChild(block.parentNode.firstChild);
    }
  }
}

/** Fire cleanups (depth-first child scopes first) without touching the DOM. */
function fireCleanupsOnly(scope: Scope): void {
  const children = scope.children;
  for (let i = 0, n = children.length; i < n; i++) fireCleanupsOnly(children[i].scope);
  const c = scope.cleanups;
  for (let i = 0, n = c.length; i < n; i++) {
    try { c[i](); } catch (err) { console.error(err); }
  }
}

function unmountScope(scope: Scope): void {
  // Recurse into child scopes first.
  const children = scope.children;
  for (let i = 0, n = children.length; i < n; i++) unmountScope(children[i].scope);
  // Walk slot-stashed child Blocks (ifBlock / forBlock / componentSlot / portal).
  for (const key in scope) {
    if (key.charCodeAt(0) === 95 /* '_' */) {
      const val = scope[key];
      if (val && val.__kind === 'ifBlockSlot') {
        if (val.block) unmountBlock(val.block);
      } else if (val && val.__kind === 'forBlockSlot') {
        const items = val.items as Map<any, Block>;
        const it = items.values();
        for (let r = it.next(); !r.done; r = it.next()) unmountBlock(r.value);
      } else if (val && (val.__kind === 'componentSlotSlot' || val.__kind === 'portalSlotSlot' || val.__kind === 'trySlotSlot')) {
        if (val.block) unmountBlock(val.block);
      }
    }
  }
  // Fire cleanups in registration order (React semantics — cleanups before bodies).
  const c = scope.cleanups;
  for (let i = 0, n = c.length; i < n; i++) {
    try { c[i](); } catch (err) { console.error(err); }
  }
}

// ---------------------------------------------------------------------------
// Hooks — keyed by compile-time Symbol per call site
// ---------------------------------------------------------------------------

interface StateSlot<T> { value: T; setter: (next: T | ((prev: T) => T)) => void; }

export function useState<T>(
  initial: T | (() => T),
  slot: symbol,
): [T, (next: T | ((prev: T) => T)) => void] {
  const scope = CURRENT_SCOPE!;
  const block = CURRENT_BLOCK!;
  let s = scope.hooks.get(slot) as StateSlot<T> | undefined;
  if (s === undefined) {
    const initVal = typeof initial === 'function' ? (initial as () => T)() : initial;
    s = {
      value: initVal,
      setter: (next) => {
        const computed = typeof next === 'function'
          ? (next as (p: T) => T)(s!.value)
          : next;
        if (Object.is(computed, s!.value)) return;
        s!.value = computed;
        scheduleRender(block);
      },
    };
    scope.hooks.set(slot, s);
  }
  return [s.value, s.setter];
}

export function useReducer<S, A>(
  reducer: (s: S, a: A) => S,
  initial: S | (() => S),
  slot: symbol,
): [S, (action: A) => void] {
  const scope = CURRENT_SCOPE!;
  const block = CURRENT_BLOCK!;
  let s = scope.hooks.get(slot) as { value: S; dispatch: (a: A) => void; reducer: (s: S, a: A) => S } | undefined;
  if (s === undefined) {
    const initVal = typeof initial === 'function' ? (initial as () => S)() : initial;
    s = {
      value: initVal,
      reducer,
      dispatch: (action) => {
        const next = s!.reducer(s!.value, action);
        if (Object.is(next, s!.value)) return;
        s!.value = next;
        scheduleRender(block);
      },
    };
    scope.hooks.set(slot, s);
  } else {
    // Allow reducer reference to update across renders.
    s.reducer = reducer;
  }
  return [s.value, s.dispatch];
}

function depsChanged(prev: any[] | undefined, next: any[] | undefined): boolean {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

function enqueueEffect(slot: symbol, fn: EffectFn, deps: any[], phase: Phase): void {
  const scope = CURRENT_SCOPE!;
  const prev = scope.hooks.get(slot) as EffectSlot | undefined;
  if (prev && !depsChanged(prev.deps, deps)) return;
  if (!prev) {
    scope.hooks.set(slot, { deps, cleanup: undefined });
    // Mark any enclosing for-block items so batch-clear knows to walk cleanups.
    let b: Block | null = scope.block;
    while (b) {
      if (b.forSlot) b.forSlot.hasCleanups = true;
      b = b.parentBlock;
    }
  } else {
    prev.deps = deps;
  }
  effectQueues[phase].push({ scope, slot, fn, args: deps });
}

export function useEffect(fn: EffectFn, deps: any[], slot: symbol): void {
  enqueueEffect(slot, fn, deps, PASSIVE);
}
export function useLayoutEffect(fn: EffectFn, deps: any[], slot: symbol): void {
  enqueueEffect(slot, fn, deps, LAYOUT);
}
export function useInsertionEffect(fn: EffectFn, deps: any[], slot: symbol): void {
  enqueueEffect(slot, fn, deps, INSERTION);
}

export function useMemo<T>(compute: (...deps: any[]) => T, deps: any[], slot: symbol): T {
  const scope = CURRENT_SCOPE!;
  const prev = scope.hooks.get(slot) as { deps: any[]; value: T } | undefined;
  if (prev && !depsChanged(prev.deps, deps)) return prev.value;
  const value = compute.apply(null, deps);
  scope.hooks.set(slot, { deps, value });
  return value;
}

export function useCallback<F extends (...args: any[]) => any>(fn: F, deps: any[], slot: symbol): F {
  return useMemo(() => fn, deps, slot);
}

export function useRef<T>(initial: T, slot: symbol): { current: T } {
  const scope = CURRENT_SCOPE!;
  let s = scope.hooks.get(slot) as { current: T } | undefined;
  if (s === undefined) {
    s = { current: initial };
    scope.hooks.set(slot, s);
  }
  return s;
}

/**
 * React's `useImperativeHandle(ref, factory, deps)` — exposes an imperative
 * API to a parent via the ref. Scheduled as a layout-phase effect so the
 * `ref.current` is populated before paint and before any layout effects in
 * ancestors that depend on the API. Cleared to null on unmount.
 */
export function useImperativeHandle<T>(
  ref: { current: T | null } | ((value: T | null) => void) | null | undefined,
  factory: () => T,
  deps: any[],
  slot: symbol,
): void {
  const setRef = (value: T | null): void => {
    if (typeof ref === 'function') (ref as any)(value);
    else if (ref != null) (ref as { current: T | null }).current = value;
  };
  enqueueEffect(slot, () => {
    setRef(factory());
    return () => setRef(null);
  }, deps, LAYOUT);
}

/**
 * React 19 `useEffectEvent` — returns a stable function whose body always
 * reflects the latest version of `fn`. Use inside `useEffect` deps to escape
 * the "must re-create the effect just because a closure-captured value changed"
 * trap. The returned function has the same identity across renders; calling it
 * invokes the most-recent `fn` (i.e., it always sees fresh closure values).
 */
export function useEffectEvent<F extends (...args: any[]) => any>(fn: F, slot: symbol): F {
  const scope = CURRENT_SCOPE!;
  let s = scope.hooks.get(slot) as { current: F; stable: F } | undefined;
  if (s === undefined) {
    const stable = ((...args: any[]) => s!.current.apply(null, args)) as F;
    s = { current: fn, stable };
    scope.hooks.set(slot, s);
  } else {
    s.current = fn;
  }
  return s.stable;
}

// ---------------------------------------------------------------------------
// Context — createContext + use() (React 19 shape, no useContext)
// ---------------------------------------------------------------------------

const CONTEXT_TAG = Symbol.for('inferno-next.context');

export interface Context<T> {
  $$kind: typeof CONTEXT_TAG;
  defaultValue: T;
  Provider: ComponentBody<{ value: T; children?: any }>;
}

/**
 * Create a Context. Providers push the value into a Block-scoped slot; `use(ctx)`
 * walks the Block parent chain to find the nearest Provider for that context.
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const ctx = { $$kind: CONTEXT_TAG, defaultValue } as Context<T>;
  // A Provider is a built-in component that stamps the value on its Block
  // and renders its `children` body inside its scope.
  ctx.Provider = function ProviderBody(scope, props) {
    // Stash on the scope (not block) so siblings of the Provider don't see it.
    (scope as any).$$ctxValues ??= new Map();
    (scope as any).$$ctxValues.set(ctx, props.value);
    // Children is the compiled render-body for the JSX between the Provider tags.
    if (typeof props.children === 'function') {
      props.children(scope);
    }
  };
  return ctx;
}

/**
 * React 19's `use()` — for the spike, supports `use(context)` only.
 * Walks the Block tree from CURRENT_BLOCK upward to find a Provider's value.
 */
/**
 * Walk Scope.parent (within current block) then Block.parentBlock (cross-block)
 * looking for a Provider for `context`. Returns the nearest value or the default.
 */
export function use<T>(context: Context<T>): T {
  if (!context || context.$$kind !== CONTEXT_TAG) {
    throw new Error('use(): argument is not a Context (Suspense / promise use() not implemented yet)');
  }
  let s: Scope | null = CURRENT_SCOPE;
  while (s !== null) {
    const m = (s as any).$$ctxValues as Map<Context<any>, any> | undefined;
    if (m && m.has(context)) return m.get(context) as T;
    s = s.parent;
  }
  // Cross block boundaries: walk up from the parent block's root scope.
  let b: Block | null = CURRENT_BLOCK ? CURRENT_BLOCK.parentBlock : null;
  while (b !== null) {
    const m = (b as any).$$ctxValues as Map<Context<any>, any> | undefined;
    if (m && m.has(context)) return m.get(context) as T;
    b = b.parentBlock;
  }
  return context.defaultValue;
}

// Monotonic counter — produces stable cross-render IDs.
let _idCounter = 0;
export function useId(slot: symbol): string {
  const scope = CURRENT_SCOPE!;
  let s = scope.hooks.get(slot) as { id: string } | undefined;
  if (s === undefined) {
    s = { id: ':in-' + (_idCounter++).toString(36) + ':' };
    scope.hooks.set(slot, s);
  }
  return s.id;
}

// ---------------------------------------------------------------------------
// Templates: parse-once HTML → clone-per-instance
// ---------------------------------------------------------------------------

// Namespace flag: 0 = HTML, 1 = SVG, 2 = MathML. The compiler picks the
// constant; we never look at namespaceURI at runtime.
export function template(html: string, ns: number = 0, frag: number = 0): Element {
  const t = document.createElement('template');
  if (ns === 0) {
    t.innerHTML = html;
    return t.content.firstChild as Element;
  }
  // Wrap in <svg>/<math> so the HTML5 parser places descendants in the right
  // foreign-content namespace (Svelte/Ripple's trick — also works around
  // happy-dom which doesn't enter MathML foreign-content mode from a bare
  // <math> root). For multi-root templates (frag=1) return the wrapper itself
  // so the caller can drain its children.
  const wrap = ns === 1 ? 'svg' : 'math';
  t.innerHTML = `<${wrap}>${html}</${wrap}>`;
  const wrapEl = t.content.firstChild as Element;
  return frag ? wrapEl : (wrapEl.firstChild as Element);
}

export function clone<T extends Node>(node: T): T {
  return node.cloneNode(true) as T;
}

// ---------------------------------------------------------------------------
// Patch helpers — `prev !== next` guards are emitted by the compiler/author;
// these helpers are unconditional "set this now" with internal data check.
// ---------------------------------------------------------------------------

export function setText(node: Text, value: any): void {
  const next = value == null || value === false ? '' : (typeof value === 'string' ? value : String(value));
  if (node.data !== next) node.data = next;
}

export function setAttribute(el: Element, name: string, value: any): void {
  if (value == null || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

export function setClassName(el: Element, value: string | null | undefined): void {
  // Fast path on HTMLElement. For SVG/MathML hosts the compiler emits
  // setAttribute(el, 'class', ...) directly — never routes here — because
  // SVGElement.className is a read-only SVGAnimatedString and assignment
  // is a no-op in real browsers.
  (el as any).className = value == null ? '' : value;
}

// ---------------------------------------------------------------------------
// Style — kebab-case object form (Inferno semantics) or full cssText string.
// `prev` is the previous value tracked by the compiler so we can diff
// object→object and only touch the properties that changed.
// ---------------------------------------------------------------------------

const IMPORTANT_RE = /\s*!important\s*$/;

export function setStyle(el: HTMLElement | SVGElement, value: any, prev: any): void {
  const style = (el as HTMLElement).style;

  if (value == null || value === false || value === '') {
    if (prev != null && prev !== false && prev !== '') style.cssText = '';
    return;
  }

  if (typeof value === 'string') {
    if (prev !== value) style.cssText = value;
    return;
  }

  // Object form. If prev is an object too, diff per-property — only changed
  // keys are touched. Otherwise (prev was string / null) reset cssText first
  // so leftover declarations don't leak across the transition.
  if (prev && typeof prev === 'object') {
    for (const k in prev) {
      if (!(k in value)) style.removeProperty(k);
    }
    for (const k in value) {
      const v = value[k];
      if (v === prev[k]) continue;
      if (v == null || v === false) style.removeProperty(k);
      else applyStyleProperty(style, k, v);
    }
  } else {
    if (typeof prev === 'string') style.cssText = '';
    for (const k in value) {
      const v = value[k];
      if (v != null && v !== false) applyStyleProperty(style, k, v);
    }
  }
}

function applyStyleProperty(style: CSSStyleDeclaration, name: string, value: any): void {
  const s = typeof value === 'number' ? String(value) : (value as string);
  if (IMPORTANT_RE.test(s)) {
    style.setProperty(name, s.replace(IMPORTANT_RE, ''), 'important');
  } else {
    style.setProperty(name, s);
  }
}

// ---------------------------------------------------------------------------
// Component-scoped <style> injection — idempotent, keyed by the compiled
// stylesheet hash so repeated mounts (or HMR re-imports) inject once.
// ---------------------------------------------------------------------------

const _injectedStyles = new Set<string>();

export function injectStyle(id: string, css: string): void {
  if (_injectedStyles.has(id)) return;
  _injectedStyles.add(id);
  const el = document.createElement('style');
  el.setAttribute('data-inferno-next', id);
  el.textContent = css;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Events — top-level delegation. Handlers stored as bare functions or { fn, args } bundles.
// ---------------------------------------------------------------------------

interface HandlerBundle {
  fn: (...args: any[]) => any;
  args: any[];
}
type EventSlot = ((event: Event) => any) | HandlerBundle | null | undefined;

const _delegated = new Set<string>();

export function delegateEvents(eventNames: string[]): void {
  for (let i = 0; i < eventNames.length; i++) {
    const name = eventNames[i];
    if (_delegated.has(name)) continue;
    _delegated.add(name);
    document.addEventListener(name, dispatchDelegated);
  }
}

function dispatchDelegated(event: Event): void {
  const key = '$$' + event.type;
  let node = event.target as any;
  while (node !== null && node !== undefined) {
    const slot = node[key] as EventSlot;
    if (slot) {
      if (typeof slot === 'function') {
        slot(event);
      } else {
        // bundle: fn(...args, event)
        const a = slot.args;
        switch (a.length) {
          case 0: slot.fn(event); break;
          case 1: slot.fn(a[0], event); break;
          case 2: slot.fn(a[0], a[1], event); break;
          default: slot.fn.apply(null, a.concat(event));
        }
      }
      if (event.cancelBubble) return;
    }
    // Portal-aware ascent: when crossing a portal root, jump to the rendering Block's DOM parent.
    if (node.$$portalParent) {
      node = node.$$portalParent;
    } else {
      node = node.parentNode;
    }
  }
}

// ---------------------------------------------------------------------------
// Portals — createPortal renders into a foreign DOM target while staying
// part of the React-tree for context / unmount / event delegation.
// ---------------------------------------------------------------------------

interface PortalSlot {
  __kind: 'portalSlotSlot';
  block: Block | null;
  target: Element | null;
  start: Comment | null;
  end: Comment | null;
}

/**
 * Mount `body` into `target` (a foreign DOM element), as a child of the
 * current Block in the Block tree. Re-rendering the enclosing Block re-runs
 * the portal body in place. Unmounting the enclosing Block tears the portal
 * down and removes its DOM from `target`.
 */
export function portal(
  parentScope: Scope,
  slotKey: string,
  target: Element,
  body: ComponentBody,
  props: any,
): void {
  const parentBlock = parentScope.block;
  let state = parentScope[slotKey] as PortalSlot | undefined;
  if (state === undefined) {
    const start = document.createComment('portal');
    const end = document.createComment('/portal');
    target.appendChild(start);
    target.appendChild(end);
    const block = createBlock('portal', parentBlock, target, start, end, body, props);
    state = { __kind: 'portalSlotSlot', block, target, start, end };
    parentScope[slotKey] = state;
    renderBlock(block);
  } else {
    state.block!.body = body;
    state.block!.props = props;
    renderBlock(state.block!);
  }
}

/**
 * ReactDOM-shape `createPortal(children, target, props?)`. The compiler
 * recognises `{createPortal(...)}` at JSX child position and lowers it to a
 * direct `portal(...)` runtime call — no descriptor allocation on the hot
 * path. This function exists so the call shape matches ReactDOM exactly and
 * so non-JSX call sites (storing in a variable, passing through props, etc.)
 * still produce something the runtime can dispatch on.
 */
const PORTAL_TAG = Symbol.for('inferno-next.portal');
export interface PortalDescriptor {
  $$kind: typeof PORTAL_TAG;
  body: ComponentBody;
  target: Element;
  props: any;
}
export function createPortal(
  body: ComponentBody,
  target: Element,
  props: any = undefined,
): PortalDescriptor {
  return { $$kind: PORTAL_TAG, body, target, props };
}

// ---------------------------------------------------------------------------
// Component slot — JSX `<Foo>` / `<ctx.Provider>` invocation as a Block
// ---------------------------------------------------------------------------

interface CompSlot {
  __kind: 'componentSlotSlot';
  start: Comment;
  end: Comment;
  block: Block | null;
  currentComp: ComponentBody | null;
}

/**
 * Mount/update a component invoked from JSX. Each invocation creates a Block
 * (so hooks/effects are scoped properly). If the component identity changes
 * across renders (dynamic-component / element-type swap), the old Block is
 * torn down and a fresh one mounted in its place.
 */
export function componentSlot(
  parentScope: Scope,
  slotKey: string,
  domParent: Node,
  comp: ComponentBody,
  props: any,
  anchor?: Node | null,
): void {
  const parentBlock = parentScope.block;
  let state = parentScope[slotKey] as CompSlot | undefined;
  if (state === undefined) {
    const start = document.createComment('comp');
    const end = document.createComment('/comp');
    // insertBefore(_, null) === appendChild — covers both end-of-parent and
    // mid-range insertion (e.g. when this slot lives in a multi-root template
    // and must sit before its enclosing block's endMarker).
    domParent.insertBefore(start, anchor ?? null);
    domParent.insertBefore(end, anchor ?? null);
    state = { __kind: 'componentSlotSlot', start, end, block: null, currentComp: null };
    parentScope[slotKey] = state;
  }
  if (comp !== state.currentComp) {
    if (state.block) unmountBlock(state.block);
    state.currentComp = comp;
    const b = createBlock('dynamic', parentBlock, domParent, state.start, state.end, comp, props);
    state.block = b;
    renderBlock(b);
  } else if (state.block) {
    state.block.props = props;
    renderBlock(state.block);
  }
}

// ---------------------------------------------------------------------------
// Control flow: tryBlock — error boundary, catches render + effect errors
// ---------------------------------------------------------------------------

interface TrySlot {
  __kind: 'trySlotSlot';
  start: Comment;
  end: Comment;
  branch: -1 | 0 | 1;   // -1 init, 0 catch, 1 try
  block: Block | null;
  tryBody: ComponentBody;
  catchBody: ComponentBody;
  err: any;
  domParent: Node;
  parentBlock: Block;
}

export function tryBlock(
  parentScope: Scope,
  slotKey: string,
  domParent: Node,
  tryBody: ComponentBody,
  catchBody: ComponentBody,
): void {
  const parentBlock = parentScope.block;
  let state = parentScope[slotKey] as TrySlot | undefined;
  if (state === undefined) {
    const start = document.createComment('try');
    const end = document.createComment('/try');
    domParent.appendChild(start);
    domParent.appendChild(end);
    state = {
      __kind: 'trySlotSlot', start, end, branch: -1, block: null,
      tryBody, catchBody, err: null, domParent, parentBlock,
    };
    parentScope[slotKey] = state;
  } else {
    state.tryBody = tryBody;
    state.catchBody = catchBody;
  }
  if (state.branch === 0) {
    // Already showing catch — re-render with current err.
    state.block!.body = state.catchBody;
    state.block!.props = { err: state.err, reset: () => mountTry(state) };
    renderBlock(state.block!);
  } else {
    mountTry(state);
  }
}

function mountTry(state: TrySlot): void {
  if (state.block) { unmountBlock(state.block); state.block = null; }
  state.branch = 1;
  const bStart = document.createComment('try-b');
  const bEnd = document.createComment('/try-b');
  state.domParent.insertBefore(bStart, state.end);
  state.domParent.insertBefore(bEnd, state.end);
  const b = createBlock('control-flow', state.parentBlock, state.domParent, bStart, bEnd, state.tryBody, undefined);
  // Register error handler so descendant effect/render errors can find us.
  (b as any).$$tryHandler = (err: any) => switchToCatch(state, err);
  state.block = b;
  try {
    renderBlock(b);
  } catch (err) {
    if (state.block) { unmountBlock(state.block); state.block = null; }
    switchToCatch(state, err);
  }
}

function switchToCatch(state: TrySlot, err: any): void {
  if (state.block) { unmountBlock(state.block); state.block = null; }
  state.branch = 0;
  state.err = err;
  const bStart = document.createComment('catch-b');
  const bEnd = document.createComment('/catch-b');
  state.domParent.insertBefore(bStart, state.end);
  state.domParent.insertBefore(bEnd, state.end);
  const reset = () => mountTry(state);
  const b = createBlock(
    'control-flow',
    state.parentBlock,
    state.domParent,
    bStart, bEnd,
    state.catchBody,
    { err, reset },
  );
  state.block = b;
  try {
    renderBlock(b);
  } catch (e2) {
    // Catch body itself threw — bubble to next enclosing tryBlock.
    if (state.block) { unmountBlock(state.block); state.block = null; }
    const parent = findTryHandler(state.parentBlock);
    if (parent) parent(e2);
    else console.error('catch body threw, no outer tryBlock:', e2);
  }
}

/** Walk Block.parentBlock chain looking for a `$$tryHandler` registration. */
export function findTryHandler(block: Block | null): ((err: any) => void) | null {
  let b: Block | null = block;
  while (b) {
    const h = (b as any).$$tryHandler;
    if (h) return h;
    b = b.parentBlock;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Control flow: ifBlock — swap a subtree based on a predicate
// ---------------------------------------------------------------------------

interface IfSlot {
  __kind: 'ifBlockSlot';
  start: Comment;
  end: Comment;
  /** Current branch: 1 = then, 0 = else, -1 = uninitialized. */
  branch: -1 | 0 | 1;
  block: Block | null;
}

export function ifBlock(
  parentScope: Scope,
  slotKey: string,
  domParent: Node,
  cond: boolean,
  thenBody: ComponentBody | null,
  elseBody: ComponentBody | null,
): void {
  const parentBlock = parentScope.block;
  let state = parentScope[slotKey] as IfSlot | undefined;
  if (state === undefined) {
    const start = document.createComment('if');
    const end = document.createComment('/if');
    domParent.appendChild(start);
    domParent.appendChild(end);
    state = { __kind: 'ifBlockSlot', start, end, branch: -1, block: null };
    parentScope[slotKey] = state;
  }
  const next: 0 | 1 = cond ? 1 : 0;
  const body = next ? thenBody : elseBody;
  if (next !== state.branch) {
    // Branch changed — tear down old, mount new.
    if (state.block) { unmountBlock(state.block); state.block = null; }
    state.branch = next;
    if (body) {
      // Each branch gets its OWN start/end markers inside the if's permanent
      // range. Branch unmount removes them along with the branch's DOM; the
      // permanent state.start / state.end stay put.
      const bStart = document.createComment('br');
      const bEnd = document.createComment('/br');
      domParent.insertBefore(bStart, state.end);
      domParent.insertBefore(bEnd, state.end);
      const b = createBlock('control-flow', parentBlock, domParent, bStart, bEnd, body, undefined);
      state.block = b;
      renderBlock(b);
    }
  } else if (state.block) {
    // Same branch — re-render in place.
    state.block.body = body!;
    renderBlock(state.block);
  }
}

// ---------------------------------------------------------------------------
// Control flow: forBlock with LIS-based keyed reconciliation
// ---------------------------------------------------------------------------

interface ForSlot {
  __kind: 'forBlockSlot';
  start: Comment;
  end: Comment;
  items: Map<any, Block>;   // key → item Block
  order: any[];              // current key order
  hasCleanups: boolean;      // true once any item registered a useEffect cleanup
}

export function forBlock<T, E = undefined>(
  parentScope: Scope,
  slotKey: string,
  domParent: Node,
  items: ArrayLike<T>,
  getKey: (item: T, index: number) => any,
  itemBody: (scope: Scope, item: T, extra: E) => void,
  extra?: E,
): void {
  const parentBlock = parentScope.block;
  let state = parentScope[slotKey] as ForSlot | undefined;
  if (state === undefined) {
    const start = document.createComment('for');
    const end = document.createComment('/for');
    domParent.appendChild(start);
    domParent.appendChild(end);
    state = { __kind: 'forBlockSlot', start, end, items: new Map(), order: [], hasCleanups: false };
    parentScope[slotKey] = state;
  }
  reconcileKeyed(parentBlock, state, items, getKey, itemBody as any, extra);
}

function reconcileKeyed<T, E>(
  parentBlock: Block,
  state: ForSlot,
  items: ArrayLike<T>,
  getKey: (item: T, index: number) => any,
  itemBody: (scope: Scope, item: T, extra: E) => void,
  extra: E,
): void {
  const oldOrder = state.order;
  const oldItems = state.items;
  const oldLen = oldOrder.length;
  const newLen = items.length;
  const parentNode = state.end.parentNode!;

  // Fast path: empty → fill
  if (oldLen === 0) {
    if (newLen === 0) return;
    const newOrder: any[] = new Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const item = items[i];
      const key = getKey(item, i);
      const block = mountItem(parentBlock, parentNode, state.end, item, itemBody, extra, state);
      oldItems.set(key, block);
      newOrder[i] = key;
    }
    state.order = newOrder;
    return;
  }
  // Fast path: clear all
  if (newLen === 0) {
    batchClearItems(state, oldItems);
    state.order = [];
    return;
  }

  // Find common prefix
  let prefixLen = 0;
  const minLen = oldLen < newLen ? oldLen : newLen;
  while (prefixLen < minLen) {
    const oldKey = oldOrder[prefixLen];
    const newKey = getKey(items[prefixLen], prefixLen);
    if (oldKey !== newKey) break;
    // Same key, same position — re-render in place.
    const block = oldItems.get(oldKey)!;
    block.props = items[prefixLen];
    block.extra = extra;
    block.body = itemBody as ComponentBody;
    renderBlock(block);
    prefixLen++;
  }

  if (prefixLen === newLen && newLen === oldLen) {
    // Lists are identical in key order — nothing more to do.
    return;
  }

  // Find common suffix
  let oldEnd = oldLen - 1;
  let newEnd = newLen - 1;
  while (oldEnd >= prefixLen && newEnd >= prefixLen) {
    const oldKey = oldOrder[oldEnd];
    const newKey = getKey(items[newEnd], newEnd);
    if (oldKey !== newKey) break;
    const block = oldItems.get(oldKey)!;
    block.props = items[newEnd];
    block.extra = extra;
    block.body = itemBody as ComponentBody;
    renderBlock(block);
    oldEnd--;
    newEnd--;
  }

  // Middle differs.
  if (prefixLen > oldEnd) {
    // Only inserts in the middle (old exhausted).
    const newOrder: any[] = state.order.slice(0, prefixLen);
    // Anchor: the DOM node right after the suffix items, or end marker.
    const anchor = newEnd + 1 < newLen
      ? oldItems.get(oldOrder[oldEnd + 1])!.startMarker!  // first node of suffix
      : state.end;
    for (let i = prefixLen; i <= newEnd; i++) {
      const item = items[i];
      const key = getKey(item, i);
      const block = mountItem(parentBlock, parentNode, anchor, item, itemBody, extra, state);
      oldItems.set(key, block);
      newOrder.push(key);
    }
    // Suffix keys remain in order.
    for (let i = oldEnd + 1; i < oldLen; i++) newOrder.push(oldOrder[i]);
    state.order = newOrder;
    return;
  }

  if (prefixLen > newEnd) {
    // Only removes in the middle (new exhausted).
    for (let i = prefixLen; i <= oldEnd; i++) {
      const key = oldOrder[i];
      const block = oldItems.get(key)!;
      unmountBlock(block);
      oldItems.delete(key);
    }
    const newOrder: any[] = state.order.slice(0, prefixLen);
    for (let i = oldEnd + 1; i < oldLen; i++) newOrder.push(oldOrder[i]);
    state.order = newOrder;
    return;
  }

  // General case — both have unique middle sections.
  // Build map of new keys → new index for the middle, and count how many old
  // items have a corresponding new key (the survivor count).
  const newKeysToIdx = new Map<any, number>();
  const newKeys: any[] = new Array(newEnd - prefixLen + 1);
  let survivorEstimate = 0;
  for (let i = prefixLen; i <= newEnd; i++) {
    const key = getKey(items[i], i);
    newKeys[i - prefixLen] = key;
    newKeysToIdx.set(key, i);
  }
  for (let i = prefixLen; i <= oldEnd; i++) {
    if (newKeysToIdx.has(oldOrder[i])) { survivorEstimate++; if (survivorEstimate > 0) break; }
  }

  // Full-replace fast path — when zero old items survive the middle (e.g.
  // `replace` op: same length, all new keys), batch-clear the middle's DOM
  // in one op instead of N×3 removeChild calls, then mount all new items.
  // We only take this when the for-block owns its parent AND prefix/suffix
  // are empty (no surviving neighbours that need to stay in place).
  if (survivorEstimate === 0 && prefixLen === 0 && oldEnd === oldLen - 1 && newEnd === newLen - 1) {
    batchClearItems(state, oldItems);
    state.order = [];
    // Now mass-mount the new items, appending each before state.end.
    const newOrder: any[] = new Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const item = items[i];
      const key = newKeys[i];
      const block = mountItem(parentBlock, parentNode, state.end, item, itemBody, extra, state);
      oldItems.set(key, block);
      newOrder[i] = key;
    }
    state.order = newOrder;
    return;
  }

  // sources[i] = old index for new[prefixLen + i], or -1 if new (not in old).
  const sources = new Int32Array(newEnd - prefixLen + 1);
  for (let i = 0; i < sources.length; i++) sources[i] = -1;

  let moved = false;
  let lastIdx = 0;
  let patched = 0;

  // Walk old middle: re-render survivors in place, mark unmounts.
  for (let i = prefixLen; i <= oldEnd; i++) {
    const oldKey = oldOrder[i];
    const newIdx = newKeysToIdx.get(oldKey);
    if (newIdx === undefined) {
      // Removed.
      const block = oldItems.get(oldKey)!;
      unmountBlock(block);
      oldItems.delete(oldKey);
    } else {
      sources[newIdx - prefixLen] = i;
      if (newIdx < lastIdx) moved = true;
      else lastIdx = newIdx;
      patched++;
      const block = oldItems.get(oldKey)!;
      block.props = items[newIdx];
      block.extra = extra;
      block.body = itemBody as ComponentBody;
      renderBlock(block);
    }
  }

  // Build new order array.
  const newOrder: any[] = state.order.slice(0, prefixLen);
  for (let i = 0; i < newKeys.length; i++) newOrder.push(newKeys[i]);
  for (let i = oldEnd + 1; i < oldLen; i++) newOrder.push(oldOrder[i]);

  // Anchor for inserts in the middle = first node of suffix (or end marker).
  const middleAnchor: Node = oldEnd + 1 < oldLen
    ? oldItems.get(oldOrder[oldEnd + 1])!.startMarker!
    : state.end;

  if (moved) {
    // LIS — find longest increasing subsequence over sources (only for surviving items).
    const seq = lis(sources);
    let seqIdx = seq.length - 1;
    // Walk new middle from end to start; if our position is in LIS, leave alone, else move/mount.
    for (let i = sources.length - 1; i >= 0; i--) {
      const targetIdx = i + prefixLen;
      const key = newKeys[i];
      // Anchor = the DOM node that should be AFTER this item.
      const nextItem = targetIdx + 1 < newOrder.length ? oldItems.get(newOrder[targetIdx + 1]) : null;
      const anchor: Node = nextItem ? nextItem.startMarker! : middleAnchor;
      if (sources[i] === -1) {
        // New item — mount it.
        const item = items[targetIdx];
        const block = mountItem(parentBlock, parentNode, anchor, item, itemBody, extra, state);
        oldItems.set(key, block);
      } else if (seqIdx < 0 || i !== seq[seqIdx]) {
        // Moved — relocate the DOM range before the anchor.
        const block = oldItems.get(key)!;
        moveBlockBefore(block, anchor);
      } else {
        seqIdx--;
      }
    }
  } else if (patched !== newKeys.length) {
    // No moves, but some new mounts. Walk and insert those.
    for (let i = sources.length - 1; i >= 0; i--) {
      if (sources[i] !== -1) continue;
      const targetIdx = i + prefixLen;
      const nextItem = targetIdx + 1 < newOrder.length ? oldItems.get(newOrder[targetIdx + 1]) : null;
      const anchor: Node = nextItem ? nextItem.startMarker! : middleAnchor;
      const key = newKeys[i];
      const item = items[targetIdx];
      const block = mountItem(parentBlock, parentNode, anchor, item, itemBody, extra, state);
      oldItems.set(key, block);
    }
  }

  state.order = newOrder;
}

/**
 * Bulk-clear a forBlock's items. When the forBlock owns its parent (markers
 * bracket the entire content), uses `textContent = ''` — the fastest DOM clear
 * on Chromium per Ripple's measured advantage on the `clear` op. Otherwise
 * falls back to a scoped Range deletion.
 *
 * Skips the per-item disposal loop unless at least one item has cleanups,
 * which is detected by tracking `hasCleanups` on the ForSlot.
 */
function batchClearItems(state: ForSlot, oldItems: Map<any, Block>): void {
  const p = state.start.parentNode!;
  if (state.start.previousSibling === null && state.end.nextSibling === null) {
    // forBlock owns the parent — nuke everything in one DOM op, then re-add markers.
    (p as Element).textContent = '';
    p.appendChild(state.start);
    p.appendChild(state.end);
  } else {
    // Shared parent (other JSX interleaved) — scoped Range delete keeps neighbors intact.
    const range = document.createRange();
    range.setStartAfter(state.start);
    range.setEndBefore(state.end);
    range.deleteContents();
  }
  // Disposal: mark + run cleanups only when needed. Common case (no useEffect
  // inside list items) skips the iteration entirely.
  if (state.hasCleanups) {
    const it = oldItems.values();
    for (let r = it.next(); !r.done; r = it.next()) {
      const b = r.value;
      b.disposed = true;
      if (b.cleanups.length > 0 || b.children.length > 0) fireCleanupsOnly(b);
    }
  }
  oldItems.clear();
}

function mountItem<T, E>(
  parentBlock: Block,
  parentNode: Node,
  anchor: Node,
  item: T,
  body: (s: Scope, item: T, extra: E) => void,
  extra: E,
  forSlot: ForSlot,
): Block {
  const start = document.createComment('it');
  const end = document.createComment('/it');
  parentNode.insertBefore(start, anchor);
  parentNode.insertBefore(end, anchor);
  const block = createBlock('control-flow', parentBlock, parentNode, start, end, body as ComponentBody, item, extra);
  block.forSlot = forSlot;
  renderBlock(block);
  return block;
}

function moveBlockBefore(block: Block, anchor: Node): void {
  const parent = block.startMarker!.parentNode!;
  let n: Node | null = block.startMarker!;
  const stop = block.endMarker!.nextSibling;
  while (n && n !== stop) {
    const next: Node | null = n.nextSibling;
    parent.insertBefore(n, anchor);
    n = next;
  }
}

/**
 * Longest Increasing Subsequence — returns indices into `arr` whose values form the LIS.
 * Skips entries where arr[i] === -1 (new items).
 * Ported from the standard O(n log n) patience-sort algorithm used by Inferno/Solid/Vue.
 */
function lis(arr: Int32Array): number[] {
  const n = arr.length;
  const p = new Int32Array(n);
  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v === -1) continue;
    if (result.length === 0 || arr[result[result.length - 1]] < v) {
      p[i] = result.length === 0 ? -1 : result[result.length - 1];
      result.push(i);
      continue;
    }
    // Binary search for the smallest tail >= v.
    let lo = 0, hi = result.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[result[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (v < arr[result[lo]]) {
      p[i] = lo > 0 ? result[lo - 1] : -1;
      result[lo] = i;
    }
  }
  // Reconstruct.
  let u = result.length;
  let v = result[u - 1];
  while (u-- > 0) {
    result[u] = v;
    v = p[v];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public root API — React-DOM parity
// ---------------------------------------------------------------------------

export interface Root {
  render(body: ComponentBody, props?: any): void;
  unmount(): void;
}

export function createRoot(container: Element): Root {
  let rootBlock: Block | null = null;
  let currentBody: ComponentBody | null = null;
  return {
    render(body, props) {
      if (rootBlock && currentBody === body) {
        rootBlock.props = props;
        scheduleRender(rootBlock);
        return;
      }
      if (rootBlock) {
        unmountBlock(rootBlock);
        rootBlock = null;
        currentBody = null;
      }
      while (container.firstChild) container.removeChild(container.firstChild);
      rootBlock = createBlock('root', null, container, null, null, body, props);
      currentBody = body;
      renderBlock(rootBlock);
      // First render commits effects on next microtask flush.
      if (!syncFlush && !scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    unmount() {
      if (rootBlock) {
        unmountBlock(rootBlock);
        rootBlock = null;
        currentBody = null;
      }
    },
  };
}
