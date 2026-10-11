/**
 * The project options EPANET keeps in [OPTIONS], [TIMES], [REACTIONS], [ENERGY] and
 * [REPORT], as a catalogue the options editor and agent tools share. Lines are matched
 * exactly as the engine reads them (`optionchoice`, `optionvalue`, `timedata`,
 * `reactdata`, `energydata`, `reportdata`), so the editor shows the value that will be
 * used. Writing an option replaces every line that sets it with one canonical line at
 * the place of the first; clearing it removes them, which restores EPANET's default.
 * Lines the catalogue does not cover are never touched.
 */

import type { KeywordLine, KeywordSection } from './generated/model.ts';
import { keywordMatches as m } from './units.ts';
import type { Quantity } from './schema.ts';

export type OptionSection = 'options' | 'times' | 'reactions' | 'energy' | 'report';

export type OptionKind =
  | { type: 'choice'; choices: readonly (readonly [value: string, label: string])[] }
  | { type: 'number'; min?: number; above?: number; below?: number; integer?: boolean }
  | { type: 'duration' }
  | { type: 'clock' }
  | { type: 'pattern' }
  /** Edited by a dedicated control (quality, unbalanced, reported elements). */
  | { type: 'custom' };

export interface OptionSpec {
  id: string;
  section: OptionSection;
  group: string;
  label: string;
  help: string;
  /** Keywords written before the value. */
  keys: readonly string[];
  /** Whether a line sets this option, as the engine decides. */
  match: (t: readonly string[]) => boolean;
  /** The value tokens of a matching line. */
  value: (t: readonly string[]) => string[];
  kind: OptionKind;
  /** EPANET's value when no line sets it, in the form the editor shows. */
  fallback: string;
  quantity?: Quantity | 'pressureSetting';
}

/** C `strtod` with the whole token consumed, as EPANET's `getfloat`. */
export function getfloat(s: string): number | undefined {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : undefined;
}

/** EPANET's `hour`: a time in hours, or -1 if it cannot be read. */
export function hour(time: string, units = ''): number {
  const parts = time.split(':').filter((s) => s !== '');
  const y = [0, 0, 0];
  let n = 0;
  for (const s of parts) {
    if (n >= 3) break;
    const v = getfloat(s);
    if (v === undefined) return -1;
    y[n++] = v;
  }
  if (n === 1) {
    if (units === '') return y[0]!;
    if (m(units, 'SEC')) return y[0]! / 3600;
    if (m(units, 'MIN')) return y[0]! / 60;
    if (m(units, 'HOU')) return y[0]!;
    if (m(units, 'DAY')) return y[0]! * 24;
  }
  if (n > 1) y[0] = y[0]! + y[1]! / 60 + y[2]! / 3600;
  if (units === '') return y[0]!;
  if (m(units, 'AM')) {
    if (y[0]! >= 13) return -1;
    return y[0]! >= 12 ? y[0]! - 12 : y[0]!;
  }
  if (m(units, 'PM')) {
    if (y[0]! >= 13) return -1;
    return y[0]! >= 12 ? y[0]! : y[0]! + 12;
  }
  return -1;
}

/** Seconds from the value tokens of a [TIMES] line, as `timedata` reads them; undefined if unreadable. */
export function timeSeconds(t: readonly string[]): number | undefined {
  const n = t.length - 1;
  if (n < 0) return undefined;
  let y = getfloat(t[n]!);
  if (y === undefined) {
    y = hour(t[n]!);
    if (y < 0) {
      if (n < 1) return undefined;
      y = hour(t[n - 1]!, t[n]);
      if (y < 0) return undefined;
    }
  }
  return Math.trunc(3600 * y + 0.5);
}

/** h:mm, or h:mm:ss when there are seconds. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${h}:${String(mm).padStart(2, '0')}${ss ? `:${String(ss).padStart(2, '0')}` : ''}`;
}

/** A time of day as h:mm AM/PM. */
export function formatClock(seconds: number): string {
  const s = ((seconds % 86400) + 86400) % 86400;
  const h24 = Math.floor(s / 3600);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const rest = formatDuration(s % 3600).slice(1);
  return `${h}${rest} ${h24 < 12 ? 'AM' : 'PM'}`;
}

const from = (i: number) => (t: readonly string[]) => t.slice(i);
const last = (t: readonly string[]) => t.slice(-1);
const at = (t: readonly string[], i: number, k: string) => t.length > i && m(t[i]!, k);
const timeValue = (t: readonly string[]) => {
  const s = timeSeconds(t);
  return s === undefined ? t.slice(-1) : [String(s)];
};

const FLOW = [
  ['CFS', 'CFS (cubic feet per second)'],
  ['GPM', 'GPM (US gallons per minute)'],
  ['MGD', 'MGD (million US gallons per day)'],
  ['IMGD', 'IMGD (million imperial gallons per day)'],
  ['AFD', 'AFD (acre-feet per day)'],
  ['LPS', 'LPS (litres per second)'],
  ['LPM', 'LPM (litres per minute)'],
  ['MLD', 'MLD (megalitres per day)'],
  ['CMH', 'CMH (cubic metres per hour)'],
  ['CMD', 'CMD (cubic metres per day)'],
  ['CMS', 'CMS (cubic metres per second)'],
] as const;
const YES_NO = [
  ['YES', 'Yes'],
  ['NO', 'No'],
] as const;

const opt = (s: Omit<OptionSpec, 'section' | 'value'> & { value?: OptionSpec['value'] }): OptionSpec => ({
  section: 'options',
  value: from(s.keys.length),
  ...s,
});

export const OPTION_SPECS: readonly OptionSpec[] = [
  // [OPTIONS]: hydraulics
  opt({
    id: 'flowUnits',
    group: 'Hydraulics',
    label: 'Flow units',
    help: 'Also selects US customary or SI units for every other quantity. Values are not converted: change units before entering data.',
    keys: ['UNITS'],
    match: (t) => m(t[0]!, 'UNIT'),
    kind: { type: 'choice', choices: FLOW },
    fallback: 'GPM',
  }),
  opt({
    id: 'headloss',
    group: 'Hydraulics',
    label: 'Headloss formula',
    help: 'Hazen-Williams, Darcy-Weisbach or Chezy-Manning. Pipe roughness means something different in each.',
    keys: ['HEADLOSS'],
    match: (t) => m(t[0]!, 'HEADL'),
    kind: {
      type: 'choice',
      choices: [
        ['H-W', 'Hazen-Williams'],
        ['D-W', 'Darcy-Weisbach'],
        ['C-M', 'Chezy-Manning'],
      ],
    },
    fallback: 'H-W',
  }),
  opt({
    id: 'pressureUnits',
    group: 'Hydraulics',
    label: 'Pressure units',
    help: 'Units for reported pressures. The default follows the flow units: psi for US, metres for SI.',
    keys: ['PRESSURE'],
    match: (t) => m(t[0]!, 'PRESSURE') && !at(t, 1, 'EXP'),
    kind: {
      type: 'choice',
      choices: [
        ['PSI', 'psi'],
        ['KPA', 'kPa'],
        ['METERS', 'metres'],
        ['BAR', 'bar'],
        ['FEET', 'feet'],
      ],
    },
    fallback: '',
  }),
  opt({
    id: 'specificGravity',
    group: 'Hydraulics',
    label: 'Specific gravity',
    help: 'Density of the fluid relative to water at 4 °C.',
    keys: ['SPECIFIC', 'GRAVITY'],
    match: (t) => m(t[0]!, 'SPEC'),
    kind: { type: 'number', above: 0 },
    fallback: '1',
  }),
  opt({
    id: 'viscosity',
    group: 'Hydraulics',
    label: 'Relative viscosity',
    help: 'Kinematic viscosity relative to water at 20 °C (Darcy-Weisbach only).',
    keys: ['VISCOSITY'],
    match: (t) => m(t[0]!, 'VISC'),
    kind: { type: 'number', above: 0 },
    fallback: '1',
  }),
  opt({
    id: 'trials',
    group: 'Hydraulics',
    label: 'Maximum trials',
    help: 'Most iterations allowed to solve the network at one time.',
    keys: ['TRIALS'],
    match: (t) => m(t[0]!, 'TRIAL'),
    kind: { type: 'number', above: 0, integer: true },
    fallback: '200',
  }),
  opt({
    id: 'accuracy',
    group: 'Hydraulics',
    label: 'Accuracy',
    help: 'Convergence: total flow change divided by total flow. Kept between 0.00001 and 0.1.',
    keys: ['ACCURACY'],
    match: (t) => m(t[0]!, 'ACCU'),
    kind: { type: 'number', above: 0 },
    fallback: '0.001',
  }),
  opt({
    id: 'headError',
    group: 'Hydraulics',
    label: 'Head error limit',
    help: 'Also required for convergence: largest head-loss error on any link (0 means not checked).',
    keys: ['HEADERROR'],
    match: (t) => m(t[0]!, 'HEADERROR'),
    kind: { type: 'number', min: 0 },
    fallback: '0',
    quantity: 'head',
  }),
  opt({
    id: 'flowChange',
    group: 'Hydraulics',
    label: 'Flow change limit',
    help: 'Also required for convergence: largest flow change on any link (0 means not checked).',
    keys: ['FLOWCHANGE'],
    match: (t) => m(t[0]!, 'FLOWCHANGE'),
    kind: { type: 'number', min: 0 },
    fallback: '0',
    quantity: 'flow',
  }),
  opt({
    id: 'checkFreq',
    group: 'Hydraulics',
    label: 'Status check frequency',
    help: 'Trials between status checks of pumps, check valves and tank links.',
    keys: ['CHECKFREQ'],
    match: (t) => m(t[0]!, 'CHECKFREQ'),
    kind: { type: 'number', above: 0, integer: true },
    fallback: '2',
  }),
  opt({
    id: 'maxCheck',
    group: 'Hydraulics',
    label: 'Maximum status checks',
    help: 'Trial after which status checks stop.',
    keys: ['MAXCHECK'],
    match: (t) => m(t[0]!, 'MAXCHECK'),
    kind: { type: 'number', above: 0, integer: true },
    fallback: '10',
  }),
  opt({
    id: 'dampLimit',
    group: 'Hydraulics',
    label: 'Damping limit',
    help: 'Accuracy below which flow changes are damped and valves checked every trial (0 means never).',
    keys: ['DAMPLIMIT'],
    match: (t) => m(t[0]!, 'DAMPLIMIT'),
    kind: { type: 'number' },
    fallback: '0',
  }),
  opt({
    id: 'unbalanced',
    group: 'Hydraulics',
    label: 'If unbalanced',
    help: 'Stop the run, or continue for some more trials with link status fixed.',
    keys: ['UNBALANCED'],
    match: (t) => m(t[0]!, 'UNBA'),
    kind: { type: 'custom' },
    fallback: 'STOP',
  }),
  // [OPTIONS]: demands
  opt({
    id: 'defaultPattern',
    group: 'Demands',
    label: 'Default pattern',
    help: 'Pattern for junction demands that have none. EPANET uses pattern 1 if it exists.',
    keys: ['PATTERN'],
    match: (t) => m(t[0]!, 'PATT'),
    kind: { type: 'pattern' },
    fallback: '1',
  }),
  opt({
    id: 'demandMultiplier',
    group: 'Demands',
    label: 'Demand multiplier',
    help: 'Scales every junction demand.',
    keys: ['DEMAND', 'MULTIPLIER'],
    match: (t) => m(t[0]!, 'DEMAND') && !at(t, 1, 'MODEL'),
    kind: { type: 'number', above: 0 },
    fallback: '1',
  }),
  opt({
    id: 'demandModel',
    group: 'Demands',
    label: 'Demand model',
    help: 'Demand-driven (demands always met) or pressure-driven (demand falls with pressure).',
    keys: ['DEMAND', 'MODEL'],
    match: (t) => m(t[0]!, 'DEMAND') && at(t, 1, 'MODEL'),
    kind: {
      type: 'choice',
      choices: [
        ['DDA', 'Demand-driven'],
        ['PDA', 'Pressure-driven'],
      ],
    },
    fallback: 'DDA',
  }),
  opt({
    id: 'minimumPressure',
    group: 'Demands',
    label: 'Minimum pressure',
    help: 'Pressure-driven analysis: pressure at which demand is zero.',
    keys: ['MINIMUM', 'PRESSURE'],
    match: (t) => m(t[0]!, 'MINI'),
    kind: { type: 'number', min: 0 },
    fallback: '0',
    quantity: 'pressureSetting',
  }),
  opt({
    id: 'requiredPressure',
    group: 'Demands',
    label: 'Required pressure',
    help: 'Pressure-driven analysis: pressure at which the full demand is met. At least 0.1 above the minimum.',
    keys: ['REQUIRED', 'PRESSURE'],
    match: (t) => m(t[0]!, 'REQ'),
    kind: { type: 'number', min: 0 },
    fallback: '0.1',
    quantity: 'pressureSetting',
  }),
  opt({
    id: 'pressureExponent',
    group: 'Demands',
    label: 'Pressure exponent',
    help: 'Pressure-driven analysis: exponent of the pressure-demand relation.',
    keys: ['PRESSURE', 'EXPONENT'],
    match: (t) => m(t[0]!, 'PRESSURE') && at(t, 1, 'EXP'),
    kind: { type: 'number', min: 0 },
    fallback: '0.5',
  }),
  opt({
    id: 'emitterExponent',
    group: 'Demands',
    label: 'Emitter exponent',
    help: 'Exponent of pressure in emitter flow.',
    keys: ['EMITTER', 'EXPONENT'],
    match: (t) => m(t[0]!, 'EMIT'),
    kind: { type: 'number', above: 0 },
    fallback: '0.5',
  }),
  opt({
    id: 'backflow',
    group: 'Demands',
    label: 'Emitter backflow',
    help: 'Whether emitters can take water into the network when pressure is negative (EPANET 2.3).',
    keys: ['BACKFLOW', 'ALLOWED'],
    match: (t) => m(t[0]!, 'BACK') && at(t, 1, 'ALLOW'),
    kind: { type: 'choice', choices: YES_NO },
    fallback: 'YES',
  }),
  // [OPTIONS]: quality
  opt({
    id: 'quality',
    group: 'Quality',
    label: 'Analysis',
    help: 'None, a chemical with its name and units, water age, or the percentage of water from a node.',
    keys: ['QUALITY'],
    match: (t) => m(t[0]!, 'QUAL'),
    kind: { type: 'custom' },
    fallback: 'NONE',
  }),
  opt({
    id: 'diffusivity',
    group: 'Quality',
    label: 'Relative diffusivity',
    help: 'Molecular diffusivity of the chemical relative to chlorine in water. 0 ignores mass transfer to the wall.',
    keys: ['DIFFUSIVITY'],
    match: (t) => m(t[0]!, 'DIFF'),
    kind: { type: 'number', min: 0 },
    fallback: '1',
  }),
  opt({
    id: 'tolerance',
    group: 'Quality',
    label: 'Quality tolerance',
    help: 'Smallest change in quality that makes a new parcel of water.',
    keys: ['TOLERANCE'],
    match: (t) => m(t[0]!, 'TOLER'),
    kind: { type: 'number', min: 0 },
    fallback: '0.01',
  }),
  // [REACTIONS]
  ...(
    [
      ['bulkOrder', 'ORDER', 'BULK', 'Bulk reaction order', 'Order of reactions in the bulk flow.', '1'],
      [
        'wallOrder',
        'ORDER',
        'WALL',
        'Wall reaction order',
        'Order of reactions at the pipe wall: 0 or 1.',
        '1',
      ],
      ['tankOrder', 'ORDER', 'TANK', 'Tank reaction order', 'Order of bulk reactions in tanks.', '1'],
      [
        'globalBulk',
        'GLOBAL',
        'BULK',
        'Global bulk coefficient',
        'Bulk rate coefficient for pipes and tanks without their own.',
        '0',
      ],
      [
        'globalWall',
        'GLOBAL',
        'WALL',
        'Global wall coefficient',
        'Wall rate coefficient for pipes without their own.',
        '0',
      ],
    ] as const
  ).map(([id, k0, k1, label, help, fallback]): OptionSpec => ({
    id,
    section: 'reactions',
    group: 'Reactions',
    label,
    help,
    keys: [k0, k1],
    match: (t) => t.length >= 3 && m(t[0]!, k0) && m(t[1]!, k1),
    value: last,
    kind:
      id === 'wallOrder'
        ? {
            type: 'choice',
            choices: [
              ['0', 'Zero'],
              ['1', 'First'],
            ],
          }
        : { type: 'number' },
    fallback,
  })),
  {
    id: 'limitingPotential',
    section: 'reactions',
    group: 'Reactions',
    label: 'Limiting concentration',
    help: 'Concentration that limits growth or decay (0 means no limit).',
    keys: ['LIMITING', 'POTENTIAL'],
    match: (t) => t.length >= 3 && m(t[0]!, 'LIMIT'),
    value: last,
    kind: { type: 'number' },
    fallback: '0',
    quantity: 'concentration',
  },
  {
    id: 'roughnessCorrelation',
    section: 'reactions',
    group: 'Reactions',
    label: 'Wall coefficient correlation',
    help: 'Relates each pipe’s wall coefficient to its roughness (0 means none).',
    keys: ['ROUGHNESS', 'CORRELATION'],
    match: (t) => t.length >= 3 && m(t[0]!, 'ROUG'),
    value: last,
    kind: { type: 'number' },
    fallback: '0',
  },
  // [TIMES]
  ...(
    [
      [
        'duration',
        ['DURATION'],
        (t: readonly string[]) => m(t[0]!, 'DURA'),
        'Total duration',
        'Length of the simulation. 0 runs a single steady-state analysis.',
        '0:00',
      ],
      [
        'hydraulicStep',
        ['HYDRAULIC', 'TIMESTEP'],
        (t: readonly string[]) => m(t[0]!, 'HYDR'),
        'Hydraulic time step',
        'How often a new hydraulic state is computed (at most the pattern and report steps).',
        '1:00',
      ],
      [
        'qualityStep',
        ['QUALITY', 'TIMESTEP'],
        (t: readonly string[]) => m(t[0]!, 'QUAL'),
        'Quality time step',
        'Time step for water quality transport. Defaults to a tenth of the hydraulic step.',
        '',
      ],
      [
        'ruleStep',
        ['RULE', 'TIMESTEP'],
        (t: readonly string[]) => m(t[0]!, 'RULE'),
        'Rule time step',
        'Time step for checking rule-based controls. Defaults to a tenth of the hydraulic step.',
        '',
      ],
      [
        'patternStep',
        ['PATTERN', 'TIMESTEP'],
        (t: readonly string[]) => m(t[0]!, 'PATT') && at(t, 1, 'TIME'),
        'Pattern time step',
        'Length of each period of every time pattern.',
        '1:00',
      ],
      [
        'patternStart',
        ['PATTERN', 'START'],
        (t: readonly string[]) => m(t[0]!, 'PATT') && at(t, 1, 'STAR'),
        'Pattern start time',
        'Time into every pattern at which the simulation starts.',
        '0:00',
      ],
      [
        'reportStep',
        ['REPORT', 'TIMESTEP'],
        (t: readonly string[]) => m(t[0]!, 'REPO') && at(t, 1, 'TIME'),
        'Reporting time step',
        'Interval between reported results.',
        '1:00',
      ],
      [
        'reportStart',
        ['REPORT', 'START'],
        (t: readonly string[]) => m(t[0]!, 'REPO') && at(t, 1, 'STAR'),
        'Report start time',
        'Time into the simulation at which reporting starts.',
        '0:00',
      ],
    ] as const
  ).map(([id, keys, match, label, help, fallback]): OptionSpec => ({
    id,
    section: 'times',
    group: 'Times',
    label,
    help,
    keys,
    match: (t) => t.length >= 2 && match(t),
    value: timeValue,
    kind: { type: 'duration' },
    fallback,
  })),
  {
    id: 'startClock',
    section: 'times',
    group: 'Times',
    label: 'Starting time of day',
    help: 'Clock time at which the simulation begins.',
    keys: ['START', 'CLOCKTIME'],
    match: (t) => t.length >= 2 && m(t[0]!, 'STAR'),
    value: timeValue,
    kind: { type: 'clock' },
    fallback: '12:00 AM',
  },
  {
    id: 'statistic',
    section: 'times',
    group: 'Times',
    label: 'Time statistic',
    help: 'Report a statistic over the reporting period instead of every time step.',
    keys: ['STATISTIC'],
    match: (t) => t.length >= 2 && m(t[0]!, 'STAT'),
    value: last,
    kind: {
      type: 'choice',
      choices: [
        ['NONE', 'None (time series)'],
        ['AVERAGE', 'Average'],
        ['MINIMUM', 'Minimum'],
        ['MAXIMUM', 'Maximum'],
        ['RANGE', 'Range'],
      ],
    },
    fallback: 'NONE',
  },
  // [ENERGY]
  ...(
    [
      [
        'globalEfficiency',
        'EFFICIENCY',
        'EFFI',
        'Pump efficiency',
        'Efficiency of pumps without an efficiency curve, in percent.',
        '75',
      ],
      ['globalPrice', 'PRICE', 'PRICE', 'Energy price', 'Price per kWh for pumps without their own.', '0'],
      [
        'globalPattern',
        'PATTERN',
        'PATT',
        'Price pattern',
        'Time pattern of the energy price for pumps without their own.',
        '',
      ],
    ] as const
  ).map(([id, key, prefix, label, help, fallback]): OptionSpec => ({
    id,
    section: 'energy',
    group: 'Energy',
    label,
    help,
    keys: ['GLOBAL', key],
    match: (t) => t.length >= 3 && m(t[0]!, 'GLOB') && m(t[t.length - 2]!, prefix),
    value: last,
    kind: id === 'globalPattern' ? { type: 'pattern' } : { type: 'number', min: 0 },
    fallback,
    ...(id === 'globalPrice' ? { quantity: 'price' as const } : {}),
  })),
  {
    id: 'demandCharge',
    section: 'energy',
    group: 'Energy',
    label: 'Demand charge',
    help: 'Charge per maximum kW used during the simulation.',
    keys: ['DEMAND', 'CHARGE'],
    match: (t) => t.length >= 3 && m(t[0]!, 'DEMAN'),
    value: (t) => t.slice(2, 3),
    kind: { type: 'number', min: 0 },
    fallback: '0',
  },
  // [REPORT]
  ...(
    [
      [
        'reportStatus',
        'STATUS',
        'STATUS',
        'Status report',
        'Hydraulic status changes in the report: no, yes, or full (every trial).',
        'NO',
      ],
      [
        'reportSummary',
        'SUMMARY',
        'SUMM',
        'Input summary',
        'The table of network size and options at the top of the report.',
        'YES',
      ],
      ['reportEnergy', 'ENERGY', 'ENER', 'Energy report', 'Pump energy usage and cost.', 'NO'],
      ['reportMessages', 'MESSAGES', 'MESS', 'Warning messages', 'Warnings in the report.', 'YES'],
    ] as const
  ).map(([id, key, prefix, label, help, fallback]): OptionSpec => ({
    id,
    section: 'report',
    group: 'Report',
    label,
    help,
    keys: [key],
    match: (t) => t.length >= 2 && m(t[0]!, prefix),
    value: last,
    kind:
      id === 'reportStatus'
        ? {
            type: 'choice',
            choices: [
              ['NO', 'No'],
              ['YES', 'Yes'],
              ['FULL', 'Full'],
            ],
          }
        : { type: 'choice', choices: YES_NO },
    fallback,
  })),
  {
    id: 'reportNodes',
    section: 'report',
    group: 'Report',
    label: 'Nodes reported',
    help: 'Nodes whose results the full report lists: none, all, or the ones named.',
    keys: ['NODES'],
    match: (t) => t.length >= 2 && m(t[0]!, 'NODE'),
    value: from(1),
    kind: { type: 'custom' },
    fallback: 'NONE',
  },
  {
    id: 'reportLinks',
    section: 'report',
    group: 'Report',
    label: 'Links reported',
    help: 'Links whose results the full report lists: none, all, or the ones named.',
    keys: ['LINKS'],
    match: (t) => t.length >= 2 && m(t[0]!, 'LINK'),
    value: from(1),
    kind: { type: 'custom' },
    fallback: 'NONE',
  },
  {
    id: 'pageSize',
    section: 'report',
    group: 'Report',
    label: 'Page size',
    help: 'Lines per page of the report (0 means no page breaks).',
    keys: ['PAGESIZE'],
    match: (t) => t.length >= 2 && m(t[0]!, 'PAGE'),
    value: last,
    kind: { type: 'number', min: 0, below: 256, integer: true },
    fallback: '0',
  },
];

export const optionSpec = new Map(OPTION_SPECS.map((s) => [s.id, s]));

function spec(id: string): OptionSpec {
  const s = optionSpec.get(id);
  if (!s) throw new Error(`unknown option ${id}`);
  return s;
}

/**
 * The value tokens of an option, or undefined if no line sets it. For the reported
 * nodes and links every line counts (EPANET accumulates them); otherwise the last wins.
 */
export function readOption(section: KeywordSection, id: string): string[] | undefined {
  const s = spec(id);
  const lines = section.lines.filter((l) => l.tokens.length > 0 && s.match(l.tokens));
  if (lines.length === 0) return undefined;
  if (id === 'reportNodes' || id === 'reportLinks') {
    const lastAll = lines.findLastIndex((l) => {
      const v = l.tokens.at(-1)!;
      return m(v, 'NONE') || m(v, 'ALL');
    });
    if (lastAll === lines.length - 1) return s.value(lines[lastAll]!.tokens).slice(-1);
    return lines.slice(lastAll + 1).flatMap((l) => s.value(l.tokens));
  }
  return s.value(lines[lines.length - 1]!.tokens);
}

const IDS_PER_LINE = 10;

/**
 * A section with the option set to `value` (null removes it). Returns the same section
 * when nothing changes, so callers can skip a no-op edit.
 */
export function writeOption(
  section: KeywordSection,
  id: string,
  value: readonly string[] | null,
): KeywordSection {
  const s = spec(id);
  const first = section.lines.findIndex((l) => l.tokens.length > 0 && s.match(l.tokens));
  const kept = section.lines.filter((l) => !(l.tokens.length > 0 && s.match(l.tokens)));
  let add: KeywordLine[] = [];
  if (value !== null) {
    const comment = first >= 0 ? (section.lines[first]!.comment ?? null) : null;
    if ((id === 'reportNodes' || id === 'reportLinks') && value.length > IDS_PER_LINE) {
      for (let i = 0; i < value.length; i += IDS_PER_LINE)
        add.push({
          tokens: [...s.keys, ...value.slice(i, i + IDS_PER_LINE)],
          comment: i === 0 ? comment : null,
        });
    } else add = [{ tokens: [...s.keys, ...value], comment }];
  }
  const removedBefore =
    first < 0
      ? 0
      : section.lines.slice(0, first).filter((l) => l.tokens.length > 0 && s.match(l.tokens)).length;
  const insertAt = first < 0 ? kept.length : first - removedBefore;
  const lines = [...kept.slice(0, insertAt), ...add, ...kept.slice(insertAt)];
  if (
    lines.length === section.lines.length &&
    lines.every(
      (l, i) =>
        l.comment === section.lines[i]!.comment &&
        l.tokens.length === section.lines[i]!.tokens.length &&
        l.tokens.every((t, j) => t === section.lines[i]!.tokens[j]),
    )
  )
    return section;
  return { lines };
}

/** The value as the editor shows it: durations and clock times formatted, else the tokens joined. */
export function displayOption(section: KeywordSection, id: string): string | undefined {
  const s = spec(id);
  const v = readOption(section, id);
  if (v === undefined) return undefined;
  if (s.kind.type === 'duration' || s.kind.type === 'clock') {
    const n = getfloat(v[0] ?? '');
    if (n === undefined) return v.join(' ');
    return s.kind.type === 'clock' ? formatClock(n) : formatDuration(n);
  }
  return v.join(' ');
}

export type ParsedOption = { ok: true; tokens: string[] | null } | { ok: false; error: string };

/** Check what the user typed for a simple option and turn it into value tokens (empty means default). */
export function parseOption(id: string, text: string): ParsedOption {
  const s = spec(id);
  const t = text.trim();
  if (t === '') return { ok: true, tokens: null };
  const k = s.kind;
  switch (k.type) {
    case 'number': {
      const y = getfloat(t);
      if (y === undefined) return { ok: false, error: `${s.label} must be a number.` };
      if (k.integer && !Number.isInteger(y))
        return { ok: false, error: `${s.label} must be a whole number.` };
      if (k.min !== undefined && y < k.min)
        return { ok: false, error: `${s.label} cannot be less than ${k.min}.` };
      if (k.above !== undefined && y <= k.above)
        return { ok: false, error: `${s.label} must be greater than ${k.above}.` };
      if (k.below !== undefined && y >= k.below)
        return { ok: false, error: `${s.label} must be less than ${k.below}.` };
      return { ok: true, tokens: [t] };
    }
    case 'duration':
    case 'clock': {
      const parts = t.split(/\s+/);
      if (parts.length > 2) return { ok: false, error: `Enter ${s.label.toLowerCase()} as h:mm.` };
      const secs = timeSeconds(parts);
      if (secs === undefined || secs < 0)
        return {
          ok: false,
          error:
            k.type === 'clock'
              ? `Enter a time of day such as 6:00 AM.`
              : `Enter ${s.label.toLowerCase()} as h:mm, or a number with units such as 30 min.`,
        };
      if (k.type === 'clock') {
        const c = formatClock(secs).split(' ');
        return { ok: true, tokens: c };
      }
      return { ok: true, tokens: [formatDuration(secs)] };
    }
    case 'choice':
      if (!k.choices.some(([v]) => v === t))
        return { ok: false, error: `${t} is not a choice for ${s.label}.` };
      return { ok: true, tokens: [t] };
    case 'pattern':
      if (/[\s;"]/.test(t)) return { ok: false, error: 'A pattern ID cannot contain spaces.' };
      return { ok: true, tokens: [t] };
    case 'custom':
      return { ok: true, tokens: t.split(/\s+/) };
  }
}

export type QualityOption =
  | { kind: 'none' }
  | { kind: 'age' }
  | { kind: 'trace'; node: string }
  | { kind: 'chemical'; name: string; units: string };

/** The QUALITY option as the editor shows it. */
export function readQuality(options: KeywordSection): QualityOption {
  const t = readOption(options, 'quality');
  const t1 = t?.[0];
  if (!t1 || m(t1, 'NONE')) return { kind: 'none' };
  if (m(t1, 'AGE')) return { kind: 'age' };
  if (m(t1, 'TRACE')) return { kind: 'trace', node: t[1] ?? '' };
  if (m(t1, 'CHEM')) return { kind: 'chemical', name: '', units: '' };
  return { kind: 'chemical', name: t1, units: t[1] ?? '' };
}

/** Value tokens for a QUALITY option, or an error. A chemical name EPANET would read as a keyword is refused. */
export function qualityTokens(q: QualityOption): ParsedOption {
  switch (q.kind) {
    case 'none':
      return { ok: true, tokens: null };
    case 'age':
      return { ok: true, tokens: ['AGE'] };
    case 'trace':
      if (q.node.trim() === '') return { ok: false, error: 'Choose the node to trace.' };
      return { ok: true, tokens: ['TRACE', q.node.trim()] };
    case 'chemical': {
      const name = q.name.trim();
      const units = q.units.trim();
      if (name === '') return { ok: true, tokens: ['CHEMICAL'] };
      if (/\s/.test(name) || /\s/.test(units))
        return { ok: false, error: 'The chemical name and units cannot contain spaces.' };
      if (['NONE', 'CHEM', 'AGE', 'TRACE'].some((k) => m(name, k)))
        return { ok: false, error: `EPANET would read “${name}” as a keyword: choose another name.` };
      return { ok: true, tokens: units ? [name, units] : [name] };
    }
  }
}
