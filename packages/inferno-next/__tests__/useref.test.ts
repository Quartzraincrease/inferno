import { describe, it, expect, vi } from 'vitest';
import { mount, nextPaint } from './_helpers';
import {
  PersistsAcrossRenders, MutationDoesNotRerender, StableIdentity,
  RefInIf, PerRowRef, DomRefObject, DomRefCallback, MultipleRefsOneEl,
  DomRefCleanup, LazyInit,
} from './_fixtures/useref.tsrx';

describe('useRef — mutation API', () => {
  it('persists ref.current across renders', () => {
    const r = mount(PersistsAcrossRenders);
    expect(r.find('.value').textContent).toBe('0');
    r.click('#bump'); r.click('#bump'); r.click('#bump');
    expect(r.find('.value').textContent).toBe('3');
    r.unmount();
  });

  it('mutating ref.current does not trigger a render', () => {
    const handle: any = {};
    const r = mount(MutationDoesNotRerender, { tick: 1, bumpHandle: handle });
    expect(r.find('.count').textContent).toBe('1');
    expect(handle.read()).toBe(0);

    // Mutate ref off-render — DOM does not update.
    handle.bump(); handle.bump(); handle.bump();
    expect(r.find('.count').textContent).toBe('1');
    expect(handle.read()).toBe(3);

    // Force a re-render via prop change — ref still has value 3.
    r.update(MutationDoesNotRerender, { tick: 2, bumpHandle: handle });
    expect(r.find('.count').textContent).toBe('2');
    expect(handle.read()).toBe(3);
    r.unmount();
  });

  it('returns the same ref object identity across renders', () => {
    const observe = vi.fn();
    const r = mount(StableIdentity, { observe });
    const first = observe.mock.calls[0][0];
    r.click('button'); r.click('button');
    for (const c of observe.mock.calls) expect(c[0]).toBe(first);
    expect(first.current).toEqual({ data: 'inner' });
    r.unmount();
  });

  it('runs the initial value only once', () => {
    const factory = vi.fn(() => ({ token: Math.random() }));
    const r = mount(LazyInit, { factory });
    const first = factory.mock.results[0].value;
    r.click('button'); r.click('button');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(r.find('button').textContent).toContain(String(first));
    r.unmount();
  });
});

describe('useRef — boundary semantics', () => {
  it('ref inside an if-branch resets when the branch remounts', () => {
    const r = mount(RefInIf);
    expect(r.find('#inner').textContent).toBe('0');
    r.click('#inner'); r.click('#inner'); r.click('#inner');
    expect(r.find('#inner').textContent).toBe('3');
    r.click('#top');                                        // hide → branch unmount
    expect(r.findAll('#inner')).toHaveLength(0);
    r.click('#top');                                        // show → fresh slot
    expect(r.find('#inner').textContent).toBe('0');
    r.unmount();
  });

  it('each for-of item has its own ref slot, surviving reorders', () => {
    const r = mount(PerRowRef);
    // Bump each row a different number of times.
    r.click('.r-1 button'); r.click('.r-1 button');             // a → 2
    r.click('.r-2 button');                                     // b → 1
    r.click('.r-3 button'); r.click('.r-3 button'); r.click('.r-3 button');  // c → 3
    expect(r.findAll('li button').map(b => b.textContent)).toEqual(['a:2', 'b:1', 'c:3']);
    // Reverse — refs follow their keys.
    r.click('#reverse');
    expect(r.findAll('li button').map(b => b.textContent)).toEqual(['c:3', 'b:1', 'a:2']);
    r.unmount();
  });
});

describe('useRef — DOM ref attribute', () => {
  it('object ref captures the mounted element', async () => {
    const target: any = {};
    const r = mount(DomRefObject, { target });
    // After commit, the effect ran and copied ref.current into target.received.
    await nextPaint();
    const el = target.received;
    expect(el).not.toBe(null);
    expect(el.tagName).toBe('DIV');
    expect(el.id).toBe('unique-id');
    expect(el.className).toBe('target');
    r.unmount();
  });

  it('callback ref is invoked with the mounted element', () => {
    const target: any = {};
    mount(DomRefCallback, { target });
    expect(target.received).not.toBe(null);
    expect(target.received.tagName).toBe('DIV');
    expect(target.received.className).toBe('callback-target');
  });

  it('multiple {ref} expressions on one element all attach', async () => {
    const target: any = {};
    mount(MultipleRefsOneEl, { target });
    await nextPaint();
    expect(target.a).not.toBe(null);
    expect(target.b).not.toBe(null);
    expect(target.a).toBe(target.b);   // both refer to the same element
    expect(target.a.className).toBe('multi');
  });

  it('object ref is cleared when the host element unmounts', () => {
    const r = mount(DomRefCleanup);
    expect(r.find('.snapshot').textContent).toBe('has-el');
    r.click('#toggle');                                     // hide → element unmounts
    // After re-render, the ref was set to null on unmount, snapshot reflects it.
    expect(r.find('.snapshot').textContent).toBe('null');
    r.click('#toggle');                                     // show again
    expect(r.find('.snapshot').textContent).toBe('has-el');
    r.unmount();
  });
});
