import { describe, it, expect } from 'vitest';
import { mount } from './_helpers';
import { Toggle, IfOnly, HookInIf, IdInComponent } from './_fixtures/control.tsrx';

describe('ifBlock', () => {
  it('swaps then/else branches', () => {
    const r = mount(Toggle);
    expect(r.findAll('.shown')).toHaveLength(0);
    expect(r.findAll('.hidden')).toHaveLength(1);
    r.click('button');
    expect(r.findAll('.shown')).toHaveLength(1);
    expect(r.findAll('.hidden')).toHaveLength(0);
    r.click('button');
    expect(r.findAll('.shown')).toHaveLength(0);
    expect(r.findAll('.hidden')).toHaveLength(1);
    r.unmount();
  });

  it('handles if without else (mount + unmount nothing on false)', () => {
    const r = mount(IfOnly);
    expect(r.findAll('.maybe')).toHaveLength(0);
    r.click('button');
    expect(r.findAll('.maybe')).toHaveLength(1);
    r.click('button');
    expect(r.findAll('.maybe')).toHaveLength(0);
    r.unmount();
  });

  it('hooks inside if-branch reset when branch unmounts (Block boundary)', () => {
    const r = mount(HookInIf);
    expect(r.find('#inner').textContent).toBe('0');
    r.click('#inner');
    r.click('#inner');
    expect(r.find('#inner').textContent).toBe('2');
    r.click('#top');  // hide
    expect(r.findAll('#inner')).toHaveLength(0);
    r.click('#top');  // show again — fresh state
    expect(r.find('#inner').textContent).toBe('0');
    r.unmount();
  });
});

describe('useId', () => {
  it('produces a stable id for the component', () => {
    const r = mount(IdInComponent);
    const id1 = r.find('label').getAttribute('for');
    expect(id1).toMatch(/^:in-[a-z0-9]+:$/);
    expect(r.find('label').textContent).toBe(id1!);
    r.unmount();
  });

  it('produces distinct ids across separate components', () => {
    const r1 = mount(IdInComponent);
    const r2 = mount(IdInComponent);
    expect(r1.find('label').getAttribute('for')).not.toBe(r2.find('label').getAttribute('for'));
    r1.unmount(); r2.unmount();
  });
});
