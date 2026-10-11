import { describe, expect, it } from 'vitest';
import { extent, hoursLabel, niceStep, niceTicks, tickLabel } from './scale.ts';

describe('chart scales', () => {
  it('finds extents of finite values', () => {
    expect(extent([3, NaN, -1, 7])).toEqual([-1, 7]);
    expect(extent([])).toEqual([0, 1]);
  });

  it('picks nice steps', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(1, 4)).toBe(0.25);
    expect(niceStep(730, 5)).toBe(200);
  });

  it('widens ranges to whole ticks', () => {
    const t = niceTicks(3.2, 47.9, 5);
    expect([t.min, t.max, t.step]).toEqual([0, 50, 10]);
    expect(t.values).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(5, 5).values.length).toBeGreaterThan(1);
  });

  it('labels ticks and times', () => {
    expect(tickLabel(20, 10)).toBe('20');
    expect(tickLabel(0.5, 0.5)).toBe('0.5');
    expect(tickLabel(0.25, 0.25)).toBe('0.25');
    expect(tickLabel(1.2, 0.2)).toBe('1.2');
    expect(hoursLabel(25.5)).toBe('1d 1:30');
  });
});
