import { describe, it, expect } from 'vitest';
import { mount } from './_helpers';
import { List, MutableList } from './_fixtures/for.tsrx';

const labels = (r: ReturnType<typeof mount>) =>
  r.findAll('li').map(li => li.textContent);

describe('forBlock — mount', () => {
  it('mounts an empty list', () => {
    const r = mount(List, { items: [] });
    expect(r.findAll('li')).toHaveLength(0);
    r.unmount();
  });

  it('mounts items in order', () => {
    const r = mount(List, { items: [{id:1,label:'a'},{id:2,label:'b'},{id:3,label:'c'}] });
    expect(labels(r)).toEqual(['a', 'b', 'c']);
    r.unmount();
  });
});

describe('forBlock — reconciliation', () => {
  it('reverse — keeps DOM nodes, reorders', () => {
    const r = mount(MutableList);
    const before = r.findAll('li');
    r.click('#reverse');
    expect(labels(r)).toEqual(['c', 'b', 'a']);
    // Same DOM nodes, just reordered (LIS-keyed reconciliation).
    const after = r.findAll('li');
    expect(after[0]).toBe(before[2]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[0]);
    r.unmount();
  });

  it('swap first + last', () => {
    const r = mount(MutableList);
    r.click('#swap');
    expect(labels(r)).toEqual(['c', 'b', 'a']);
    r.unmount();
  });

  it('append at end keeps existing nodes', () => {
    const r = mount(MutableList);
    const before = r.findAll('li');
    r.click('#add');
    expect(labels(r)).toEqual(['a', 'b', 'c', 'd']);
    const after = r.findAll('li');
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    r.unmount();
  });

  it('remove-first', () => {
    const r = mount(MutableList);
    r.click('#remove-first');
    expect(labels(r)).toEqual(['b', 'c']);
    r.unmount();
  });

  it('remove-middle', () => {
    const r = mount(MutableList);
    r.click('#remove-middle');
    expect(labels(r)).toEqual(['a', 'c']);
    r.unmount();
  });

  it('clear all', () => {
    const r = mount(MutableList);
    r.click('#clear');
    expect(labels(r)).toEqual([]);
    r.unmount();
  });

  it('add → reverse → remove permutation', () => {
    const r = mount(MutableList);
    r.click('#add');                                  // a b c d
    r.click('#reverse');                              // d c b a
    r.click('#remove-middle');                        // d c a
    expect(labels(r)).toEqual(['d', 'c', 'a']);
    r.unmount();
  });
});
