import { describe, expect, it } from 'vitest';
import type { KeywordSection } from './generated/model.ts';
import {
  displayOption,
  formatClock,
  formatDuration,
  hour,
  OPTION_SPECS,
  parseOption,
  qualityTokens,
  readOption,
  readQuality,
  timeSeconds,
  writeOption,
} from './options.ts';
import { unitSystem } from './units.ts';

const sec = (...lines: string[]): KeywordSection => ({
  lines: lines.map((l) => ({ tokens: l.split(/\s+/), comment: null })),
});
const text = (s: KeywordSection) => s.lines.map((l) => l.tokens.join(' '));

describe('options', () => {
  it('reads options as the engine matches them', () => {
    const o = sec(
      'Units LPS',
      'Headloss D-W',
      'Pressure kPa',
      'Pressure Exponent 0.6',
      'Demand Multiplier 1.5',
      'Demand Model PDA',
      'Specific Gravity 0.9',
      'Minimum Pressure 5',
      'Quality Chlorine mg/L',
    );
    expect(readOption(o, 'flowUnits')).toEqual(['LPS']);
    expect(readOption(o, 'headloss')).toEqual(['D-W']);
    expect(readOption(o, 'pressureUnits')).toEqual(['kPa']);
    expect(readOption(o, 'pressureExponent')).toEqual(['0.6']);
    expect(readOption(o, 'demandMultiplier')).toEqual(['1.5']);
    expect(readOption(o, 'demandModel')).toEqual(['PDA']);
    expect(readOption(o, 'specificGravity')).toEqual(['0.9']);
    expect(readOption(o, 'minimumPressure')).toEqual(['5']);
    expect(readOption(o, 'trials')).toBeUndefined();
    expect(readQuality(o)).toEqual({ kind: 'chemical', name: 'Chlorine', units: 'mg/L' });
    // A later PRESSURE EXPONENT line does not hide the pressure units.
    expect(unitSystem(o).pressure).toBe('KPA');
  });

  it('writes one canonical line in place of every line that set the option', () => {
    const o = sec('UNITS GPM', 'TRIALS 40', 'HEADLOSS H-W', 'TRIAL 50');
    expect(text(writeOption(o, 'trials', ['100']))).toEqual(['UNITS GPM', 'TRIALS 100', 'HEADLOSS H-W']);
    expect(text(writeOption(o, 'trials', null))).toEqual(['UNITS GPM', 'HEADLOSS H-W']);
    expect(text(writeOption(o, 'accuracy', ['0.0001']))).toEqual([...text(o), 'ACCURACY 0.0001']);
    // Pressure units and the pressure exponent are separate.
    const p = sec('PRESSURE EXPONENT 0.5', 'PRESSURE PSI');
    expect(text(writeOption(p, 'pressureUnits', ['METERS']))).toEqual([
      'PRESSURE EXPONENT 0.5',
      'PRESSURE METERS',
    ]);
    // Unchanged writes return the same section.
    const same = sec('TRIALS 100');
    expect(writeOption(same, 'trials', ['100'])).toBe(same);
  });

  it('keeps the comment of the line it replaces', () => {
    const o: KeywordSection = { lines: [{ tokens: ['TRIALS', '40'], comment: 'tuned' }] };
    expect(writeOption(o, 'trials', ['60']).lines[0]).toEqual({ tokens: ['TRIALS', '60'], comment: 'tuned' });
  });

  it('reads times as timedata does', () => {
    expect(hour('1:30')).toBe(1.5);
    expect(hour('90', 'MIN')).toBe(1.5);
    expect(hour('12', 'AM')).toBe(0);
    expect(hour('12', 'PM')).toBe(12);
    expect(hour('1:30', 'PM')).toBe(13.5);
    expect(hour('13', 'PM')).toBe(-1);
    expect(timeSeconds(['DURATION', '24', 'HOURS'])).toBe(86400);
    expect(timeSeconds(['HYDRAULIC', 'TIMESTEP', '0:15'])).toBe(900);
    expect(timeSeconds(['START', 'CLOCKTIME', '6', 'PM'])).toBe(18 * 3600);
    const t = sec(
      'DURATION 72 HOURS',
      'HYDRAULIC TIMESTEP 0:30',
      'PATTERN START 2',
      'START CLOCKTIME 6:30 PM',
    );
    expect(displayOption(t, 'duration')).toBe('72:00');
    expect(displayOption(t, 'hydraulicStep')).toBe('0:30');
    expect(displayOption(t, 'patternStart')).toBe('2:00');
    expect(displayOption(t, 'patternStep')).toBeUndefined();
    expect(displayOption(t, 'startClock')).toBe('6:30 PM');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(12 * 3600)).toBe('12:00 PM');
  });

  it('parses what the user types', () => {
    expect(parseOption('trials', '')).toEqual({ ok: true, tokens: null });
    expect(parseOption('trials', '40')).toEqual({ ok: true, tokens: ['40'] });
    expect(parseOption('trials', '4.5')).toMatchObject({ ok: false });
    expect(parseOption('trials', '0')).toMatchObject({ ok: false });
    expect(parseOption('accuracy', 'abc')).toMatchObject({ ok: false });
    expect(parseOption('duration', '48')).toEqual({ ok: true, tokens: ['48:00'] });
    expect(parseOption('duration', '30 min')).toEqual({ ok: true, tokens: ['0:30'] });
    expect(parseOption('duration', 'soon')).toMatchObject({ ok: false });
    expect(parseOption('startClock', '6 PM')).toEqual({ ok: true, tokens: ['6:00', 'PM'] });
    expect(parseOption('headloss', 'D-W')).toEqual({ ok: true, tokens: ['D-W'] });
    expect(parseOption('headloss', 'XX')).toMatchObject({ ok: false });
  });

  it('writes the quality option so EPANET reads it back', () => {
    expect(qualityTokens({ kind: 'none' })).toEqual({ ok: true, tokens: null });
    expect(qualityTokens({ kind: 'age' })).toEqual({ ok: true, tokens: ['AGE'] });
    expect(qualityTokens({ kind: 'trace', node: 'R1' })).toEqual({ ok: true, tokens: ['TRACE', 'R1'] });
    expect(qualityTokens({ kind: 'chemical', name: 'Fluoride', units: 'mg/L' })).toEqual({
      ok: true,
      tokens: ['Fluoride', 'mg/L'],
    });
    expect(qualityTokens({ kind: 'chemical', name: '', units: '' })).toEqual({
      ok: true,
      tokens: ['CHEMICAL'],
    });
    // "Agent" begins with AGE, so EPANET would run a water age analysis.
    expect(qualityTokens({ kind: 'chemical', name: 'Agent', units: 'mg/L' })).toMatchObject({ ok: false });
    expect(readQuality(sec('QUALITY TRACE R1'))).toEqual({ kind: 'trace', node: 'R1' });
  });

  it('reads energy, reactions and report lines', () => {
    const e = sec('GLOBAL EFFIC 80', 'Global Price 0.12', 'DEMAND CHARGE 3.5');
    expect(readOption(e, 'globalEfficiency')).toEqual(['80']);
    expect(readOption(e, 'globalPrice')).toEqual(['0.12']);
    expect(readOption(e, 'demandCharge')).toEqual(['3.5']);
    const r = sec('ORDER BULK 2', 'ORDER WALL 0', 'GLOBAL BULK -0.5', 'LIMITING POTENTIAL 1');
    expect(readOption(r, 'bulkOrder')).toEqual(['2']);
    expect(readOption(r, 'wallOrder')).toEqual(['0']);
    expect(readOption(r, 'globalBulk')).toEqual(['-0.5']);
    expect(readOption(r, 'globalWall')).toBeUndefined();
    expect(readOption(r, 'limitingPotential')).toEqual(['1']);
    const p = sec('STATUS FULL', 'NODES 1 2', 'NODES 3', 'LINKS ALL', 'PRESSURE PRECISION 3');
    expect(readOption(p, 'reportStatus')).toEqual(['FULL']);
    expect(readOption(p, 'reportNodes')).toEqual(['1', '2', '3']);
    expect(readOption(p, 'reportLinks')).toEqual(['ALL']);
    const ids = Array.from({ length: 23 }, (_, i) => `N${i}`);
    const w = writeOption(p, 'reportNodes', ids);
    expect(w.lines.filter((l) => l.tokens[0] === 'NODES')).toHaveLength(3);
    expect(readOption(w, 'reportNodes')).toEqual(ids);
    // Report field lines are left alone.
    expect(text(w)).toContain('PRESSURE PRECISION 3');
  });

  it('gives every option a unique id and a fallback that parses', () => {
    const ids = OPTION_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of OPTION_SPECS) {
      if (s.fallback === '' || s.kind.type === 'custom') continue;
      expect(parseOption(s.id, s.fallback), s.id).toMatchObject({ ok: true });
    }
  });
});
