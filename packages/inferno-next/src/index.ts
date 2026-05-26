export const version = '0.1.0-alpha.0';

export {
  // Public API
  createRoot,
  flushSync,
  drainPassiveEffects,
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
  useTransition,
  startTransition,
  memo,

  // Context
  createContext,
  use,
  type Context,


  // Compiler-emitted runtime helpers
  template,
  clone,
  setText,
  setAttribute,
  setClassName,
  setStyle,
  setSpread,
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
