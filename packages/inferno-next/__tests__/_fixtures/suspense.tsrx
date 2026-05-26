import { use, useState, useEffect, useDeferredValue } from 'inferno-next';

// ---------------------------------------------------------------------------
// Basic Suspense flow — try/pending/catch with a use(promise) inside try.
// ---------------------------------------------------------------------------
export component BasicSuspense(props) {
  try {
    const value = use(props.promise);
    <div class='resolved'>{text value}</div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  }
}

// `use` of a rejected promise rethrows the reason — caught by `catch`,
// independent from the `pending` arm.
export component CatchRejection(props) {
  try {
    const value = use(props.promise);
    <div class='resolved'>{text value}</div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  } catch (err) {
    <div class='error'>{text 'caught: ' + err.message}</div>
  }
}

// Resetting from catch re-tries the try body — useful for retry buttons.
export component RetryFromCatch(props) {
  try {
    const value = use(props.promise);
    <div class='resolved'>{text value}</div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  } catch (err, reset) {
    <button id='retry' onClick={reset}>{text 'retry: ' + err.message}</button>
  }
}

// Multiple use() calls — should all suspend and resolve in order. On replay,
// earlier resolved use() calls return synchronously from cache.
export component TwoUses(props) {
  try {
    const a = use(props.a);
    const b = use(props.b);
    <div class='both'>{text a + '/' + b}</div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  }
}

// `try keep` mode — once resolved, subsequent re-renders that suspend keep
// the prior DOM visible. Use the React-idiomatic `useDeferredValue` to detect
// staleness: when `props.promise !== deferred`, you're rendering with old
// data while the new promise loads in the background.
export component KeepMode(props) {
  try {
    'use keep';
    const deferred = useDeferredValue(props.promise);
    const isStale = props.promise !== deferred;
    const value = use(deferred);
    <div class={isStale ? 'data stale' : 'data fresh'}>{text value}</div>
  } pending {
    <div class='fallback'>{text 'first load'}</div>
  }
}

// State inside the try body survives suspend/resume — the body re-runs but
// the hook's stored value persists across attempts (only commits on success
// would lose it; mid-render setters during a suspended attempt are queued).
export component StateInsideTry(props) {
  try {
    const value = use(props.promise);
    const [n, setN] = useState(0);
    <div>
      <span id='val'>{text value + ':' + n}</span>
      <button id='inc' onClick={() => setN(n + 1)}>{text 'inc'}</button>
    </div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  }
}

// Effects under a suspended try body should NOT fire while pending. They fire
// when the body finally resolves (matches React's "no effects in WIP tree
// that didn't commit").
export component EffectAfterResolve(props) {
  try {
    const value = use(props.promise);
    useEffect((log) => { log.push('mounted:' + value); }, [props.log, value]);
    <div>{text value}</div>
  } pending {
    <div class='fallback'>{text 'pending'}</div>
  }
}

// Nested try — inner pending catches first; outer is unaffected.
export component NestedSuspense(props) {
  try {
    <div class='outer'>{text 'outer'}</div>
    try {
      const v = use(props.promise);
      <div class='inner'>{text v}</div>
    } pending {
      <div class='inner-fallback'>{text 'inner-loading'}</div>
    }
  } pending {
    <div class='outer-fallback'>{text 'outer-loading'}</div>
  }
}

// Rejection bubbles past pending to catch (separate channel).
export component RejectVsPending(props) {
  try {
    const v = use(props.promise);
    <div class='resolved'>{text v}</div>
  } pending {
    <div class='fallback'>{text 'p'}</div>
  } catch (err) {
    <div class='caught'>{text 'rejected: ' + err.message}</div>
  }
}

// Mirrors ReactUse-test.js: hooks ABOVE a suspending use() are reused on
// replay — useState's value comes from the committed scope, not re-initialized.
export component ReplayHookCache(props) {
  try {
    const [n, setN] = useState(0);
    const value = use(props.promise);
    <div>
      <span id='val'>{text value + ':' + n}</span>
      <button id='inc' onClick={() => setN(n + 1)}>{text 'inc'}</button>
    </div>
  } pending {
    <div class='fallback'>{text 'loading'}</div>
  }
}

// Mirrors ReactSuspenseWithNoopRenderer's "does not call lifecycles of a
// suspended component (hooks)". Effects for the suspended sibling never
// fire while pending; the resolved sibling and the fallback's own effect
// run as usual.
export component EffectsSkippedForSuspended(props) {
  <ul>
    <li>
      <span class='a'>{text 'A'}</span>
    </li>
    try {
      const v = use(props.promise);
      <li>
        <span class='b'>{text 'B:' + v}</span>
      </li>
      useEffect((log) => { log.push('B-mount'); }, [props.log, v]);
    } pending {
      <li class='loading-li'>{text 'Loading...'}</li>
      useEffect((log) => { log.push('fallback-mount'); }, [props.log]);
    }
    <li>
      <span class='c'>{text 'C'}</span>
    </li>
  </ul>
}

// Mirrors "load multiple nested Suspense boundaries": each layer resolves
// in sequence, the inner fallback is revealed only after the outer resolves.
export component NestedRevealOrder(props) {
  try {
    const a = use(props.a);
    <div>
      <span class='a-resolved'>{text 'A:' + a}</span>
      try {
        const b = use(props.b);
        <span class='b-resolved'>{text 'B:' + b}</span>
      } pending {
        <span class='b-loading'>{text 'B-loading'}</span>
      }
    </div>
  } pending {
    <div class='a-loading'>{text 'A-loading'}</div>
  }
}
