import { describe, expect, it } from 'vitest';
import { calibrationReport, interpolate, parseCalibration, pearson } from './calibration.ts';

describe('calibration', () => {
  it('reads EPANET .dat files, continuing locations', () => {
    const { observations, issues } = parseCalibration(
      ';Fluoride data\nN1  0  1.2\n    6:30  1.4 ; later\nN2 2 0.9\nbad line here x\n7\n',
    );
    expect(observations).toEqual([
      { location: 'N1', hours: 0, value: 1.2 },
      { location: 'N1', hours: 6.5, value: 1.4 },
      { location: 'N2', hours: 2, value: 0.9 },
    ]);
    expect(issues).toHaveLength(2);
  });

  it('interpolates between report times', () => {
    expect(interpolate([0, 1, 2], [10, 20, 40], 1.5)).toBe(30);
    expect(interpolate([0, 1, 2], [10, 20, 40], 0)).toBe(10);
    expect(interpolate([0, 1, 2], [10, 20, 40], 3)).toBeNaN();
  });

  it('computes per-location and network statistics', () => {
    const hours = [0, 1, 2];
    const sim: Record<string, number[]> = { A: [10, 10, 10], B: [20, 22, 24] };
    const r = calibrationReport(
      [
        { location: 'A', hours: 0, value: 11 },
        { location: 'A', hours: 2, value: 9 },
        { location: 'B', hours: 1, value: 21 },
        { location: 'B', hours: 5, value: 21 },
        { location: 'C', hours: 1, value: 1 },
      ],
      hours,
      (l) => sim[l] ?? null,
    );
    expect(r.unknown).toEqual(['C']);
    expect(r.outside).toBe(1);
    expect(r.rows[0]).toEqual({
      location: 'A',
      n: 2,
      observedMean: 10,
      computedMean: 10,
      meanError: 1,
      rmsError: 1,
    });
    expect(r.rows[1]).toMatchObject({
      location: 'B',
      n: 1,
      observedMean: 21,
      computedMean: 22,
      meanError: 1,
    });
    expect(r.network.n).toBe(3);
    expect(r.correlation).toBeCloseTo(1, 12);
    expect(pearson([1], [1])).toBeNull();
  });
});
