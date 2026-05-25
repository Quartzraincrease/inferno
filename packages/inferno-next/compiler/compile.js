/**
 * @tsrx/inferno-next compiler — compiles TSRX source into JS that targets
 * the inferno-next runtime.
 *
 * Architecture (mirrors PLAN-TEMPLATE-RUNTIME.md §6 and §7):
 *   1. Parse TSRX via @tsrx/core's parseModule.
 *   2. For each top-level node:
 *        - Component → compile to a function that takes (scope, props, extra).
 *        - Other (imports, regular consts/functions) → emit as-is via esrap.
 *   3. Within a Component body:
 *        - Statements (declarations, hook calls, etc.) are kept and run on
 *          every invocation. Hook calls get a fresh module-scope Symbol
 *          passed as their last argument (conditional-hook-safe, §6.5).
 *        - JSX statements are extracted into a hoisted HTML template + a
 *          plan of dynamic bindings (text holes, attribute holes, event
 *          handlers) and a forBlock call for any for-of inside element
 *          children.
 *
 * Scope of the spike: handles the constructs used by the js-framework-benchmark
 * fixture (Main.tsrx). Sufficient for: components with attributes (static +
 * dynamic), event handlers, only-child text holes, for-of with keyed
 * reconciliation. Out of scope: TSRX `<style>`, scoped CSS, lazy destructure,
 * ifBlock, dynamic components, portals.
 */

import { parseModule } from '@tsrx/core';
import { print as esrapPrint } from 'esrap';
import esrapTsx from 'esrap/languages/tsx';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const HOOK_NAMES = new Set([
  'useState', 'useReducer', 'useEffect', 'useLayoutEffect', 'useInsertionEffect',
  'useMemo', 'useCallback', 'useRef', 'useId', 'useEffectEvent',
]);

const RUNTIME_NAMES = new Set([
  'createRoot', 'flushSync', 'delegateEvents',
  'template', 'clone', 'setText', 'setAttribute', 'setClassName',
  'forBlock', 'createContext', 'use', 'createPortal',
  ...HOOK_NAMES,
]);

/**
 * Compile a .tsrx source string into JS targeting `inferno-next`.
 * @param {string} source
 * @param {string} filename
 * @returns {{ code: string, map: any }}
 */
export function compile(source, filename) {
  const ast = parseModule(source, filename);

  const ctx = {
    filename,
    runtimeNeeded: new Set(),
    hoistedTemplates: [], // { name, html }
    hoistedHelpers: [],   // raw JS strings (sub-components, hook Symbols, key fns)
    delegatedEvents: new Set(),  // event names seen in JSX — auto-emits delegateEvents(...)
    nextHookSymId: 0,
    nextTemplateId: 0,
    nextHelperId: 0,
  };

  let body = '';
  for (const node of ast.body) {
    if (node.type === 'Component') {
      body += compileComponent(node, ctx) + '\n\n';
    } else if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'Component') {
      // `export default component Foo() {...}` → emit as named const + `export default Foo;`.
      const c = node.declaration;
      const compiled = compileComponent({ ...c, default: false }, ctx);
      body += compiled + '\nexport default ' + c.id.name + ';\n\n';
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'Component') {
      // `export component Foo() {...}` → emit as `export const Foo = ...;`.
      const c = node.declaration;
      const compiled = compileComponent({ ...c, export: true }, ctx);
      body += compiled + '\n\n';
    } else if (node.type === 'ImportDeclaration' && node.source.value === 'inferno-next') {
      // Preserve ALL user-imported names from inferno-next (Portal, createContext,
      // use, custom helpers, etc.) — merged into the single prelude import.
      for (const sp of node.specifiers || []) {
        const name = sp.imported?.name || sp.local?.name;
        if (name) ctx.runtimeNeeded.add(name);
      }
    } else {
      body += printNode(node) + '\n';
    }
  }

  // Auto-emit delegateEvents([...]) once at module scope for every event seen.
  if (ctx.delegatedEvents.size > 0) {
    ctx.runtimeNeeded.add('delegateEvents');
  }

  // Build prelude.
  const runtimeImport = ctx.runtimeNeeded.size > 0
    ? `import { ${[...ctx.runtimeNeeded].sort().join(', ')} } from 'inferno-next';\n\n`
    : '';
  const delegateCall = ctx.delegatedEvents.size > 0
    ? `delegateEvents(${JSON.stringify([...ctx.delegatedEvents].sort())});\n\n`
    : '';
  const templates = ctx.hoistedTemplates
    .map(t => `const ${t.name} = template(${JSON.stringify(t.html)});`)
    .join('\n');
  const templatesBlock = templates ? templates + '\n\n' : '';
  const helpers = ctx.hoistedHelpers.join('\n');
  const helpersBlock = helpers ? helpers + '\n\n' : '';

  return { code: runtimeImport + delegateCall + templatesBlock + helpersBlock + body, map: null };
}

// ===========================================================================
// Component compilation
// ===========================================================================

function compileComponent(node, ctx) {
  const name = node.id.name;
  const isExported = !!(node.export || node.default || node.exported);
  const isDefault = !!node.default;

  const fn = compileFunctionBody(node, ctx, name);

  if (isDefault) {
    return `const ${name} = ${fn};\nexport default ${name};`;
  }
  if (isExported) {
    return `export const ${name} = ${fn};`;
  }
  return `const ${name} = ${fn};`;
}

/**
 * Generate just the `function (...) { ... }` text for a component-shaped node.
 * Used both for top-level components and for inlined for-of item bodies.
 */
function compileFunctionBody(node, ctx, name) {
  const params = node.params.map(p => printNode(p)).join(', ');
  const paramsClause = params ? `, ${params}` : '';

  // Early-return desugaring: `if (cond) return;` short-circuits the rest of
  // the body. We rewrite this into `if (!cond) { ...rest }` so all subsequent
  // JSX is gated by the inverted condition. Our Symbol-keyed hooks make it
  // safe for hooks to appear after early returns (call-order independence).
  const bodyRewritten = rewriteEarlyReturns(node.body);

  // Split body: statement nodes vs JSX-position nodes.
  const statements = [];
  const jsxNodes = [];
  for (const child of bodyRewritten) {
    if (isJsxNode(child)) jsxNodes.push(child);
    else statements.push(child);
  }

  // Plan + emit JSX. Records any inline-sub-component code that needs to live
  // INSIDE this function body (so for-of item bodies can capture parent state).
  const inlinedSubs = [];

  // Rewrite hook calls and `<tsrx>` blocks in statements before printing them.
  // A `<tsrx>` block at expression position (e.g. `const f = <tsrx>...</tsrx>`)
  // is hoisted as a render function in inlinedSubs and replaced with an
  // identifier reference. Suitable for top-level render-prop patterns where
  // the block doesn't capture local arrow params.
  const rewrittenStatements = statements
    .map(s => rewriteHookCalls(s, ctx, name))
    .map(s => rewriteTsrxBlocks(s, ctx, name, inlinedSubs));
  const statementCode = rewrittenStatements.map(s => '  ' + printNode(s).replace(/\n/g, '\n  ')).join('\n');

  const plan = planJsx(jsxNodes, ctx, name, inlinedSubs);

  const lines = [];
  if (statementCode) lines.push(statementCode);
  if (inlinedSubs.length > 0) lines.push(inlinedSubs.map(s => '  ' + s.replace(/\n/g, '\n  ')).join('\n'));
  if (plan.bindingsName) {
    lines.push(`  let _b = __s.${plan.bindingsName};`);
    lines.push(`  if (_b === undefined) {`);
    lines.push(plan.mount);
    lines.push(`  } else {`);
    lines.push(plan.update);
    lines.push(`  }`);
  }
  if (plan.after) lines.push(plan.after);

  return `function ${name}(__s${paramsClause}, __extra) {\n  const __block = __s.block;\n${lines.join('\n')}\n}`;
}

// ===========================================================================
// Hook-call rewriting
// ===========================================================================

function rewriteHookCalls(node, ctx, componentName) {
  return mapAst(node, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && HOOK_NAMES.has(n.callee.name)) {
      ctx.runtimeNeeded.add(n.callee.name);
      const symVar = allocHookSymbol(ctx, `${componentName}.${n.callee.name}#${ctx.nextHookSymId}`);
      return {
        ...n,
        arguments: [...n.arguments, { type: 'Identifier', name: symVar }],
      };
    }
    return null;
  });
}

/**
 * Replace `<tsrx>...</tsrx>` and `<tsx>...</tsx>` AST nodes at expression
 * position with an identifier referencing a hoisted render function.
 * The render function is added to `inlinedSubs` (visible in the surrounding
 * component-body scope), so it can capture the component's locals via closure.
 * Note: it cannot capture params of nested arrows — see compiler README.
 */
function rewriteTsrxBlocks(node, ctx, componentName, inlinedSubs) {
  return mapAst(node, (n) => {
    if (n.type === 'Tsrx' || n.type === 'Tsx') {
      const helperName = `__tsrx$${ctx.nextHelperId++}`;
      const fakeBody = {
        type: 'Component',
        id: { type: 'Identifier', name: helperName },
        params: [],
        body: n.children || [],
      };
      const fn = compileFunctionBody(fakeBody, ctx, helperName);
      // Function declaration — hoisted within the enclosing body, so the
      // statement that references it can sit either before or after.
      inlinedSubs.push(fn + ';');
      return { type: 'Identifier', name: helperName };
    }
    return null;
  });
}

function allocHookSymbol(ctx, debugName) {
  const id = ctx.nextHookSymId++;
  const name = `_h$${id}`;
  ctx.hoistedHelpers.push(`const ${name} = Symbol(${JSON.stringify(debugName)});`);
  return name;
}

// ===========================================================================
// JSX planning
// ===========================================================================

/**
 * Normalize a list of JSX child nodes:
 *   - Whitespace-only JSXText → dropped
 *   - JSXText with content → text Literal node
 *   - JSXExpressionContainer → Text hole
 *   - JSXElement → Element (matches our compiler's expected shape)
 *   - Tsx (`<>...</>`) and Tsrx (`<tsrx>...</tsrx>`) → flattened (children inlined)
 *   - Anything else (Element / ForOf / If / etc.) → passed through
 */
function normalizeChildren(nodes) {
  const out = [];
  if (!nodes) return out;
  for (const n of nodes) {
    if (!n) continue;
    if (n.type === 'JSXText') {
      if (/^\s*$/.test(n.value)) continue;
      out.push({ type: 'Text', expression: { type: 'Literal', value: n.value, raw: JSON.stringify(n.value) } });
    } else if (n.type === 'JSXExpressionContainer') {
      out.push({ type: 'Text', expression: n.expression });
    } else if (n.type === 'JSXElement') {
      out.push({
        type: 'Element',
        id: n.openingElement.name,
        attributes: n.openingElement.attributes || [],
        openingElement: n.openingElement,
        children: n.children || [],
        selfClosing: n.openingElement.selfClosing,
      });
    } else if (n.type === 'Tsx' || n.type === 'Tsrx' || n.type === 'JSXFragment') {
      out.push(...normalizeChildren(n.children || []));
    } else {
      out.push(n);
    }
  }
  return out;
}

function planJsx(jsxNodesRaw, ctx, componentName, inlinedSubs) {
  const jsxNodes = normalizeChildren(jsxNodesRaw);
  if (jsxNodes.length === 0) return { mount: '', update: '', after: '' };

  // Emit ONE template containing all top-level JSX (wrapping multiple roots in
  // a synthetic <inferno-frag>).
  // We walk the tree, building HTML and a list of bindings.
  const elementBindings = [];   // ordered list of bindings (per dynamic site)
  const forCalls = [];          // forBlock calls — emitted after the mount/append
  const ifCalls = [];           // ifBlock calls
  const compCalls = [];         // component-as-tag calls (<Provider>, <Foo/>, <ctx.X/>)
  ctx._portalCalls = [];        // {createPortal(...)} calls (collected per-plan)
  const tryCalls = [];          // tryBlock calls

  // Track HTML index across top-level nodes — component-call nodes don't
  // contribute HTML, so their indices DON'T advance the frag position. Each
  // HTML-contributing top-level node lives at _root.childNodes[htmlIdx].
  const partsHtml = [];
  let htmlIdx = 0;
  for (const node of jsxNodes) {
    const nodeIsComp = node.type === 'Element' && isComponentTag(node);
    // Single-root: path=[]. Multi-root HTML: path=[htmlIdx]. Component-call: path=[].
    const nodePath = (jsxNodes.length > 1 && !nodeIsComp) ? [htmlIdx] : [];
    partsHtml.push(emitNodeHtml(node, nodePath, elementBindings, forCalls, ifCalls, compCalls, tryCalls, ctx, componentName, inlinedSubs));
    if (!nodeIsComp) htmlIdx++;
  }
  const html = partsHtml.join('');
  const single = jsxNodes.length === 1 && jsxNodes[0].type === 'Element' && !isComponentTag(jsxNodes[0]);
  // Was every emitted JSX node a component-call (or any non-HTML node that
  // contributes no HTML)? Then there's no template to clone — control-flow /
  // component-slot calls render directly into __block.parentNode using
  // __block.endMarker as the anchor.
  const noTemplate = html === '';

  const bindingsName = `b$${ctx.nextHelperId++}`;
  const mountLines = [];
  mountLines.push(`    _b = __s.${bindingsName} = {};`);

  let tpl = null;
  let elementVars;
  let ensureVar;
  if (!noTemplate) {
    ctx.runtimeNeeded.add('template');
    ctx.runtimeNeeded.add('clone');
    const tplHtml = single ? html : `<inferno-frag>${html}</inferno-frag>`;
    tpl = allocTemplate(ctx, tplHtml);
    mountLines.push(`    const _root = clone(${tpl});`);
    elementVars = new Map();
    let varCounter = 0;
    ensureVar = (path) => {
      // Top-level position in a multi-root template — the synthetic frag we
      // cloned gets drained on mount, so empty-path callers (top-level
      // control-flow / component slots) need to point at the live parent.
      if (path.length === 0 && !single) {
        return '__block.parentNode';
      }
      const key = path.join(',');
      if (elementVars.has(key)) return elementVars.get(key);
      const v = `_el${varCounter++}`;
      elementVars.set(key, v);
      mountLines.push(`    const ${v} = ${walkExpr('_root', path)};`);
      return v;
    };
  } else {
    // No template — host is __block.parentNode. Stash it once.
    mountLines.push(`    _b._compHost = __block.parentNode;`);
    ensureVar = (_path) => `_b._compHost`;
  }

  // Emit per-binding mount code.
  for (const b of elementBindings) {
    const elVar = ensureVar(b.path);
    if (b.kind === 'text' || b.kind === 'textOnlyChild') ctx.runtimeNeeded.add('setText');
    if (b.kind === 'attr') ctx.runtimeNeeded.add('setAttribute');
    if (b.kind === 'class') ctx.runtimeNeeded.add('setClassName');
    mountLines.push(emitBindingMount(b, elVar));
  }
  for (const fc of forCalls) {
    const elVar = ensureVar(fc.hostPath);
    fc.elVar = elVar;
    mountLines.push(`    _b._for$${fc.id} = ${elVar};`);
  }
  for (const ic of ifCalls) {
    const elVar = ensureVar(ic.hostPath);
    ic.elVar = elVar;
    mountLines.push(`    _b._ifHost$${ic.id} = ${elVar};`);
  }
  for (const cc of compCalls) {
    const elVar = ensureVar(cc.hostPath);
    cc.elVar = elVar;
    mountLines.push(`    _b._compHost$${cc.id} = ${elVar};`);
  }
  // tryBlock targets.
  for (const tc of tryCalls) {
    const elVar = ensureVar(tc.hostPath);
    tc.elVar = elVar;
    mountLines.push(`    _b._tryHost$${tc.id} = ${elVar};`);
  }

  if (!noTemplate) {
    if (single) {
      mountLines.push(`    __block.parentNode.insertBefore(_root, __block.endMarker);`);
    } else {
      mountLines.push(`    while (_root.firstChild) __block.parentNode.insertBefore(_root.firstChild, __block.endMarker);`);
    }
  }

  // Update.
  const updateLines = [];
  for (const b of elementBindings) {
    updateLines.push(emitBindingUpdate(b));
  }

  // After (forBlock + ifBlock calls run on every render — they reconcile).
  const afterLines = [];
  for (const fc of forCalls) {
    ctx.runtimeNeeded.add('forBlock');
    afterLines.push(`  forBlock(__s, ${JSON.stringify('_for$' + fc.id)}, __s.${bindingsName}._for$${fc.id}, ${fc.itemsExpr}, ${fc.keyHelper}, ${fc.bodyHelper}, ${fc.extraExpr});`);
  }
  for (const ic of ifCalls) {
    ctx.runtimeNeeded.add('ifBlock');
    const elseArg = ic.elseHelper || 'null';
    afterLines.push(`  ifBlock(__s, ${JSON.stringify('_if$' + ic.id)}, __s.${bindingsName}._ifHost$${ic.id}, (${ic.condExpr}), ${ic.thenHelper}, ${elseArg});`);
  }
  for (const cc of compCalls) {
    ctx.runtimeNeeded.add('componentSlot');
    // Always pass __block.endMarker as the anchor. When the host element is
    // the block's own parentNode (multi-root / noTemplate cases), this keeps
    // the slot's markers inside the block's range so for-of item reordering
    // and tryBlock branch unmount move the slot's DOM along with the block.
    // When the host is a nested element, the anchor is irrelevant (insertBefore
    // ignores anchors not in the host).
    const isInsideHost = cc.elVar.startsWith('_el');  // captured from _root walk
    const anchorArg = isInsideHost ? '' : ', __block.endMarker';
    afterLines.push(`  componentSlot(__s, ${JSON.stringify('_comp$' + cc.id)}, __s.${bindingsName}._compHost$${cc.id}, ${cc.compExpr}, ${cc.propsExpr}${anchorArg});`);
  }
  for (const pc of ctx._portalCalls) {
    ctx.runtimeNeeded.add('portal');
    afterLines.push(`  portal(__s, ${JSON.stringify('_portal$' + pc.id)}, ${pc.targetExpr}, ${pc.bodyExpr}, ${pc.propsExpr});`);
  }
  ctx._portalCalls = [];
  for (const tc of tryCalls) {
    ctx.runtimeNeeded.add('tryBlock');
    afterLines.push(`  tryBlock(__s, ${JSON.stringify('_try$' + tc.id)}, __s.${bindingsName}._tryHost$${tc.id}, ${tc.tryHelper}, ${tc.catchHelper});`);
  }

  return {
    bindingsName,
    mount: mountLines.join('\n'),
    update: updateLines.join('\n'),
    after: afterLines.join('\n'),
  };
}

// All `expr` strings get wrapped in `(…)` so ternaries / comma exprs / etc.
// don't break operator precedence in the comparisons or assignments.
function emitBindingMount(b, elVar) {
  const E = `(${b.expr})`;
  switch (b.kind) {
    case 'textOnlyChild': {
      return `    {
      const _v = ${E};
      const _t = document.createTextNode(_v == null || _v === false ? '' : String(_v));
      ${elVar}.appendChild(_t);
      _b._txt$${b.id} = _t;
      _b._prev$${b.id} = _v;
    }`;
    }
    case 'text': {
      return `    {
      const _v = ${E};
      const _t = document.createTextNode(_v == null || _v === false ? '' : String(_v));
      const _m = ${elVar}.childNodes[${b.childIndex}];
      ${elVar}.insertBefore(_t, _m);
      ${elVar}.removeChild(_m);
      _b._txt$${b.id} = _t;
      _b._prev$${b.id} = _v;
    }`;
    }
    case 'attr': {
      return `    {
      const _v = ${E};
      setAttribute(${elVar}, ${JSON.stringify(b.name)}, _v);
      _b._el$${b.id} = ${elVar};
      _b._prev$${b.id} = _v;
    }`;
    }
    case 'class': {
      return `    {
      const _v = ${E};
      setClassName(${elVar}, _v);
      _b._el$${b.id} = ${elVar};
      _b._prev$${b.id} = _v;
    }`;
    }
    case 'event': {
      return `    _b._el$${b.id} = ${elVar};
    ${elVar}.$$${b.eventName} = (${b.expr});`;
    }
    case 'ref': {
      // Callback ref → call with the element; object ref → set .current.
      // Register a scope cleanup so unmount clears the ref to null (React parity).
      return `    {
      const _r = (${b.expr});
      if (typeof _r === 'function') _r(${elVar});
      else if (_r != null) _r.current = ${elVar};
      _b._ref$${b.id} = _r;
      _b._el$${b.id} = ${elVar};
      __s.cleanups.push(() => {
        const _x = _b._ref$${b.id};
        if (typeof _x === 'function') _x(null);
        else if (_x != null) _x.current = null;
      });
    }`;
    }
  }
  return '';
}

function emitBindingUpdate(b) {
  const E = `(${b.expr})`;
  switch (b.kind) {
    case 'textOnlyChild':
    case 'text': {
      return `    { const _v = ${E}; if (_b._prev$${b.id} !== _v) { setText(_b._txt$${b.id}, _v); _b._prev$${b.id} = _v; } }`;
    }
    case 'attr': {
      return `    { const _v = ${E}; if (_b._prev$${b.id} !== _v) { setAttribute(_b._el$${b.id}, ${JSON.stringify(b.name)}, _v); _b._prev$${b.id} = _v; } }`;
    }
    case 'class': {
      return `    { const _v = ${E}; if (_b._prev$${b.id} !== _v) { setClassName(_b._el$${b.id}, _v); _b._prev$${b.id} = _v; } }`;
    }
    case 'event': {
      return `    _b._el$${b.id}.$$${b.eventName} = (${b.expr});`;
    }
    case 'ref': {
      // Ref expression identity may change across renders — re-attach if so.
      return `    {
      const _r = (${b.expr});
      if (_r !== _b._ref$${b.id}) {
        const _old = _b._ref$${b.id};
        if (_old != null && typeof _old !== 'function') _old.current = null;
        if (typeof _r === 'function') _r(_b._el$${b.id});
        else if (_r != null) _r.current = _b._el$${b.id};
        _b._ref$${b.id} = _r;
      }
    }`;
    }
  }
  return '';
}

// ===========================================================================
// HTML emission
// ===========================================================================

function emitNodeHtml(node, path, bindings, forCalls, ifCalls, compCalls, tryCalls, ctx, componentName, inlinedSubs) {
  if (node.type === 'Text') {
    bindings.push({ id: bindings.length, kind: 'text', expr: printExpr(node.expression), path: path.slice(0, -1), childIndex: path[path.length - 1] });
    return '<!>';
  }
  if (node.type === 'Element') return emitElementHtml(node, path, bindings, forCalls, ifCalls, compCalls, tryCalls, ctx, componentName, inlinedSubs);
  if (node.type === 'Literal' && typeof node.value === 'string') return escapeHtml(node.value);
  // Top-level control-flow — register as a call hosted on the body's parent.
  if (node.type === 'IfStatement') {
    const ic = makeIfCall(node, ctx, componentName, inlinedSubs);
    ic.hostPath = [];
    ifCalls.push(ic);
    return '';
  }
  if (node.type === 'ForOfStatement') {
    const fc = makeForCall(node, ctx, componentName, inlinedSubs);
    fc.hostPath = [];
    forCalls.push(fc);
    return '';
  }
  if (node.type === 'TryStatement') {
    const tc = makeTryCall(node, ctx, componentName, inlinedSubs);
    tc.hostPath = [];
    tryCalls.push(tc);
    return '';
  }
  return '';
}

function emitElementHtml(node, path, bindings, forCalls, ifCalls, compCalls, tryCalls, ctx, componentName, inlinedSubs) {
  // If the tag is a component (uppercase ident or MemberExpression), don't emit
  // HTML — register a componentSlot call instead.
  if (isComponentTag(node)) {
    const cc = makeCompCall(node, ctx, componentName, inlinedSubs, bindings, forCalls, ifCalls, compCalls);
    cc.hostPath = path;
    compCalls.push(cc);
    return '';  // no HTML
  }

  const tag = node.id?.name || node.openingElement?.name?.name;
  if (!tag) throw new Error('Element without tag');

  // Collect attributes.
  const attrs = node.attributes || node.openingElement?.attributes || [];
  let attrHtml = '';
  for (const attr of attrs) {
    if (attr.type !== 'Attribute' && attr.type !== 'JSXAttribute') continue;
    const attrName = attr.name.name || attr.name;
    if (attrName === 'key') continue;  // consumed by for-of, not emitted

    const val = attr.value;
    if (val == null) {
      attrHtml += ` ${attrName}`;
      continue;
    }
    const inner = val.type === 'JSXExpressionContainer' ? val.expression : val;

    // Static literal value? Inline into HTML.
    if (inner.type === 'Literal') {
      if (typeof inner.value === 'string') {
        attrHtml += ` ${attrName}="${escapeAttr(inner.value)}"`;
      } else if (typeof inner.value === 'number') {
        attrHtml += ` ${attrName}="${inner.value}"`;
      } else if (inner.value === true) {
        attrHtml += ` ${attrName}`;
      }
      continue;
    }

    // Dynamic value — record a binding.
    const expr = printExprWithTsrx(inner, ctx, componentName, inlinedSubs);
    if (attrName.length > 2 && attrName.startsWith('on') && /^[A-Z]/.test(attrName[2])) {
      const eventName = attrName.slice(2).toLowerCase();
      ctx.delegatedEvents.add(eventName);
      bindings.push({ id: bindings.length, kind: 'event', expr, path, eventName });
    } else if (attrName === 'class' || attrName === 'className') {
      bindings.push({ id: bindings.length, kind: 'class', expr, path });
    } else {
      bindings.push({ id: bindings.length, kind: 'attr', name: attrName, expr, path });
    }
  }

  const isVoid = VOID_ELEMENTS.has(tag) && (node.children || []).length === 0;
  if (isVoid) {
    return `<${tag}${attrHtml}/>`;
  }

  let html = `<${tag}${attrHtml}>`;

  const children = normalizeChildren(node.children || []);
  // Special case: a single Text child (only-child text fast path).
  if (children.length === 1 && children[0].type === 'Text') {
    const txtChild = children[0];
    bindings.push({
      id: bindings.length, kind: 'textOnlyChild',
      expr: printExpr(txtChild.expression),
      path,
    });
    // The element stays empty in the template — runtime appends a Text node.
  } else {
    // Mixed children — walk them in order.
    let childIdx = 0;
    for (const child of children) {
      if (child.type === 'Text') {
        bindings.push({
          id: bindings.length, kind: 'text',
          expr: printExpr(child.expression),
          path, childIndex: childIdx,
        });
        html += '<!>';  // placeholder we'll replace at mount
        childIdx++;
      } else if (child.type === 'Element') {
        if (isComponentTag(child)) {
          const cc = makeCompCall(child, ctx, componentName, inlinedSubs, bindings, forCalls, ifCalls, compCalls);
          cc.hostPath = path;
          compCalls.push(cc);
        } else {
          html += emitElementHtml(child, [...path, childIdx], bindings, forCalls, ifCalls, compCalls, tryCalls, ctx, componentName, inlinedSubs);
          childIdx++;
        }
      } else if (child.type === 'ForOfStatement') {
        const forCall = makeForCall(child, ctx, componentName, inlinedSubs);
        forCall.hostPath = path;
        forCalls.push(forCall);
      } else if (child.type === 'IfStatement') {
        const ifCall = makeIfCall(child, ctx, componentName, inlinedSubs);
        ifCall.hostPath = path;
        ifCalls.push(ifCall);
      } else if (child.type === 'TryStatement') {
        const tc = makeTryCall(child, ctx, componentName, inlinedSubs);
        tc.hostPath = path;
        tryCalls.push(tc);
      } else if (child.type === 'TSRXExpression') {
        // {expr} at JSX child position. Recognised forms:
        //   - `{ref refExpr}` → ref-attach binding on the host element (TSRX RefExpression)
        //   - `{createPortal(BODY, TARGET, PROPS?)}` → portal() call (no descriptor alloc)
        //   - anything else → emit as a text hole (runtime stringifies on render)
        const expr = child.expression;
        if (expr && expr.type === 'RefExpression') {
          bindings.push({
            id: bindings.length, kind: 'ref',
            expr: printExpr(expr.argument),
            path,
          });
          // No HTML, no markers — the ref binds to the host (parent path).
        } else if (isCreatePortalCall(expr)) {
          const pc = makePortalCall(expr, ctx, componentName, inlinedSubs);
          (ctx._portalCalls ??= []).push(pc);
        } else {
          bindings.push({
            id: bindings.length, kind: 'text',
            expr: printExpr(expr),
            path, childIndex: childIdx,
          });
          html += '<!>';
          childIdx++;
        }
      }
    }
  }

  html += `</${tag}>`;
  return html;
}

function isCreatePortalCall(node) {
  return node
    && node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && node.callee.name === 'createPortal';
}

function makePortalCall(callNode, ctx, componentName, inlinedSubs) {
  const [bodyArg, targetArg, propsArg] = callNode.arguments;
  // The body is typically a <tsrx>...</tsrx> block — compile to a render fn.
  // rewriteTsrxBlocks turns Tsrx/Tsx into an Identifier referencing a hoisted fn.
  const bodyExpr = printExprWithTsrx(bodyArg, ctx, componentName, inlinedSubs);
  const targetExpr = printExpr(targetArg);
  const propsExpr = propsArg ? printExpr(propsArg) : 'undefined';
  return {
    id: ctx.nextHelperId++,
    bodyExpr,
    targetExpr,
    propsExpr,
  };
}

// ===========================================================================
// for-of inside element children → forBlock call
// ===========================================================================

// ===========================================================================
// if-statement inside element children → ifBlock call
// ===========================================================================

function makeIfCall(node, ctx, componentName, inlinedSubs) {
  // node.test, node.consequent (BlockStatement | Element), node.alternate (BlockStatement | IfStatement | null)
  const condExpr = printExpr(node.test);

  const thenStmts = node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
  const thenHelperName = `__then$${ctx.nextHelperId++}`;
  const thenFake = {
    type: 'Component',
    id: { type: 'Identifier', name: thenHelperName },
    params: [],
    body: thenStmts,
  };
  const thenFn = compileFunctionBody(thenFake, ctx, thenHelperName);
  inlinedSubs.push(thenFn + ';');

  let elseHelperName = null;
  if (node.alternate) {
    const elseStmts = node.alternate.type === 'BlockStatement' ? node.alternate.body : [node.alternate];
    elseHelperName = `__else$${ctx.nextHelperId++}`;
    const elseFake = {
      type: 'Component',
      id: { type: 'Identifier', name: elseHelperName },
      params: [],
      body: elseStmts,
    };
    const elseFn = compileFunctionBody(elseFake, ctx, elseHelperName);
    inlinedSubs.push(elseFn + ';');
  }

  return {
    id: ctx.nextHelperId++,
    condExpr,
    thenHelper: thenHelperName,
    elseHelper: elseHelperName,
    hostPath: null,
  };
}

// ===========================================================================
// Component-as-tag — `<Foo>...</Foo>`, `<ctx.Provider>...</ctx.Provider>`
// ===========================================================================

function isComponentTag(node) {
  const name = node.openingElement?.name || node.id;
  if (!name) return false;
  if (name.type === 'MemberExpression' || name.type === 'JSXMemberExpression') return true;
  if (name.type === 'Identifier' || name.type === 'JSXIdentifier') {
    return typeof name.name === 'string' && /^[A-Z]/.test(name.name);
  }
  return false;
}

function tagExpr(node) {
  const name = node.openingElement?.name || node.id;
  if (name.type === 'MemberExpression' || name.type === 'JSXMemberExpression') {
    return printExpr(name);
  }
  return name.name;
}

function makeCompCall(node, ctx, componentName, inlinedSubs, bindings, forCalls, ifCalls, compCalls) {
  const id = ctx.nextHelperId++;
  const compExpr = tagExpr(node);

  // Build the props object literal from JSX attributes.
  const attrs = node.attributes || node.openingElement?.attributes || [];
  const propParts = [];
  for (const attr of attrs) {
    if (attr.type !== 'Attribute' && attr.type !== 'JSXAttribute') continue;
    const attrName = attr.name.name || attr.name;
    const val = attr.value;
    if (val == null) { propParts.push(`${JSON.stringify(attrName)}: true`); continue; }
    const inner = val.type === 'JSXExpressionContainer' ? val.expression : val;
    if (inner.type === 'Literal') {
      propParts.push(`${JSON.stringify(attrName)}: ${JSON.stringify(inner.value)}`);
    } else {
      propParts.push(`${JSON.stringify(attrName)}: (${printExprWithTsrx(inner, ctx, componentName, inlinedSubs)})`);
    }
  }

  // Compile children as a render function: (scope) => { renders JSX into scope }.
  // The function is inlined inside the parent component body so its closures
  // capture the parent's locals (props, state, etc.).
  const children = node.children || [];
  if (children.length > 0) {
    const childrenHelperName = `__children$${ctx.nextHelperId++}`;
    const fakeBody = {
      type: 'Component',
      id: { type: 'Identifier', name: childrenHelperName },
      params: [],
      body: children,
    };
    const childrenFn = compileFunctionBody(fakeBody, ctx, childrenHelperName);
    inlinedSubs.push(childrenFn + ';');
    propParts.push(`"children": ${childrenHelperName}`);
  }

  const propsExpr = `{ ${propParts.join(', ')} }`;

  return { id, compExpr, propsExpr, hostPath: null };
}

// ===========================================================================
// try/catch → tryBlock call
// ===========================================================================

function makeTryCall(node, ctx, componentName, inlinedSubs) {
  // node.block = try BlockStatement, node.handler = CatchClause (param, resetParam, body)
  const tryStmts = node.block.body;
  const tryHelperName = `__try$${ctx.nextHelperId++}`;
  const tryFake = {
    type: 'Component',
    id: { type: 'Identifier', name: tryHelperName },
    params: [],
    body: tryStmts,
  };
  const tryFn = compileFunctionBody(tryFake, ctx, tryHelperName);
  inlinedSubs.push(tryFn + ';');

  let catchHelperName = '() => null';
  if (node.handler) {
    const handler = node.handler;
    const errName = handler.param?.name || '_err';
    const resetName = handler.resetParam?.name || '_reset';
    const catchStmts = handler.body.body;
    const tmpName = `__catch$${ctx.nextHelperId++}`;
    // The catch body sees `err` and `reset` as bindings unpacked from the
    // tryBlock-supplied props object. We synthesize a small destructuring
    // VariableDeclaration at the top of the body so the user's identifiers
    // resolve. The body is otherwise compiled like any component body.
    const destructure = {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [{
        type: 'VariableDeclarator',
        id: {
          type: 'ObjectPattern',
          properties: [
            { type: 'Property', key: { type: 'Identifier', name: 'err' }, value: { type: 'Identifier', name: errName }, kind: 'init', shorthand: errName === 'err', computed: false, method: false },
            { type: 'Property', key: { type: 'Identifier', name: 'reset' }, value: { type: 'Identifier', name: resetName }, kind: 'init', shorthand: resetName === 'reset', computed: false, method: false },
          ],
        },
        init: { type: 'Identifier', name: '__props' },
      }],
    };
    const catchFake = {
      type: 'Component',
      id: { type: 'Identifier', name: tmpName },
      params: [{ type: 'Identifier', name: '__props' }],
      body: [destructure, ...catchStmts],
    };
    const catchFn = compileFunctionBody(catchFake, ctx, tmpName);
    inlinedSubs.push(catchFn + ';');
    catchHelperName = tmpName;
  }
  return {
    id: ctx.nextHelperId++,
    tryHelper: tryHelperName,
    catchHelper: catchHelperName,
    hostPath: null,
  };
}

function makeForCall(node, ctx, componentName, inlinedSubs) {
  // node.left = const x, node.right = expr, node.body = BlockStatement,
  // node.key = optional `key …` expression (TSRX for-of syntax), node.index = optional index identifier.
  const itemName = node.left.declarations[0].id.name;
  const itemsExpr = printExpr(node.right);
  const subStmts = node.body.body;

  // Key resolution priority (matches @tsrx/core's build_hoisted_for_of_with_hooks):
  //   1. `key={…}` attribute on the first Element child (legacy / explicit).
  //   2. `for (const x of y; key x.id) { ... }` — TSRX for-of header.
  //   3. `for (const x, i of y) { ... }` — second loop param treated as the key.
  //   4. Fallback: `x.id ?? x` (object identity).
  let keyFn = null;
  const firstEl = subStmts.find(n => n.type === 'Element');
  if (firstEl) {
    const keyAttr = (firstEl.attributes || firstEl.openingElement?.attributes || [])
      .find(a => (a.name?.name || a.name) === 'key');
    if (keyAttr) {
      const inner = keyAttr.value.type === 'JSXExpressionContainer' ? keyAttr.value.expression : keyAttr.value;
      keyFn = `(${itemName}) => ${printExpr(inner)}`;
    }
  }
  if (!keyFn && node.key) {
    keyFn = `(${itemName}) => ${printExpr(node.key)}`;
  }
  if (!keyFn && node.index) {
    // Index identifier — caller iterates with index, key by index.
    keyFn = `(${itemName}, ${node.index.name}) => ${node.index.name}`;
  }
  if (!keyFn) keyFn = `(${itemName}) => ${itemName}.id != null ? ${itemName}.id : ${itemName}`;

  // Key fn is hoisted (it doesn't typically capture parent state).
  const keyHelper = `_key$${ctx.nextHelperId++}`;
  ctx.hoistedHelpers.push(`const ${keyHelper} = ${keyFn};`);

  // The item body is INLINED inside the parent component body so it captures
  // any locals it references (e.g. `state.selected`, the parent's hook setters).
  // This trades a per-render closure alloc for the per-render flexibility.
  const itemHelperName = `__item$${ctx.nextHelperId++}`;
  const fakeComponent = {
    type: 'Component',
    id: { type: 'Identifier', name: itemHelperName },
    params: [{ type: 'Identifier', name: itemName }],
    body: subStmts,
  };
  const itemFnSource = compileFunctionBody(fakeComponent, ctx, itemHelperName);
  inlinedSubs.push(itemFnSource + ';');

  return {
    id: ctx.nextHelperId++,
    itemsExpr,
    keyHelper,
    bodyHelper: itemHelperName,
    extraExpr: 'undefined',
    hostPath: null,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Detect `if (cond) return;` (with or without braces). These are short-circuit
 * guards that short-circuit the body from this point on.
 */
function isEarlyReturnIf(stmt) {
  if (!stmt || stmt.type !== 'IfStatement' || stmt.alternate) return false;
  const c = stmt.consequent;
  if (c.type === 'ReturnStatement' && c.argument == null) return true;
  if (c.type === 'BlockStatement'
    && c.body.length === 1
    && c.body[0].type === 'ReturnStatement'
    && c.body[0].argument == null) return true;
  return false;
}

/**
 * Rewrite TSRX early-returns into nested negated-condition if-blocks:
 *   stmt1; if (X) return; stmt2; if (Y) return; stmt3;
 *   ⇒
 *   stmt1; if (!X) { stmt2; if (!Y) { stmt3; } }
 *
 * The result is then processed by our existing if-as-jsx machinery — each
 * synthetic `if (!cond) { ... }` becomes an ifBlock if its body contains JSX.
 */
function rewriteEarlyReturns(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (isEarlyReturnIf(stmt)) {
      const rest = rewriteEarlyReturns(body.slice(i + 1));
      // If `rest` is empty, the early-return becomes a no-op (nothing after it).
      if (rest.length > 0) {
        out.push({
          type: 'IfStatement',
          test: { type: 'UnaryExpression', operator: '!', argument: stmt.test, prefix: true },
          consequent: { type: 'BlockStatement', body: rest },
          alternate: null,
        });
      }
      return out;
    }
    out.push(stmt);
  }
  return out;
}

function isJsxNode(node) {
  if (node.type === 'Element' || node.type === 'Text') return true;
  if (node.type === 'Tsx' || node.type === 'Tsrx') return true;
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return true;
  if (node.type === 'IfStatement') {
    return bodyContainsJsx(node.consequent) || (!!node.alternate && bodyContainsJsx(node.alternate));
  }
  if (node.type === 'ForOfStatement') {
    return bodyContainsJsx(node.body);
  }
  if (node.type === 'TryStatement') {
    return bodyContainsJsx(node.block)
      || (!!node.handler && bodyContainsJsx(node.handler.body));
  }
  return false;
}

function bodyContainsJsx(node) {
  if (!node) return false;
  if (node.type === 'BlockStatement') return node.body.some(isJsxNode);
  return isJsxNode(node);
}

function walkExpr(rootVar, path) {
  if (path.length === 0) return rootVar;
  let expr = rootVar;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    expr = `${expr}.firstChild`;
    for (let n = 0; n < idx; n++) expr = `${expr}.nextSibling`;
  }
  return expr;
}

function allocTemplate(ctx, html) {
  const id = ctx.nextTemplateId++;
  const name = `_t$${id}`;
  ctx.hoistedTemplates.push({ name, html });
  return name;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function printNode(node) {
  const { code } = esrapPrint(node, esrapTsx());
  return code;
}

function printExpr(node) {
  // Wrap in an ExpressionStatement to get a printable form, then strip trailing `;`.
  const wrapped = { type: 'ExpressionStatement', expression: node };
  return printNode(wrapped).trim().replace(/;$/, '');
}

/**
 * Like printExpr, but first walks the AST and replaces any `<tsrx>...</tsrx>`
 * or `<tsx>...</tsx>` blocks with identifier references to hoisted render fns.
 * Used at attribute-value and prop-value sites where Tsrx is at expression position.
 */
function printExprWithTsrx(node, ctx, componentName, inlinedSubs) {
  const rewritten = rewriteTsrxBlocks(node, ctx, componentName, inlinedSubs);
  return printExpr(rewritten);
}

function mapAst(node, mutate) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(c => mapAst(c, mutate));
  const replaced = mutate(node);
  if (replaced != null) return replaced;
  const out = {};
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'metadata') { out[k] = node[k]; continue; }
    out[k] = mapAst(node[k], mutate);
  }
  return out;
}
