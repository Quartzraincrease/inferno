export const version = '0.1.0-alpha.0';

export {
  // Public API
  createRoot,
  flushSync,
  drainPassiveEffects,
  hasPendingWork,
  act,
  type Root,

  // Hooks
  useState,
  useReducer,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useMemo,
  useCallback,
  useRef,
  useId,
  useImperativeHandle,
  useEffectEvent,
  useDeferredValue,

  // Context
  createContext,
  use,
  type Context,

  // Suspense
  isSuspenseException,
  type TrackedThenable,

  // Compiler-emitted runtime helpers
  template,
  clone,
  setText,
  setAttribute,
  setClassName,
  setStyle,
  injectStyle,
  delegateEvents,
  forBlock,
  ifBlock,
  tryBlock,
  componentSlot,
  portal,
  createPortal,
  type PortalDescriptor,
  withScope,
  renderBlock,
  createBlock,
  unmountBlock,
  scheduleRender,
  getCurrentScope,
  getCurrentBlock,

  type ComponentBody,
  type Scope,
  type Block,
} from './runtime';
