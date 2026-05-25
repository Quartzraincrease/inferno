import { describe, it, expect } from 'vitest';
import { mount } from './_helpers';
import { Hello, Counter, Greet, Mixed } from './_fixtures/basic.tsrx';

describe('basic', () => {
  it('mounts a static element', () => {
    const r = mount(Hello);
    expect(r.html()).toBe('<div class="greet">Hello, world</div>');
    r.unmount();
    expect(r.container.parentNode).toBe(null);
  });

  it('renders props into a text hole (only-child fast path)', () => {
    const r = mount(Counter, { n: 7 });
    expect(r.html()).toBe('<span>7</span>');
    r.unmount();
  });

  it('renders multiple text holes among static text', () => {
    const r = mount(Greet, { name: 'world' });
    expect(r.find('p').textContent).toBe('Hello, world !');
    r.unmount();
  });

  it('mounts nested static elements', () => {
    const r = mount(Mixed);
    expect(r.findAll('#m > span')).toHaveLength(2);
    expect(r.find('.a').textContent).toBe('A');
    expect(r.find('.b').textContent).toBe('B');
    r.unmount();
  });
});
