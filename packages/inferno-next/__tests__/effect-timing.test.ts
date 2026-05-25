import { describe, it, expect, vi } from 'vitest';
import { mount, nextPaint } from './_helpers';
import { PhaseOrder, LayoutReadsDom, PassiveDeferred } from './_fixtures/effect-timing.tsrx';

describe('effect timing', () => {
  it('phase order on mount: insertion → layout (sync) → passive (post-paint)', async () => {
    const log: string[] = [];
    const r = mount(PhaseOrder, { tick: 0, log });
    // insertion + layout fire synchronously during commit (inside mount's flushSync).
    expect(log).toEqual(['ins:body', 'lay:body']);
    // passive deferred until after paint.
    await nextPaint();
    expect(log).toEqual(['ins:body', 'lay:body', 'eff:body']);
    r.unmount();
  });

  it('phase order on re-render: cleanups fire before bodies of same phase', async () => {
    const log: string[] = [];
    const r = mount(PhaseOrder, { tick: 0, log });
    await nextPaint();
    log.length = 0;                          // clear mount log
    r.update(PhaseOrder, { tick: 1, log });
    // After update: insertion cleanup → insertion body → layout cleanup → layout body.
    expect(log).toEqual(['ins:cleanup', 'ins:body', 'lay:cleanup', 'lay:body']);
    await nextPaint();
    // Then passive cleanup → passive body.
    expect(log).toEqual([
      'ins:cleanup', 'ins:body',
      'lay:cleanup', 'lay:body',
      'eff:cleanup', 'eff:body',
    ]);
    r.unmount();
  });

  it('all phases fire cleanup on unmount', async () => {
    const log: string[] = [];
    const r = mount(PhaseOrder, { tick: 0, log });
    await nextPaint();
    log.length = 0;
    r.unmount();
    // Cleanups fire in scope-cleanup order (registration order: ins → lay → eff).
    expect(log).toEqual(['ins:cleanup', 'lay:cleanup', 'eff:cleanup']);
  });

  it('useLayoutEffect can read the committed DOM synchronously', () => {
    const onCommit = vi.fn();
    const r = mount(LayoutReadsDom, { onCommit });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const html = onCommit.mock.calls[0][0];
    expect(html).toContain('id="measured"');
    expect(html).toContain('A');
    r.unmount();
  });

  it('flushSync drains insertion+layout but NOT passive', async () => {
    const log: string[] = [];
    const r = mount(PassiveDeferred, { tick: 0, log });
    // flushSync (used by mount) drained layout but not passive.
    expect(log).toEqual(['layout']);
    await nextPaint();
    expect(log).toEqual(['layout', 'passive']);
    r.unmount();
  });
});
